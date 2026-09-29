// Turns "who says they are who" into something Firestore can check.
//
// Until now the browser decided, entirely on its own, which role someone had: it compared the
// typed password against fields it had itself downloaded, and then simply set a variable. The
// database was never told any of it — every read and write went out with nothing but the
// project's public API key, so the roles were an arrangement inside the page, not a rule the
// data enforced.
//
// This is the piece that makes the claim checkable. The password is compared HERE, where the
// answer can't be edited by whoever is asking, and what comes back is a Firebase token
// carrying the role. From then on the browser's requests are signed with it, and the security
// rules — not the page — decide what that role may read and write.
//
// Required Vercel environment variable: FIREBASE_SERVICE_ACCOUNT (see ../_lib/fbauth.js).

const { readDoc, updateDoc, fsInt, clone } = require('../_lib/firestore');
const { mintCustomToken, hasServiceAccount } = require('../_lib/fbauth');
const crypto = require('crypto');

// Exactly the accounts service-manager.html's doLogin() accepts, in the same order and with
// the same defaults — this has to agree with it to the letter, or the change locks somebody
// out of their own system. `gated` marks the four that only exist once the budget has been
// released to everyone (getBudgetReleased there, budget_released here).
const ACCOUNTS = [
  { role: 'owner',          user: 'owner_username',          defUser: 'yosef',      pwd: 'owner_pwd',          defPwd: 'yosef123' },
  { role: 'admin',          user: 'admin_username',          defUser: 'admin',      pwd: 'admin_pwd',          defPwd: 'admin123' },
  { role: 'kitchen',        user: 'kitchen_username',        defUser: 'kitchen',    pwd: 'kitchen_pwd',        defPwd: 'kitchen123' },
  { role: 'kitchen_worker', user: 'kitchen_worker_username', defUser: 'worker',     pwd: 'kitchen_worker_pwd', defPwd: 'worker123' },
  { role: 'alexander',      user: 'alexander_username',      defUser: 'alexander',  pwd: 'alexander_pwd',      defPwd: 'alex123',    gated: true },
  { role: 'accountant',     user: 'accountant_username',     defUser: 'accountant', pwd: 'accountant_pwd',     defPwd: 'buh123',     gated: true },
  { role: 'management',     user: 'management_username',     defUser: 'management', pwd: 'management_pwd',     defPwd: 'board2026',  gated: true },
  { role: 'admin2',         user: 'admin2_username',         defUser: 'admin2',     pwd: 'admin2_pwd',         defPwd: 'lichny2026', gated: true },
];

// PROVIDERS in service-manager.html. Each signs in with its own id unless a name was set for
// it in provider_usernames, and with the pin from provider_pins (1234 until changed).
const PROVIDER_IDS = ['mosoblgaz', 'rosseti', 'energiya', 'aquavita', 'ruskhem', 'ekoregion', 'ruzoperator', 'asspb', 'algorithm'];

const CRED_FIELDS = ACCOUNTS.map(a => a.user).concat(ACCOUNTS.map(a => a.pwd))
  .concat(['provider_usernames', 'provider_pins', 'budget_released']);

// Brute force is a real prospect now that one public URL answers "is this the password?", and
// the passwords in use are short. Tries are counted per caller; the window is short enough
// that a person who mistyped theirs is not shut out for long.
const THROTTLE_DOC = 'appdata/_auth_throttle';
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;

const callerKey = req => {
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.headers['x-real-ip'] || 'unknown').trim();
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16); // hashed: no need to store anyone's address
};

const entriesOf = f => (f.entries && f.entries.mapValue && f.entries.mapValue.fields) || {};
const numOf = v => Number((v && (v.integerValue || v.stringValue)) || 0);

// Drops entries whose window has passed, so this document stays small on its own.
function prune(entries, now) {
  const out = {};
  Object.keys(entries).forEach(k => {
    const e = entries[k].mapValue && entries[k].mapValue.fields;
    if (e && numOf(e.until) > now) out[k] = entries[k];
  });
  return out;
}

