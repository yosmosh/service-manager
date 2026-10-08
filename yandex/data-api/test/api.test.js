// The data API end to end over an in-memory store: sign-in, tokens, the settings screen's
// account changes, the move of the passwords out of appdata/state, and who may read what.
//
//   node yandex/data-api/test/api.test.js
//
// Nothing here talks to Yandex: YDB is replaced by a Map with the same transaction contract,
// the file bucket by a stub. (Not part of the deployed function — see deploy/yandex-data-api.ps1.)

'use strict';

process.env.AUTH_SECRET = 'test-secret-' + Math.random();
process.env.SERVICE_KEY = 'svc-' + Math.random();

const assert = require('assert');
const core = require('../core');
const auth = require('../auth');
const { createApi } = require('../api');
const { createAccounts, verifyPassword } = require('../accounts');

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async read(path, names) {
      const d = docs.get(path);
      if (!d) return null;
      const fields = {};
      for (const n of Object.keys(d.fields)) if (!names || names.includes(n)) fields[n] = d.fields[n];
      return { meta: { createTime: d.createTime, updateTime: d.updateTime, qdate: d.qdate }, fields };
    },
    async transact(path, fn) {
      const d = docs.get(path);
      return fn({
        meta: async () => (d ? { createTime: d.createTime, updateTime: d.updateTime, qdate: d.qdate } : null),
        fields: async names => { const o = {}; if (d) for (const n of names) if (n in d.fields) o[n] = d.fields[n]; return o; },
        write: async ({ collection, upserts, deletes, createTime, updateTime, qdate }) => {
          const next = d && deletes !== null ? Object.assign({}, d.fields) : {};
          for (const n of deletes || []) delete next[n];
          Object.assign(next, upserts);
          docs.set(path, { collection, createTime, updateTime, qdate, fields: next });
        },
        remove: async () => { docs.delete(path); },
      });
    },
    async query() { return []; },
    async setup() {},
  };
}

let clockMs = Date.parse('2026-10-05T12:00:00Z');
const now = () => clockMs;

function setup() {
  const store = memoryStore();
  const accounts = createAccounts({ store, auth, now });
  const presigned = [];
  const files = { presignUpload: async o => { presigned.push(o); return { id: 'x', uploadUrl: 'u', headers: {}, url: 'p' }; }, remove: async () => {} };
  const images = {
    search: async (query, page, iamToken) => [{ url: 'https://shop.example/a.jpg', thumb: 'https://avatars.mds.yandex.net/i?id=a', sig: 'good', query, iamToken }],
    fetchImage: async ({ sig }) => (sig === 'good' ? { type: 'image/jpeg', data: 'AA==', from: 'original' } : sig === 'gone' ? null : { error: 'bad signature' }),
  };
  const api = createApi({ store, auth, files, accounts, images, now });
  const call = async (method, rest, { body, token, service, query, ip } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (service) headers['X-Service-Key'] = process.env.SERVICE_KEY;
    const res = await api.handle({ method, rest, query: query || {}, headers, body: body === undefined ? '' : JSON.stringify(body), ip: ip || '10.0.0.1', iamToken: 'fn-iam' });
    return { status: res.status, body: JSON.parse(res.body) };
  };
  const seedState = async fields => call('PATCH', 'v1/documents/appdata/state', { service: true, body: { fields } });
  return { store, call, seedState, presigned };
}

const S = v => ({ stringValue: v });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const LIVE_LIKE = {
  owner_username: S('Yosmosh'), owner_pwd: S('own-secret'),
  admin_pwd: S('adm-secret'),
  accountant_username: S('Buh'), accountant_pwd: S('buh-secret'),
  provider_usernames: { mapValue: { fields: { energiya: S('Energo') } } },
  provider_pins: { mapValue: { fields: { energiya: S('7777') } } },
  budget_released: { booleanValue: true },
  sos_items: { arrayValue: { values: [] } },
};

test('nobody signs in before the passwords are moved — not even with a default', async () => {
  const t = setup();
  await t.seedState(LIVE_LIKE);
  const r = await t.call('POST', 'v1/auth:login', { body: { username: 'admin', password: 'admin123' } });
  assert.strictEqual(r.status, 503);
});

