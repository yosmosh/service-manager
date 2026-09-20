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
// Phase 2b: messages in "Хозчасть и Ремонт" (topicId 57) additionally get turned into a
// manager-reviewed draft SOS/maintenance record (never auto-created — see
// handleFreshMessageInDraftTopic/handleReplyInDraftTopic below), with photo support and
// a clarifying-question follow-up when a report is too thin to act on.
//
// One-time setup after this is deployed (done once, not on every request):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//     -d "url=https://sad-budushego.ru/api/telegram/webhook" \
//     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//
// Required Vercel environment variables: TELEGRAM_WEBHOOK_SECRET (Telegram echoes it
// back on every call so this can reject anyone else), TELEGRAM_BOT_TOKEN,
// ANTHROPIC_API_KEY (shared with api/cron/telegram-digest.js — Phase 2b features are
// silently skipped if it's not set).

const FIRESTORE_MESSAGES_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/telegram_messages';
const FIRESTORE_STATE_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const FIRESTORE_FILES_REGISTRY_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/files_registry';
const FIRESTORE_QUERY_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents:runQuery';
const STORAGE_BUCKET = 'sad-budushego.firebasestorage.app';
const TELEGRAM_CHAT_ID = -1004438968318; // Сад Будущего | Рабочая группа — ignore anything from elsewhere

// Known topic names — extend this as more topics are identified (same technique used
// to find the first two: send "@sad_budushego_bot test" in the topic, read getUpdates).
const TOPIC_NAMES = {
  57: 'Хозчасть и Ремонт',
  34: 'Покупки',
};

// Scoped to this one topic for now — extend to widen it, no other change needed.
const DRAFT_TOPIC_IDS = [57];
const COMPLETION_RE = /готов|сделан|исправ|решен|решён|устранен|устранён|закры|выполнен/i;

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }
function fsInt(v) { return { integerValue: String(Math.round(v)) }; }
function fsTimestamp(iso) { return { timestampValue: iso }; }
function fsStringArray(arr) { return { arrayValue: { values: (arr || []).map(fsString) } }; }

async function sendTelegramDM(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendTelegramReply(topicId, replyToMessageId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_thread_id: topicId, reply_to_message_id: replyToMessageId, text }),
  });
}

// ---------- Photo pipeline (Phase 2b) ----------
// Downloads a Telegram-hosted photo and re-hosts it in the same Firebase Storage bucket
// the client already uses for every other file upload (dbSave, service-manager.html),
// registering it in appdata/files_registry so the normal file-preview/gallery code in
// the app can show it with no special-casing for "came from Telegram".

async function downloadTelegramFile(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) return null;
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) return null;
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
  return { buf, ext };
}

async function uploadPhotoToStorage(buf, ext) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const name = `files/${id}.${ext}`;
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const uploadRes = await fetch(`https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: buf,
  });
  const meta = await uploadRes.json();
  if (!meta.downloadTokens) return null;
  const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(name)}?alt=media&token=${meta.downloadTokens}`;
  return { id, name: `telegram-photo.${ext}`, type: mime, size: Number(meta.size) || buf.length, url };
}

async function registerFile(fileMeta) {
  const res = await fetch(`${FIRESTORE_FILES_REGISTRY_URL}?mask.fieldPaths=files`);
  const doc = await res.json();
  const existingFields = (doc.fields && doc.fields.files && doc.fields.files.mapValue.fields) || {};
  const merged = Object.assign({}, existingFields, {
    [fileMeta.id]: { mapValue: { fields: {
      id: fsString(fileMeta.id), name: fsString(fileMeta.name), type: fsString(fileMeta.type),
      size: fsInt(fileMeta.size), url: fsString(fileMeta.url),
    } } },
  });
  await fetch(`${FIRESTORE_FILES_REGISTRY_URL}?updateMask.fieldPaths=files`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { files: { mapValue: { fields: merged } } } }),
  });
}

async function capturePhotoFromMessage(msg) {
  if (!msg.photo || !msg.photo.length) return null;
  const largest = msg.photo[msg.photo.length - 1];
  const dl = await downloadTelegramFile(largest.file_id);
  if (!dl) return null;
  const meta = await uploadPhotoToStorage(dl.buf, dl.ext);
  if (!meta) return null;
  await registerFile(meta);
  return meta;
}

// ---------- Classification (Phase 2b: extends Phase 2's actionable/type/title/etc. with
// sufficient/clarifyingQuestion) ----------

