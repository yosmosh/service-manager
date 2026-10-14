// The backup off this computer. Every night, after the snapshot (windows-service.js), what isn't in
// the cloud yet goes up to the backup bucket in Yandex Object Storage (sad-budushego-backup):
//
//   data/laptop-<date>.json.gz   the night's snapshot of the data (data/ is kept a year there)
//   files/<id>                   every photo and document not there yet — the same keys as the
//                                cloud backup's (yandex/backup), so the 2,237 copied before the move
//                                aren't sent again. A file never changes once uploaded, so the new
//                                ones are the whole backup; one deleted from the app stays in it.
//
// and the report goes to appdata/backup_status — the owner sees it in Настройки, red when two
// nights are missed. It signs in as the service account «backup» with a static access key
// (BACKUP_KEY_ID / BACKUP_KEY_SECRET in <root>\env, made by deploy\selfhost-windows.ps1
// -CloudBackup). That account can add to the bucket but not delete: whatever happens to this
// computer, what is in the cloud stays (an object written over keeps its old version 90 days).
//
//   node selfhost/cloud-backup.js       (settings from the environment, as the service gives them)

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ENDPOINT = 'https://storage.yandexcloud.net';
const REGION = 'ru-central1';
const FILE_ID = /^[a-z0-9]{8,64}$/;
const SNAPSHOT = /^\d{4}-\d\d-\d\d\.json\.gz$/;

// ---- AWS Signature Version 4, as Object Storage takes it ----
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// The headers a request goes with, Authorization among them. headers: those to be signed (host
// included); payloadHash: the body's SHA-256, hex.
function signRequest({ method, path: p, query, headers, payloadHash, keyId, secret, region, service, time }) {
  const amzDate = new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = Object.assign({}, headers, { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate });
  const names = Object.keys(all).map(n => n.toLowerCase()).sort();
  const value = n => String(all[Object.keys(all).find(k => k.toLowerCase() === n)]).trim().replace(/\s+/g, ' ');
  const canonical = [
    method,
    p.split('/').map(enc).join('/'),
    Object.keys(query || {}).sort().map(k => enc(k) + '=' + enc(String(query[k]))).join('&'),
    names.map(n => n + ':' + value(n) + '\n').join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = [day, region, service, 'aws4_request'].join('/');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  const out = {};
  for (const n of Object.keys(all)) out[n] = all[n];
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return out;
}

// ---- the bucket ----
function createBucket({ bucket, keyId, secret, endpoint, now }) {
  const base = new URL(endpoint || ENDPOINT);
  const clock = now || (() => Date.now());
  const lib = base.protocol === 'http:' ? http : https;

  // One request; body: a Buffer, or { file, size } streamed from disk. Resolves { status, text }.
  function send(method, key, { query, body, type, hash, timeout } = {}) {
    const p = '/' + bucket + (key ? '/' + key : '');
    const size = !body ? 0 : Buffer.isBuffer(body) ? body.length : body.size;
    const headers = { host: base.host };
    if (method === 'PUT') { headers['content-length'] = String(size); headers['content-type'] = type || 'application/octet-stream'; }
    const signed = signRequest({ method, path: p, query, headers, payloadHash: hash || sha256(''), keyId, secret, region: REGION, service: 's3', time: clock() });
    const qs = Object.keys(query || {}).map(k => enc(k) + '=' + enc(String(query[k]))).join('&');
    return new Promise((resolve, reject) => {
      const r = lib.request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method,
        path: p.split('/').map(enc).join('/') + (qs ? '?' + qs : ''), headers: signed, timeout: timeout || 120000 }, res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      });
      r.on('timeout', () => r.destroy(new Error('no answer in time')));
      r.on('error', reject);
      if (!body) r.end();
      else if (Buffer.isBuffer(body)) r.end(body);
      else fs.createReadStream(body.file).on('error', reject).pipe(r);
    });
  }
  const failed = (what, res) => new Error(`${what}: ${res.status} ${(/<Code>([^<]*)<\/Code>/.exec(res.text) || [])[1] || res.text.slice(0, 120)}`);

  // Every key under a prefix, a thousand at a time.
  async function list(prefix) {
    const keys = [];
    let token = '';
    do {
      const query = { 'list-type': '2', 'max-keys': '1000', prefix };
      if (token) query['continuation-token'] = token;
      const res = await send('GET', '', { query });
      if (res.status !== 200) throw failed('Список ' + prefix, res);
      const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      for (const m of res.text.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unxml(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(res.text) ? unxml((/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(res.text) || [])[1] || '') : '';
    } while (token);
    return keys;
  }
  // A file from disk, up to three tries.
  async function putFile(key, file, type) {
    const size = fs.statSync(file).size;
    const hash = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('error', reject).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex')));
    });
    let last = null;
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await send('PUT', key, { body: { file, size }, type, hash, timeout: 30 * 60 * 1000 });
        if (res.status === 200) return size;
        last = failed(key, res);
        if (res.status === 403) break;   // the key itself is refused: no use trying again
      } catch (e) { last = e; }
      await new Promise(r => setTimeout(r, 2000 * i));
    }
    throw last;
  }
  return { list, putFile, send };
}

