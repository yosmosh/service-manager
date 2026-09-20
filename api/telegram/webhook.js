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
    if (!msg || !msg.text || !msg.chat || msg.chat.id !== TELEGRAM_CHAT_ID) {
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

    res.status(200).json({ ok: true });
  } catch (e) {
    // Still 200 — an error here shouldn't make Telegram hammer us with retries.
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
