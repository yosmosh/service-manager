// Daily reminder: any SOS item still "pending" more than 24h after it was logged gets
// posted once to the Хозчасть и Ремонт Telegram topic, so it can't just sit unnoticed
// the way it could before (same problem the unpaid-first Budget sort fixed inside the
// app itself — this is the same fix, just reaching outside the app).
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
const STALE_HOURS = 24;

function fsGet(fields) {
  const mask = fields.map(f => `mask.fieldPaths=${f}`).join('&');
  return fetch(`${FIRESTORE_BASE}?${mask}`).then(r => r.json());
}

function fsPatch(fieldName, value) {
  const body = { fields: { [fieldName]: value } };
  return fetch(`${FIRESTORE_BASE}?updateMask.fieldPaths=${fieldName}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }

// Convert one Firestore array element (mapValue) into a plain JS object, and back.
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
  out.__raw = mv; // keep the original Firestore-format map so we can patch just one field back
  return out;
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
    const doc = await fsGet(['sos_items']);
    const rawList = (doc.fields && doc.fields.sos_items && doc.fields.sos_items.arrayValue.values) || [];
    const now = Date.now();
    const notified = [];

    for (const rawItem of rawList) {
      const it = fromFsMap(rawItem);
      if (it.status !== 'pending') continue;
      if (it.telegramNotifiedAt) continue;
      const refTime = it.createdAt ? new Date(it.createdAt).getTime() : new Date(it.date).getTime();
      if (!refTime || isNaN(refTime)) continue;
      if ((now - refTime) / 3600000 < STALE_HOURS) continue;

      const priorityLabel = it.priority === 'high' ? 'Высокий' : it.priority === 'medium' ? 'Средний' : 'Низкий';
      const text = `⚠️ SOS всё ещё не решён (более ${STALE_HOURS}ч): "${it.title || ''}"\nДата: ${it.date || ''} · Приоритет: ${priorityLabel}`;
      if (!dryRun) {
        await sendTelegram(token, text);
        rawItem.mapValue.fields.telegramNotifiedAt = fsString(new Date().toISOString());
      }
      notified.push({ id: it.id, title: it.title, date: it.date, wouldSendText: text });
    }

    if (notified.length && !dryRun) {
      await fsPatch('sos_items', { arrayValue: { values: rawList } });
    }

    res.status(200).json({ ok: true, dryRun: !!dryRun, notified });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