test('the import hashes every account and leaves no credential in appdata/state', async () => {
  const t = setup();
  await t.seedState(LIVE_LIKE);
  const r = await t.call('POST', 'v1/admin:importCredentials', { service: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.roles, 8);
  assert.strictEqual(r.body.providers, 18);
  const state = t.store.docs.get('appdata/state').fields;
  for (const n of Object.keys(state)) assert.ok(!/_pwd$|_username$|^provider_pins$|^provider_usernames$/.test(n), 'left in state: ' + n);
  assert.ok(state.sos_items && state.budget_released, 'other fields kept');
  assert.ok(!t.store.docs.get('_auth/credentials').fields.roles.includes('own-secret'), 'no plain password stored');
});

test('the import needs the service key', async () => {
  const t = setup();
  await t.seedState(LIVE_LIKE);
  assert.strictEqual((await t.call('POST', 'v1/admin:importCredentials')).status, 403);
});

async function imported() {
  const t = setup();
  await t.seedState(LIVE_LIKE);
  await t.call('POST', 'v1/admin:importCredentials', { service: true });
  return t;
}
const login = (t, username, password, ip) => t.call('POST', 'v1/auth:login', { body: { username, password }, ip });

test('every account signs in with what it had on Firebase, and with nothing else', async () => {
  const t = await imported();
  const ok = [
    ['Yosmosh', 'own-secret', 'owner'], ['yosmosh', 'own-secret', 'owner'], ['  YOSMOSH ', 'own-secret', 'owner'],
    ['admin', 'adm-secret', 'admin'], ['kitchen', 'kitchen123', 'kitchen'], ['worker', 'worker123', 'kitchen_worker'],
    ['alexander', 'alex123', 'alexander'], ['buh', 'buh-secret', 'accountant'], ['management', 'board2026', 'management'],
    ['admin2', 'lichny2026', 'admin2'],
  ];
  for (const [u, p, role] of ok) {
    const r = await login(t, u, p);
    assert.strictEqual(r.status, 200, u + ' → ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.role, role);
    assert.strictEqual(r.body.providerId, null);
    assert.ok(/^u1\./.test(r.body.token));
  }
  const prov = await login(t, 'energo', '7777');
  assert.strictEqual(prov.status, 200);
  assert.deepStrictEqual([prov.body.role, prov.body.providerId], ['provider', 'energiya']);
  const prov2 = await login(t, 'rosseti', '1234');
  assert.deepStrictEqual([prov2.body.role, prov2.body.providerId], ['provider', 'rosseti']);
  for (const [u, p] of [['yosef', 'yosef123'], ['admin', 'admin123'], ['Yosmosh', 'own-secret '], ['energiya', '7777'], ['energo', '1234'], ['accountant', 'buh-secret']]) {
    const r = await login(t, u, p, '10.9.9.' + Math.floor(Math.random() * 200));
    assert.strictEqual(r.status, 401, u + '/' + p + ' should fail');
    assert.strictEqual(r.body.error, 'Неверный логин или пароль');
  }
});

test('the budget roles stay shut until the budget is published', async () => {
  const t = setup();
  await t.seedState(Object.assign({}, LIVE_LIKE, { budget_released: { booleanValue: false } }));
  await t.call('POST', 'v1/admin:importCredentials', { service: true });
  assert.strictEqual((await login(t, 'buh', 'buh-secret')).status, 401);
  assert.strictEqual((await login(t, 'admin', 'adm-secret')).status, 200);
  await t.call('PATCH', 'v1/documents/appdata/state', { service: true, query: { 'updateMask.fieldPaths': ['budget_released'] }, body: { fields: { budget_released: { booleanValue: true } } } });
  assert.strictEqual((await login(t, 'buh', 'buh-secret')).status, 200);
});

test('twenty wrong tries lock that caller out for 15 minutes; others are not affected', async () => {
  const t = await imported();
  for (let i = 0; i < 20; i++) assert.strictEqual((await login(t, 'admin', 'nope', '1.1.1.1')).status, 401);
  assert.strictEqual((await login(t, 'admin', 'adm-secret', '1.1.1.1')).status, 429, 'even the right password');
  assert.strictEqual((await login(t, 'admin', 'adm-secret', '2.2.2.2')).status, 200, 'another caller');
  clockMs += 16 * 60 * 1000;
  assert.strictEqual((await login(t, 'admin', 'adm-secret', '1.1.1.1')).status, 200, 'after the window');
  const th = t.store.docs.get('_auth/throttle').fields.entries;
  assert.ok(!th.includes('1.1.1.1'), 'addresses are stored hashed');
});

test('a token opens the app data; no token opens nothing but share pages', async () => {
  const t = await imported();
  const tok = (await login(t, 'kitchen', 'kitchen123')).body.token;
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: tok })).status, 200);
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state')).status, 401);
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: tok.slice(0, -2) + 'xx' })).status, 401);
  await t.call('PATCH', 'v1/documents/appdata/share_abc', { service: true, body: { fields: { html: S('<p>') } } });
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/share_abc')).status, 200);
});

