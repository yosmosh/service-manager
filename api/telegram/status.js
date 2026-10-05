// Is Telegram managing to deliver the group's messages to the webhook? Telegram's own answer
// (getWebhookInfo), reduced to what says so and nothing secret: where it delivers, how many
// messages are waiting because delivery failed, and the last error it got. Without this the
// only sign of a broken webhook is silence — indistinguishable from a quiet day.
//
//   GET /api/telegram/status
//
// Answers are cached for half a minute, so the URL can't be used to hammer Telegram's API.
//
//   POST /api/telegram/status   points Telegram's delivery at WEBHOOK_URL — that address and
//                               no other, so calling it can do nothing but this.
//
// Why straight to Vercel: from the move to Yandex (2026-10-05) the main address is Yandex's
// gateway in Russia, which would only pass the call back to Vercel — and Telegram's servers
// connecting into Russia timed out for 23 minutes that very evening before one got through.

const WEBHOOK_URL = 'https://api.sad-budushego.ru/api/telegram/webhook';

let cached = { at: 0, body: null };

module.exports = async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' }); return; }
  if (req.method === 'POST') {
    if (!process.env.TELEGRAM_WEBHOOK_SECRET) { res.status(500).json({ error: 'TELEGRAM_WEBHOOK_SECRET not configured' }); return; }
    try {
      // Pending messages are kept (drop_pending_updates is not set), and so is the list of
      // update types Telegram sends (allowed_updates left out keeps the previous setting).
      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: WEBHOOK_URL, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }),
      });
      const j = await r.json();
      cached = { at: 0, body: null };
      res.status(j.ok ? 200 : 502).json({ ok: !!j.ok, url: WEBHOOK_URL, telegram: String(j.description || '') });
    } catch (e) {
      res.status(502).json({ error: 'Telegram unreachable: ' + String(e && e.message || e) });
    }
    return;
  }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!cached.body || Date.now() - cached.at > 30000) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const j = await r.json();
      if (!j.ok) { res.status(502).json({ error: 'Telegram: ' + String(j.description || r.status) }); return; }
      const w = j.result || {};
      const at = s => (s ? new Date(s * 1000).toISOString() : null);
      cached = {
        at: Date.now(),
        body: {
          url: w.url || '',
          pendingUpdates: w.pending_update_count || 0,
          lastErrorAt: at(w.last_error_date),
          lastError: w.last_error_message || null,
          lastSyncErrorAt: at(w.last_synchronization_error_date),
          checkedAt: new Date().toISOString(),
        },
      };
    } catch (e) {
      res.status(502).json({ error: 'Telegram unreachable: ' + String(e && e.message || e) });
      return;
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(cached.body);
};
