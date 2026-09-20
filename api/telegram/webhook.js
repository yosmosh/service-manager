// Telegram pushes every new message in the group here in real time (a "webhook" —
// the opposite of the reminder crons, which pull app data on a schedule). Each message
// gets written as its OWN document in a separate top-level Firestore collection,
// telegram_messages — deliberately NOT inside appdata/state, which already carries the
// entire app's data and has a hard 1MiB Firestore document-size limit. A 32-person
// active group could produce hundreds of messages a day; appending them to that shared
// document risks breaking saving for the whole app, not just this feature.
//
// api/cron/telegram-digest.js reads this collection once a day to build the digest.
//
// One-time setup after this is deployed (done once, not on every request):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//     -d "url=https://sad-budushego.ru/api/telegram/webhook" \
//     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//
// Required Vercel environment variable: TELEGRAM_WEBHOOK_SECRET (any random string —
// Telegram echoes it back on every webhook call so this can reject anyone else).

const FIRESTORE_MESSAGES_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/telegram_messages';
const FIRESTORE_STATE_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const TELEGRAM_CHAT_ID = -1004438968318; // Сад Будущего | Рабочая группа — ignore anything from elsewhere

// Known topic names — extend this as more topics are identified (same technique used
// to find the first two: send "@sad_budushego_bot test" in the topic, read getUpdates).
const TOPIC_NAMES = {
  57: 'Хозчасть и Ремонт',
  34: 'Покупки',
};

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }
function fsInt(v) { return { integerValue: String(Math.round(v)) }; }
function fsTimestamp(iso) { return { timestampValue: iso }; }

