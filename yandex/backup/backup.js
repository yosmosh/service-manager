// The weekly backup, apart from the cloud it runs in (index.js wires it to YDB and the buckets).
//
// Each run:
//   • writes every document of the app's database — except the sign-in secrets under _auth/ —
//     to data/<date>.json.gz in the backup bucket: one JSON file, readable as it is, with each
//     document's fields decoded from the stored Firestore values;
//   • copies into files/ of the backup bucket every photo and document not copied before. A file
//     never changes once uploaded (each upload gets a new id), so copying the new ones is the
//     whole backup — and a file deleted from the app stays in the backup;
//   • records how it went in appdata/backup_status, which the owner sees in Настройки.
// Copying stops starting new files near the time limit; the next run carries on from there.

'use strict';

const zlib = require('zlib');

const SKIP_PATH = /^_auth\//;

// The stored value of a field is its Firestore Value as JSON text. Decoded for reading.
function decodeValue(v) {
  if (v == null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = decodeValue(x);
    return o;
  }
  return v;
}
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  const fields = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = encodeValue(x);
  return { mapValue: { fields } };
}

// Rows of doc_meta and doc_fields → { path: { collection, createTime, updateTime, qdate, fields } }.
// A field whose row has no value was removed; a field of a document with no meta row is left
// over from a deleted document. Neither is part of the data.
function buildSnapshot(metaRows, fieldRows, createdAt) {
  const documents = {};
  for (const m of metaRows) {
    if (SKIP_PATH.test(m.path)) continue;
    documents[m.path] = { collection: m.collection, createTime: m.create_time, updateTime: m.update_time, qdate: m.qdate || null, fields: {} };
  }
  for (const r of fieldRows) {
    const d = documents[r.path];
    if (!d || r.value == null) continue;
    d.fields[r.field] = decodeValue(JSON.parse(r.value));
  }
  return { createdAt, note: 'Сад Будущего — резервная копия данных (без паролей). Каждый документ: его поля как в приложении.', documents };
}

// The field rows to read, in batches that keep each answer well under the 4 MB a YDB reply
// may carry: by their sizes, at most `maxRows` a batch; a row bigger than the cap goes alone.
function planBatches(keys, maxBytes = 2.5 * 1024 * 1024, maxRows = 200) {
  const out = [];
  let cur = [], bytes = 0;
  for (const k of keys) {
    const n = Number(k.n) || 0;
    if (cur.length && (bytes + n > maxBytes || cur.length >= maxRows)) { out.push(cur); cur = []; bytes = 0; }
    cur.push({ path: k.path, field: k.field });
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// The source files not yet in the backup.
function planCopies(sourceKeys, backupKeys) {
  const have = new Set(backupKeys);
  return sourceKeys.filter(k => !have.has(k));
}

// Runs fn over items, `concurrency` at a time, starting no new item once shouldStop() says so.
async function pool(items, concurrency, fn, shouldStop) {
  let next = 0, done = 0;
  const errors = [];
  async function worker() {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      try { await fn(item); done++; } catch (e) { errors.push({ item, error: String(e && e.message || e) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { done, errors };
}

// deps: db { scanMeta(), scanFields(), readStatus(), writeStatus(fields) }
//       s3 { list(bucket, prefix) → [key], put(bucket, key, body, type), copy(srcBucket, key, dstBucket) }
//       now() → ms, deadline (ms) after which no new file copy starts.
async function runBackup({ db, s3, srcBucket, dstBucket, now, deadline, concurrency = 8 }) {
  const startedAt = new Date(now()).toISOString();
  const status = { at: startedAt, ok: false, dataKey: null, documents: 0, filesTotal: 0, filesInBackup: 0, filesCopied: 0, filesLeft: 0, errors: 0, error: null };
  try {
    const snapshot = buildSnapshot(await db.scanMeta(), await db.scanFields(), startedAt);
    status.documents = Object.keys(snapshot.documents).length;
    const dataKey = 'data/' + startedAt.slice(0, 10) + '.json.gz';
    await s3.put(dstBucket, dataKey, zlib.gzipSync(Buffer.from(JSON.stringify(snapshot))), 'application/gzip');
    status.dataKey = dataKey;

    const source = await s3.list(srcBucket, 'files/');
    const backedUp = await s3.list(dstBucket, 'files/');
    const missing = planCopies(source, backedUp);
    status.filesTotal = source.length;
    const res = await pool(missing, concurrency, key => s3.copy(srcBucket, key, dstBucket), () => now() >= deadline);
    status.filesCopied = res.done;
    status.errors = res.errors.length;
    status.filesLeft = missing.length - res.done;
    status.filesInBackup = source.length - status.filesLeft;
    if (res.errors.length) status.error = 'Не скопировано файлов: ' + res.errors.length + ' (первая ошибка: ' + res.errors[0].error.slice(0, 200) + ')';
    status.ok = !res.errors.length;
  } catch (e) {
    status.error = String(e && e.message || e).slice(0, 500);
  }
  status.finishedAt = new Date(now()).toISOString();
  // The last run, and the last one that went well — so a failure never hides how old the
  // newest good copy is.
  const prev = (await db.readStatus().catch(() => null)) || {};
  const fields = { last: encodeValue(status), lastOk: status.ok ? encodeValue(status) : (prev.lastOk || encodeValue(null)) };
  await db.writeStatus(fields);
  return status;
}

module.exports = { decodeValue, encodeValue, buildSnapshot, planBatches, planCopies, pool, runBackup, SKIP_PATH };
