// The budgets' documents that exist only as Google Drive links — the history imported from the old
// sheets, about 620 invoices on 2026-10-15 — copied into the app's own files. Each link stays where
// it is; beside it the invoice gets the document itself, so that it opens fast in Russia without a
// VPN, the invoice reader (🤖 Заполнить позиции из счёта) can read it, and the nightly backup holds
// it. The documents are shared on Drive as "anyone with the link", so no Google sign-in is needed.
//
//   node selfhost/drive-docs.js fetch <snapshot.json.gz> <cacheDir>
//        As anyone, the app running: every Drive document the snapshot's budgets link to is
//        downloaded into cacheDir — once (by its Drive id), whatever the run before got kept.
//   sadb-admin drive-docs <cacheDir>      (deploy\selfhost-windows.ps1 -DriveDocs, the app stopped)
//        Into the data: each cached document becomes a file of the app (data\files), an entry of
//        the files registry, and a reference on its invoice, next to the link (fromDrive: the
//        link). One not cached yet is downloaded then. Run again, it adds nothing twice.
//
// Folder links, documents Drive refuses, and anything that comes back as a web page instead of a
// file are left as links and counted.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const STATE_DOC = 'appdata/state', LEDGER_DOC = 'appdata/finance_ledger', FILES_DOC = 'appdata/files_registry';
// Where the budgets are: [document, field].
const LISTS = [[LEDGER_DOC, 'finance_tx_maintenance'], [LEDGER_DOC, 'finance_tx_personal'], [STATE_DOC, 'finance_tx_kitchen']];
const MAX_BYTES = 50 * 1024 * 1024;

// A Drive address → what it is and its id; null when it isn't Drive's.
function driveRef(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return null; }
  const id = s => (/^[A-Za-z0-9_-]{10,}$/.test(s || '') ? s : null);
  if (u.hostname === 'drive.google.com') {
    let m = /^\/file\/d\/([^/]+)/.exec(u.pathname);
    if (m && id(m[1])) return { kind: 'file', id: m[1] };
    m = /^\/drive\/(?:u\/\d+\/)?folders\/([^/?]+)/.exec(u.pathname);
    if (m && id(m[1])) return { kind: 'folder', id: m[1] };
    if (/^\/(open|uc)$/.test(u.pathname) && id(u.searchParams.get('id'))) return { kind: 'file', id: u.searchParams.get('id') };
    return null;
  }
  if (u.hostname === 'docs.google.com') {
    const m = /^\/(document|spreadsheets|presentation)\/d\/([^/]+)/.exec(u.pathname);
    if (m && id(m[2])) return { kind: m[1], id: m[2] };
  }
  return null;
}
// Where its bytes can be had, in order.
function downloadUrls(ref) {
  if (ref.kind === 'file') return [
    'https://drive.usercontent.google.com/download?id=' + ref.id + '&export=download&confirm=t',
    'https://drive.google.com/uc?export=download&id=' + ref.id,
  ];
  if (ref.kind === 'document' || ref.kind === 'spreadsheets' || ref.kind === 'presentation') {
    return ['https://docs.google.com/' + ref.kind + '/d/' + ref.id + '/export?format=pdf'];
  }
  return [];
}
const cacheKey = ref => ref.kind + '-' + ref.id;

// What the bytes are. A web page (Drive's "no access" or "can't scan" page) is not a document.
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', zip: 'application/zip' };
function typeOf(buf, name, header) {
  const head = buf.slice(0, 16);
  if (head.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(head.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (/^\s*</.test(buf.slice(0, 64).toString('latin1'))) return null;   // a web page
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(name || '') || [])[1];
  if (ext && EXT_TYPES[ext.toLowerCase()]) return EXT_TYPES[ext.toLowerCase()];
  const h = String(header || '').split(';')[0].trim().toLowerCase();
  return h && h !== 'text/html' && h !== 'application/octet-stream' ? h : 'application/octet-stream';
}
function nameFrom(disposition) {
  const d = String(disposition || '');
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(d);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch (e) {} }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(d) || /filename\s*=\s*([^;]+)/i.exec(d);
  return plain ? plain[1].trim() : '';
}

