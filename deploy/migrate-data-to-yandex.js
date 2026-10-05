// Copies the app's data from Firestore into the Yandex data API (YDB), as it is right now.
// Run through deploy/migrate-data-to-yandex.ps1, which hands it the service key; run once for
// the rehearsal and once more, with -Force, at the switch itself.
//
//   1. Every document of `appdata` and `telegram_messages` is read from Firestore and written
//      whole to the data API — replacing what was there, so a re-run brings YDB back in line
//      with Firestore (the rehearsal's own edits included).
//   2. On the way, every Firebase Storage address of a file is replaced by its copy in Yandex
//      Object Storage, by way of the files registry — the files themselves were copied, under
//      the same ids, by copy-files-to-yandex.ps1, which must have run (again) first.
//   3. Each document is read back and compared with what was sent.
//   4. The passwords: the data API hashes the ones the copied appdata/state carries into
//      _auth/credentials and removes them from it (admin:importCredentials). They are never
//      read here — only Firestore's documents pass through, as they are.
//
// Prints counts and paths, never a value.

'use strict';

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents';
const API_KEY = 'AIzaSyAol7Oz5JSdqweqz1y1qVKkyXuj8Kq8alw'; // the app's public web key (service-manager.html)
const DATA_API = String(process.env.DATA_API_URL || 'https://d5do4n0o23evidqovr16.jki8ffxa.apigw.yandexcloud.net/db').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SERVICE_KEY;
const FORCE = process.argv.includes('--force');
const COLLECTIONS = ['appdata', 'telegram_messages'];

const FIREBASE_FILE = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/sad-budushego\.firebasestorage\.app\/o\/([^?#]+)\?alt=media&token=[0-9a-fA-F-]+$/;
const YANDEX_FILES = 'https://storage.yandexcloud.net/sad-budushego-files/files/';

if (!SERVICE_KEY) { console.error('SERVICE_KEY is not set (run through migrate-data-to-yandex.ps1)'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retrying(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= 5) throw new Error(what + ': ' + (e && e.message || e));
      await sleep(1000 * attempt);
    }
  }
}

async function listCollection(coll) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `${FIRESTORE}/${coll}?key=${API_KEY}&pageSize=100` + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const j = await retrying('list ' + coll, async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Firestore list ' + coll + ' → ' + r.status);
      return r.json();
    });
    for (const d of j.documents || []) docs.push(d);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}

const api = (method, rest, body) => retrying(method + ' ' + rest, async () => {
  const r = await fetch(DATA_API + '/' + rest, {
    method,
    headers: Object.assign({ 'X-Service-Key': SERVICE_KEY }, body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status >= 500) throw new Error(method + ' ' + rest + ' → ' + r.status + ' ' + text.slice(0, 200));
  return { status: r.status, text };
});

// Firebase object name (as it appears in the URL, "files%2F<name>") → the file's registry id.
function registryMap(registryDoc) {
  const out = new Map();
  const files = (registryDoc && registryDoc.fields && registryDoc.fields.files && registryDoc.fields.files.mapValue && registryDoc.fields.files.mapValue.fields) || {};
  for (const id of Object.keys(files)) {
    const f = (files[id].mapValue && files[id].mapValue.fields) || {};
    const url = f.url && f.url.stringValue;
    const m = url && FIREBASE_FILE.exec(url);
    if (m) out.set(m[1], id);
  }
  return out;
}

// A Firestore value with every Firebase file address replaced by its Yandex copy.
function rewrite(value, map, stats) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => rewrite(v, map, stats));
  const out = {};
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (k === 'stringValue' && typeof v === 'string' && v.startsWith('https://firebasestorage.googleapis.com/')) {
      const m = FIREBASE_FILE.exec(v);
      const id = m && map.get(m[1]);
      if (id) { out[k] = YANDEX_FILES + id; stats.rewritten++; }
      else { out[k] = v; stats.unmapped.add(m ? decodeURIComponent(m[1]) : v.slice(0, 120)); }
    } else {
      out[k] = rewrite(v, map, stats);
    }
  }
  return out;
}

const canonical = v => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
};

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// After the switch (--after-switch=<ISO time of the switch>): what still reached Firebase since.
// A tab that stayed open on the old version keeps writing there until it reloads — those
// documents are listed, to be carried over by hand (a blind copy could undo newer edits made
// in Yandex). Telegram messages that came in around the switch are copied over if missing.
async function afterSwitch(since) {
  const late = [];
  for (const coll of COLLECTIONS) {
    for (const d of await listCollection(coll)) {
      const path = d.name.split('/documents/')[1];
      if (d.updateTime > since) late.push({ path, d });
    }
  }
  let added = 0, had = 0;
  const appLate = [];
  for (const { path, d } of late) {
    if (!path.startsWith('telegram_messages/')) { appLate.push(path + '  (saved ' + d.updateTime + ')'); continue; }
    const r = await api('PATCH', 'v1/documents/' + path + '?currentDocument.exists=false', { fields: d.fields || {} });
    if (r.status === 200) added++; else if (r.status === 409) had++; else throw new Error('copy ' + path + ' → ' + r.status);
  }
  console.log(`telegram messages since ${since}: ${added} copied over, ${had} already in Yandex`);
  console.log(appLate.length ? `app documents saved to Firebase after the switch (${appLate.length}):\n   ` + appLate.join('\n   ') : 'app documents saved to Firebase after the switch: none');
}

