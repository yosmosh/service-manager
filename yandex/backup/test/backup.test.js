// The backup over doubles of YDB and the two buckets.
//
//   node yandex/backup/test/backup.test.js

'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { runBackup, buildSnapshot, planCopies, decodeValue, encodeValue } = require('../backup');

const v = x => JSON.stringify(encodeValue(x));
function world() {
  const meta = [
    { path: '_auth/credentials', collection: '_auth', create_time: 't0', update_time: 't1', qdate: null },
    { path: 'appdata/finance_ledger', collection: 'appdata', create_time: 't0', update_time: 't2', qdate: null },
    { path: 'appdata/state', collection: 'appdata', create_time: 't0', update_time: 't3', qdate: null },
    { path: 'telegram_messages/m1', collection: 'telegram_messages', create_time: 't0', update_time: 't0', qdate: '2026-10-01T10:00:00Z' },
  ];
  const fields = [
    { path: '_auth/credentials', field: 'roles', value: v({ owner: { hash: 'SECRET' } }) },
    { path: 'appdata/finance_ledger', field: 'finance_tx_personal', value: v([{ id: 'a', amount: 1500.5, vendor: 'Хозмаг' }]) },
    { path: 'appdata/state', field: 'maint_works', value: v([{ id: 'w1', title: 'Забор', relatedIds: ['w2'] }]) },
    { path: 'appdata/state', field: 'old_field', value: null },
    { path: 'appdata/gone', field: 'x', value: v(1) },
    { path: 'telegram_messages/m1', field: 'text', value: v('прорвало трубу') },
  ];
  const buckets = { src: new Map(), dst: new Map() };
  for (let i = 0; i < 25; i++) buckets.src.set('files/f' + String(i).padStart(2, '0'), 'bytes' + i);
  buckets.dst.set('files/f00', 'bytes0');
  buckets.dst.set('files/deleted-in-app', 'old');
  let status = {};
  const db = {
    scanMeta: async () => meta, scanFields: async () => fields,
    readStatus: async () => status, writeStatus: async f => { status = JSON.parse(JSON.stringify(f)); },
  };
  const calls = { copy: 0, failOn: null };
  const s3 = {
    list: async (b, prefix) => Array.from(buckets[b].keys()).filter(k => k.startsWith(prefix)),
    put: async (b, key, body) => { buckets[b].set(key, body); },
    copy: async (src, key, dst) => {
      calls.copy++;
      if (calls.failOn && calls.failOn(key)) throw new Error('copy ' + key + ': 503');
      buckets[dst].set(key, buckets[src].get(key));
    },
  };
  return { db, s3, buckets, calls, status: () => status };
}

