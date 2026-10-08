// Who may sign in, checked here rather than in the browser.
//
// On Firebase the page downloaded every account's name and password with the rest of the
// shared document and compared what was typed against them itself — so anyone who opened the
// page could read them all. Here they live in a document of their own (_auth/credentials)
// that only this service reads, and only as scrypt hashes: not even the owner's settings
// screen gets a password back, only the names. Sign-in answers with a token (auth.js) that
// every later request carries.
//
//   _auth/credentials   roles:     { owner: { user, hash, gen }, admin: {…}, … }
//                       providers: { mosoblgaz: { user, hash, gen }, … }
//   _auth/throttle      entries:   { <hashed caller>: { fails, until } }
//
// `gen` counts password changes. A token names the gen it was issued under, so changing a
// password signs out every session that used the old one (within the minute genOf caches).

'use strict';

const crypto = require('crypto');
const core = require('./core');

// Exactly the accounts the app's doLogin() accepts, in the same order and with the same
// defaults. `gated` marks the four that exist only once the owner has published the budget
// (budget_released in appdata/state).
const ACCOUNTS = [
  { role: 'owner',          user: 'owner_username',          defUser: 'yosef',      pwd: 'owner_pwd',          defPwd: 'yosef123' },
  { role: 'admin',          user: 'admin_username',          defUser: 'admin',      pwd: 'admin_pwd',          defPwd: 'admin123' },
  { role: 'kitchen',        user: 'kitchen_username',        defUser: 'kitchen',    pwd: 'kitchen_pwd',        defPwd: 'kitchen123' },
  { role: 'kitchen_worker', user: 'kitchen_worker_username', defUser: 'worker',     pwd: 'kitchen_worker_pwd', defPwd: 'worker123' },
  { role: 'alexander',      user: 'alexander_username',      defUser: 'alexander',  pwd: 'alexander_pwd',      defPwd: 'alex123',    gated: true },
  { role: 'accountant',     user: 'accountant_username',     defUser: 'accountant', pwd: 'accountant_pwd',     defPwd: 'buh123',     gated: true },
  { role: 'management',     user: 'management_username',     defUser: 'management', pwd: 'management_pwd',     defPwd: 'board2026',  gated: true },
  { role: 'admin2',         user: 'admin2_username',         defUser: 'admin2',     pwd: 'admin2_pwd',         defPwd: 'lichny2026', gated: true },
  // The warehouse's two keepers — tools and equipment, and cleaning supplies. Made after the
  // move, so they have NO default password: such an account signs in only once the owner has
  // set one (a default written in this file would open it to anyone who read the code).
  { role: 'storekeeper',    user: 'storekeeper_username',    defUser: 'sklad',      pwd: 'storekeeper_pwd',    defPwd: null },
  { role: 'cleaning_head',  user: 'cleaning_head_username',  defUser: 'klining',    pwd: 'cleaning_head_pwd',  defPwd: null },
];
// PROVIDERS in the app. Each signs in with its own id unless a name was set for it, and with
// the pin 1234 until one was set.
// Must list every id of PROVIDERS in service-manager.html — a provider missing here cannot sign
// in at all (on 2026-10-06 the last nine added to the app were missing, and were told their
// password was wrong). test/api.test.js compares the two lists.
const PROVIDER_IDS = ['mosoblgaz', 'rosseti', 'energiya', 'aquavita', 'ruskhem', 'ekoregion', 'ruzoperator', 'asspb', 'algorithm',
  'vdpo', 'cigie', 'istranet', 'remkhold', 'leshtaev', 'byrdin', 'security', 'oscar', 'evstratov'];
const PROVIDER_DEFAULT_PIN = '1234';

// Where the credentials sat in appdata/state on Firebase. importFromState() moves them out.
const STATE_CRED_FIELDS = ACCOUNTS.map(a => a.user).concat(ACCOUNTS.map(a => a.pwd), ['provider_usernames', 'provider_pins']);

const CRED_PATH = '_auth/credentials';
const THROTTLE_PATH = '_auth/throttle';
// Counted per address, and a whole office shares one: generous enough that a morning of everyone
// signing in again (and mistyping) does not shut the office out, still far from a brute force.
const MAX_FAILS = 20;
const WINDOW_MS = 15 * 60 * 1000;
const TOKEN_DAYS = 30;

