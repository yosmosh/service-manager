// Is the server side set up for the data in Yandex? Which store the functions use now, and
// whether the Vercel variable SERVICE_KEY is accepted by the Yandex data API — "ok",
// "missing", "rejected" or "unreachable"; never the key itself. Cached for half a minute.
//
//   GET /api/health

const { BACKEND, DATA_API } = require('./_lib/firestore');

let cached = { at: 0, body: null };

module.exports = async (req, res) => {
  if (!cached.body || Date.now() - cached.at > 30000) {
    let yandexKey = 'missing';
    if (process.env.SERVICE_KEY) {
      try {
        const r = await fetch(DATA_API + '/v1/health', { headers: { 'X-Service-Key': process.env.SERVICE_KEY } });
        const j = await r.json().catch(() => ({}));
        yandexKey = j.role === 'service' ? 'ok' : 'rejected';
      } catch (e) { yandexKey = 'unreachable'; }
    }
    cached = { at: Date.now(), body: { dataBackend: BACKEND, yandexKey, checkedAt: new Date().toISOString() } };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(cached.body);
};