test('the credentials can be read by nobody but the service', async () => {
  const t = await imported();
  const tok = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  for (const path of ['_auth/credentials', '_auth/throttle']) {
    assert.strictEqual((await t.call('GET', 'v1/documents/' + path, { token: tok })).status, 403, path);
    assert.strictEqual((await t.call('PATCH', 'v1/documents/' + path, { token: tok, body: { fields: {} } })).status, 403, path);
    assert.strictEqual((await t.call('GET', 'v1/documents/' + path)).status, 401, path);
  }
});

test('the settings screen gets names, never passwords — all for the owner, providers for an admin', async () => {
  const t = await imported();
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  const admin = (await login(t, 'admin', 'adm-secret')).body.token;
  const kitchen = (await login(t, 'kitchen', 'kitchen123')).body.token;
  const o = await t.call('GET', 'v1/auth:accounts', { token: owner });
  assert.strictEqual(o.status, 200);
  assert.strictEqual(o.body.roles.owner.user, 'Yosmosh');
  assert.strictEqual(o.body.roles.accountant.user, 'Buh');
  assert.strictEqual(o.body.providers.energiya.user, 'Energo');
  assert.ok(!/hash|secret|1234|7777/.test(JSON.stringify(o.body)), 'no secrets: ' + JSON.stringify(o.body));
  const a = await t.call('GET', 'v1/auth:accounts', { token: admin });
  assert.strictEqual(a.status, 200);
  assert.ok(!a.body.roles && a.body.providers.rosseti.user === 'rosseti');
  assert.strictEqual((await t.call('GET', 'v1/auth:accounts', { token: kitchen })).status, 403);
  assert.strictEqual((await t.call('GET', 'v1/auth:accounts')).status, 401);
});

test('changing a password: the new one works, the old one and its sessions stop', async () => {
  const t = await imported();
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  const buhOld = (await login(t, 'buh', 'buh-secret')).body.token;
  const kitchenTok = (await login(t, 'kitchen', 'kitchen123')).body.token;
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: buhOld })).status, 200);
  const r = await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'accountant', user: 'Buh', password: 'new-buh' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await login(t, 'buh', 'buh-secret')).status, 401);
  assert.strictEqual((await login(t, 'buh', 'new-buh')).status, 200);
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: buhOld })).status, 401, 'old session ended');
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: kitchenTok })).status, 200, 'others unaffected');
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: owner })).status, 200);
});

test('the owner changing their own password stays signed in, on the new token', async () => {
  const t = await imported();
  const old = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  const r = await t.call('POST', 'v1/auth:setAccount', { token: old, body: { kind: 'role', id: 'owner', user: 'Yosmosh', password: 'brand-new' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token && r.body.token !== old);
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: old })).status, 401);
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: r.body.token })).status, 200);
  const other = await t.call('POST', 'v1/auth:setAccount', { token: r.body.token, body: { kind: 'role', id: 'admin', user: 'admin', password: 'x1' } });
  assert.strictEqual(other.body.token, undefined, 'no token for someone else\'s account');
});

test('a new name alone keeps the password and the sessions', async () => {
  const t = await imported();
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  const kTok = (await login(t, 'kitchen', 'kitchen123')).body.token;
  const r = await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'kitchen', user: 'Kuhnya', password: '' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await login(t, 'kuhnya', 'kitchen123')).status, 200);
  assert.strictEqual((await login(t, 'kitchen', 'kitchen123')).status, 401);
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: kTok })).status, 200);
});

