// The budgets' Google Drive documents into the app's own files (selfhost/drive-docs.js): the
// links read, the downloads told apart from Drive's web pages, and a whole run over a real file
// store — each invoice given its document beside the link, once, however often it runs.
//
//   node selfhost/test/drive-docs.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const dd = require('../drive-docs');
const { createFileStore } = require('../store-file');
const core = require('../../yandex/data-api/core');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n%%EOF');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', ID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765', ID3 = '1NoAccessNoAccessNoAccess000', DOC = '1GoogleDocGoogleDocGoogleDoc00';

test('links: files, Google documents, folders — and what isn\'t Drive', () => {
  assert.deepStrictEqual(dd.driveRef('https://drive.google.com/file/d/' + ID1 + '/view?usp=drive_link'), { kind: 'file', id: ID1 });
  assert.deepStrictEqual(dd.driveRef('https://drive.google.com/open?id=' + ID1), { kind: 'file', id: ID1 });
  assert.deepStrictEqual(dd.driveRef('https://docs.google.com/spreadsheets/d/' + DOC + '/edit#gid=0'), { kind: 'spreadsheets', id: DOC });
  assert.deepStrictEqual(dd.driveRef('https://drive.google.com/drive/folders/' + ID2 + '?usp=share_link'), { kind: 'folder', id: ID2 });
  assert.strictEqual(dd.driveRef('https://example.com/file/d/' + ID1), null);
  assert.strictEqual(dd.driveRef('not a url'), null);
  assert.deepStrictEqual(dd.downloadUrls({ kind: 'spreadsheets', id: DOC }), ['https://docs.google.com/spreadsheets/d/' + DOC + '/export?format=pdf']);
  assert.deepStrictEqual(dd.downloadUrls({ kind: 'folder', id: ID2 }), []);
});

test('bytes: the document\'s own kind; a web page is no document; the name from the header', () => {
  assert.strictEqual(dd.typeOf(PDF, 'x', 'application/octet-stream'), 'application/pdf');
  assert.strictEqual(dd.typeOf(JPG, '', ''), 'image/jpeg');
  assert.strictEqual(dd.typeOf(Buffer.from('<!DOCTYPE html><html>'), 'a.pdf', 'text/html'), null);
  assert.strictEqual(dd.typeOf(Buffer.from('PK\x03\x04....'), 'Счёт.xlsx', 'application/octet-stream'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(dd.nameFrom("attachment; filename=\"x.pdf\"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%2012.pdf"), 'Счёт 12.pdf');
  assert.strictEqual(dd.nameFrom('attachment; filename="plain.pdf"'), 'plain.pdf');
});

// Drive, as a double: two shared files, one that answers with its "no access" page, a Google
// sheet exported as PDF. Every request is counted.
function fakeDrive() {
  const asked = [];
  const answer = (status, body, headers) => ({ ok: status === 200, status, headers: { get: k => (headers || {})[k.toLowerCase()] || null }, arrayBuffer: async () => body });
  const fetchImpl = async url => {
    asked.push(url);
    if (url.includes(ID1)) return answer(200, PDF, { 'content-disposition': "attachment; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%20%E2%84%967.pdf", 'content-type': 'application/pdf' });
    if (url.includes(ID2)) return answer(200, JPG, { 'content-type': 'image/jpeg' });
    if (url.includes(DOC)) return answer(200, PDF, { 'content-type': 'application/pdf' });
    return answer(200, Buffer.from('<html>Нет доступа</html>'), { 'content-type': 'text/html' });
  };
  return { asked, fetchImpl };
}

// A data folder with the budgets: ТО (a record with a Drive file, one with the same file, one with
// its own document already), Личный бюджет (a Drive photo given as the old single fileRef), Кухня
// (a file Drive won't give, a folder, a Google sheet).
const link = (id, kind) => ({ name: 'Документ', url: kind === 'folder' ? 'https://drive.google.com/drive/folders/' + id : kind === 'sheet' ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : 'https://drive.google.com/file/d/' + id + '/view?usp=drive_link' });
const tx = (id, refs, single) => Object.assign({ id, type: 'expense', vendor: 'v-' + id, amount: 100 }, single ? { fileRef: refs[0] } : { fileRefs: refs, fileRef: refs[0] || null });
function dataFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sadb-drive-'));
  fs.mkdirSync(path.join(dir, 'db')); fs.mkdirSync(path.join(dir, 'files'));
  const store = createFileStore(path.join(dir, 'db'));
  const enc = v => JSON.stringify(require('../../yandex/backup/backup').encodeValue(v));
  const put = (p, fields) => store.transact(p, async t => t.write({ collection: 'appdata', upserts: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])), deletes: null, createTime: '2026-10-01T00:00:00.000000Z', updateTime: '2026-10-01T00:00:00.000000Z', qdate: null }));
  return { dir, store, put };
}
async function seeded() {
  const f = dataFolder();
  await f.put('appdata/finance_ledger', {
    finance_tx_maintenance: [tx('m1', [link(ID1)]), tx('m2', [link(ID1)]), tx('m3', [{ id: 'own0000001', name: 'a.jpg', type: 'image/jpeg' }])],
    finance_tx_personal: [tx('p1', [link(ID2)], true)],
    finance_settlements: [{ id: 's1' }],
  });
  await f.put('appdata/state', { finance_tx_kitchen: [tx('k1', [link(ID3), link(ID2, 'folder'), link(DOC, 'sheet')])], sos_items: [{ id: 'x' }] });
  await f.put('appdata/files_registry', { files: { own0000001: { id: 'own0000001', name: 'a.jpg', type: 'image/jpeg', size: 1, url: 'https://www.sad-budushego.ru/files/own0000001' } } });
  return f;
}
const decode = (store, p, n) => require('../../yandex/backup/backup').decodeValue(JSON.parse(store.docs.get(p).fields[n]));

