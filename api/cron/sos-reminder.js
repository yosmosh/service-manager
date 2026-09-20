// Daily reminder: any SOS item still "pending" gets a Telegram reminder once it's been
// stuck past a configurable threshold, and a stronger escalation once it's been stuck
// even longer — so it can't just sit unnoticed the way it could before (same problem
// the unpaid-first Budget sort fixed inside the app itself, reaching outside it).
//
// Everything about WHEN and WHAT it sends (on/off, thresholds, wording) is controlled
// from inside the app (Настройки доступа → 🤖 Бот в Telegram) via the telegram_config
// field — this file only supplies fallback defaults for when that's unset. Every
// message sent is also appended to telegram_log (capped at the last 50), which that
// same settings screen displays, so the owner can see what the bot actually said
// without leaving the app.
//
// Required Vercel environment variables (Project Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN  — the bot's API token from @BotFather
//   CRON_SECRET         — any random string; Vercel sends it back as a Bearer token
//                          on scheduled runs, so this rejects anyone else hitting the URL
//
// Wired up in vercel.json's "crons" list — Hobby plan allows once/day.

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const TELEGRAM_CHAT_ID = -1004438968318; // Сад Будущего | Рабочая группа
const TOPIC_HOZCHAST = 57; // Хозчасть и Ремонт
const DEFAULT_STALE_HOURS = 24;
const DEFAULT_ESCALATE_HOURS = 72;
const DEFAULT_TEMPLATE = '⚠️ SOS всё ещё не решён (более {hours}ч): "{title}"\nДата: {date} · Приоритет: {priority}';
const DEFAULT_ESCALATE_TEMPLATE = '🔴 ПОВТОРНО: SOS не решён уже {hours}ч! "{title}"\nДата: {date} · Приоритет: {priority}';
const LOG_CAP = 50;

function fsGet(fields) {
  const mask = fields.map(f => `mask.fieldPaths=${f}`).join('&');
  return fetch(`${FIRESTORE_BASE}?${mask}`).then(r => r.json());
}

// Patches several top-level fields in one request — keeps sos_items and telegram_log
// changes atomic instead of racing a second call against whatever else might write to
// this document (the app itself, mid-session, via its own merge-write flushes).
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

// Convert one Firestore array element (mapValue) into a plain JS object.
function fromFsMap(mv) {
  const out = {};
  const fields = (mv.mapValue && mv.mapValue.fields) || {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('doubleValue' in v) out[k] = v.doubleValue;
    else out[k] = null; // arrays/maps not needed for this job
  }
  return out;
}

// Reads the client-authored telegram_config map (same shape the settings panel saves).
function readTelegramConfig(doc) {
  const raw = (doc.fields && doc.fields.telegram_config) || null;
  if (!raw) return { enabled: false, sos: {} };
  const top = fromFsMap({ mapValue: raw.mapValue });
  const sosRaw = raw.mapValue && raw.mapValue.fields && raw.mapValue.fields.sos;
  const sos = sosRaw ? fromFsMap({ mapValue: sosRaw.mapValue }) : {};
  return { enabled: !!top.enabled, sos };
}

function applyTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

async function sendTelegram(token, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_thread_id: TOPIC_HOZCHAST, text }),
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

  // ?dryRun=1 computes exactly what would be sent/written without actually sending a
  // Telegram message or patching Firestore — for verifying against real production
  // data without side effects before trusting this to run unattended.
  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');

  try {
    const doc = await fsGet(['sos_items', 'telegram_config', 'telegram_log']);
    const cfg = readTelegramConfig(doc);
    if (!cfg.enabled || cfg.sos.enabled === false) {
      res.status(200).json({ ok: true, skipped: 'disabled in telegram_config' });
      return;
    }
    const staleHours = cfg.sos.staleHours != null ? cfg.sos.staleHours : DEFAULT_STALE_HOURS;
    const escalateHours = cfg.sos.escalateHours != null ? cfg.sos.escalateHours : DEFAULT_ESCALATE_HOURS;
    const template = cfg.sos.template || DEFAULT_TEMPLATE;
    const escalateTemplate = cfg.sos.escalateTemplate || DEFAULT_ESCALATE_TEMPLATE;

    const rawList = (doc.fields && doc.fields.sos_items && doc.fields.sos_items.arrayValue.values) || [];
    const rawLog = (doc.fields && doc.fields.telegram_log && doc.fields.telegram_log.arrayValue.values) || [];
    const now = Date.now();
    const notified = [];
    const newLogEntries = [];

    for (const rawItem of rawList) {
      const it = fromFsMap(rawItem);
      if (it.status !== 'pending') continue;
      const refTime = it.createdAt ? new Date(it.createdAt).getTime() : new Date(it.date).getTime();
      if (!refTime || isNaN(refTime)) continue;
      const elapsedHours = (now - refTime) / 3600000;
      const level = it.telegramNotifyLevel || 0;

      let sendLevel = 0;
      if (level === 0 && elapsedHours >= staleHours) sendLevel = 1;
      else if (level === 1 && escalateHours > 0 && elapsedHours >= escalateHours) sendLevel = 2;
      if (!sendLevel) continue;

      const priorityLabel = it.priority === 'high' ? 'Высокий' : it.priority === 'medium' ? 'Средний' : 'Низкий';
      const vars = { title: it.title || '', date: it.date || '', priority: priorityLabel, hours: Math.round(elapsedHours) };
      const text = applyTemplate(sendLevel === 2 ? escalateTemplate : template, vars);

      if (!dryRun) {
        await sendTelegram(token, text);
        rawItem.mapValue.fields.telegramNotifyLevel = fsInt(sendLevel);
        rawItem.mapValue.fields.telegramNotifiedAt = fsString(new Date().toISOString());
        newLogEntries.push({
          mapValue: { fields: {
            id: fsString(`${it.id}-${sendLevel}-${now}`),
            type: fsString('sos'),
            itemId: fsString(it.id),
            title: fsString(it.title),
            level: fsInt(sendLevel),
            sentAt: fsString(new Date().toISOString()),
          } }
        });
      }
      notified.push({ id: it.id, title: it.title, date: it.date, level: sendLevel, wouldSendText: text });
    }

    if (notified.length && !dryRun) {
      const mergedLog = [...rawLog, ...newLogEntries].slice(-LOG_CAP);
      await fsPatchMulti({
        sos_items: { arrayValue: { values: rawList } },
        telegram_log: { arrayValue: { values: mergedLog } },
      });
    }

    res.status(200).json({ ok: true, dryRun: !!dryRun, notified });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