async function sendTelegramDM(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Phase 2: turn a real problem report from "Хозчасть и Ремонт" into a manager-reviewed
// draft (telegram_drafts in appdata/state) instead of ever creating an SOS/maintenance
// record directly. Scoped to this one topic for now — extend DRAFT_TOPIC_IDS to widen it.
const DRAFT_TOPIC_IDS = [57];

function fsDraftEntry(d) {
  return { mapValue: { fields: {
    id: fsString(d.id), type: fsString(d.type), title: fsString(d.title),
    description: fsString(d.description), priority: fsString(d.priority || ''),
    category: fsString(d.category || ''), sourceText: fsString(d.sourceText),
    sourceFrom: fsString(d.sourceFrom), sourceTopic: fsString(d.sourceTopic),
    sourceDate: fsString(d.sourceDate), status: fsString('pending'),
    createdAt: fsString(d.createdAt),
  } } };
}

async function classifyForDraft(text) {
  const prompt = 'Ты помогаешь распознавать реальные проблемы и заявки на ремонт/обслуживание из сообщений рабочей Telegram-группы учреждения (тема "Хозчасть и Ремонт").\n\n'
    + `Сообщение: "${text}"\n\n`
    + 'Определи, описывает ли это сообщение САМО ПО СЕБЕ конкретную, реальную проблему или потребность в ремонте/обслуживании (поломка, авария, нужен ремонт и т.п.) — а не приветствие, благодарность, вопрос без содержания, обсуждение или тестовое сообщение.\n\n'
    + 'Верни ТОЛЬКО JSON без комментариев, в точности в этом формате:\n'
    + '{"actionable":true,"type":"sos","title":"...","description":"...","priority":"high","category":"other"}\n\n'
    + 'Правила:\n'
    + '- "sos" — если это срочно, опасно или блокирует работу учреждения прямо сейчас.\n'
    + '- "maintenance" — если это обычная потребность в ремонте/обслуживании, не срочная.\n'
    + '- category (только для maintenance, любое значение подходит и для sos): landscaping/cleaning/repair/electrical/plumbing/security/other.\n'
    + '- Если actionable=false — остальные поля можно оставить пустыми.\n'
    + '- title — короткий (до 60 символов), description — 1-3 предложения на основе сообщения.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 512, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const raw = ((data.content && data.content[0] && data.content[0].text) || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

async function maybeCreateDraft(text, topicId, topicName, fromName, dateIso) {
  if (!process.env.ANTHROPIC_API_KEY || !DRAFT_TOPIC_IDS.includes(topicId) || text.length < 10) return;

  const stateRes = await fetch(`${FIRESTORE_STATE_URL}?mask.fieldPaths=telegram_config&mask.fieldPaths=telegram_drafts`);
  const stateDoc = await stateRes.json();
  const cfgFields = (stateDoc.fields && stateDoc.fields.telegram_config && stateDoc.fields.telegram_config.mapValue.fields) || {};
  const draftsCfg = (cfgFields.drafts && cfgFields.drafts.mapValue && cfgFields.drafts.mapValue.fields) || {};
  if (!draftsCfg.enabled || !draftsCfg.enabled.booleanValue) return;

  const result = await classifyForDraft(text);
  if (!result || !result.actionable) return;

  const draftsRaw = (stateDoc.fields && stateDoc.fields.telegram_drafts && stateDoc.fields.telegram_drafts.arrayValue.values) || [];
  const entry = {
    id: String(Date.now()),
    type: result.type === 'sos' ? 'sos' : 'maintenance',
    title: (result.title || '').slice(0, 120),
    description: result.description || '',
    priority: ['high', 'medium', 'low'].includes(result.priority) ? result.priority : 'medium',
    category: result.category || 'other',
    sourceText: text, sourceFrom: fromName, sourceTopic: topicName, sourceDate: dateIso,
    createdAt: new Date().toISOString(),
  };
  const merged = draftsRaw.concat([fsDraftEntry(entry)]);
  await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=telegram_drafts`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { telegram_drafts: { arrayValue: { values: merged } } } }),
  });
}

// Self-service subscribe: anyone who should get the daily digest DMs the bot /start
// with the secret code from Настройки доступа (or taps the owner's t.me/…?start=CODE
// link, which sends the same thing) — this adds their chat_id to
// telegram_config.digest.ownerChatIds. Without the correct code nothing is added, so a
// stranger who finds the bot by its public username can't subscribe themselves to
// internal group summaries.
function fsSubscriber(s) {
  return { mapValue: { fields: { chatId: fsString(s.chatId), name: fsString(s.name), subscribedAt: fsString(s.subscribedAt) } } };
}

async function handleStartDM(msg) {
  const chatId = String(msg.chat.id);
  const parts = msg.text.trim().split(/\s+/);
  const payload = parts.length > 1 ? parts.slice(1).join(' ') : '';
  const name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ')
    || (msg.from && msg.from.username) || chatId;

  const stateRes = await fetch(`${FIRESTORE_STATE_URL}?mask.fieldPaths=telegram_config`);
  const stateDoc = await stateRes.json();
  const raw = stateDoc.fields && stateDoc.fields.telegram_config;
  const topFields = (raw && raw.mapValue && raw.mapValue.fields) || {};
  const digestFields = (topFields.digest && topFields.digest.mapValue && topFields.digest.mapValue.fields) || {};
  const configuredCode = (digestFields.code && digestFields.code.stringValue) || '';

  if (!configuredCode || payload !== configuredCode) {
    await sendTelegramDM(chatId, '⛔ Неверный или отсутствующий код доступа. Эта подписка только по персональной ссылке от руководителя.');
    return;
  }

  const subsRaw = (digestFields.subscribers && digestFields.subscribers.arrayValue && digestFields.subscribers.arrayValue.values) || [];
  const existing = subsRaw.map(v => {
    const f = v.mapValue.fields;
    return { chatId: f.chatId.stringValue, name: f.name.stringValue, subscribedAt: f.subscribedAt.stringValue };
  });
  const alreadyIn = existing.some(s => s.chatId === chatId);
  const newSubs = alreadyIn ? existing : existing.concat([{ chatId, name, subscribedAt: new Date().toISOString() }]);

  if (!alreadyIn) {
    const mergedDigest = Object.assign({}, digestFields, { subscribers: { arrayValue: { values: newSubs.map(fsSubscriber) } } });
    const mergedTop = Object.assign({}, topFields, { digest: { mapValue: { fields: mergedDigest } } });
    await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=telegram_config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fields: { telegram_config: { mapValue: { fields: mergedTop } } } }),
    });
  }

  await sendTelegramDM(chatId, alreadyIn
    ? '✅ Вы уже подписаны на дайджест — сводка приходит вам ежедневно.'
    : '✅ Готово! Теперь вы будете получать ежедневный дайджест сюда, в личные сообщения.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true }); // Telegram only ever POSTs; respond harmlessly to anything else
    return;
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  try {
    const update = req.body || {};
    const msg = update.message;
    // Always 200 back to Telegram even when we skip a message — a non-200 makes
    // Telegram retry the same update repeatedly, which we don't want for "nothing to do".
    if (!msg || !msg.text || !msg.chat) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    if (msg.chat.type === 'private' && msg.text.trim().toLowerCase().startsWith('/start')) {
      await handleStartDM(msg);
      res.status(200).json({ ok: true, start: true });
      return;
    }

    if (msg.chat.id !== TELEGRAM_CHAT_ID) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const topicId = msg.message_thread_id || 0;
    const topicName = TOPIC_NAMES[topicId] || `Тема #${topicId}`;
    // An anonymous "post as the group" message carries the real sender's name in
    // author_signature instead of a normal `from` user.
    const fromName = msg.author_signature || (msg.from && (msg.from.first_name || msg.from.username)) || 'Неизвестно';
    const dateIso = new Date((msg.date || 0) * 1000).toISOString();

    const body = {
      fields: {
        topicId: fsInt(topicId),
        topicName: fsString(topicName),
        fromName: fsString(fromName),
        text: fsString(msg.text),
        date: fsTimestamp(dateIso),
      },
    };
    await fetch(FIRESTORE_MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });

    if (!(msg.from && msg.from.is_bot)) {
      try { await maybeCreateDraft(msg.text, topicId, topicName, fromName, dateIso); }
      catch (e) { /* draft classification is best-effort — message capture above already succeeded */ }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    // Still 200 — an error here shouldn't make Telegram hammer us with retries.
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
