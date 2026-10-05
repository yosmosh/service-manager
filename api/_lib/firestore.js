// Shared Firestore REST helpers for the serverless functions. (The leading underscore keeps
// Vercel from turning this directory into an endpoint.)
//
// Every server-side writer used to follow the same pattern: read a whole array (or map)
// from appdata/state, do something slow — call the AI, download and upload photos, send
// Telegram messages — and then write the whole thing back. Anything the app changed in
// those seconds was silently overwritten: a draft the manager had just approved came back,
// an SOS item closed at 08:00:03 reopened when the 08:00 reminder finished, a photo another
// user had just uploaded dropped out of the registry. updateDoc() is the one correct way to
// do a read-modify-write here, and every writer goes through it.

// Where the data is — the same place the app reads it (DATA_BACKEND in service-manager.html).
// 'yandex': the data API in Yandex Cloud (yandex/data-api), the same REST shapes as Firestore,
// called with the service key — Vercel environment variable SERVICE_KEY. DATA_BACKEND may
// override the default below; the move to Yandex flips the default.
const BACKEND = process.env.DATA_BACKEND || 'firebase';
const YANDEX = BACKEND === 'yandex';
const DATA_API = String(process.env.DATA_API_URL || 'https://d5do4n0o23evidqovr16.jki8ffxa.apigw.yandexcloud.net/db').replace(/\/+$/, '');
const DOCS = YANDEX ? DATA_API + '/v1/documents'
  : 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents';
const RUN_QUERY_URL = DOCS + ':runQuery';

// fetch() for the database: on Yandex every request carries the service key.
function dbFetch(url, init) {
  if (!YANDEX) return fetch(url, init);
  if (!process.env.SERVICE_KEY) throw new Error('SERVICE_KEY not configured');
  const opts = Object.assign({}, init || {});
  opts.headers = Object.assign({}, opts.headers || {}, { 'X-Service-Key': process.env.SERVICE_KEY });
  return fetch(url, opts);
}

// A photo the bot received, put where the app keeps every other file, so the app's own
// gallery shows it like any upload. Returns the registry entry ({ id, name, type, size, url })
// or null. On Yandex the data API hands out an address in the bucket to PUT it at.
const FIREBASE_BUCKET = 'sad-budushego.firebasestorage.app';
async function uploadPhoto(buf, ext) {
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const name = `telegram-photo.${ext}`;
  if (YANDEX) {
    const pr = await dbFetch(DATA_API + '/v1/files:presign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type: mime }),
    });
    const p = await pr.json().catch(() => ({}));
    if (!pr.ok || !p.uploadUrl) return null;
    const put = await fetch(p.uploadUrl, { method: 'PUT', headers: p.headers || { 'Content-Type': mime }, body: buf });
    if (!put.ok) return null;
    return { id: p.id, name, type: mime, size: buf.length, url: p.url };
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const objectName = `files/${id}.${ext}`;
  const uploadRes = await fetch(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`, {
    method: 'POST', headers: { 'Content-Type': mime }, body: buf,
  });
  const meta = await uploadRes.json();
  if (!meta.downloadTokens) return null;
  const url = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&token=${meta.downloadTokens}`;
  return { id, name, type: mime, size: Number(meta.size) || buf.length, url };
}

// Addresses of the app's own uploads, in either store — what scan-invoice may fetch.
const OWN_FILE_PREFIXES = [
  `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o/files%2F`,
  'https://storage.yandexcloud.net/sad-budushego-files/files/',
];

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }
function fsInt(v) { return { integerValue: String(Math.round(v)) }; }
function fsStringArray(arr) { return { arrayValue: { values: (arr || []).map(fsString) } }; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

// Returns { exists, fields, updateTime }. A mask naming no real field returns the version only.
async function readDoc(path, maskFields) {
  const mask = (maskFields && maskFields.length ? maskFields : ['zzVersionProbe'])
    .map(f => 'mask.fieldPaths=' + encodeURIComponent(f)).join('&');
  const r = await dbFetch(`${DOCS}/${path}?${mask}`);
  if (r.status === 404) return { exists: false, fields: {}, updateTime: null };
  if (!r.ok) throw new Error(`Firestore GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { exists: true, fields: j.fields || {}, updateTime: j.updateTime || null };
}

// Optimistic read-modify-write of the fields named in readMask.
//
// apply(currentFields) gets a private copy of the document's current fields and returns the
// fields to write ({ name: FirestoreValue }), or null to write nothing. The write only lands
// if the document is still at the version that was read; if anything else wrote in between,
// Firestore rejects it untouched (400 FAILED_PRECONDITION) and apply runs again on fresh data.
// apply may therefore run more than once, so it must be free of side effects — send messages
// or upload files before calling this, not inside apply.
async function updateDoc(path, readMask, apply, attempts) {
  const max = attempts || 10;
  for (let i = 0; i < max; i++) {
    const cur = await readDoc(path, readMask);
    const out = apply(clone(cur.fields));
    if (!out || !Object.keys(out).length) return { written: false };
    const mask = Object.keys(out).map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
    const cond = cur.exists
      ? '&currentDocument.updateTime=' + encodeURIComponent(cur.updateTime)
      : '&currentDocument.exists=false';
    const r = await dbFetch(`${DOCS}/${path}?${mask}${cond}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fields: out }),
    });
    if (r.ok) return { written: true, updateTime: (await r.json()).updateTime || null };
    const body = await r.text();
    // Lost the race (or the document was created concurrently) — re-read and re-apply,
    // after a short random pause so contending writers don't keep retrying in lockstep.
    if ((r.status === 400 && body.includes('FAILED_PRECONDITION')) || r.status === 409) {
      await new Promise(res => setTimeout(res, 20 + Math.random() * 120));
      continue;
    }
    throw new Error(`Firestore PATCH ${path} → ${r.status} ${body.slice(0, 200)}`);
  }
  throw new Error(`Firestore ${path}: kept losing to concurrent writes after ${max} attempts`);
}