const afterArg = process.argv.find(a => a.startsWith('--after-switch='));
if (afterArg) {
  afterSwitch(afterArg.split('=')[1]).catch(e => { console.error('FAILED: ' + (e && e.message || e)); process.exit(1); });
} else (async () => {
  const started = Date.now();
  const health = await api('GET', 'v1/health');
  if (health.status !== 200 || JSON.parse(health.text).role !== 'service') throw new Error('the data API does not accept the service key');

  const all = [];
  for (const coll of COLLECTIONS) {
    const docs = await listCollection(coll);
    console.log(`${coll}: ${docs.length} documents in Firestore`);
    for (const d of docs) all.push({ path: d.name.split('/documents/')[1], fields: d.fields || {} });
  }
  const reg = all.find(d => d.path === 'appdata/files_registry');
  const map = registryMap(reg);
  console.log(`files registry: ${map.size} Firebase addresses to rewrite`);

  // Files the data points at that are no longer in the registry — in practice photos in old
  // shared reports (share_*), deleted from the app since. Those still in Firebase are copied
  // too (under their own name, as the registry's files were), so the old links keep working
  // once Firebase is gone; those already gone from Firebase are left as they are.
  const outside = new Set();
  for (const d of all) {
    const scan = v => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(scan); return; }
      for (const k of Object.keys(v)) {
        if (k === 'stringValue' && typeof v[k] === 'string') { const m = FIREBASE_FILE.exec(v[k]); if (m && !map.has(m[1])) outside.add(v[k]); }
        else scan(v[k]);
      }
    };
    scan(d.fields);
  }
  let extraCopied = 0, extraThere = 0, extraGone = 0;
  for (const url of outside) {
    const obj = FIREBASE_FILE.exec(url)[1];
    const id = decodeURIComponent(obj).replace(/^files\//, '');
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) { extraGone++; continue; }
    const there = await retrying('HEAD ' + id, () => fetch(YANDEX_FILES + id, { method: 'HEAD' }));
    if (there.ok) { map.set(obj, id); extraThere++; continue; }
    const src = await retrying('GET ' + id, () => fetch(url));
    if (!src.ok) { extraGone++; continue; }
    const type = String(src.headers.get('content-type') || 'application/octet-stream');
    const buf = Buffer.from(await retrying('read ' + id, () => src.arrayBuffer()));
    const pr = await api('POST', 'v1/admin:presignCopy', { id, type });
    if (pr.status !== 200) throw new Error('presignCopy ' + id + ' → ' + pr.status);
    const p = JSON.parse(pr.text);
    const put = await retrying('PUT ' + id, () => fetch(p.uploadUrl, { method: 'PUT', headers: p.headers || { 'Content-Type': type }, body: buf }));
    const check = put.ok ? await retrying('HEAD ' + id, () => fetch(YANDEX_FILES + id, { method: 'HEAD' })) : null;
    if (!check || !check.ok || Number(check.headers.get('content-length')) !== buf.length) throw new Error('copy of ' + id + ' did not land');
    map.set(obj, id);
    extraCopied++;
  }
  if (outside.size) console.log(`files outside the registry: ${outside.size} — copied now ${extraCopied}, already in Yandex ${extraThere}, gone from Firebase ${extraGone}`);

  const stats = { rewritten: 0, unmapped: new Set() };
  for (const d of all) d.out = rewrite(d.fields, map, stats);
  console.log(`file addresses rewritten: ${stats.rewritten}; left as they were (gone from Firebase): ${stats.unmapped.size}`);

  // Write: the big appdata documents one by one, the messages several at a time.
  let written = 0;
  const write = async d => {
    const r = await api('PATCH', 'v1/documents/' + d.path, { fields: d.out });
    if (r.status !== 200) throw new Error('write ' + d.path + ' → ' + r.status + ' ' + r.text.slice(0, 200));
    written++;
    if (written % 200 === 0) console.log(`  written ${written}/${all.length}`);
  };
  for (const d of all.filter(x => x.path.startsWith('appdata/'))) await write(d);
  await pool(all.filter(x => !x.path.startsWith('appdata/')), 8, write);
  console.log(`written: ${written}/${all.length}`);

  // Read back and compare.
  let same = 0;
  const differ = [];
  await pool(all, 8, async d => {
    const r = await api('GET', 'v1/documents/' + d.path);
    const got = r.status === 200 ? (JSON.parse(r.text).fields || {}) : null;
    if (got && canonical(got) === canonical(d.out)) same++; else differ.push(d.path + (got ? '' : ' (' + r.status + ')'));
  });
  console.log(`read back identical: ${same}/${all.length}`);
  if (differ.length) { differ.slice(0, 20).forEach(p => console.log('   DIFFERS: ' + p)); throw new Error(differ.length + ' documents differ after the copy'); }

  const imp = await api('POST', 'v1/admin:importCredentials', FORCE ? { force: true } : {});
  if (imp.status !== 200) throw new Error('importCredentials → ' + imp.status + ' ' + imp.text.slice(0, 200));
  const ib = JSON.parse(imp.text);
  console.log(ib.kept
    ? `passwords: kept those already in Yandex; ${ib.removedFromState} credential fields removed from appdata/state`
    : `passwords: ${ib.roles} accounts and ${ib.providers} providers hashed; ${ib.removedFromState} credential fields removed from appdata/state`);

  console.log(`DONE in ${Math.round((Date.now() - started) / 1000)} s`);
})().catch(e => { console.error('FAILED: ' + (e && e.message || e)); process.exit(1); });