async function classifyReport(text, hasPhoto) {
  const prompt = 'Ты помогаешь распознавать реальные проблемы и заявки на ремонт/обслуживание из сообщений рабочей Telegram-группы учреждения (тема "Хозчасть и Ремонт").\n\n'
    + `Сообщение: "${text}"\n`
    + (hasPhoto ? 'К сообщению приложено фото проблемы — учти это как дополнительный контекст, фото само по себе может делать короткий текст достаточным.\n' : '')
    + '\nОпредели:\n'
    + '1. actionable — описывает ли сообщение САМО ПО СЕБЕ конкретную, реальную проблему или потребность в ремонте/обслуживании (не приветствие, не благодарность, не пустой вопрос, не тестовое сообщение).\n'
    + '2. Если actionable — достаточно ли информации (что именно, где) чтобы завести заявку (sufficient: true/false).\n'
    + '3. Если недостаточно — clarifyingQuestion: короткий вопрос по-русски, который нужно задать в ответ сотруднику.\n\n'
    + 'Верни ТОЛЬКО JSON без комментариев, в точности в этом формате:\n'
    + '{"actionable":true,"sufficient":true,"clarifyingQuestion":"","type":"sos","title":"...","description":"...","priority":"high","category":"other"}\n\n'
    + 'Правила:\n'
    + '- "sos" — если это срочно, опасно или блокирует работу учреждения прямо сейчас.\n'
    + '- "maintenance" — если это обычная потребность в ремонте/обслуживании, не срочная.\n'
    + '- category: landscaping/cleaning/repair/electrical/plumbing/security/other.\n'
    + '- Если actionable=false или sufficient=false — остальные текстовые поля можно оставить пустыми.\n'
    + '- title — короткий (до 60 символов), description — 1-3 предложения на основе сообщения.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 512, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await resp.json();
  const raw = ((data.content && data.content[0] && data.content[0].text) || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function fsDraftEntry(d) {
  return { mapValue: { fields: {
    id: fsString(d.id), type: fsString(d.type), title: fsString(d.title),
    description: fsString(d.description), priority: fsString(d.priority || ''),
    category: fsString(d.category || ''), sourceText: fsString(d.sourceText),
    sourceFrom: fsString(d.sourceFrom), sourceTopic: fsString(d.sourceTopic),
    sourceDate: fsString(d.sourceDate), sourceMessageId: fsString(d.sourceMessageId),
    status: fsString('pending'), createdAt: fsString(d.createdAt),
    fileIds: fsStringArray(d.fileIds), fileNames: fsStringArray(d.fileNames), fileTypes: fsStringArray(d.fileTypes),
  } } };
}

async function fetchMessageById(messageId) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'telegram_messages' }],
      where: { fieldFilter: { field: { fieldPath: 'messageId' }, op: 'EQUAL', value: { integerValue: String(messageId) } } },
      limit: 1,
    },
  };
  const res = await fetch(FIRESTORE_QUERY_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
  });
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows.find(r => r.document) : null;
  if (!row) return null;
  const f = row.document.fields;
  return { text: (f.text && f.text.stringValue) || '' };
}