test('who may change what', async () => {
  const t = await imported();
  const admin = (await login(t, 'admin', 'adm-secret')).body.token;
  const kitchen = (await login(t, 'kitchen', 'kitchen123')).body.token;
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: admin, body: { kind: 'provider', id: 'rosseti', user: 'Ros', password: '5555' } })).status, 200);
  assert.strictEqual((await login(t, 'ros', '5555')).body.providerId, 'rosseti');
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: admin, body: { kind: 'role', id: 'owner', user: 'x', password: 'y' } })).status, 403);
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: kitchen, body: { kind: 'provider', id: 'rosseti', user: 'x', password: 'y' } })).status, 403);
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { body: { kind: 'provider', id: 'rosseti', user: 'x', password: 'y' } })).status, 401);
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'nobody', user: 'x' } })).status, 400);
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'admin', user: '  ' } })).status, 400);
  const dup = await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'admin', user: 'ENERGO' } });
  assert.strictEqual(dup.status, 409, 'a name another account uses');
  assert.strictEqual((await login(t, 'admin', 'adm-secret')).status, 200, 'unchanged after the refusal');
});

test('every provider of the app can sign in: the server knows the same list as the page', async () => {
  const fs = require('fs'), path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'service-manager.html'), 'utf8');
  const start = page.indexOf('const PROVIDERS = [');
  const block = page.slice(start, page.indexOf('\n];', start));
  const ids = [...block.matchAll(/\{\s*id:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 18, 'found ' + ids.length + ' providers in the page');
  assert.deepStrictEqual([...require('../accounts').PROVIDER_IDS].sort(), [...ids].sort());
});

test('a provider added to the app later is added on re-import; everyone else is kept', async () => {
  const t = await imported();
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'admin', user: 'admin', password: 'changed' } });
  // As after the move: the credentials hold only some providers; state brings the rest.
  const doc = t.store.docs.get('_auth/credentials');
  const prov = JSON.parse(doc.fields.providers);
  delete prov.mapValue.fields.evstratov;
  doc.fields.providers = JSON.stringify(prov);
  await t.seedState(Object.assign({}, LIVE_LIKE, {
    provider_usernames: { mapValue: { fields: { evstratov: S('Evstratov') } } },
    provider_pins: { mapValue: { fields: { evstratov: S('4321') } } },
  }));
  assert.strictEqual((await login(t, 'evstratov', '4321')).status, 401, 'missing before');
  const r = await t.call('POST', 'v1/admin:importCredentials', { service: true });
  assert.deepStrictEqual([r.status, r.body.kept, r.body.added], [200, true, 1]);
  const ev = await login(t, 'Evstratov', '4321');
  assert.deepStrictEqual([ev.status, ev.body.providerId], [200, 'evstratov']);
  assert.strictEqual((await login(t, 'admin', 'changed')).status, 200, 'changed password kept');
  assert.strictEqual((await login(t, 'admin', 'adm-secret')).status, 401);
  assert.ok(!('provider_pins' in t.store.docs.get('appdata/state').fields), 'state cleaned');
});

test('a re-import keeps passwords changed since, unless forced; state is cleaned either way', async () => {
  const t = await imported();
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'admin', user: 'admin', password: 'changed' } });
  await t.seedState(LIVE_LIKE); // a fresh copy from Firebase brings the old fields back
  const kept = await t.call('POST', 'v1/admin:importCredentials', { service: true });
  assert.strictEqual(kept.body.kept, true);
  assert.ok(!('admin_pwd' in t.store.docs.get('appdata/state').fields));
  assert.strictEqual((await login(t, 'admin', 'changed')).status, 200);
  await t.seedState(LIVE_LIKE);
  const forced = await t.call('POST', 'v1/admin:importCredentials', { service: true, body: { force: true } });
  assert.strictEqual(forced.status, 200);
  assert.ok(!('admin_pwd' in t.store.docs.get('appdata/state').fields));
  assert.strictEqual((await login(t, 'admin', 'adm-secret')).status, 200);
  assert.strictEqual((await login(t, 'admin', 'changed')).status, 401);
});

