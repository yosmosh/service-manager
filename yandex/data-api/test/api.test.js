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

test('passport details: the owner and the administrators alone, never the others signed in', async () => {
  const t = await imported();
  const tok = async (u, p) => (await login(t, u, p)).body.token;
  const people = { fields: { people: { mapValue: { fields: { p1: { mapValue: { fields: { name: S('Шахинян Агавни Юриковна'), number: S('0272552') } } } } } } } };
  const owner = await tok('Yosmosh', 'own-secret');
  assert.strictEqual((await t.call('PATCH', 'v1/documents/private/people', { token: owner, body: people })).status, 200);
  for (const [u, p] of [['Yosmosh', 'own-secret'], ['admin', 'adm-secret'], ['admin2', 'lichny2026']]) {
    const k = await tok(u, p);
    const r = await t.call('GET', 'v1/documents/private/people', { token: k });
    assert.strictEqual(r.status, 200, u);
    assert.ok(JSON.stringify(r.body).includes('0272552'), u);
    assert.strictEqual((await t.call('PATCH', 'v1/documents/private/people', { token: k, query: { 'updateMask.fieldPaths': ['people.p2'] }, body: { fields: { people: { mapValue: { fields: { p2: { mapValue: { fields: {} } } } } } } } })).status, 200, u + ' writes');
  }
  const query = { structuredQuery: { from: [{ collectionId: 'private' }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2000' } } } } };
  for (const [u, p] of [['kitchen', 'kitchen123'], ['worker', 'worker123'], ['alexander', 'alex123'], ['buh', 'buh-secret'], ['management', 'board2026'], ['energo', '7777']]) {
    const k = await tok(u, p);
    assert.strictEqual((await t.call('GET', 'v1/documents/private/people', { token: k })).status, 403, u + ' reads');
    assert.strictEqual((await t.call('PATCH', 'v1/documents/private/people', { token: k, body: people })).status, 403, u + ' writes');
    assert.strictEqual((await t.call('DELETE', 'v1/documents/private/people', { token: k })).status, 403, u + ' deletes');
    assert.strictEqual((await t.call('POST', 'v1/documents:runQuery', { token: k, body: query })).status, 403, u + ' queries');
  }
  assert.strictEqual((await t.call('GET', 'v1/documents/private/people')).status, 401, 'nobody signed in');
  assert.ok(t.store.docs.has('private/people'), 'still there');
});

// Личный бюджет and its payouts: a cash record (c1, its receipt f1), a bank one (b1, f2), a payout
// (s1, f3); ТО (m1, f4) — and the registry of the four documents.
const M_ = fields => ({ mapValue: { fields } });
const A_ = values => ({ arrayValue: { values } });
const rec = (id, fund, file, extra) => M_(Object.assign({ id: S(id), fund: S(fund), amount: { integerValue: '100' }, fileRefs: A_([M_({ id: S(file) })]) }, extra || {}));
async function budgets() {
  const t = await imported();
  await t.call('PATCH', 'v1/documents/appdata/finance_ledger', { service: true, body: { fields: {
    finance_tx_personal: A_([rec('c1', 'Наличные', 'f1'), rec('b1', 'РООИ-ММЕО', 'f2')]),
    finance_settlements: A_([M_({ id: S('s1'), fileIds: A_([S('f3')]) })]),
    finance_tx_maintenance: A_([rec('m1', '', 'f4')]),
  } } });
  await t.call('PATCH', 'v1/documents/appdata/files_registry', { service: true, body: { fields: { files: M_({ f1: M_({ url: S('u1') }), f2: M_({ url: S('u2') }), f3: M_({ url: S('u3') }), f4: M_({ url: S('u4') }) }) } } });
  const tok = async (u, p) => (await login(t, u, p)).body.token;
  const T = { owner: await tok('Yosmosh', 'own-secret'), admin: await tok('admin', 'adm-secret'), admin2: await tok('admin2', 'lichny2026'), buh: await tok('buh', 'buh-secret'),
    kitchen: await tok('kitchen', 'kitchen123'), worker: await tok('worker', 'worker123'), alexander: await tok('alexander', 'alex123'), management: await tok('management', 'board2026'), provider: await tok('energo', '7777') };
  const read = async (token, path, query) => { const r = await t.call('GET', 'v1/documents/' + path, { token, query }); return r.status === 200 ? r.body.fields || {} : r.status; };
  const ids = v => (v && v.arrayValue ? (v.arrayValue.values || []).map(e => e.mapValue.fields.id.stringValue) : v);
  const stored = name => ids(JSON.parse(t.store.docs.get('appdata/finance_ledger').fields[name]));
  return { t, T, read, ids, stored };
}

test('Личный бюджет: all of it for the owner and the administrators, its bank records for the accountant, nothing for anyone else', async () => {
  const { T, read, ids } = await budgets();
  for (const who of ['owner', 'admin', 'admin2']) {
    const l = await read(T[who], 'appdata/finance_ledger'), f = await read(T[who], 'appdata/files_registry');
    assert.deepStrictEqual([ids(l.finance_tx_personal), ids(l.finance_settlements), ids(l.finance_tx_maintenance)], [['c1', 'b1'], ['s1'], ['m1']], who);
    assert.deepStrictEqual(Object.keys(f.files.mapValue.fields).sort(), ['f1', 'f2', 'f3', 'f4'], who);
  }
  const b = await read(T.buh, 'appdata/finance_ledger'), bf = await read(T.buh, 'appdata/files_registry');
  assert.deepStrictEqual([ids(b.finance_tx_personal), b.finance_settlements, ids(b.finance_tx_maintenance)], [['b1'], undefined, ['m1']], 'the accountant');
  assert.deepStrictEqual(Object.keys(bf.files.mapValue.fields).sort(), ['f2', 'f4'], 'the accountant: no cash receipt, no payout');
  const pl = await read(T.provider, 'appdata/finance_ledger'), pf = await read(T.provider, 'appdata/files_registry');
  assert.deepStrictEqual([pl, Object.keys(pf.files.mapValue.fields)], [{}, []], 'a provider: none of the budgets, none of their documents');
  for (const who of ['kitchen', 'worker']) {
    const l = await read(T[who], 'appdata/finance_ledger'), f = await read(T[who], 'appdata/files_registry');
    assert.deepStrictEqual([l, Object.keys(f.files.mapValue.fields)], [{}, []], who + ': the kitchen budget is in the state; none of the ledger, none of its documents');
  }
  for (const who of ['alexander', 'management']) {
    const l = await read(T[who], 'appdata/finance_ledger'), f = await read(T[who], 'appdata/files_registry');
    assert.deepStrictEqual([l.finance_tx_personal, l.finance_settlements, ids(l.finance_tx_maintenance)], [undefined, undefined, ['m1']], who);
    assert.deepStrictEqual(Object.keys(f.files.mapValue.fields), ['f4'], who + ': only the documents of what it is given');
    assert.deepStrictEqual(await read(T[who], 'appdata/finance_ledger', { 'mask.fieldPaths': ['finance_tx_personal'] }), {}, who + ' asking for that field alone');
    assert.deepStrictEqual(await read(T[who], 'appdata/files_registry', { 'mask.fieldPaths': ['files.f1'] }), {}, who + ' asking for one document');
  }
});

test('Личный бюджет: writes within the part each one is given', async () => {
  const { t, T, stored } = await budgets();
  const W = (token, fields, mask) => t.call('PATCH', 'v1/documents/appdata/finance_ledger', { token, query: mask ? { 'updateMask.fieldPaths': mask } : {}, body: { fields } });
  assert.strictEqual((await W(T.provider, { finance_tx_maintenance: A_([]) }, ['finance_tx_maintenance'])).status, 403, 'a provider: not even ТО');
  for (const who of ['kitchen', 'alexander', 'management', 'provider']) {
    assert.strictEqual((await W(T[who], { finance_tx_personal: A_([]) }, ['finance_tx_personal'])).status, 403, who + ' Личный бюджет');
    assert.strictEqual((await W(T[who], { finance_settlements: A_([]) }, ['finance_settlements'])).status, 403, who + ' payouts');
    assert.strictEqual((await W(T[who], { finance_tx_maintenance: A_([rec('m1', '', 'f4')]) })).status, 403, who + ' the whole document');
    assert.strictEqual((await t.call('DELETE', 'v1/documents/appdata/finance_ledger', { token: T[who] })).status, 403, who + ' deleting it');
  }
  assert.strictEqual((await W(T.alexander, { finance_tx_maintenance: A_([rec('m1', '', 'f4', { status: S('approved') })]) }, ['finance_tx_maintenance'])).status, 200, 'ТО as before');
  assert.deepStrictEqual([stored('finance_tx_personal'), stored('finance_settlements')], [['c1', 'b1'], ['s1']], 'untouched');
  // The accountant marks the bank record paid: the cash one stays as it is, where it is.
  const r = await W(T.buh, { finance_tx_personal: A_([rec('b1', 'РООИ-ММЕО', 'f2', { paid: { booleanValue: true } }), rec('n1', 'РООИ-ММЕО', 'f9')]) }, ['finance_tx_personal']);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(stored('finance_tx_personal'), ['c1', 'b1', 'n1']);
  const now = JSON.parse(t.store.docs.get('appdata/finance_ledger').fields.finance_tx_personal).arrayValue.values;
  assert.deepStrictEqual([now[0].mapValue.fields.paid, now[1].mapValue.fields.paid], [undefined, { booleanValue: true }], 'hers written, the cash one not');
  for (const [what, list] of [['a cash record changed', [rec('c1', 'Наличные', 'f1', { paid: { booleanValue: true } })]], ['a new cash record', [rec('x1', 'Наличные', 'f8')]],
    ['a cash record passed off as bank', [rec('c1', 'РООИ-ММЕО', 'f1')]], ['a bank record made cash', [rec('b1', 'Наличные', 'f2')]]]) {
    assert.strictEqual((await W(T.buh, { finance_tx_personal: A_(list) }, ['finance_tx_personal'])).status, 403, 'the accountant: ' + what);
  }
  assert.strictEqual((await W(T.buh, { finance_settlements: A_([]) }, ['finance_settlements'])).status, 403, 'the accountant: payouts');
  assert.deepStrictEqual(stored('finance_tx_personal'), ['c1', 'b1', 'n1'], 'nothing changed by the refused ones');
  assert.strictEqual((await W(T.admin, { finance_settlements: A_([]) }, ['finance_settlements'])).status, 200, 'an administrator: as before');
});

test('the files registry: nobody writes the documents of records they are not given', async () => {
  const { t, T } = await budgets();
  const W = (token, id) => t.call('PATCH', 'v1/documents/appdata/files_registry', { token, query: { 'updateMask.fieldPaths': ['files.' + id] }, body: { fields: { files: M_({ [id]: M_({ url: S('x') }) }) } } });
  assert.deepStrictEqual([(await W(T.buh, 'f1')).status, (await W(T.buh, 'f3')).status, (await W(T.buh, 'f2')).status, (await W(T.buh, 'f7')).status], [403, 403, 200, 200], 'the accountant');
  assert.deepStrictEqual([(await W(T.kitchen, 'f2')).status, (await W(T.kitchen, 'f4')).status, (await W(T.kitchen, 'k1')).status], [403, 403, 200], 'the kitchen');
  assert.strictEqual((await W(T.alexander, 'f4')).status, 200, 'Alexander: a document of ТО');
  assert.strictEqual((await t.call('PATCH', 'v1/documents/appdata/files_registry', { token: T.kitchen, query: { 'updateMask.fieldPaths': ['files'] }, body: { fields: { files: M_({}) } } })).status, 403, 'the whole registry');
  assert.strictEqual((await W(T.owner, 'f1')).status, 200, 'the owner');
});

// Two providers' months, their requests, the journal, the settings, and the documents of each.
async function providers() {
  const t = await imported();
  const visit = file => M_({ visits: A_([M_({ completed: { booleanValue: true }, fileIds: A_([S(file)]) })]) });
  const req = (id, pid, status, file) => M_({ id: S(id), providerId: S(pid), status: S(status), title: S('Заявка ' + id), fileIds: A_([S(file)]) });
  await t.seedState({
    svc_records: M_({ energiya_2026_9: visit('fe9'), energiya_2026_10: visit('fe10'), rosseti_2026_9: visit('fr9'), energiya2_2026_9: visit('fx') }),
    purchase_requests: A_([req('q1', 'energiya', 'pending', 'fq1'), req('q2', 'rosseti', 'pending', 'fq2'), req('q3', 'energiya', 'approved', 'fq3')]),
    activity_log: A_([M_({ id: S('a1'), type: S('budget'), title: S('Оплата 28 000 ₽') })]),
    notify_config: M_({ enabled: { booleanValue: true }, owner_email: S('owner@x'), accountant_email: S('buh@x'), alexander_email: S('al@x'), emailjs_key: S('k'), emailjs_service: S('s'), emailjs_template: S('t'), fcm_token: S('tok') }),
    telegram_config: M_({ digest: M_({ code: S('123456') }) }),
    maint_works: A_([M_({ id: S('w1') })]),
    finance_tx_kitchen: A_([M_({ id: S('k1') })]),
  });
  const reg = Object.fromEntries(['fe9', 'fe10', 'fr9', 'fq1', 'fq2', 'fq3', 'fx', 'fw'].map(id => [id, M_({ url: S('u-' + id) })]));
  await t.call('PATCH', 'v1/documents/appdata/files_registry', { service: true, body: { fields: { files: M_(reg) } } });
  const tok = async (u, p) => (await login(t, u, p)).body.token;
  const E = await tok('energo', '7777'), R = await tok('rosseti', '1234'), O = await tok('Yosmosh', 'own-secret');
  const read = async (token, path, query) => { const r = await t.call('GET', 'v1/documents/' + path, { token, query }); return r.status === 200 ? r.body.fields || {} : r.status; };
  const stored = name => JSON.parse(t.store.docs.get('appdata/state').fields[name]);
  const W = (token, fields, mask) => t.call('PATCH', 'v1/documents/appdata/state', { token, query: { 'updateMask.fieldPaths': mask }, body: { fields } });
  return { t, E, R, O, read, stored, W, visit, req };
}

test('a provider is given its own: its months, its requests, the owner\'s address — nothing else', async () => {
  const { E, R, O, read } = await providers();
  const s = await read(E, 'appdata/state');
  assert.deepStrictEqual(Object.keys(s).sort(), ['notify_config', 'purchase_requests', 'svc_records'], 'only these fields');
  assert.deepStrictEqual(Object.keys(s.svc_records.mapValue.fields).sort(), ['energiya_2026_10', 'energiya_2026_9'], 'its months — not another\'s, not one whose id merely starts the same');
  assert.deepStrictEqual(s.purchase_requests.arrayValue.values.map(e => e.mapValue.fields.id.stringValue), ['q1', 'q3']);
  assert.deepStrictEqual(Object.keys(s.notify_config.mapValue.fields).sort(), ['emailjs_key', 'emailjs_service', 'emailjs_template', 'enabled', 'owner_email']);
  const f = await read(E, 'appdata/files_registry');
  assert.deepStrictEqual(Object.keys(f.files.mapValue.fields).sort(), ['fe10', 'fe9', 'fq1', 'fq3'], 'only the documents of its own records');
  assert.deepStrictEqual(Object.keys((await read(R, 'appdata/files_registry')).files.mapValue.fields).sort(), ['fq2', 'fr9'], 'the other provider: its own');
  assert.deepStrictEqual(await read(E, 'appdata/state', { 'mask.fieldPaths': ['telegram_config', 'activity_log'] }), {}, 'asking for a field by name');
  assert.deepStrictEqual(await read(E, 'appdata/state', { 'mask.fieldPaths': ['svc_records.rosseti_2026_9'] }), {}, 'asking for another\'s month by name');
  for (const path of ['appdata/warehouse', 'appdata/warehouse_docs', 'appdata/backup_status', 'appdata/_drafts_lease', 'private/people', 'telegram_messages/m1']) {
    assert.strictEqual(await read(E, path), 403, path);
  }
  const all = await read(O, 'appdata/state');
  assert.deepStrictEqual(Object.keys(all.svc_records.mapValue.fields).length, 4, 'the owner: all of it');
  assert.ok(all.telegram_config && all.activity_log, 'the owner: all of it');
});

test('the warehouse keepers: of the budgets what was paid for their part — read, never written', async () => {
  const { t, T, read, ids } = await budgets();
  await t.call('PATCH', 'v1/documents/appdata/finance_ledger', { service: true, query: { 'updateMask.fieldPaths': ['finance_tx_personal', 'finance_tx_maintenance'] }, body: { fields: {
    finance_tx_personal: A_([rec('c1', 'Наличные', 'f1'), rec('b1', 'РООИ-ММЕО', 'f2'), rec('w1', 'РООИ-ММЕО', 'fw1', { whIntake: S('tools') }), rec('w2', 'Наличные', 'fw2', { whIntake: S('cleaning') })]),
    finance_tx_maintenance: A_([rec('m1', '', 'f4'), rec('mw', '', 'fmw', { whIntake: S('tools') })]),
  } } });
  await t.call('PATCH', 'v1/documents/appdata/files_registry', { service: true, query: { 'updateMask.fieldPaths': ['files.fw1', 'files.fw2', 'files.fmw'] }, body: { fields: { files: M_({ fw1: M_({ url: S('w1') }), fw2: M_({ url: S('w2') }), fmw: M_({ url: S('mw') }) }) } } });
  const owner = T.owner;
  const keeper = async (id, user) => {
    await t.call('POST', 'v1/auth:setAccount', { token: owner, body: { kind: 'role', id, user, password: user + '-pass-1' } });
    return (await login(t, user, user + '-pass-1')).body.token;
  };
  const sk = await keeper('storekeeper', 'sklad'), cl = await keeper('cleaning_head', 'klining');
  const l1 = await read(sk, 'appdata/finance_ledger'), l2 = await read(cl, 'appdata/finance_ledger');
  assert.deepStrictEqual([ids(l1.finance_tx_personal), ids(l1.finance_tx_maintenance), l1.finance_settlements], [['w1'], ['mw'], undefined], 'the storekeeper: the tools paid for — not the rest of ТО');
  assert.deepStrictEqual([ids(l2.finance_tx_personal), ids(l2.finance_tx_maintenance)], [['w2'], []], 'cleaning: its part, even paid in cash');
  assert.deepStrictEqual(Object.keys((await read(sk, 'appdata/files_registry')).files.mapValue.fields).sort(), ['fmw', 'fw1'], 'the documents of those');
  for (const name of ['finance_tx_personal', 'finance_tx_maintenance']) {
    const r = await t.call('PATCH', 'v1/documents/appdata/finance_ledger', { token: sk, query: { 'updateMask.fieldPaths': [name] }, body: { fields: { [name]: A_([rec(name === 'finance_tx_personal' ? 'w1' : 'mw', 'РООИ-ММЕО', 'fw1', { whIntake: S('tools') })]) } } });
    assert.strictEqual(r.status, 403, name + ': never written');
  }
  const st = await read(sk, 'appdata/state');
  assert.deepStrictEqual(Object.keys(st).sort(), ['budget_released'], 'of the state: whether Бюджет is published');
  for (const [tok, path, want] of [[sk, 'appdata/warehouse', 404], [cl, 'appdata/warehouse_docs', 404], [T.kitchen, 'appdata/warehouse', 403], [T.alexander, 'appdata/warehouse_docs', 403]]) {
    assert.strictEqual((await t.call('GET', 'v1/documents/' + path, { token: tok })).status, want, path);
  }
});

test('the staff: not Telegram, not the journal — to which they still add their lines', async () => {
  const t = await imported();
  await t.seedState({
    telegram_config: M_({ digest: M_({ code: S('123456') }) }), telegram_drafts: A_([M_({ id: S('d1') })]), telegram_log: A_([]),
    activity_log: A_([M_({ id: S('a1'), type: S('budget'), title: S('Оплата') })]),
    sos_items: A_([M_({ id: S('s1') })]), notify_config: M_({ owner_email: S('o@x') }), budget_released: { booleanValue: true },
  });
  const tok = async (u, p) => (await login(t, u, p)).body.token;
  const K = await tok('kitchen', 'kitchen123'), A = await tok('alexander', 'alex123'), O = await tok('Yosmosh', 'own-secret'), AD = await tok('admin', 'adm-secret');
  const st = async token => (await t.call('GET', 'v1/documents/appdata/state', { token })).body.fields || {};
  for (const [who, token] of [['kitchen', K], ['alexander', A]]) {
    assert.deepStrictEqual(Object.keys(await st(token)).sort(), ['budget_released', 'notify_config'], who + ': not even the SOS list, which neither screen shows');
  }
  assert.deepStrictEqual(Object.keys(await st(O)).sort(), ['activity_log', 'budget_released', 'notify_config', 'sos_items', 'telegram_config', 'telegram_drafts', 'telegram_log'], 'the owner');
  assert.ok((await st(AD)).telegram_drafts, 'the administrator: the drafts');
  const W = (token, fields, mask) => t.call('PATCH', 'v1/documents/appdata/state', { token, query: { 'updateMask.fieldPaths': mask }, body: { fields } });
  let r = await W(K, { activity_log: A_([M_({ id: S('a2'), type: S('maint'), title: S('Покос') })]) }, ['activity_log']);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const log = () => JSON.parse(t.store.docs.get('appdata/state').fields.activity_log).arrayValue.values.map(e => e.mapValue.fields.id.stringValue);
  assert.deepStrictEqual(log(), ['a1', 'a2'], 'its line added, the rest kept');
  assert.strictEqual((await W(K, { activity_log: A_(Array.from({ length: 6 }, (_, i) => M_({ id: S('x' + i), type: S('maint') }))) }, ['activity_log'])).status, 403, 'not many at once');
  for (const name of ['telegram_config', 'telegram_drafts', 'telegram_log']) assert.strictEqual((await W(K, { [name]: A_([]) }, [name])).status, 403, name);
  assert.strictEqual((await W(K, { sos_items: A_([M_({ id: S('s1') }), M_({ id: S('s2') })]) }, ['sos_items'])).status, 403, 'nor what its screens never save');
  assert.strictEqual((await W(K, { kitchen_invoices: A_([M_({ id: S('i1') })]) }, ['kitchen_invoices'])).status, 200, 'what they do, as before');
  assert.strictEqual((await W(O, { telegram_drafts: A_([]) }, ['telegram_drafts'])).status, 200, 'the owner');
});

// Every role signed in, over a state with one entry of everything the live one carries, each naming
// a document of its own; the ledger's lists, with an invoice waiting for the chief engineer (e1); a
// warehouse act; and the registry of all those documents, plus one no record names.
async function everyone() {
  const t = await imported();
  const one = (id, file) => A_([M_({ id: S(id), fileIds: A_([S(file)]) })]);
  await t.seedState({
    svc_records: M_({ energiya_2026_9: M_({ visits: A_([M_({ fileIds: A_([S('f-svc')]) })]) }) }),
    payment_records: M_({ energiya_2026_9: M_({ paid: { booleanValue: true } }) }),
    provider_contacts: M_({ energiya: M_({ phone: S('+7 900 000') }) }), provider_prices: M_({ energiya: { integerValue: '28000' } }),
    maint_works: one('w1', 'f-maint'), sos_items: one('s1', 'f-sos'), projects: A_([M_({ id: S('p1'), name: S('Крыша') })]),
    purchase_requests: one('q1', 'f-req'),
    finance_tx_kitchen: one('k1', 'f-ktx'), finance_funds: A_([M_({ id: S('fd1'), name: S('Наличные') })]), finance_month_locks: M_({ kitchen: M_({}) }),
    kitchen_invoices: one('ki1', 'f-kinv'), kitchen_deliveries: one('kd1', 'f-kdel'), kitchen_inventory: one('kv1', 'f-kinvt'), kitchen_writeoffs: one('kw1', 'f-kwo'),
    kitchen_suppliers: one('ks1', 'f-ksup'), kitchen_daily_usage: one('ku1', 'f-kuse'), kitchen_inv_snapshots: one('kn1', 'f-ksnap'),
    activity_log: A_([M_({ id: S('a1'), type: S('budget') })]), telegram_config: M_({ digest: M_({ code: S('123456') }) }), telegram_drafts: one('d1', 'f-tg'),
    notify_config: M_({ enabled: { booleanValue: true }, owner_email: S('o@x'), alexander_email: S('al@x'), accountant_email: S('b@x'), engineer_email: S('e@x'),
      emailjs_key: S('k'), emailjs_service: S('s'), emailjs_template: S('t'), fcm_vapid: S('v'), fcm_token: S('tok') }),
    budget_released: { booleanValue: true }, anthropic_api_key: S('sk-x'),
  });
  await t.call('PATCH', 'v1/documents/appdata/finance_ledger', { service: true, body: { fields: {
    finance_tx_maintenance: A_([rec('m1', '', 'f-m1'), rec('e1', '', 'f-e1', { needsEngineer: { booleanValue: true } })]),
    finance_tx_personal: A_([rec('c1', 'Наличные', 'f-cash1'), rec('b1', 'РООИ-ММЕО', 'f-b1')]),
    finance_settlements: A_([M_({ id: S('s1'), fileIds: A_([S('f-set')]) })]),
  } } });
  await t.call('PATCH', 'v1/documents/appdata/warehouse_docs', { service: true, body: { fields: { wh_docs: one('wd1', 'f-wh') } } });
  const all = ['f-svc', 'f-maint', 'f-sos', 'f-req', 'f-ktx', 'f-kinv', 'f-kdel', 'f-kinvt', 'f-kwo', 'f-ksup', 'f-kuse', 'f-ksnap', 'f-tg', 'f-m1', 'f-e1', 'f-cash1', 'f-b1', 'f-set', 'f-wh', 'f-orphan'];
  await t.call('PATCH', 'v1/documents/appdata/files_registry', { service: true, body: { fields: { files: M_(Object.fromEntries(all.map(id => [id, M_({ url: S('u-' + id) })]))) } } });
  const tok = async (u, p) => (await login(t, u, p)).body.token;
  const T = { owner: await tok('Yosmosh', 'own-secret'), kitchen: await tok('kitchen', 'kitchen123'), worker: await tok('worker', 'worker123'),
    alexander: await tok('alexander', 'alex123'), management: await tok('management', 'board2026'), buh: await tok('buh', 'buh-secret') };
  for (const [id, user] of [['storekeeper', 'sklad'], ['cleaning_head', 'klining'], ['engineer', 'inzh']]) {
    await t.call('POST', 'v1/auth:setAccount', { token: T.owner, body: { kind: 'role', id, user, password: user + '-pass-1' } });
    T[id] = await tok(user, user + '-pass-1');
  }
  const read = async (token, path, query) => { const r = await t.call('GET', 'v1/documents/' + path, { token, query }); return r.status === 200 ? r.body.fields || {} : r.status; };
  const ids = v => (v && v.arrayValue ? (v.arrayValue.values || []).map(e => e.mapValue.fields.id.stringValue) : v);
  return { t, T, read, ids };
}

test('the staff: each given of the shared state what its own screens use, and its documents alone', async () => {
  const { t, T, read } = await everyone();
  const common = ['budget_released', 'notify_config'];
  const want = {
    worker: ['kitchen_deliveries', 'kitchen_inv_snapshots', 'kitchen_inventory', 'kitchen_invoices', 'kitchen_suppliers'],
    kitchen: ['finance_month_locks', 'finance_tx_kitchen', 'kitchen_daily_usage', 'kitchen_deliveries', 'kitchen_inv_snapshots', 'kitchen_inventory', 'kitchen_invoices', 'kitchen_suppliers', 'kitchen_writeoffs'],
    storekeeper: [], cleaning_head: [],
    alexander: ['finance_month_locks', 'finance_tx_kitchen', 'maint_works', 'projects', 'svc_records'],
    management: ['finance_month_locks', 'finance_tx_kitchen', 'maint_works', 'projects', 'svc_records'],
    engineer: ['finance_month_locks', 'maint_works', 'projects', 'provider_contacts', 'sos_items', 'svc_records'],
    buh: ['finance_funds', 'finance_month_locks', 'finance_tx_kitchen', 'projects'],
  };
  const files = {
    worker: ['f-kdel', 'f-kinv', 'f-kinvt', 'f-ksnap', 'f-ksup'],
    kitchen: ['f-kdel', 'f-kinv', 'f-kinvt', 'f-ksnap', 'f-ksup', 'f-ktx', 'f-kuse', 'f-kwo'],
    storekeeper: ['f-wh'], cleaning_head: ['f-wh'],
    alexander: ['f-e1', 'f-ktx', 'f-m1', 'f-maint', 'f-svc'], management: ['f-e1', 'f-ktx', 'f-m1', 'f-maint', 'f-svc'],
    engineer: ['f-e1', 'f-maint', 'f-sos', 'f-svc'],
    buh: ['f-b1', 'f-e1', 'f-ktx', 'f-m1'],
  };
  for (const who of Object.keys(want)) {
    const s = await read(T[who], 'appdata/state');
    assert.deepStrictEqual(Object.keys(s).sort(), common.concat(want[who]).sort(), who + ': the state');
    assert.deepStrictEqual(Object.keys(s.notify_config.mapValue.fields).sort(),
      ['accountant_email', 'alexander_email', 'emailjs_key', 'emailjs_service', 'emailjs_template', 'enabled', 'engineer_email', 'owner_email'], who + ': the addresses it emails, no more');
    assert.deepStrictEqual(Object.keys((await read(T[who], 'appdata/files_registry')).files.mapValue.fields).sort(), files[who], who + ': the documents of what it is given');
    assert.deepStrictEqual(await read(T[who], 'appdata/state', { 'mask.fieldPaths': ['telegram_config', 'payment_records', 'provider_prices', 'activity_log'] }), {}, who + ': asking for others by name');
    assert.strictEqual(await read(T[who], 'appdata/some_new_document'), 403, who + ': a document added later');
  }
  assert.strictEqual(await read(T.owner, 'appdata/some_new_document'), 404, 'the owner: there is none');
  assert.strictEqual(Object.keys(await read(T.owner, 'appdata/state')).length, 24, 'the owner: all of it');
  const q = { structuredQuery: { from: [{ collectionId: 'appdata' }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2000' } } } } };
  assert.strictEqual((await t.call('POST', 'v1/documents:runQuery', { token: T.kitchen, body: q })).status, 403, 'nor by a query');
});

test('the staff save only what their screens save; the journal they add to', async () => {
  const { t, T } = await everyone();
  const W = (token, name) => t.call('PATCH', 'v1/documents/appdata/state', { token, query: { 'updateMask.fieldPaths': [name] }, body: { fields: { [name]: A_([M_({ id: S('n1') })]) } } }).then(r => r.status);
  const cases = {
    worker: { 200: ['kitchen_deliveries', 'kitchen_invoices', 'kitchen_inventory', 'kitchen_inv_snapshots'], 403: ['kitchen_suppliers', 'kitchen_writeoffs', 'finance_tx_kitchen'] },
    kitchen: { 200: ['kitchen_writeoffs', 'kitchen_suppliers', 'kitchen_daily_usage', 'finance_tx_kitchen'], 403: ['finance_month_locks', 'svc_records', 'sos_items'] },
    alexander: { 200: ['finance_tx_kitchen'], 403: ['maint_works', 'svc_records', 'projects', 'finance_month_locks'] },
    management: { 200: [], 403: ['finance_tx_kitchen', 'maint_works', 'svc_records'] },
    engineer: { 200: [], 403: ['svc_records', 'provider_contacts', 'sos_items', 'maint_works'] },
    buh: { 200: ['finance_tx_kitchen'], 403: ['finance_funds', 'projects', 'payment_records'] },
    storekeeper: { 200: [], 403: ['budget_released', 'notify_config', 'wh_items'] },
  };
  for (const who of Object.keys(cases)) {
    for (const n of cases[who][200]) assert.strictEqual(await W(T[who], n), 200, who + ' saves ' + n);
    for (const n of cases[who][403].concat(['telegram_config', 'anthropic_api_key'])) assert.strictEqual(await W(T[who], n), 403, who + ' never ' + n);
    assert.strictEqual((await t.call('PATCH', 'v1/documents/appdata/state', { token: T[who], query: { 'updateMask.fieldPaths': ['activity_log'] }, body: { fields: { activity_log: A_([M_({ id: S('a-' + who), type: S('budget') })]) } } })).status, 200, who + ': a line of the journal');
  }
  assert.strictEqual(JSON.parse(t.store.docs.get('appdata/state').fields.activity_log).arrayValue.values.length, 8, 'every line added, none lost');
  assert.strictEqual(await W(T.owner, 'telegram_config'), 200, 'the owner');
});

test('ТО и зарплаты: the chief engineer his invoices alone, changed but never added or taken off', async () => {
  const { t, T, read, ids } = await everyone();
  const l = await read(T.engineer, 'appdata/finance_ledger');
  assert.deepStrictEqual([ids(l.finance_tx_maintenance), l.finance_tx_personal, l.finance_settlements], [['e1'], undefined, undefined], 'the invoice waiting for him');
  for (const who of ['alexander', 'management', 'buh']) assert.deepStrictEqual(ids((await read(T[who], 'appdata/finance_ledger')).finance_tx_maintenance), ['m1', 'e1'], who + ': all of ТО');
  const W = (token, list, name) => t.call('PATCH', 'v1/documents/appdata/finance_ledger', { token, query: { 'updateMask.fieldPaths': [name || 'finance_tx_maintenance'] }, body: { fields: { [name || 'finance_tx_maintenance']: A_(list) } } }).then(r => r.status);
  const stored = () => JSON.parse(t.store.docs.get('appdata/finance_ledger').fields.finance_tx_maintenance).arrayValue.values;
  const eng = { needsEngineer: { booleanValue: true } };
  const approved = Object.assign({ approvals: M_({ engineer: M_({ approved: { booleanValue: true } }) }) }, eng);
  assert.strictEqual(await W(T.engineer, [rec('e1', '', 'f-e1', approved)]), 200, 'he approves his');
  assert.deepStrictEqual(stored().map(e => [e.mapValue.fields.id.stringValue, !!e.mapValue.fields.approvals]), [['m1', false], ['e1', true]], 'his approved, the rest as it was');
  assert.strictEqual(await W(T.engineer, []), 200, 'an empty list…');
  assert.deepStrictEqual(stored().map(e => e.mapValue.fields.id.stringValue), ['m1', 'e1'], '…takes nothing off');
  for (const [what, list] of [['another invoice', [rec('m1', '', 'f-m1', approved)]], ['a new one', [rec('x1', '', 'f-x1', eng)]], ['his made not his', [rec('e1', '', 'f-e1')]]]) {
    assert.strictEqual(await W(T.engineer, list), 403, 'the engineer: ' + what);
  }
  assert.strictEqual(await W(T.engineer, [rec('b1', 'РООИ-ММЕО', 'f-b1')], 'finance_tx_personal'), 403, 'the engineer: Личный бюджет');
  for (const who of ['management', 'kitchen', 'storekeeper']) assert.strictEqual(await W(T[who], [rec('m1', '', 'f-m1'), rec('e1', '', 'f-e1', eng)]), 403, who + ' writes no budget');
  for (const who of ['alexander', 'buh']) assert.strictEqual(await W(T[who], [rec('m1', '', 'f-m1', { status: S('approved') }), rec('e1', '', 'f-e1', approved)]), 200, who + ': ТО as before');
  assert.strictEqual(await W(T.alexander, [], 'finance_settlements'), 403, 'nobody of the staff: the payouts');
});

test('the staff\'s documents: theirs, new ones, and ones no record names — written or deleted', async () => {
  const { t, T } = await everyone();
  const Wf = (token, id) => t.call('PATCH', 'v1/documents/appdata/files_registry', { token, query: { 'updateMask.fieldPaths': ['files.' + id] }, body: { fields: { files: M_({ [id]: M_({ url: S('x') }) }) } } }).then(r => r.status);
  assert.deepStrictEqual([await Wf(T.kitchen, 'f-kinv'), await Wf(T.kitchen, 'f-new1'), await Wf(T.kitchen, 'f-orphan')], [200, 200, 200], 'the kitchen: its own, a new upload, one no record names');
  assert.deepStrictEqual([await Wf(T.kitchen, 'f-svc'), await Wf(T.kitchen, 'f-b1'), await Wf(T.worker, 'f-kwo')], [403, 403, 403], 'what it isn\'t given');
  assert.deepStrictEqual([await Wf(T.engineer, 'f-e1'), await Wf(T.engineer, 'f-m1')], [200, 403], 'the engineer');
  assert.deepStrictEqual([await Wf(T.storekeeper, 'f-wh'), await Wf(T.storekeeper, 'f-maint')], [200, 403], 'the storekeeper');
  const D = async (token, id) => (await t.call('DELETE', 'v1/files/' + id, { token })).status;
  assert.deepStrictEqual([await D(T.kitchen, 'f-kinv'), await D(T.alexander, 'f-maint'), await D(T.buh, 'f-cash1')], [403, 403, 403], 'a document a record still names: no one of the staff deletes it');
  assert.deepStrictEqual([await D(T.kitchen, 'f-orphan'), await D(T.owner, 'f-kdel')], [200, 200], 'one no record names; the owner, any');
});

test('share pages: written by the owner and the administrators, read by anyone with the link', async () => {
  const t = await imported();
  const tok = async (u, p) => (await login(t, u, p)).body.token;
  const page = token => t.call('PATCH', 'v1/documents/appdata/share_abc123', { token, body: { fields: { html: S('<p>отчёт</p>') } } });
  for (const [u, p] of [['kitchen', 'kitchen123'], ['alexander', 'alex123'], ['buh', 'buh-secret'], ['energo', '7777']]) assert.strictEqual((await page(await tok(u, p))).status, 403, u);
  assert.strictEqual((await page(await tok('admin', 'adm-secret'))).status, 200, 'an administrator');
  assert.strictEqual((await t.call('GET', 'v1/documents/appdata/share_abc123')).status, 200, 'the link, without signing in');
  for (const path of ['appdata/backup_status', 'appdata/_scan_quota', 'appdata/_drafts_lease']) {
    assert.strictEqual((await t.call('GET', 'v1/documents/' + path, { token: await tok('kitchen', 'kitchen123') })).status, 403, path);
  }
});

test('the Telegram messages: the server functions\' alone', async () => {
  const t = await imported();
  const q = { structuredQuery: { from: [{ collectionId: 'telegram_messages' }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2000' } } } } };
  for (const [u, p] of [['Yosmosh', 'own-secret'], ['kitchen', 'kitchen123'], ['energo', '7777']]) {
    const token = (await login(t, u, p)).body.token;
    assert.strictEqual((await t.call('POST', 'v1/documents:runQuery', { token, body: q })).status, 403, u);
    assert.strictEqual((await t.call('GET', 'v1/documents/telegram_messages/m1', { token })).status, 403, u);
  }
  assert.strictEqual((await t.call('POST', 'v1/documents:runQuery', { service: true, body: q })).status, 200, 'the bot');
});

test('a provider writes its own months and requests; never another\'s, never an approval', async () => {
  const { E, W, stored, visit, req } = await providers();
  // Its month saved: the others' stay as they are.
  let r = await W(E, { svc_records: M_({ energiya_2026_9: visit('fe9'), energiya_2026_10: visit('fe10'), energiya_2026_11: visit('fn') }) }, ['svc_records']);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(Object.keys(stored('svc_records').mapValue.fields).sort(), ['energiya2_2026_9', 'energiya_2026_10', 'energiya_2026_11', 'energiya_2026_9', 'rosseti_2026_9']);
  assert.strictEqual((await W(E, { svc_records: M_({ rosseti_2026_9: visit('x') }) }, ['svc_records'])).status, 403, 'another\'s month');
  assert.strictEqual((await W(E, { svc_records: M_({ energiya2_2026_9: visit('x') }) }, ['svc_records'])).status, 403, 'a month of a provider whose id starts the same');
  assert.strictEqual((await W(E, { svc_records: M_({}) }, ['svc_records.rosseti_2026_9'])).status, 403, 'by a path into another\'s');
  // Its requests: a new one pending; its own pending one changed; never another's, never approved.
  r = await W(E, { purchase_requests: A_([req('q1', 'energiya', 'pending', 'fq1'), req('q3', 'energiya', 'approved', 'fq3'), req('q4', 'energiya', 'pending', 'fq4')]) }, ['purchase_requests']);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(stored('purchase_requests').arrayValue.values.map(e => e.mapValue.fields.id.stringValue), ['q1', 'q2', 'q3', 'q4'], 'the other provider\'s request kept');
  for (const [what, list] of [['a new one approved', [req('q5', 'energiya', 'approved', 'f')]], ['its own approved by itself', [req('q1', 'energiya', 'approved', 'fq1')]],
    ['another\'s', [req('q2', 'energiya', 'pending', 'fq2')]], ['one in another\'s name', [req('q6', 'rosseti', 'pending', 'f')]]]) {
    assert.strictEqual((await W(E, { purchase_requests: A_(list.concat([req('q3', 'energiya', 'approved', 'fq3'), req('q4', 'energiya', 'pending', 'fq4')])) }, ['purchase_requests'])).status, 403, what);
  }
  assert.strictEqual((await W(E, { purchase_requests: A_([req('q1', 'energiya', 'pending', 'fq1'), req('q4', 'energiya', 'pending', 'fq4')]) }, ['purchase_requests'])).status, 403, 'an approved one taken back');
  // The journal: lines added, none read or changed.
  r = await W(E, { activity_log: A_([M_({ id: S('a9'), type: S('visit'), title: S('Визит записан') })]) }, ['activity_log']);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(stored('activity_log').arrayValue.values.map(e => e.mapValue.fields.id.stringValue), ['a1', 'a9']);
  assert.strictEqual((await W(E, { activity_log: A_([M_({ id: S('a8'), type: S('budget'), title: S('x') })]) }, ['activity_log'])).status, 403, 'a line of another kind');
  for (const name of ['telegram_config', 'notify_config', 'maint_works', 'finance_tx_kitchen', 'sos_items', 'projects']) {
    assert.strictEqual((await W(E, { [name]: A_([]) }, [name])).status, 403, name);
  }
  assert.strictEqual((await W(E, { svc_records: M_({}) })).status, 403, 'the whole document');
});

test('a provider\'s documents: its own, new ones, and none it isn\'t given — written or deleted', async () => {
  const { t, E, R } = await providers();
  const Wf = (token, id, value) => t.call('PATCH', 'v1/documents/appdata/files_registry', { token, query: { 'updateMask.fieldPaths': ['files.' + id] }, body: { fields: { files: M_(value === undefined ? {} : { [id]: value }) } } });
  const url = M_({ url: S('x') });
  assert.deepStrictEqual([(await Wf(E, 'fe9', url)).status, (await Wf(E, 'fnew', url)).status], [200, 200], 'its own; a new upload');
  assert.deepStrictEqual([(await Wf(E, 'fr9', url)).status, (await Wf(E, 'fq2', undefined)).status, (await Wf(E, 'fx', url)).status], [403, 403, 403], 'another\'s, written or taken off');
  assert.strictEqual((await Wf(E, 'fw', undefined)).status, 200, 'one no record names: taken off');
  const D =async (token, id) => (await t.call('DELETE', 'v1/files/' + id, { token })).status;
  await t.seedState({ svc_records: M_({ rosseti_2026_9: M_({ visits: A_([M_({ fileIds: A_([S('frosseti9')]) })]) }) }) });
  assert.deepStrictEqual([await D(E, 'frosseti9'), await D(E, 'forphan01')], [403, 200], 'a provider deletes only a file no record names');
  assert.strictEqual(await D(R, 'frosseti9'), 403, 'not even its own while a record still names it');
  for (const [m, path] of [['PATCH', 'appdata/warehouse'], ['PATCH', 'appdata/share_x'], ['DELETE', 'appdata/state'], ['PATCH', 'private/people']]) {
    assert.strictEqual((await t.call(m, 'v1/documents/' + path, { token: E, body: { fields: {} } })).status, 403, m + ' ' + path);
  }
  assert.strictEqual((await t.call('PATCH', 'v1/documents/appdata/_ping', { token: E, body: { fields: { t: { integerValue: '1' } } } })).status, 200, 'the connection check');
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