(async () => {
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('ok ' + name); };

  await t('values decode back to what the app stored', async () => {
    const x = { a: 1, b: 2.5, c: 'т', d: [true, null], e: { f: [] } };
    assert.deepStrictEqual(decodeValue(encodeValue(x)), x);
  });

  await t('snapshot: every document, decoded; no _auth, no removed fields, no leftovers', async () => {
    const w = world();
    const s = buildSnapshot(await w.db.scanMeta(), await w.db.scanFields(), 'now');
    assert.deepStrictEqual(Object.keys(s.documents), ['appdata/finance_ledger', 'appdata/state', 'telegram_messages/m1']);
    assert.deepStrictEqual(s.documents['appdata/state'].fields, { maint_works: [{ id: 'w1', title: 'Забор', relatedIds: ['w2'] }] });
    assert.strictEqual(s.documents['appdata/finance_ledger'].fields.finance_tx_personal[0].amount, 1500.5);
    assert.strictEqual(s.documents['telegram_messages/m1'].qdate, '2026-10-01T10:00:00Z');
    assert.ok(!JSON.stringify(s).includes('SECRET'));
  });

  await t('field reads batched under the 4 MB a YDB reply may carry; a big row goes alone', async () => {
    const { planBatches } = require('../backup');
    const MB = 1024 * 1024;
    const keys = [{ path: 'a', field: '1', n: String(0.9 * MB) }, { path: 'a', field: '2', n: String(1.2 * MB) }, { path: 'a', field: '3', n: String(0.6 * MB) },
      { path: 'b', field: 'x', n: String(3 * MB) }, { path: 'c', field: 'y', n: '10' }];
    const b = planBatches(keys);
    assert.deepStrictEqual(b.map(x => x.map(k => k.path + k.field)), [['a1', 'a2'], ['a3'], ['bx'], ['cy']]);
    assert.ok(b.every(x => x.reduce((s, k) => s + Number(keys.find(z => z.path === k.path && z.field === k.field).n), 0) <= 2.5 * MB || x.length === 1));
    const many = Array.from({ length: 450 }, (_, i) => ({ path: 'm', field: String(i), n: '100' }));
    assert.deepStrictEqual(planBatches(many).map(x => x.length), [200, 200, 50]);
    assert.deepStrictEqual(planBatches([]), []);
  });

  await t('only the files not yet backed up are copied', async () => {
    assert.deepStrictEqual(planCopies(['files/a', 'files/b', 'files/c'], ['files/b', 'files/x']), ['files/a', 'files/c']);
  });

  await t('a run: the data as a dated gzip, the new files, the status', async () => {
    const w = world();
    const st = await runBackup({ db: w.db, s3: w.s3, srcBucket: 'src', dstBucket: 'dst', now: () => Date.parse('2026-10-11T00:05:00Z'), deadline: Infinity, concurrency: 4 });
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.dataKey, 'data/2026-10-11.json.gz');
    const snap = JSON.parse(zlib.gunzipSync(w.buckets.dst.get('data/2026-10-11.json.gz')));
    assert.strictEqual(snap.documents['appdata/state'].fields.maint_works[0].title, 'Забор');
    assert.deepStrictEqual([st.documents, st.filesTotal, st.filesCopied, st.filesLeft, st.filesInBackup], [3, 25, 24, 0, 25]);
    assert.strictEqual(w.buckets.dst.get('files/deleted-in-app'), 'old', 'a file deleted in the app stays in the backup');
    const saved = w.status();
    assert.strictEqual(decodeValue(saved.last).ok, true);
    assert.strictEqual(decodeValue(saved.lastOk).dataKey, 'data/2026-10-11.json.gz');
    const again = await runBackup({ db: w.db, s3: w.s3, srcBucket: 'src', dstBucket: 'dst', now: () => Date.parse('2026-10-18T00:05:00Z'), deadline: Infinity });
    assert.deepStrictEqual([again.filesCopied, again.filesLeft, w.calls.copy], [0, 0, 24], 'the next week copies nothing old again');
  });

  await t('out of time: stops starting copies, says how many are left, carries on next run', async () => {
    const w = world();
    let clock = 0;
    const s3 = Object.assign({}, w.s3, { copy: async (a, k, b) => { clock += 10; await w.s3.copy(a, k, b); } });
    const st = await runBackup({ db: w.db, s3, srcBucket: 'src', dstBucket: 'dst', now: () => clock, deadline: 100, concurrency: 1 });
    assert.ok(st.filesCopied >= 10 && st.filesLeft === 24 - st.filesCopied, JSON.stringify(st));
    const st2 = await runBackup({ db: w.db, s3: w.s3, srcBucket: 'src', dstBucket: 'dst', now: () => 0, deadline: Infinity });
    assert.deepStrictEqual([st2.filesLeft, st2.filesInBackup], [0, 25]);
  });

  await t('a failure is recorded, and the last good copy is kept in the status', async () => {
    const w = world();
    await runBackup({ db: w.db, s3: w.s3, srcBucket: 'src', dstBucket: 'dst', now: () => Date.parse('2026-10-11T00:05:00Z'), deadline: Infinity });
    w.buckets.src.set('files/new1', 'n'); w.buckets.src.set('files/new2', 'n');
    w.calls.failOn = k => k === 'files/new2';
    const st = await runBackup({ db: w.db, s3: w.s3, srcBucket: 'src', dstBucket: 'dst', now: () => Date.parse('2026-10-18T00:05:00Z'), deadline: Infinity });
    assert.deepStrictEqual([st.ok, st.filesCopied, st.errors, st.filesLeft], [false, 1, 1, 1]);
    assert.ok(/Не скопировано файлов: 1/.test(st.error));
    const saved = w.status();
    assert.strictEqual(decodeValue(saved.last).ok, false);
    assert.strictEqual(decodeValue(saved.lastOk).at, '2026-10-11T00:05:00.000Z');
    const broken = Object.assign({}, w.db, { scanFields: async () => { throw new Error('YDB: driver not ready'); } });
    const st3 = await runBackup({ db: broken, s3: w.s3, srcBucket: 'src', dstBucket: 'dst', now: () => 0, deadline: Infinity });
    assert.deepStrictEqual([st3.ok, st3.error], [false, 'YDB: driver not ready']);
  });

  console.log(n + ' passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