// Registers files in appdata/files_registry by nested per-id paths (files.<id>). That touches
// only these ids, needs no read at all, and so can never erase an entry another writer just
// added — unlike reading the whole (large) map and writing it back. File ids are base36
// alphanumeric by construction, so they need no field-path escaping.
async function registerFiles(metas, registryPath) {
  const reg = registryPath || 'appdata/files_registry';
  const list = (metas || []).filter(Boolean);
  if (!list.length) return;
  const files = {};
  list.forEach(m => {
    files[m.id] = { mapValue: { fields: {
      id: fsString(m.id), name: fsString(m.name), type: fsString(m.type),
      size: fsInt(m.size), url: fsString(m.url),
    } } };
  });
  const mask = list.map(m => 'updateMask.fieldPaths=' + encodeURIComponent('files.' + m.id)).join('&');
  const r = await dbFetch(`${DOCS}/${reg}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { files: { mapValue: { fields: files } } } }),
  });
  if (!r.ok) throw new Error(`Firestore register files → ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// A short-lived exclusive lease in its own document, so only one instance of a job runs at
// a time. Taking it is itself an updateDoc, so two instances racing for it can't both win:
// the loser's conditional write is rejected, it re-reads, and sees the lease already held.
// The lease expires on its own, so a run that dies without releasing can't block forever.
async function acquireLease(path, holder, ttlMs) {
  const res = await updateDoc(path, ['leaseUntil'], f => {
    const until = f.leaseUntil ? Date.parse(f.leaseUntil.stringValue) : 0;
    if (until > Date.now()) return null;
    return {
      leaseUntil: fsString(new Date(Date.now() + ttlMs).toISOString()),
      holder: fsString(holder),
    };
  });
  return res.written;
}

async function releaseLease(path, holder, extraFields) {
  await updateDoc(path, ['holder'], f => {
    if (!f.holder || f.holder.stringValue !== holder) return null; // not ours any more
    return Object.assign({ leaseUntil: fsString(new Date(0).toISOString()) }, extraFields || {});
  });
}

// Records reminders a cron has just sent: stamps each reminded item (matched by id) with
// the reminder level and time, and appends the log entries. The reminder crons used to
// write back the whole list they had read before sending — so an SOS item closed, or a
// request approved, while the reminders were going out was reverted. Here the stamps are
// applied to the list as it stands at write time; an item removed meanwhile is skipped.
async function recordReminders(listField, markers, logEntries, logCap) {
  return updateDoc('appdata/state', [listField, 'telegram_log'], fields => {
    const list = (fields[listField] && fields[listField].arrayValue && fields[listField].arrayValue.values) || [];
    let stamped = 0;
    list.forEach(v => {
      const f = v && v.mapValue && v.mapValue.fields;
      const id = f && f.id && f.id.stringValue;
      const m = id && markers[id];
      if (!m) return;
      f.telegramNotifyLevel = fsInt(m.level);
      f.telegramNotifiedAt = fsString(m.at);
      stamped++;
    });
    const log = ((fields.telegram_log && fields.telegram_log.arrayValue && fields.telegram_log.arrayValue.values) || [])
      .concat(logEntries).slice(-logCap);
    const out = { telegram_log: { arrayValue: { values: log } } };
    // Leave the list untouched entirely if none of its items is still there to stamp.
    if (stamped) out[listField] = { arrayValue: { values: list } };
    return out;
  });
}

async function appendLog(logEntries, logCap) {
  if (!logEntries.length) return { written: false };
  return updateDoc('appdata/state', ['telegram_log'], fields => {
    const log = ((fields.telegram_log && fields.telegram_log.arrayValue && fields.telegram_log.arrayValue.values) || [])
      .concat(logEntries).slice(-logCap);
    return { telegram_log: { arrayValue: { values: log } } };
  });
}

module.exports = {
  BACKEND, YANDEX, DATA_API, DOCS, RUN_QUERY_URL, dbFetch, uploadPhoto, OWN_FILE_PREFIXES, fsString, fsInt, fsStringArray, clone,
  readDoc, updateDoc, registerFiles, acquireLease, releaseLease,
  recordReminders, appendLog,
};