// One Drive document → { ok, buf, type, name } or { ok: false, error }.
async function fetchDoc(ref, fetchImpl) {
  const get = fetchImpl || fetch;
  let last = 'nothing to download';
  for (const url of downloadUrls(ref)) {
    try {
      const r = await get(url, { redirect: 'follow', signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' } });
      if (!r.ok) { last = 'Drive answered ' + r.status; continue; }
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_BYTES) { last = 'over 50 MB'; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) { last = buf.length ? 'over 50 MB' : 'empty'; continue; }
      const name = nameFrom(r.headers.get('content-disposition'));
      const type = typeOf(buf, name, r.headers.get('content-type'));
      if (!type) { last = 'a web page, not a document (no access?)'; continue; }
      return { ok: true, buf, type, name };
    } catch (e) { last = String(e && e.message || e); }
  }
  return { ok: false, error: last };
}

// The cache: <key>.bin (the bytes) and <key>.json ({ ok, name, type, size, error }).
function cached(cacheDir, ref) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheKey(ref) + '.json'), 'utf8'));
    if (!meta.ok) return meta;
    return Object.assign(meta, { file: path.join(cacheDir, cacheKey(ref) + '.bin') });
  } catch (e) { return null; }
}
async function fetchToCache(cacheDir, ref, fetchImpl) {
  const got = await fetchDoc(ref, fetchImpl);
  const base = path.join(cacheDir, cacheKey(ref));
  if (got.ok) {
    fs.writeFileSync(base + '.bin.part', got.buf);
    fs.renameSync(base + '.bin.part', base + '.bin');
    fs.writeFileSync(base + '.json', JSON.stringify({ ok: true, name: got.name, type: got.type, size: got.buf.length }));
  } else fs.writeFileSync(base + '.json', JSON.stringify({ ok: false, error: got.error }));
  return cached(cacheDir, ref);
}

// The link references of the budgets' records (decoded, as in a snapshot): [{ url, name, ref }].
const refsOf = t => (Array.isArray(t && t.fileRefs) ? t.fileRefs : t && t.fileRef ? [t.fileRef] : []).filter(Boolean);
function linksIn(docs) {
  const out = new Map();
  for (const [p, n] of LISTS) {
    const list = ((docs[p] || {}).fields || {})[n];
    for (const t of Array.isArray(list) ? list : []) {
      for (const f of refsOf(t)) {
        if (f.id || !f.url) continue;
        const ref = driveRef(f.url);
        if (ref && !out.has(cacheKey(ref))) out.set(cacheKey(ref), { url: f.url, name: f.name || '', ref });
      }
    }
  }
  return [...out.values()];
}

// `fetch`: every Drive document of a snapshot's budgets into the cache, four at a time.
async function fetchAll(snapshotFile, cacheDir, { fetchImpl, log } = {}) {
  const say = log || (() => {});
  fs.mkdirSync(cacheDir, { recursive: true });
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshotFile)).toString('utf8'));
  const links = linksIn(snap.documents || {});
  const todo = links.filter(l => l.ref.kind !== 'folder' && !(cached(cacheDir, l.ref) || {}).ok);
  say(`${links.length} Drive links (${links.filter(l => l.ref.kind === 'folder').length} folders); ${links.length - todo.length} already here or folders; ${todo.length} to download`);
  const res = { links: links.length, folders: links.filter(l => l.ref.kind === 'folder').length, downloaded: 0, failed: [] };
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < todo.length) {
      const l = todo[next++];
      const c = await fetchToCache(cacheDir, l.ref, fetchImpl);
      if (c && c.ok) res.downloaded++; else res.failed.push({ url: l.url, error: c ? c.error : 'not saved' });
      if ((res.downloaded + res.failed.length) % 50 === 0) say(`… ${res.downloaded + res.failed.length} of ${todo.length}`);
    }
  }));
  say(`downloaded ${res.downloaded}, not downloaded ${res.failed.length}`);
  return res;
}

// ---- into the data (raw Firestore Values, as the store keeps them) ----
const S = v => ({ stringValue: String(v) });
const I = v => ({ integerValue: String(v) });
const mapFields = v => (v && v.mapValue && v.mapValue.fields) || {};
const listValues = v => (v && v.arrayValue && v.arrayValue.values) || [];
const str = v => (v && typeof v.stringValue === 'string' ? v.stringValue : '');