// ---- one night's run ----
// Returns the report (the shape the cloud backup's was: yandex/backup/backup.js).
async function runCloudBackup({ dataDir, bucket, timeLimitMs, now, log }) {
  const clock = now || (() => Date.now());
  const say = log || (() => {});
  const started = clock();
  const status = { at: new Date(started).toISOString(), ok: false, from: 'laptop', dataKey: null, documents: 0,
    filesTotal: 0, filesInBackup: 0, filesCopied: 0, filesLeft: 0, errors: 0, error: null };
  try {
    // The newest snapshot of the data.
    const snapDir = path.join(dataDir, 'backups');
    const snap = (fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : []).filter(n => SNAPSHOT.test(n)).sort().pop();
    if (!snap) throw new Error('Нет снимка данных в ' + snapDir);
    const snapFile = path.join(snapDir, snap);
    status.documents = Object.keys(JSON.parse(zlib.gunzipSync(fs.readFileSync(snapFile)).toString('utf8')).documents || {}).length;
    status.dataKey = 'data/laptop-' + snap;
    await bucket.putFile(status.dataKey, snapFile, 'application/gzip');
    say(`${status.dataKey}: ${status.documents} documents`);

    // The files the cloud hasn't got yet, oldest first (an id starts with the time it was made).
    const filesDir = path.join(dataDir, 'files');
    const here = (fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []).filter(n => FILE_ID.test(n)).sort();
    const there = new Set((await bucket.list('files/')).map(k => k.slice('files/'.length)));
    const missing = here.filter(id => !there.has(id));
    status.filesTotal = here.length;
    const errs = [];
    let done = 0;
    for (const id of missing) {
      if (clock() - started > (timeLimitMs || 5 * 3600 * 1000)) break;   // the rest the next night
      let type = 'application/octet-stream';
      try { type = JSON.parse(fs.readFileSync(path.join(filesDir, id + '.meta'), 'utf8')).type || type; } catch (e) {}
      try { await bucket.putFile('files/' + id, path.join(filesDir, id), type); done++; }
      catch (e) { errs.push({ id, error: String(e && e.message || e) }); if (/: 403 /.test(errs[errs.length - 1].error)) break; }
    }
    status.filesCopied = done;
    status.errors = errs.length;
    status.filesLeft = missing.length - done;
    status.filesInBackup = here.length - status.filesLeft;
    if (errs.length) status.error = 'Не скопировано файлов: ' + errs.length + ' (первая ошибка: ' + errs[0].error.slice(0, 200) + ')';
    status.ok = !errs.length;
    say(`files: ${here.length} here, ${there.size} in the cloud before, ${done} copied, ${status.filesLeft} left, ${errs.length} errors`);
  } catch (e) {
    status.error = String(e && e.message || e).slice(0, 500);
  }
  status.finishedAt = new Date(clock()).toISOString();
  return status;
}

// The report to appdata/backup_status, through this computer's own server (the service key):
// `last` every time, `lastOk` when it went well.
async function reportStatus(status, { port, serviceKey }) {
  const { encodeValue } = require(path.join(__dirname, '..', 'yandex', 'backup', 'backup'));
  const fields = { last: encodeValue(status) };
  if (status.ok) fields.lastOk = encodeValue(status);
  const mask = Object.keys(fields).map(n => 'updateMask.fieldPaths=' + n).join('&');
  const body = JSON.stringify({ fields });
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'PATCH', path: '/db/v1/documents/appdata/backup_status?' + mask,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Service-Key': serviceKey }, timeout: 30000 }, res => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error('status not saved: ' + res.statusCode))));
    });
    r.on('timeout', () => r.destroy(new Error('the server did not answer')));
    r.on('error', reject);
    r.end(body);
  });
}

module.exports = { signRequest, createBucket, runCloudBackup, reportStatus };

if (require.main === module) {
  (async () => {
    const env = process.env;
    if (!env.BACKUP_KEY_ID || !env.BACKUP_KEY_SECRET) { console.log('No cloud backup key (deploy\\selfhost-windows.ps1 -CloudBackup) — nothing to do'); return; }
    const bucket = createBucket({ bucket: env.BACKUP_BUCKET || 'sad-budushego-backup', keyId: env.BACKUP_KEY_ID, secret: env.BACKUP_KEY_SECRET, endpoint: env.BACKUP_ENDPOINT });
    const status = await runCloudBackup({ dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', '..', 'data')), bucket, log: m => console.log(m) });
    console.log(status.ok ? 'Cloud backup OK' : 'Cloud backup FAILED: ' + status.error);
    try { await reportStatus(status, { port: Number(env.PORT || 8080), serviceKey: env.SERVICE_KEY }); }
    catch (e) { console.log('The report was not saved: ' + e.message); }
    process.exitCode = status.ok ? 0 : 1;
  })().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
}
