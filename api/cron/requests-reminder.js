// Same pattern as api/cron/sos-reminder.js, for покупки: a purchase request still
// "pending" (nobody from admin/owner has acted on it) past a configurable threshold
// gets a Telegram reminder in the Покупки topic, naming who asked for it — and a
// stronger escalation if it's still untouched after a second, longer threshold.
//
// Controlled from Настройки доступа → 🤖 Бот в Telegram → "Заявки на закупку"
// (telegram_config.requests) — this file only supplies fallback defaults.
//
// Required Vercel environment variables: TELEGRAM_BOT_TOKEN, CRON_SECRET (see
// sos-reminder.js for details — both files share the same bot/secret).

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const TELEGRAM_CHAT_ID = -1004438968318; // Сад Будущего | Рабочая группа
const TOPIC_POKUPKI = 34; // Покупки
const DEFAULT_STALE_HOURS = 24;
const DEFAULT_ESCALATE_HOURS = 72;
const DEFAULT_TEMPLATE = '🔔 Заявка на закупку ждёт рассмотрения уже {hours}ч: "{title}"\nОт: {requester} · Дата: {date}';
const DEFAULT_ESCALATE_TEMPLATE = '🔴 ПОВТОРНО: заявка на закупку не рассмотрена уже {hours}ч! "{title}"\nОт: {requester} · Дата: {date}';
const LOG_CAP = 50;

function fsGet(fields) {
  const mask = fields.map(f => `mask.fieldPaths=${f}`).join('&');
  return fetch(`${FIRESTORE_BASE}?${mask}`).then(r => r.json());
}

function fsPatchMulti(fieldValues) {
  const fieldNames = Object.keys(fieldValues);
  const mask = fieldNames.map(f => `updateMask.fieldPaths=${f}`).join('&');
  const body = { fields: fieldValues };
  return fetch(`${FIRESTORE_BASE}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
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

function readRequestsConfig(doc) {
  const raw = (doc.fields && doc.fields.telegram_config) || null;
  if (!raw) return { enabled: false, requests: {} };
  const top = fromFsMap({ mapValue: raw.mapValue });
  const reqRaw = raw.mapValue && raw.mapValue.fields && raw.mapValue.fields.requests;
  const requests = reqRaw ? fromFsMap({ mapValue: reqRaw.mapValue }) : {};
  return { enabled: !!top.enabled, requests };
}

function applyTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

async function sendTelegram(token, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_thread_id: TOPIC_POKUPKI, text }),
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
  if (!token) {
    res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
    return;
  }

  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');

  try {
    const doc = await fsGet(['purchase_requests', 'telegram_config', 'telegram_log']);
    const cfg = readRequestsConfig(doc);
    if (!cfg.enabled || cfg.requests.enabled === false) {
      res.status(200).json({ ok: true, skipped: 'disabled in telegram_config' });
      return;
    }
    const staleHours = cfg.requests.staleHours != null ? cfg.requests.staleHours : DEFAULT_STALE_HOURS;
    const escalateHours = cfg.requests.escalateHours != null ? cfg.requests.escalateHours : DEFAULT_ESCALATE_HOURS;
    const template = cfg.requests.template || DEFAULT_TEMPLATE;
    const escalateTemplate = cfg.requests.escalateTemplate || DEFAULT_ESCALATE_TEMPLATE;

    const rawList = (doc.fields && doc.fields.purchase_requests && doc.fields.purchase_requests.arrayValue.values) || [];
    const rawLog = (doc.fields && doc.fields.telegram_log && doc.fields.telegram_log.arrayValue.values) || [];
    const now = Date.now();
    const notified = [];
    const newLogEntries = [];

    for (const rawItem of rawList) {
      const it = fromFsMap(rawItem);
      if (it.status !== 'pending') continue; // only "awaiting admin review" — same status renderRequests() treats as needing attention
      const refTime = it.date ? new Date(it.date).getTime() : NaN;
      if (!refTime || isNaN(refTime)) continue;
      const elapsedHours = (now - refTime) / 3600000;
      const level = it.telegramNotifyLevel || 0;

      let sendLevel = 0;
      if (level === 0 && elapsedHours >= staleHours) sendLevel = 1;
      else if (level === 1 && escalateHours > 0 && elapsedHours >= escalateHours) sendLevel = 2;
      if (!sendLevel) continue;

      const vars = { title: it.title || '', date: it.date || '', requester: it.providerName || it.providerId || '', hours: Math.round(elapsedHours) };
      const text = applyTemplate(sendLevel === 2 ? escalateTemplate : template, vars);

      if (!dryRun) {
        await sendTelegram(token, text);
        rawItem.mapValue.fields.telegramNotifyLevel = fsInt(sendLevel);
        rawItem.mapValue.fields.telegramNotifiedAt = fsString(new Date().toISOString());
        newLogEntries.push({
          mapValue: { fields: {
            id: fsString(`${it.id}-${sendLevel}-${now}`),
            type: fsString('requests'),
            itemId: fsString(it.id),
            title: fsString(it.title),
            level: fsInt(sendLevel),
            sentAt: fsString(new Date().toISOString()),
          } }
        });
      }
      notified.push({ id: it.id, title: it.title, requester: vars.requester, level: sendLevel, wouldSendText: text });
    }

    if (notified.length && !dryRun) {
      const mergedLog = [...rawLog, ...newLogEntries].slice(-LOG_CAP);
      await fsPatchMulti({
        purchase_requests: { arrayValue: { values: rawList } },
        telegram_log: { arrayValue: { values: mergedLog } },
      });
    }

    res.status(200).json({ ok: true, dryRun: !!dryRun, notified });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