test('fetch: every Drive document of a snapshot into the cache, once; refused ones noted, not kept', async () => {
  const f = await seeded();
  const snapFile = path.join(f.dir, 'snap.json.gz');
  const snapDocs = {};
  for (const [p, d] of f.store.docs) snapDocs[p] = { fields: Object.fromEntries(Object.entries(d.fields).map(([k, t]) => [k, require('../../yandex/backup/backup').decodeValue(JSON.parse(t))])) };
  fs.writeFileSync(snapFile, zlib.gzipSync(JSON.stringify({ documents: snapDocs })));
  const cache = path.join(f.dir, 'cache');
  const d = fakeDrive();
  const r = await dd.fetchAll(snapFile, cache, { fetchImpl: d.fetchImpl });
  assert.deepStrictEqual([r.links, r.folders, r.downloaded, r.failed.length], [5, 1, 3, 1], 'ID1 once for two records; ID2 as a file and as a folder; the sheet; ID3 refused');
  assert.ok(/web page/.test(r.failed[0].error));
  const again = await dd.fetchAll(snapFile, cache, { fetchImpl: d.fetchImpl });
  assert.strictEqual(again.downloaded, 0, 'what is cached is not downloaded again');
});

test('into the data: each record its document beside the link, a file and a registry entry each — and only once', async () => {
  const f = await seeded();
  const cache = path.join(f.dir, 'cache');
  fs.mkdirSync(cache);
  const d = fakeDrive();
  const r = await dd.attachAll(f.store, { cacheDir: cache, filesDir: path.join(f.dir, 'files'), publicOrigin: 'https://www.sad-budushego.ru', nextTime: core.nextTime, fetchImpl: d.fetchImpl, now: () => Date.parse('2026-10-15T12:00:00Z') });
  assert.deepStrictEqual([r.records, r.attached, r.folders, r.failed.length], [4, 4, 1, 1], 'm1, m2, p1, k1 (its sheet); the folder and the refused file left');
  const maint = decode(f.store, 'appdata/finance_ledger', 'finance_tx_maintenance');
  const [m1, m2, m3] = maint;
  assert.deepStrictEqual(m1.fileRefs.map(x => [!!x.id, x.fromDrive ? 'fromDrive' : '', x.url ? 'link' : '']), [[true, 'fromDrive', ''], [false, '', 'link']], 'the document first, the link kept after it');
  assert.deepStrictEqual([m1.fileRefs[0].name, m1.fileRefs[0].type, m1.fileRef.id === m1.fileRefs[0].id], ['Счёт №7.pdf', 'application/pdf', true], 'its name and kind; fileRef the first, as the page keeps it');
  assert.strictEqual(m1.fileRefs[0].id, m2.fileRefs[0].id, 'one document for the two invoices that link to it');
  assert.ok(/^[0-9a-f]{64}$/.test(m1.fileRefs[0].hash), 'a PDF hashed as the page hashes an upload');
  assert.deepStrictEqual(m3.fileRefs.map(x => x.id), ['own0000001'], 'a record with its own document only: as it was');
  const p1 = decode(f.store, 'appdata/finance_ledger', 'finance_tx_personal')[0];
  assert.deepStrictEqual([p1.fileRefs.length, p1.fileRefs[0].type, p1.fileRef.id === p1.fileRefs[0].id], [2, 'image/jpeg', true], 'the old single fileRef: now both');
  const k1 = decode(f.store, 'appdata/state', 'finance_tx_kitchen')[0];
  assert.deepStrictEqual(k1.fileRefs.map(x => x.id ? 'own:' + x.type : 'link'), ['link', 'link', 'own:application/pdf', 'link'], 'the refused file and the folder stay links; the sheet as PDF before its link');
  assert.deepStrictEqual(decode(f.store, 'appdata/finance_ledger', 'finance_settlements'), [{ id: 's1' }], 'the rest of the document as it was');
  assert.deepStrictEqual(decode(f.store, 'appdata/state', 'sos_items'), [{ id: 'x' }]);
  const reg = decode(f.store, 'appdata/files_registry', 'files');
  const made = [m1.fileRefs[0].id, p1.fileRefs[0].id, k1.fileRefs[2].id];
  assert.deepStrictEqual(Object.keys(reg).sort(), ['own0000001'].concat(made).sort(), 'the registry: the one before and the three made');
  for (const id of made) {
    assert.strictEqual(reg[id].url, 'https://www.sad-budushego.ru/files/' + id);
    assert.ok(fs.existsSync(path.join(f.dir, 'files', id)), 'the bytes');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'files', id + '.meta'), 'utf8')).type, reg[id].type, 'served as what it is');
  }
  assert.ok(fs.readFileSync(path.join(f.dir, 'files', m1.fileRefs[0].id)).equals(PDF));
  assert.notStrictEqual(f.store.docs.get('appdata/finance_ledger').updateTime, '2026-10-01T00:00:00.000000Z', 'a new update time, so open pages take it up');
  // Again: nothing added twice.
  const asked = d.asked.length;
  const r2 = await dd.attachAll(f.store, { cacheDir: cache, filesDir: path.join(f.dir, 'files'), publicOrigin: 'https://www.sad-budushego.ru', nextTime: core.nextTime, fetchImpl: d.fetchImpl });
  assert.deepStrictEqual([r2.records, r2.attached, r2.already], [0, 0, 4]);
  assert.strictEqual(Object.keys(decode(f.store, 'appdata/files_registry', 'files')).length, 4);
  assert.strictEqual(d.asked.length - asked, 2, 'only the refused one asked for again (two addresses)');
  // And the store, read afresh from its files, has the same.
  const reread = createFileStore(path.join(f.dir, 'db'));
  assert.strictEqual(JSON.parse(reread.docs.get('appdata/finance_ledger').fields.finance_tx_maintenance).arrayValue.values[0].mapValue.fields.fileRefs.arrayValue.values.length, 2);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