// `drive-docs`: each record of the budgets whose document is a Drive link gets the document itself
// beside it. store: the app's store (selfhost/store-file.js), the app stopped.
async function attachAll(store, { cacheDir, filesDir, publicOrigin, now, fetchImpl, log, nextTime }) {
  const say = log || (() => {});
  const clock = now || (() => Date.now());
  const newId = () => Date.now().toString(36) + crypto.randomBytes(10).toString('hex');
  const res = { records: 0, attached: 0, already: 0, folders: 0, failed: [] };
  const registryAdds = {};
  const madeFor = new Map();   // cache key → the file made for it in this run (one document, many invoices)

  function fileFor(ref) {
    if (madeFor.has(cacheKey(ref))) return madeFor.get(cacheKey(ref));
    const c = cached(cacheDir, ref);
    if (!c || !c.ok) return null;
    const id = newId();
    const name = c.name || 'Документ' + (c.type === 'application/pdf' ? '.pdf' : '');
    fs.copyFileSync(c.file, path.join(filesDir, id));
    fs.writeFileSync(path.join(filesDir, id + '.meta'), JSON.stringify({ type: c.type, disposition: "inline; filename*=UTF-8''" + encodeURIComponent(name.slice(0, 200)) }));
    const size = fs.statSync(path.join(filesDir, id)).size;
    registryAdds[id] = { mapValue: { fields: { id: S(id), name: S(name), type: S(c.type), size: I(size), url: S(publicOrigin + '/files/' + id) } } };
    // As the page hashes an uploaded document (_fileContentHash: SHA-256 of its data: URL), so the
    // same PDF uploaded again is recognised as an invoice already entered.
    const hash = c.type === 'application/pdf'
      ? crypto.createHash('sha256').update('data:application/pdf;base64,' + fs.readFileSync(c.file).toString('base64')).digest('hex') : '';
    const made = { id, name, type: c.type, size, hash };
    madeFor.set(cacheKey(ref), made);
    return made;
  }

  // One record (a mapValue): its references with the documents put in, or null if unchanged.
  async function withDocs(rec) {
    const f = mapFields(rec);
    const refs = f.fileRefs && f.fileRefs.arrayValue ? listValues(f.fileRefs) : f.fileRef && f.fileRef.mapValue ? [f.fileRef] : [];
    const done = new Set(refs.map(r => str(mapFields(r).fromDrive)).filter(Boolean));
    const out = [];
    let changed = false;
    for (const r of refs) {
      const rf = mapFields(r);
      const url = str(rf.url);
      const ref = !str(rf.id) && url ? driveRef(url) : null;
      if (ref && ref.kind === 'folder') res.folders++;
      if (ref && ref.kind !== 'folder') {
        if (done.has(url)) res.already++;
        else {
          if (!(cached(cacheDir, ref) || {}).ok && !madeFor.has(cacheKey(ref))) await fetchToCache(cacheDir, ref, fetchImpl);
          const made = fileFor(ref);
          if (!made) res.failed.push({ url, error: (cached(cacheDir, ref) || {}).error || 'not downloaded' });
          else {
            const own = { id: S(made.id), name: S(made.name), type: S(made.type), size: I(made.size), fromDrive: S(url) };
            if (made.hash) own.hash = S(made.hash);
            out.push({ mapValue: { fields: own } });
            res.attached++;
            changed = true;
          }
        }
      }
      out.push(r);
    }
    if (!changed) return null;
    res.records++;
    const fields = Object.assign({}, f, { fileRefs: { arrayValue: { values: out } }, fileRef: out[0] });
    return { mapValue: { fields } };
  }

  // Each document: its lists, records changed in place; written once, with a new update time so
  // every open page takes it up.
  const byDoc = {};
  for (const [p, n] of LISTS) (byDoc[p] = byDoc[p] || []).push(n);
  for (const p of Object.keys(byDoc)) {
    await store.transact(p, async tx => {
      const meta = await tx.meta();
      if (!meta) return;
      const texts = await tx.fields(byDoc[p]);
      const upserts = {};
      for (const n of Object.keys(texts)) {
        const v = JSON.parse(texts[n]);
        if (!v || !v.arrayValue) continue;
        let any = false;
        const values = [];
        for (const rec of listValues(v)) { const nv = await withDocs(rec); values.push(nv || rec); if (nv) any = true; }
        if (any) upserts[n] = JSON.stringify({ arrayValue: { values } });
      }
      if (!Object.keys(upserts).length) return;
      await tx.write({ collection: 'appdata', upserts, deletes: [], createTime: meta.createTime, updateTime: nextTime(meta.updateTime, clock()), qdate: meta.qdate || null });
    });
  }
  if (Object.keys(registryAdds).length) {
    await store.transact(FILES_DOC, async tx => {
      const meta = await tx.meta();
      const cur = JSON.parse((await tx.fields(['files'])).files || '{"mapValue":{"fields":{}}}');
      const fields = Object.assign({}, mapFields(cur), registryAdds);
      const t = nextTime(meta && meta.updateTime, clock());
      await tx.write({ collection: 'appdata', upserts: { files: JSON.stringify({ mapValue: { fields } }) }, deletes: [], createTime: meta ? meta.createTime : t, updateTime: t, qdate: meta ? meta.qdate || null : null });
    });
  }
  say(`records given their documents: ${res.records}; documents attached: ${res.attached} (files made: ${madeFor.size}); already done before: ${res.already}; folder links left as they are: ${res.folders}; not attached: ${res.failed.length}`);
  for (const f of res.failed.slice(0, 20)) say('  not attached: ' + f.url + ' — ' + f.error);
  return res;
}

module.exports = { driveRef, downloadUrls, typeOf, nameFrom, fetchDoc, linksIn, fetchAll, attachAll };

if (require.main === module) {
  const [cmd, snapshot, cacheDir] = process.argv.slice(2);
  if (cmd !== 'fetch' || !snapshot || !cacheDir) { console.error('Usage: node selfhost/drive-docs.js fetch <snapshot.json.gz> <cacheDir>'); process.exit(1); }
  fetchAll(path.resolve(snapshot), path.resolve(cacheDir), { log: m => console.log(m) })
    .then(r => { for (const f of r.failed.slice(0, 30)) console.log('  ' + f.url + ' — ' + f.error); process.exitCode = r.failed.length ? 2 : 0; })
    .catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
}
