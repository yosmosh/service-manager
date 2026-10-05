// Who is asking. Two kinds of caller:
//   • the server functions (Vercel: the Telegram bot, the reminders, the AI) — header
//     X-Service-Key, a shared secret;
//   • a person signed in to the app — Authorization: Bearer u1.<payload>.<signature>, a token
//     this service signs at sign-in (HMAC-SHA256 with AUTH_SECRET, accounts.js), carrying
//     their role (r), account (s) and the password generation it was issued under (g).
// Anyone else is anonymous. Both secrets come from Lockbox through the function's environment.

'use strict';

const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64url');
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function sign(payload) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET not configured');
  const body = b64u(JSON.stringify(payload));
  return 'u1.' + body + '.' + b64u(crypto.createHmac('sha256', secret).update(body).digest());
}

function verify(token) {
  const secret = process.env.AUTH_SECRET;
  const m = /^u1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!secret || !m) return null;
  const expected = b64u(crypto.createHmac('sha256', secret).update(m[1]).digest());
  if (!sameText(expected, m[2])) return null;
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.r !== 'string' || !p.r || p.r === 'service') return null;
  if (!p.exp || Date.now() / 1000 > p.exp) return null;
  return p;
}

// The caller's role, or null. tokenCurrent(payload), when given, also turns away a token
// issued before its account's password was last changed.
async function identify(headers, tokenCurrent) {
  const h = {};
  for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
  const sk = h['x-service-key'];
  if (sk && process.env.SERVICE_KEY && sameText(sk, process.env.SERVICE_KEY)) return 'service';
  const m = /^Bearer\s+(\S+)$/.exec(h['authorization'] || '');
  const p = m ? verify(m[1]) : null;
  if (!p) return null;
  if (tokenCurrent && !(await tokenCurrent(p))) return null;
  return p.r;
}

module.exports = { sign, verify, identify };