async function createDraft(stateDoc, entry) {
  const draftsRaw = (stateDoc.fields && stateDoc.fields.telegram_drafts && stateDoc.fields.telegram_drafts.arrayValue.values) || [];
  const merged = draftsRaw.concat([fsDraftEntry(entry)]);
  await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=telegram_drafts`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { telegram_drafts: { arrayValue: { values: merged } } } }),
  });
}

// Fresh (non-reply) message in the watched topic: classify it directly.
async function handleFreshMessageInDraftTopic(msg, topicId, topicName, fromName, text, dateIso) {
  if (!process.env.ANTHROPIC_API_KEY) return { skip: 'no ANTHROPIC_API_KEY' };
  if (text.length < 10 && !msg.photo) return { skip: 'text too short and no photo' };

  const stateRes = await fetch(`${FIRESTORE_STATE_URL}?mask.fieldPaths=telegram_config&mask.fieldPaths=telegram_drafts`);
  const stateDoc = await stateRes.json();
  const cfgFields = (stateDoc.fields && stateDoc.fields.telegram_config && stateDoc.fields.telegram_config.mapValue.fields) || {};
  const draftsCfg = (cfgFields.drafts && cfgFields.drafts.mapValue && cfgFields.drafts.mapValue.fields) || {};
  if (!draftsCfg.enabled || !draftsCfg.enabled.booleanValue) return { skip: 'drafts disabled', cfgFields: Object.keys(cfgFields) };

  const result = await classifyReport(text, !!msg.photo);
  if (!result) return { skip: 'classifyReport returned null' };
  if (!result.actionable) return { skip: 'not actionable', result };

  if (!result.sufficient) {
    await sendTelegramReply(topicId, msg.message_id, result.clarifyingQuestion || 'Уточните, пожалуйста, подробнее: что случилось и где?');
    return { action: 'asked clarifying question', result };
  }

  let photoError = null;
  const photoMeta = msg.photo ? await capturePhotoFromMessage(msg).catch((e) => { photoError = String(e && e.message || e); return null; }) : null;
  await createDraft(stateDoc, {
    id: String(Date.now()),
    type: result.type === 'sos' ? 'sos' : 'maintenance',
    title: (result.title || '').slice(0, 120),
    description: result.description || '',
    priority: ['high', 'medium', 'low'].includes(result.priority) ? result.priority : 'medium',
    category: result.category || 'other',
    sourceText: text, sourceFrom: fromName, sourceTopic: topicName, sourceDate: dateIso,
    sourceMessageId: String(msg.message_id),
    createdAt: new Date().toISOString(),
    fileIds: photoMeta ? [photoMeta.id] : [],
    fileNames: photoMeta ? [photoMeta.name] : [],
    fileTypes: photoMeta ? [photoMeta.type] : [],
  });
  return { action: 'draft created', result, photoError };
}

// A reply in the watched topic: either a completion signal on something we're already
// tracking (draft or real record), or elaboration on a report that needed more detail.
async function handleReplyInDraftTopic(msg, topicId, topicName, fromName, text, dateIso) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const replyToId = String(msg.reply_to_message.message_id);

  const stateRes = await fetch(`${FIRESTORE_STATE_URL}?mask.fieldPaths=telegram_config&mask.fieldPaths=telegram_drafts&mask.fieldPaths=sos_items&mask.fieldPaths=maint_works`);
  const stateDoc = await stateRes.json();
  const cfgFields = (stateDoc.fields && stateDoc.fields.telegram_config && stateDoc.fields.telegram_config.mapValue.fields) || {};
  const draftsCfg = (cfgFields.drafts && cfgFields.drafts.mapValue && cfgFields.drafts.mapValue.fields) || {};
  if (!draftsCfg.enabled || !draftsCfg.enabled.booleanValue) return;

  const draftsRaw = (stateDoc.fields && stateDoc.fields.telegram_drafts && stateDoc.fields.telegram_drafts.arrayValue.values) || [];
  const sosRaw = (stateDoc.fields && stateDoc.fields.sos_items && stateDoc.fields.sos_items.arrayValue.values) || [];
  const maintRaw = (stateDoc.fields && stateDoc.fields.maint_works && stateDoc.fields.maint_works.arrayValue.values) || [];

  const bySourceId = raw => raw.mapValue.fields.sourceMessageId && raw.mapValue.fields.sourceMessageId.stringValue === replyToId;
  const byLinkedId = raw => raw.mapValue.fields.telegramSourceMessageId && raw.mapValue.fields.telegramSourceMessageId.stringValue === replyToId;
  const draftIdx = draftsRaw.findIndex(bySourceId);
  const sosIdx = sosRaw.findIndex(byLinkedId);
  const maintIdx = maintRaw.findIndex(byLinkedId);

  if (draftIdx === -1 && sosIdx === -1 && maintIdx === -1) {
    // Not replying to anything we're tracking — treat as elaboration on the original
    // message (which we still have, in telegram_messages, regardless of whether it ever
    // became a draft) and reclassify with the combined context.
    const original = await fetchMessageById(replyToId);
    if (!original) return;
    const mergedText = [original.text, text].filter(Boolean).join('\n');
    const result = await classifyReport(mergedText, !!msg.photo);
    if (!result || !result.actionable) return;
    // Capped at one follow-up round: even if still insufficient, create the draft with
    // whatever's known rather than ask the employee a second time.
    const photoMeta = msg.photo ? await capturePhotoFromMessage(msg).catch(() => null) : null;
    await createDraft(stateDoc, {
      id: String(Date.now()),
      type: result.type === 'sos' ? 'sos' : 'maintenance',
      title: (result.title || '').slice(0, 120) || mergedText.slice(0, 60),
      description: result.description || mergedText,
      priority: ['high', 'medium', 'low'].includes(result.priority) ? result.priority : 'medium',
      category: result.category || 'other',
      sourceText: mergedText, sourceFrom: fromName, sourceTopic: topicName, sourceDate: dateIso,
      sourceMessageId: replyToId,
      createdAt: new Date().toISOString(),
      fileIds: photoMeta ? [photoMeta.id] : [],
      fileNames: photoMeta ? [photoMeta.name] : [],
      fileTypes: photoMeta ? [photoMeta.type] : [],
    });
    return;
  }

  // Replying to something already tracked: only act on a clear completion signal with a
  // photo attached — this only ever adds evidence, it never changes status, since that
  // decision belongs to whoever reviews the record, not the bot.
  if (!COMPLETION_RE.test(text) || !msg.photo) return;
  const photoMeta = await capturePhotoFromMessage(msg).catch(() => null);
  if (!photoMeta) return;

  if (draftIdx !== -1) {
    const f = draftsRaw[draftIdx].mapValue.fields;
    const ids = (f.fileIds && f.fileIds.arrayValue.values || []).map(v => v.stringValue).concat([photoMeta.id]);
    const names = (f.fileNames && f.fileNames.arrayValue.values || []).map(v => v.stringValue).concat(['После: ' + photoMeta.name]);
    const types = (f.fileTypes && f.fileTypes.arrayValue.values || []).map(v => v.stringValue).concat([photoMeta.type]);
    draftsRaw[draftIdx].mapValue.fields.fileIds = fsStringArray(ids);
    draftsRaw[draftIdx].mapValue.fields.fileNames = fsStringArray(names);
    draftsRaw[draftIdx].mapValue.fields.fileTypes = fsStringArray(types);
    await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=telegram_drafts`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fields: { telegram_drafts: { arrayValue: { values: draftsRaw } } } }),
    });
  } else {
    const isSos = sosIdx !== -1;
    const targetRaw = isSos ? sosRaw : maintRaw;
    const idx = isSos ? sosIdx : maintIdx;
    const fieldName = isSos ? 'sos_items' : 'maint_works';
    const f = targetRaw[idx].mapValue.fields;
    const ids = (f.fileIds && f.fileIds.arrayValue.values || []).map(v => v.stringValue).concat([photoMeta.id]);
    const names = (f.fileNames && f.fileNames.arrayValue.values || []).map(v => v.stringValue).concat(['После: ' + photoMeta.name]);
    const types = (f.fileTypes && f.fileTypes.arrayValue.values || []).map(v => v.stringValue).concat([photoMeta.type]);
    targetRaw[idx].mapValue.fields.fileIds = fsStringArray(ids);
    targetRaw[idx].mapValue.fields.fileNames = fsStringArray(names);
    targetRaw[idx].mapValue.fields.fileTypes = fsStringArray(types);
    await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=${fieldName}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fields: { [fieldName]: { arrayValue: { values: targetRaw } } } }),
    });
  }
}