test('an upload keeps the file name for opening in the browser', async () => {
  const t = await imported();
  const tok = (await login(t, 'admin', 'adm-secret')).body.token;
  const r = await t.call('POST', 'v1/files:presign', { token: tok, body: { name: 'Счёт №5.pdf', type: 'application/pdf' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(t.presigned[0], { name: 'Счёт №5.pdf', type: 'application/pdf' });
  assert.strictEqual((await t.call('POST', 'v1/files:presign', { body: { name: 'a' } })).status, 401);
});

test('product photos: only the warehouse roles search and fetch', async () => {
  const t = await imported();
  const admin = (await login(t, 'admin', 'adm-secret')).body.token;
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  const kitchen = (await login(t, 'kitchen', 'kitchen123')).body.token;
  const s = await t.call('POST', 'v1/images:search', { token: admin, body: { query: 'Дрель' } });
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual([s.body.results[0].query, s.body.results[0].iamToken], ['Дрель', 'fn-iam'], 'searches as the function');
  assert.strictEqual((await t.call('POST', 'v1/images:search', { token: owner, body: { query: 'x' } })).status, 200);
  assert.strictEqual((await t.call('POST', 'v1/images:search', { token: kitchen, body: { query: 'x' } })).status, 403);
  assert.strictEqual((await t.call('POST', 'v1/images:search', { body: { query: 'x' } })).status, 401);
  const f = await t.call('POST', 'v1/images:fetch', { token: admin, body: { url: 'u', thumb: 't', sig: 'good' } });
  assert.deepStrictEqual([f.status, f.body.type, f.body.data], [200, 'image/jpeg', 'AA==']);
  assert.strictEqual((await t.call('POST', 'v1/images:fetch', { token: admin, body: { url: 'u', thumb: 't', sig: 'forged' } })).status, 400);
  const gone = await t.call('POST', 'v1/images:fetch', { token: admin, body: { url: 'u', thumb: 't', sig: 'gone' } });
  assert.deepStrictEqual([gone.status, gone.body.error], [422, 'Это фото не удалось загрузить — выберите другое']);
});

test('the warehouse keepers: no way in until the owner sets a password, then only with it', async () => {
  const t = await imported();
  // Not created by the import — there was nothing of theirs on Firebase, and no default.
  assert.ok(!t.store.docs.get('_auth/credentials').fields.roles.includes('storekeeper'));
  for (const [u, p] of [['sklad', ''], ['sklad', 'null'], ['sklad', 'undefined'], ['sklad', '1234'], ['klining', 'null'], ['klining', '']]) {
    assert.strictEqual((await login(t, u, p)).status, 401, u + '/' + p);
  }
  const owner = (await login(t, 'Yosmosh', 'own-secret')).body.token;
  const list = await t.call('GET', 'v1/auth:accounts', { token: owner });
  assert.deepStrictEqual([list.body.roles.storekeeper, list.body.roles.cleaning_head, list.body.roles.admin], [{ user: 'sklad', unset: true }, { user: 'klining', unset: true }, { user: 'admin' }]);
  // A name alone is not enough for an account that has no password yet.
  const noPwd = await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'storekeeper', user: 'sklad' } });
  assert.strictEqual(noPwd.status, 400);
  assert.strictEqual((await login(t, 'sklad', 'null')).status, 401);
  const set = await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'storekeeper', user: 'Sklad', password: 'skl-pass-1' } });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  const r = await login(t, 'sklad', 'skl-pass-1');
  assert.deepStrictEqual([r.status, r.body.role], [200, 'storekeeper']);
  assert.strictEqual((await login(t, 'sklad', 'wrong')).status, 401);
  assert.strictEqual((await login(t, 'klining', 'skl-pass-1')).status, 401, 'the other keeper still has no way in');
  // Once set, renaming without a new password keeps the password.
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id: 'storekeeper', user: 'sklad2' } })).status, 200);
  assert.strictEqual((await login(t, 'sklad2', 'skl-pass-1')).status, 200);
  const list2 = await t.call('GET', 'v1/auth:accounts', { token: owner });
  assert.deepStrictEqual(list2.body.roles.storekeeper, { user: 'sklad2' });
  // The keeper reads the app's data and may use the photo search; the settings stay the owner's.
  const tok = (await login(t, 'sklad2', 'skl-pass-1')).body.token;
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/state', { token: tok })).status, 200);
  assert.strictEqual((await t.call('GET', 'v1/auth:accounts', { token: tok })).status, 403);
  assert.strictEqual((await t.call('POST', 'v1/auth:setAccount', { token: tok, body: { kind: 'role', id: 'storekeeper', user: 'x', password: 'y' } })).status, 403);
  assert.strictEqual((await t.call('POST', 'v1/images:search', { token: tok, body: { query: 'дрель' } })).status, 200);
});

test('hashes: salted, and checked exactly', async () => {
  const { hashPassword } = require('../accounts');
  const a = await hashPassword('same'), b = await hashPassword('same');
  assert.notStrictEqual(a, b);
  assert.ok(await verifyPassword('same', a));
  assert.ok(!(await verifyPassword('Same', a)));
  assert.ok(!(await verifyPassword('same', 'garbage')));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