async function isBlocked(key) {
  try {
    const d = await readDoc(THROTTLE_DOC, ['entries']);
    const e = entriesOf(d.fields)[key];
    const f = e && e.mapValue && e.mapValue.fields;
    return !!(f && numOf(f.fails) >= MAX_FAILS && numOf(f.until) > Date.now());
  } catch (err) { return false; } // the database being unreachable must not lock people out
}

async function countFailure(key) {
  const now = Date.now();
  try {
    await updateDoc(THROTTLE_DOC, ['entries'], f => {
      const entries = prune(clone(entriesOf(f)), now);
      const prev = entries[key] && entries[key].mapValue.fields;
      const fails = (prev && numOf(prev.until) > now ? numOf(prev.fails) : 0) + 1;
      entries[key] = { mapValue: { fields: { fails: fsInt(fails), until: fsInt(now + WINDOW_MS) } } };
      return { entries: { mapValue: { fields: entries } } };
    });
  } catch (err) { /* best effort */ }
}

async function clearFailures(key) {
  try {
    await updateDoc(THROTTLE_DOC, ['entries'], f => {
      const entries = prune(clone(entriesOf(f)), Date.now());
      if (!entries[key]) return null;
      delete entries[key];
      return { entries: { mapValue: { fields: entries } } };
    });
  } catch (err) { /* best effort */ }
}

const str = (f, k, dflt) => ((f[k] && f[k].stringValue) || '') || dflt;
// Compared without leaking, through timing, how much of a password was right.
function sameSecret(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Which account these credentials belong to, or null. Mirrors doLogin()'s order exactly.
function matchAccount(fields, username, password) {
  const released = !!(fields.budget_released && fields.budget_released.booleanValue);
  for (const a of ACCOUNTS) {
    if (a.gated && !released) continue;
    if (username !== str(fields, a.user, a.defUser).toLowerCase()) continue;
    if (sameSecret(password, str(fields, a.pwd, a.defPwd))) return { role: a.role };
  }
  const names = (fields.provider_usernames && fields.provider_usernames.mapValue && fields.provider_usernames.mapValue.fields) || {};
  const pins = (fields.provider_pins && fields.provider_pins.mapValue && fields.provider_pins.mapValue.fields) || {};
  for (const pid of PROVIDER_IDS) {
    if (username !== str(names, pid, pid).toLowerCase()) continue;
    if (sameSecret(password, str(pins, pid, '1234'))) return { role: 'provider', providerId: pid };
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!hasServiceAccount()) { res.status(503).json({ error: 'auth not configured' }); return; }

  const key = callerKey(req);
  try {
    if (await isBlocked(key)) {
      res.status(429).json({ error: 'Слишком много попыток входа — подождите 15 минут' });
      return;
    }
    const { username, password } = req.body || {};
    if (!username || typeof password !== 'string') { res.status(400).json({ error: 'username and password required' }); return; }

    const doc = await readDoc('appdata/state', CRED_FIELDS);
    const hit = matchAccount(doc.fields || {}, String(username).trim().toLowerCase(), password);
    if (!hit) {
      await countFailure(key);
      // Deliberately the same answer whether the name or the password was wrong, so this
      // can't be used to find out which accounts exist.
      res.status(401).json({ error: 'Неверный логин или пароль' });
      return;
    }
    await clearFailures(key);
    // uid is the role itself (a provider's is its own id), so a rule can name an account
    // directly as well as go by role.
    const uid = hit.providerId || hit.role;
    const claims = hit.providerId ? { role: 'provider', providerId: hit.providerId } : { role: hit.role };
    res.status(200).json({ token: mintCustomToken(uid, claims), role: hit.role, providerId: hit.providerId || null });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// Exposed for tests only.
module.exports.matchAccount = matchAccount;
module.exports.ACCOUNTS = ACCOUNTS;
module.exports.PROVIDER_IDS = PROVIDER_IDS;
