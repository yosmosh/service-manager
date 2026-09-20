// Daily digest for management: reads the last 24h of group messages (written in real
// time by api/telegram/webhook.js into the separate telegram_messages collection),
// asks Claude for a short per-topic summary, and DMs it privately to every configured
// recipient (telegram_config.digest.ownerChatIds — each DMs the bot /start once to be
// added) — never posted back to the group.
//
// Controlled from Настройки доступа → 🤖 Бот в Telegram → "📋 Дайджест для руководства"
// (telegram_config.digest), same panel/pattern as the SOS and Заявки reminders.
//
// Required Vercel environment variables:
//   TELEGRAM_BOT_TOKEN  — shared with the other bot functions
//   ANTHROPIC_API_KEY   — for the summarization call
//   CRON_SECRET         — shared with the other cron functions

const FIRESTORE_STATE_BASE = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const FIRESTORE_QUERY_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents:runQuery';
const LOG_CAP = 50;

function fsGet(fields) {
  const mask = fields.map(f => `mask.fieldPaths=${f}`).join('&');
  return fetch(`${FIRESTORE_STATE_BASE}?${mask}`).then(r => r.json());
}

function fsPatchMulti(fieldValues) {
  const fieldNames = Object.keys(fieldValues);
  const mask = fieldNames.map(f => `updateMask.fieldPaths=${f}`).join('&');
  return fetch(`${FIRESTORE_STATE_BASE}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: fieldValues }),
  }).then(r => r.json());
}

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }
function fsInt(v) { return { integerValue: String(Math.round(v)) }; }

function fromFsMap(mv) {
  const out = {};
  const fields = (mv.mapValue && mv.mapValue.fields) || {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('doubleValue' in v) out[k] = v.doubleValue;
    else out[k] = null;
  }
  return out;
}

function readDigestConfig(doc) {
  const raw = (doc.fields && doc.fields.telegram_config) || null;
  if (!raw) return { enabled: false, digest: {} };
  const top = fromFsMap({ mapValue: raw.mapValue });
  const dRaw = raw.mapValue && raw.mapValue.fields && raw.mapValue.fields.digest;
  const digest = dRaw ? fromFsMap({ mapValue: dRaw.mapValue }) : {};
  const subsRaw = dRaw && dRaw.mapValue && dRaw.mapValue.fields && dRaw.mapValue.fields.subscribers;
  const subscribers = (subsRaw && subsRaw.arrayValue && subsRaw.arrayValue.values || [])
    .map(v => v.mapValue.fields.chatId.stringValue).filter(Boolean);
  digest.ownerChatIds = subscribers;
  return { enabled: !!top.enabled, digest };
}

// Firestore documents from a message collection each look like
// { name, fields: { topicId, topicName, fromName, text, date } } — plain field values,
// not the mapValue-wrapped array-element shape the other two cron files deal with.
function fromFsDoc(doc) {
  const out = {};
  const fields = doc.fields || {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('timestampValue' in v) out[k] = v.timestampValue;
    else out[k] = null;
  }
  return out;
}

async function fetchRecentMessages(sinceIso) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'telegram_messages' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'date' },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { timestampValue: sinceIso },
        },
      },
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'ASCENDING' }],
    },
  };
  const res = await fetch(FIRESTORE_QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r.document)
    .map(r => fromFsDoc(r.document));
}

function groupByTopic(messages) {
  const byTopic = {};
  for (const m of messages) {
    const key = m.topicName || 'Без темы';
    (byTopic[key] = byTopic[key] || []).push(m);
  }
  return byTopic;
}

async function summarizeWithClaude(byTopic) {
  const transcript = Object.entries(byTopic)
    .map(([topic, msgs]) => `## ${topic}\n` + msgs.map(m => `[${m.fromName}] ${m.text}`).join('\n'))
    .join('\n\n');

  const prompt = `Вот сообщения за последние 24 часа из рабочей Telegram-группы учреждения, по темам (разделам).
Составь краткую сводку для руководителя — по каждой теме, где было что-то важное: какие проблемы подняты, какие просьбы/заявки поступили, что было решено/закрыто.
Пропускай темы без ничего существенного. Пиши по-русски, кратко, по пунктам, без вступлений и заключений.

${transcript}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Anthropic API error: ' + JSON.stringify(data));
  return (data.content && data.content[0] && data.content[0].text) || '';
}

async function sendTelegramDM(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.json();
}

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!token) { res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' }); return; }
  if (!claudeKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');

  try {
    const stateDoc = await fsGet(['telegram_config', 'telegram_log']);
    const cfg = readDigestConfig(stateDoc);
    if (!cfg.enabled || cfg.digest.enabled === false) {
      res.status(200).json({ ok: true, skipped: 'disabled in telegram_config' });
      return;
    }
    if (!cfg.digest.ownerChatIds.length) {
      res.status(200).json({ ok: true, skipped: 'no ownerChatIds set — each recipient must DM the bot /start first' });
      return;
    }

    const sinceIso = new Date(Date.now() - 24 * 3600000).toISOString();
    const messages = await fetchRecentMessages(sinceIso);
    if (!messages.length) {
      res.status(200).json({ ok: true, skipped: 'no messages in the last 24h' });
      return;
    }
    const byTopic = groupByTopic(messages);
    const digestText = await summarizeWithClaude(byTopic);

    if (!dryRun) {
      for (const chatId of cfg.digest.ownerChatIds) {
        await sendTelegramDM(token, chatId, `📋 Дайджест за сутки:\n\n${digestText}`);
      }
      const rawLog = (stateDoc.fields && stateDoc.fields.telegram_log && stateDoc.fields.telegram_log.arrayValue.values) || [];
      const entry = {
        mapValue: { fields: {
          id: fsString(`digest-${Date.now()}`),
          type: fsString('digest'),
          title: fsString(digestText.slice(0, 200)),
          level: fsInt(0),
          sentAt: fsString(new Date().toISOString()),
        } }
      };
      const mergedLog = [...rawLog, entry].slice(-LOG_CAP);
      await fsPatchMulti({ telegram_log: { arrayValue: { values: mergedLog } } });
    }

    res.status(200).json({ ok: true, dryRun: !!dryRun, messageCount: messages.length, topics: Object.keys(byTopic), digestText });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
