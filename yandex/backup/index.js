// Yandex Cloud Function «backup», run every Sunday night by a timer trigger (and by hand when
// needed). backup.js does the work; this file connects it to YDB and the two buckets.
//
// It runs as service account «backup»: it may read the database and the files, write the
// status document, and add objects to sad-budushego-backup — but not delete anything there.
// The bucket keeps old versions of anything overwritten (90 days) and each data snapshot for
// a year. Object Storage is reached with the function's own IAM token; nothing secret is
// configured.

'use strict';

const { Driver, getCredentialsFromEnv, TypedValues, Types } = require('ydb-sdk');
const { runBackup } = require('./backup');

const SRC = process.env.FILES_BUCKET || 'sad-budushego-files';
const DST = process.env.BACKUP_BUCKET || 'sad-budushego-backup';
const STATUS_PATH = 'appdata/backup_status';
const S3 = 'https://storage.yandexcloud.net';

let driverPromise = null;
function driver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      const d = new Driver({ connectionString: process.env.YDB_CONNECTION_STRING, authService: getCredentialsFromEnv() });
      if (!(await d.ready(15000))) throw new Error('YDB: driver not ready');
      return d;
    })().catch(e => { driverPromise = null; throw e; });
  }
  return driverPromise;
}
const U = TypedValues.utf8;
const cell = item => (item && Object.prototype.hasOwnProperty.call(item, 'textValue') ? item.textValue : null);
function rowsOf(rs) {
  if (!rs) return [];
  if (rs.truncated) throw new Error('YDB: result truncated');
  const names = (rs.columns || []).map(c => c.name);
  return (rs.rows || []).map(r => { const o = {}; (r.items || []).forEach((it, k) => { o[names[k]] = cell(it); }); return o; });
}
async function q(text, params) {
  const d = await driver();
  return d.tableClient.withSessionRetry(async s => (await s.executeQuery(text, params)).resultSets.map(rowsOf));
}

// Whole tables, a thousand rows at a time, in key order.
async function scanMeta() {
  const out = [];
  let after = '';
  for (;;) {
    const [rows] = await q(`DECLARE $after AS Utf8;
SELECT path, collection, create_time, update_time, qdate FROM doc_meta WHERE path > $after ORDER BY path LIMIT 1000;`, { $after: U(after) });
    out.push(...rows);
    if (rows.length < 1000) return out;
    after = rows[rows.length - 1].path;
  }
}
async function scanFields() {
  const out = [];
  let p = '', f = '';
  for (;;) {
    const [rows] = await q(`DECLARE $p AS Utf8; DECLARE $f AS Utf8;
SELECT path, field, value FROM doc_fields WHERE path > $p OR (path = $p AND field > $f) ORDER BY path, field LIMIT 1000;`, { $p: U(p), $f: U(f) });
    out.push(...rows);
    if (rows.length < 1000) return out;
    p = rows[rows.length - 1].path; f = rows[rows.length - 1].field;
  }
}
async function readStatus() {
  const [rows] = await q(`DECLARE $path AS Utf8; SELECT field, value FROM doc_fields WHERE path = $path AND value IS NOT NULL;`, { $path: U(STATUS_PATH) });
  const o = {};
  rows.forEach(r => { o[r.field] = JSON.parse(r.value); });
  return o;
}
// The status document, written as the data API writes any document: a meta row (its version)
// and a row per field holding the Firestore Value as JSON text.
async function writeStatus(fields) {
  const [meta] = await q(`DECLARE $path AS Utf8; SELECT create_time FROM doc_meta WHERE path = $path;`, { $path: U(STATUS_PATH) });
  const now = new Date().toISOString().replace('Z', '000Z');
  const rows = Object.entries(fields).map(([field, v]) => ({ field, value: JSON.stringify(v) }));
  const ROW = Types.struct({ field: Types.UTF8, value: Types.optional(Types.UTF8) });
  await q(`DECLARE $path AS Utf8; DECLARE $ct AS Utf8; DECLARE $ut AS Utf8;
DECLARE $rows AS List<Struct<field: Utf8, value: Utf8?>>;
UPSERT INTO doc_fields SELECT $path AS path, field, value FROM AS_TABLE($rows);
UPSERT INTO doc_meta (path, collection, create_time, update_time, qdate) VALUES ($path, 'appdata', $ct, $ut, NULL);`, {
    $path: U(STATUS_PATH), $ct: U((meta[0] && meta[0].create_time) || now), $ut: U(now), $rows: TypedValues.list(ROW, rows),
  });
}

// Object Storage over its S3 API, authorised by the function's IAM token.
function storage(token) {
  const auth = { 'X-YaCloud-SubjectToken': token };
  const enc = key => key.split('/').map(encodeURIComponent).join('/');
  const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  async function send(url, init, what) {
    for (let i = 0; ; i++) {
      const r = await fetch(url, init);
      const text = await r.text();
      // A copy can fail after its 200 status line, with the error in the body.
      if (r.ok && !/<Error>/.test(text)) return text;
      if (i >= 2 || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(what + ': ' + r.status + ' ' + text.slice(0, 200));
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
  return {
    async list(bucket, prefix) {
      const keys = [];
      let token2 = '';
      for (;;) {
        const url = `${S3}/${bucket}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}` + (token2 ? '&continuation-token=' + encodeURIComponent(token2) : '');
        const xml = await send(url, { headers: auth }, 'list ' + bucket);
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unxml(m[1]));
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
        if (!next) return keys;
        token2 = unxml(next[1]);
      }
    },
    async put(bucket, key, body, type) {
      await send(`${S3}/${bucket}/${enc(key)}`, { method: 'PUT', headers: Object.assign({ 'Content-Type': type }, auth), body }, 'put ' + key);
    },
    async copy(srcBucket, key, dstBucket) {
      await send(`${S3}/${dstBucket}/${enc(key)}`, { method: 'PUT', headers: Object.assign({ 'x-amz-copy-source': `/${srcBucket}/${enc(key)}`, 'x-amz-metadata-directive': 'COPY' }, auth) }, 'copy ' + key);
    },
  };
}

module.exports.handler = async function (event, context) {
  const started = Date.now();
  const limitMs = Number(process.env.TIME_BUDGET_MS) || 8.5 * 60 * 1000;
  const token = context && context.token && context.token.access_token;
  if (!token) throw new Error('No IAM token: the function needs its service account');
  const status = await runBackup({
    db: { scanMeta, scanFields, readStatus, writeStatus },
    s3: storage(token),
    srcBucket: SRC, dstBucket: DST,
    now: () => Date.now(),
    deadline: started + limitMs,
  });
  console.log(JSON.stringify(status));
  return { statusCode: status.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status) };
};
