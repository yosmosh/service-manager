// The copy to the cloud (selfhost/cloud-backup.js): the request signature against AWS's own
// examples, and whole runs against a bucket double that checks every signature and keeps what is
// put in it.
//
//   node selfhost/test/cloud-backup.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { signRequest, createBucket, runCloudBackup, reportStatus } = require('../cloud-backup');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the signature: AWS\'s examples, exactly', async () => {
  const base = { keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3',
    time: Date.parse('2013-05-24T00:00:00Z'), payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
  const sig = h => /Signature=([0-9a-f]+)/.exec(h.Authorization)[1];
  assert.strictEqual(sig(signRequest(Object.assign({ method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' } }, base))),
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', 'GET Object');
  assert.strictEqual(sig(signRequest(Object.assign({ method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, headers: { host: 'examplebucket.s3.amazonaws.com' } }, base))),
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7', 'GET Bucket (list)');
});

// The bucket double: path-style /<bucket>/<key>; checks the signature of every request with the
// one secret it knows; lists two keys a page; refuses deleting.
function bucketDouble(secret) {
  const objects = new Map(), seen = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const url = new URL(req.url, 'http://x');
      const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(req.headers.authorization || '');
      const deny = code => { res.writeHead(403); res.end('<Error><Code>' + code + '</Code></Error>'); };
      if (!auth) return deny('AccessDenied');
      const query = Object.fromEntries(url.searchParams);
      const headers = {};
      for (const n of auth[4].split(';')) if (n !== 'x-amz-content-sha256' && n !== 'x-amz-date') headers[n] = req.headers[n];
      const amz = req.headers['x-amz-date'];
      const time = Date.parse(amz.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
      const want = signRequest({ method: req.method, path: decodeURIComponent(url.pathname), query, headers, payloadHash: req.headers['x-amz-content-sha256'], keyId: auth[1], secret, region: auth[3], service: 's3', time });
      if (want.Authorization !== req.headers.authorization) return deny('SignatureDoesNotMatch');
      if (req.method === 'PUT' && require('crypto').createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']) return deny('XAmzContentSHA256Mismatch');
      const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
      const key = rest.join('/');
      seen.push(req.method + ' ' + (key || '?' + url.searchParams.toString()));
      if (req.method === 'PUT') { objects.set(key, { body, type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
      if (req.method === 'GET' && !key) {
        const all = [...objects.keys()].filter(k => k.startsWith(query.prefix || '')).sort();
        const from = Number(query['continuation-token'] || 0), page = all.slice(from, from + 2), more = from + 2 < all.length;
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<ListBucketResult><Name>${bucket}</Name>${page.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
      }
      deny('AccessDenied');   // deleting, and anything else
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, objects, seen, endpoint: 'http://127.0.0.1:' + server.address().port })));
}

// A data folder as the server keeps it: two nights' snapshots, five files (with their .meta) and an
// upload left half-done.
function dataFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sadb-cloud-'));
  fs.mkdirSync(path.join(dir, 'backups')); fs.mkdirSync(path.join(dir, 'files'));
  const snap = n => zlib.gzipSync(Buffer.from(JSON.stringify({ createdAt: 'x', documents: Object.fromEntries(Array.from({ length: n }, (_, i) => ['appdata/d' + i, {}])) })));
  fs.writeFileSync(path.join(dir, 'backups', '2026-10-13.json.gz'), snap(3));
  fs.writeFileSync(path.join(dir, 'backups', '2026-10-14.json.gz'), snap(7));
  const ids = ['mg1aaaa0001', 'mg1aaaa0002', 'mg2bbbb0003', 'mg2bbbb0004', 'mg3cccc0005'];
  ids.forEach((id, i) => {
    fs.writeFileSync(path.join(dir, 'files', id), 'bytes of ' + id);
    fs.writeFileSync(path.join(dir, 'files', id + '.meta'), JSON.stringify({ type: i % 2 ? 'application/pdf' : 'image/jpeg' }));
  });
  fs.writeFileSync(path.join(dir, 'files', 'mg9zzzz0009.part'), 'half');
  return { dir, ids };
}

test('a night: the newest snapshot, and the files the cloud hasn\'t got — nothing else', async () => {
  const b = await bucketDouble('the-secret');
  try {
    const { dir, ids } = dataFolder();
    b.objects.set('files/' + ids[0], { body: Buffer.from('old') });
    b.objects.set('files/' + ids[1], { body: Buffer.from('old') });
    b.objects.set('files/mg0gone00001', { body: Buffer.from('deleted from the app, kept here') });
    const bucket = createBucket({ bucket: 'sad-budushego-backup', keyId: 'YCAJkey', secret: 'the-secret', endpoint: b.endpoint });
    const s = await runCloudBackup({ dataDir: dir, bucket });
    assert.deepStrictEqual([s.ok, s.error, s.dataKey, s.documents], [true, null, 'data/laptop-2026-10-14.json.gz', 7]);
    assert.deepStrictEqual([s.filesTotal, s.filesCopied, s.filesInBackup, s.filesLeft, s.errors], [5, 3, 5, 0, 0]);
    assert.strictEqual(zlib.gunzipSync(b.objects.get('data/laptop-2026-10-14.json.gz').body).toString().includes('appdata/d6'), true, 'the snapshot itself');
    assert.deepStrictEqual(ids.slice(2).map(id => [b.objects.get('files/' + id).body.toString(), b.objects.get('files/' + id).type]),
      [['bytes of mg2bbbb0003', 'image/jpeg'], ['bytes of mg2bbbb0004', 'application/pdf'], ['bytes of mg3cccc0005', 'image/jpeg']], 'each with its bytes and type');
    assert.strictEqual(b.objects.get('files/' + ids[0]).body.toString(), 'old', 'one already there is left as it is');
    assert.ok(![...b.objects.keys()].some(k => /part|meta/.test(k)), 'no half-done upload, no .meta');
    assert.ok(b.seen.some(s => /continuation-token/.test(s)), 'a list of more than one page read to the end');
    // The next night: the snapshot again, no file.
    b.seen.length = 0;
    const s2 = await runCloudBackup({ dataDir: dir, bucket });
    assert.deepStrictEqual([s2.ok, s2.filesCopied, s2.filesInBackup], [true, 0, 5]);
    assert.deepStrictEqual(b.seen.filter(x => x.startsWith('PUT')), ['PUT data/laptop-2026-10-14.json.gz']);
  } finally { b.server.close(); }
});

test('a key the cloud refuses: reported, and it stops at once', async () => {
  const b = await bucketDouble('the-secret');
  try {
    const { dir } = dataFolder();
    const s = await runCloudBackup({ dataDir: dir, bucket: createBucket({ bucket: 'sad-budushego-backup', keyId: 'YCAJkey', secret: 'wrong', endpoint: b.endpoint }) });
    assert.strictEqual(s.ok, false);
    assert.ok(/403 SignatureDoesNotMatch/.test(s.error), s.error);
    assert.strictEqual(b.objects.size, 0);
    assert.ok(b.seen.length === 0, 'nothing taken');
  } finally { b.server.close(); }
});

test('the night\'s time runs out: the rest waits for the next one; no snapshot: an error', async () => {
  const b = await bucketDouble('k');
  try {
    const { dir } = dataFolder();
    let t = 0;
    const s = await runCloudBackup({ dataDir: dir, bucket: createBucket({ bucket: 'x', keyId: 'id', secret: 'k', endpoint: b.endpoint }), timeLimitMs: 1000, now: () => (t += 400) });
    assert.deepStrictEqual([s.ok, s.filesCopied > 0, s.filesLeft > 0, s.filesCopied + s.filesLeft], [true, true, true, 5]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sadb-cloud-'));
    const e = await runCloudBackup({ dataDir: empty, bucket: createBucket({ bucket: 'x', keyId: 'id', secret: 'k', endpoint: b.endpoint }) });
    assert.deepStrictEqual([e.ok, /Нет снимка/.test(e.error)], [false, true]);
  } finally { b.server.close(); }
});

test('the report: to appdata/backup_status through the server, with the service key — lastOk only when it went well', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => { got.push({ url: req.url, key: req.headers['x-service-key'], body: JSON.parse(Buffer.concat(parts).toString()) }); res.writeHead(200); res.end('{}'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    await reportStatus({ at: 'a', ok: true, filesInBackup: 5 }, { port, serviceKey: 'sk' });
    await reportStatus({ at: 'b', ok: false, error: 'нет связи' }, { port, serviceKey: 'sk' });
    assert.deepStrictEqual(got.map(g => [g.url, g.key, Object.keys(g.body.fields).sort()]), [
      ['/db/v1/documents/appdata/backup_status?updateMask.fieldPaths=last&updateMask.fieldPaths=lastOk', 'sk', ['last', 'lastOk']],
      ['/db/v1/documents/appdata/backup_status?updateMask.fieldPaths=last', 'sk', ['last']],
    ]);
    assert.strictEqual(got[0].body.fields.lastOk.mapValue.fields.filesInBackup.integerValue, '5');
  } finally { server.close(); }
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