// ---------- Digest subscription (Phase 1) ----------

function fsSubscriber(s) {
  return { mapValue: { fields: { chatId: fsString(s.chatId), name: fsString(s.name), subscribedAt: fsString(s.subscribedAt) } } };
}

// Self-service subscribe: anyone who should get the daily digest DMs the bot /start
// with the secret code from Настройки доступа (or taps the owner's t.me/…?start=CODE
// link, which sends the same thing) — this adds their chat_id to
// telegram_config.digest.subscribers. Without the correct code nothing is added, so a
// stranger who finds the bot by its public username can't subscribe themselves to
// internal group summaries.
async function handleStartDM(msg) {
  const chatId = String(msg.chat.id);
  const parts = (msg.text || '').trim().split(/\s+/);
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
    // A photo-only/photo+caption message has no msg.text (Telegram puts that under
    // msg.photo/msg.caption instead) — accept either.
    if (!msg || !msg.chat || (!msg.text && !msg.photo)) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    if (msg.chat.type === 'private' && (msg.text || '').trim().toLowerCase().startsWith('/start')) {
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
    const text = (msg.text || msg.caption || '').trim();

    const body = {
      fields: {
        topicId: fsInt(topicId),
        topicName: fsString(topicName),
        fromName: fsString(fromName),
        text: fsString(text),
        date: fsTimestamp(dateIso),
        messageId: fsInt(msg.message_id),
      },
    };
    await fetch(FIRESTORE_MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });

    let draftDebug = null;
    if (!(msg.from && msg.from.is_bot) && DRAFT_TOPIC_IDS.includes(topicId)) {
      try {
        if (msg.reply_to_message && msg.reply_to_message.message_id) {
          draftDebug = await handleReplyInDraftTopic(msg, topicId, topicName, fromName, text, dateIso);
        } else {
          draftDebug = await handleFreshMessageInDraftTopic(msg, topicId, topicName, fromName, text, dateIso);
        }
      } catch (e) { draftDebug = { error: String(e && e.stack || e) }; }
    }

    res.status(200).json({ ok: true, draftDebug });
  } catch (e) {
    // Still 200 — an error here shouldn't make Telegram hammer us with retries.
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