// ---- hashing ----

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scrypt = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 },
    (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return ['s1', salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  const m = /^s1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const want = Buffer.from(m[2], 'base64url');
  const got = await scrypt(password, Buffer.from(m[1], 'base64url'));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A default password is compared as text — without leaking, through timing, how much was right.
function samePlain(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---- Firestore-shaped values ----

const sv = v => ({ stringValue: String(v) });
const iv = v => ({ integerValue: String(Math.trunc(Number(v) || 0)) });
const str = v => (v && typeof v.stringValue === 'string' ? v.stringValue : '');
const num = v => Number((v && (v.integerValue != null ? v.integerValue : v.doubleValue)) || 0);
const mapFields = v => (v && v.mapValue && v.mapValue.fields) || {};

// { roles: { id: { user, hash, gen } }, providers: { … } } from the stored fields.
function entriesOf(fields) {
  const out = { roles: {}, providers: {} };
  for (const kind of ['roles', 'providers']) {
    const m = mapFields(fields[kind]);
    for (const id of Object.keys(m)) {
      const f = mapFields(m[id]);
      out[kind][id] = { user: str(f.user), hash: str(f.hash), gen: num(f.gen) };
    }
  }
  return out;
}
const entryValue = e => ({ mapValue: { fields: { user: sv(e.user), hash: sv(e.hash), gen: iv(e.gen) } } });
const kindValue = entries => {
  const fields = {};
  for (const id of Object.keys(entries)) fields[id] = entryValue(entries[id]);
  return { mapValue: { fields } };
};

const parseFields = texts => {
  const o = {};
  for (const n of Object.keys(texts || {})) o[n] = JSON.parse(texts[n]);
  return o;
};
const toTexts = fields => {
  const o = {};
  for (const n of Object.keys(fields)) o[n] = JSON.stringify(fields[n]);
  return o;
};

function createAccounts({ store, auth, now }) {
  const clock = now || (() => Date.now());

  // Writes the named top-level fields of one document, keeping the rest — the same thing a
  // masked PATCH does, without going through the HTTP layer.
  async function writeFields(path, fields, removeNames) {
    const p = core.parseDocPath(path);
    await store.transact(path, async tx => {
      const meta = await tx.meta();
      const updateTime = core.nextTime(meta && meta.updateTime, clock());
      await tx.write({
        collection: p.collection, upserts: toTexts(fields), deletes: removeNames || [],
        createTime: meta ? meta.createTime : updateTime, updateTime, qdate: meta ? meta.qdate || null : null,
      });
    });
  }

  async function readCredentials() {
    const doc = await store.read(CRED_PATH, ['roles', 'providers']);
    return doc ? entriesOf(parseFields(doc.fields)) : null;
  }

  async function budgetReleased() {
    const doc = await store.read('appdata/state', ['budget_released']);
    const v = doc && doc.fields.budget_released ? JSON.parse(doc.fields.budget_released) : null;
    return !!(v && v.booleanValue);
  }

  // ---- throttle: tries are counted per caller (hashed — nobody's address is stored) ----

  const callerKey = ip => crypto.createHash('sha256').update(String(ip || 'unknown')).digest('base64url').slice(0, 16);

  async function throttleEntries() {
    const doc = await store.read(THROTTLE_PATH, ['entries']);
    return doc ? mapFields(parseFields(doc.fields).entries) : {};
  }

  async function isBlocked(key) {
    try {
      const e = mapFields((await throttleEntries())[key]);
      return num(e.fails) >= MAX_FAILS && num(e.until) > clock();
    } catch (err) { return false; } // the store being unreachable must not lock people out
  }

  async function recordAttempt(key, failed) {
    try {
      await store.transact(THROTTLE_PATH, async tx => {
        const meta = await tx.meta();
        const cur = mapFields(parseFields(await tx.fields(['entries'])).entries);
        const t = clock();
        const next = {};
        // Expired entries go, so the document stays small on its own.
        for (const k of Object.keys(cur)) if (num(mapFields(cur[k]).until) > t) next[k] = cur[k];
        if (failed) {
          const prev = mapFields(next[key]);
          next[key] = { mapValue: { fields: { fails: iv(num(prev.fails) + 1), until: iv(t + WINDOW_MS) } } };
        } else {
          if (!next[key]) return;
          delete next[key];
        }
        const updateTime = core.nextTime(meta && meta.updateTime, t);
        await tx.write({
          collection: '_auth', upserts: { entries: JSON.stringify({ mapValue: { fields: next } }) }, deletes: [],
          createTime: meta ? meta.createTime : updateTime, updateTime, qdate: null,
        });
      });
    } catch (err) { /* best effort */ }
  }

  // ---- sign-in ----

  // Which account these credentials are, in doLogin()'s order, or null.
  async function match(creds, released, username, password) {
    for (const a of ACCOUNTS) {
      if (a.gated && !released) continue;
      const e = creds.roles[a.role];
      if (!e && !a.defPwd) continue; // no password set yet: no way in
      if (username !== (e ? e.user : a.defUser).toLowerCase()) continue;
      if (e ? await verifyPassword(password, e.hash) : samePlain(password, a.defPwd)) return { role: a.role, sub: a.role, gen: e ? e.gen : 0 };
    }
    for (const pid of PROVIDER_IDS) {
      const e = creds.providers[pid];
      if (username !== (e ? e.user : pid).toLowerCase()) continue;
      if (e ? await verifyPassword(password, e.hash) : samePlain(password, PROVIDER_DEFAULT_PIN)) return { role: 'provider', sub: pid, gen: e ? e.gen : 0 };
    }
    return null;
  }

  // → { status, body }
  async function login({ username, password, ip }) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim()) {
      return { status: 400, body: { error: 'Введите имя пользователя и пароль' } };
    }
    const key = callerKey(ip);
    if (await isBlocked(key)) return { status: 429, body: { error: 'Слишком много попыток входа — подождите 15 минут' } };
    const creds = await readCredentials();
    // Until the credentials have been moved here nobody signs in — not even with a default
    // password, which would otherwise open every account to anyone who knows the defaults.
    if (!creds) return { status: 503, body: { error: 'Вход ещё не настроен' } };
    const hit = await match(creds, await budgetReleased(), username.trim().toLowerCase(), password);
    if (!hit) {
      await recordAttempt(key, true);
      // The same answer whether the name or the password was wrong.
      return { status: 401, body: { error: 'Неверный логин или пароль' } };
    }
    await recordAttempt(key, false);
    const iat = Math.floor(clock() / 1000);
    const exp = iat + TOKEN_DAYS * 86400;
    const token = auth.sign({ r: hit.role, s: hit.sub, g: hit.gen, iat, exp });
    return { status: 200, body: { token, role: hit.role, providerId: hit.role === 'provider' ? hit.sub : null, exp } };
  }

  // The gen a token's subject is at now, cached for a minute per instance: one read of the
  // credentials a minute, not one per request.
  let genCache = { at: -Infinity, gens: null };
  async function gens() {
    if (!genCache.gens || clock() - genCache.at > 60000) {
      const creds = await readCredentials();
      const gens = {};
      if (creds) {
        for (const id of Object.keys(creds.roles)) gens[id] = creds.roles[id].gen;
        for (const id of Object.keys(creds.providers)) gens['p:' + id] = creds.providers[id].gen;
      }
      genCache = { at: clock(), gens };
    }
    return genCache.gens;
  }
  async function tokenCurrent(payload) {
    const k = payload.r === 'provider' ? 'p:' + payload.s : payload.s;
    return ((await gens())[k] || 0) === (Number(payload.g) || 0);
  }

  // ---- the settings screen ----

  // Names only, never a password. The owner sees every account; an admin the providers'.
  async function list(role) {
    if (role !== 'owner' && role !== 'admin') return { status: 403, body: { error: 'Нет доступа' } };
    const creds = (await readCredentials()) || { roles: {}, providers: {} };
    const out = { providers: {} };
    PROVIDER_IDS.forEach(pid => { out.providers[pid] = { user: creds.providers[pid] ? creds.providers[pid].user : pid }; });
    if (role === 'owner') {
      out.roles = {};
      // `unset`: an account with no password yet, which can't be signed in to until one is set.
      ACCOUNTS.forEach(a => { out.roles[a.role] = creds.roles[a.role] ? { user: creds.roles[a.role].user } : (a.defPwd ? { user: a.defUser } : { user: a.defUser, unset: true }); });
    }
    return { status: 200, body: out };
  }

  // { kind: 'role'|'provider', id, user, password? } — an empty password keeps the old one.
  async function setAccount(role, b) {
    b = b || {};
    const kind = b.kind === 'provider' ? 'providers' : b.kind === 'role' ? 'roles' : null;
    const id = String(b.id || '');
    const account = kind === 'roles' ? ACCOUNTS.find(a => a.role === id) : null;
    if (!kind || (kind === 'roles' ? !account : !PROVIDER_IDS.includes(id))) return { status: 400, body: { error: 'Нет такой учётной записи' } };
    if (role !== 'owner' && !(role === 'admin' && kind === 'providers')) return { status: 403, body: { error: 'Нет доступа' } };
    const user = String(b.user == null ? '' : b.user).trim();
    const password = b.password == null ? '' : String(b.password).trim();
    if (!user) return { status: 400, body: { error: 'Введите имя пользователя' } };
    if (user.length > 64 || password.length > 128) return { status: 400, body: { error: 'Слишком длинное значение' } };

    const creds = await readCredentials();
    if (!creds) return { status: 503, body: { error: 'Вход ещё не настроен' } };
    // Two accounts under one name would make sign-in pick whichever comes first.
    const lower = user.toLowerCase();
    const taken = ACCOUNTS.some(a => !(kind === 'roles' && a.role === id) && (creds.roles[a.role] ? creds.roles[a.role].user : a.defUser).toLowerCase() === lower)
      || PROVIDER_IDS.some(pid => !(kind === 'providers' && pid === id) && (creds.providers[pid] ? creds.providers[pid].user : pid).toLowerCase() === lower);
    if (taken) return { status: 409, body: { error: 'Это имя пользователя уже занято другой учётной записью' } };

    const cur = creds[kind][id];
    const defPwd = kind === 'roles' ? account.defPwd : PROVIDER_DEFAULT_PIN;
    if (!password && !cur && !defPwd) return { status: 400, body: { error: 'Задайте пароль — без него в эту учётную запись не войти' } };
    const next = {
      user,
      hash: password ? await hashPassword(password) : (cur ? cur.hash : await hashPassword(defPwd)),
      gen: (cur ? cur.gen : 0) + (password ? 1 : 0),
    };
    // Written per account (roles.<id>), so two changes at once don't overwrite each other.
    await store.transact(CRED_PATH, async tx => {
      const meta = await tx.meta();
      const fields = parseFields(await tx.fields([kind]));
      const m = mapFields(fields[kind]);
      m[id] = entryValue(next);
      const updateTime = core.nextTime(meta && meta.updateTime, clock());
      await tx.write({
        collection: '_auth', upserts: { [kind]: JSON.stringify({ mapValue: { fields: m } }) }, deletes: [],
        createTime: meta ? meta.createTime : updateTime, updateTime, qdate: null,
      });
    });
    genCache.gens = null;
    const body = { ok: true, user };
    // Changing one's own password ends one's own session too — unless it is replaced here.
    if (kind === 'roles' && id === role && password) {
      const iat = Math.floor(clock() / 1000);
      body.token = auth.sign({ r: role, s: role, g: next.gen, iat, exp: iat + TOKEN_DAYS * 86400 });
    }
    return { status: 200, body };
  }

  // ---- the move from Firebase ----

  // Hashes the credentials the copied appdata/state carries into _auth/credentials and removes
  // them from it. Run by the move, after each copy of the data (service only). The passwords
  // never leave this service: they are read, hashed and dropped here. Credentials already
  // here are kept unless `force` — the final copy before the switch forces, so that what
  // counts is what was in use on Firebase up to that moment; without it only accounts not here
  // yet are added (a provider added to the app since). Either way, none stay behind in
  // appdata/state, where every signed-in user can read it.
  async function importFromState({ force } = {}) {
    const doc = await store.read('appdata/state', STATE_CRED_FIELDS);
    const f = doc ? parseFields(doc.fields) : {};
    const present = STATE_CRED_FIELDS.filter(n => f[n] !== undefined);
    const existing = force ? null : await readCredentials();
    const roles = {}, providers = {};
    let added = 0;
    for (const a of ACCOUNTS) {
      if (existing && existing.roles[a.role]) { roles[a.role] = existing.roles[a.role]; continue; }
      if (!str(f[a.pwd]) && !a.defPwd) continue; // nothing to import, and no default to fall back on
      roles[a.role] = { user: str(f[a.user]) || a.defUser, hash: await hashPassword(str(f[a.pwd]) || a.defPwd), gen: 0 };
      added++;
    }
    const names = mapFields(f.provider_usernames), pins = mapFields(f.provider_pins);
    for (const pid of PROVIDER_IDS) {
      if (existing && existing.providers[pid]) { providers[pid] = existing.providers[pid]; continue; }
      providers[pid] = { user: str(names[pid]) || pid, hash: await hashPassword(str(pins[pid]) || PROVIDER_DEFAULT_PIN), gen: 0 };
      added++;
    }
    if (!existing || added) await writeFields(CRED_PATH, { roles: kindValue(roles), providers: kindValue(providers) });
    if (present.length) await writeFields('appdata/state', {}, present);
    genCache.gens = null;
    return { status: 200, body: existing
      ? { ok: true, kept: true, added, removedFromState: present.length }
      : { ok: true, roles: Object.keys(roles).length, providers: Object.keys(providers).length, removedFromState: present.length } };
  }

  return { login, list, setAccount, importFromState, tokenCurrent, callerKey };
}

module.exports = { createAccounts, hashPassword, verifyPassword, ACCOUNTS, PROVIDER_IDS, STATE_CRED_FIELDS };
