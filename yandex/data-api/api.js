// The data API's requests, independent of where data lives: given a store (YDB in the cloud,
// a Map in tests), who is asking (auth) and the file bucket (files), turns a request into a
// response. Firestore's REST shapes in and out, so the app's code only changes its address.
//
//   GET    v1/documents/{collection}/{id}[?mask.fieldPaths=…]
//   PATCH  v1/documents/{collection}/{id}[?updateMask.fieldPaths=…][&currentDocument.updateTime=…|exists=…]
//   DELETE v1/documents/{collection}/{id}
//   POST   v1/documents:runQuery            (date ≥ since on one collection — the one query in use)
//   POST   v1/files:presign                 → where to PUT a new file, and its address
//   DELETE v1/files/{id}
//   POST   v1/auth:login                    → a token for the app (accounts.js)
//   GET    v1/auth:accounts                 the account names, for the settings screen
//   POST   v1/auth:setAccount               a new name and/or password for one account
//   POST   v1/images:search / images:fetch  product photos from Yandex's image search (images.js)
//   GET    v1/health
//   POST   v1/admin:setup                   (service only — creates the tables)
//   POST   v1/admin:importCredentials       (service only — the move: passwords out of state)
//
// Store: meta(path), read(path, names|null), transact(path, fn), query(...), setup().
// Field values travel through the store as JSON text, so a big document is passed on as it
// came rather than parsed and re-serialised on every read.

'use strict';

const core = require('./core');

class HttpError extends Error {
  constructor(status, statusText, message) { super(message); this.status = status; this.statusText = statusText; }
}
const precondition = msg => new HttpError(400, 'FAILED_PRECONDITION', msg || 'FAILED_PRECONDITION: the stored version of the document differs');

const one = (q, k) => { const v = q[k]; return Array.isArray(v) ? v[v.length - 1] : v; };
const many = (q, k) => { const v = q[k]; return v == null ? [] : Array.isArray(v) ? v : [v]; };

const json = (status, obj) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const errorBody = e => ({ error: { code: e.status || 500, message: e.message || String(e), status: e.statusText || 'INTERNAL' } });

// {"name":…,"fields":{…},"createTime":…,"updateTime":…} with the field values spliced in as
// stored text. Firestore leaves "fields" out when there are none.
function docJson(path, meta, fieldTexts) {
  const names = Object.keys(fieldTexts || {});
  let s = '{"name":' + JSON.stringify(core.docName(path));
  if (names.length) s += ',"fields":{' + names.map(n => JSON.stringify(n) + ':' + fieldTexts[n]).join(',') + '}';
  return s + ',"createTime":' + JSON.stringify(meta.createTime) + ',"updateTime":' + JSON.stringify(meta.updateTime) + '}';
}

// Who keeps the warehouse — they alone search the web for product photos (images.js); and
// the service key, for checking it works.
const IMAGE_ROLES = ['owner', 'admin', 'service'];

function createApi({ store, auth, files, accounts, images, now }) {
  const clock = now || (() => Date.now());

  async function getDoc(path, query) {
    const mask = many(query, 'mask.fieldPaths');
    const topNames = mask.length ? [...new Set(mask.map(p => core.splitFieldPath(p)[0]).filter(Boolean))] : null;
    const doc = await store.read(path, topNames);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found: ' + path);
    let texts = doc.fields;
    // A nested mask path returns only that part of its field.
    if (mask.some(p => core.splitFieldPath(p).length > 1)) {
      const parsed = {};
      for (const n of Object.keys(texts)) parsed[n] = JSON.parse(texts[n]);
      const masked = core.maskFields(parsed, mask);
      texts = {};
      for (const n of Object.keys(masked)) texts[n] = JSON.stringify(masked[n]);
    }
    return json(200, docJson(path, doc.meta, texts));
  }

  async function patchDoc(p, query, rawBody) {
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch (e) { throw new HttpError(400, 'INVALID_ARGUMENT', 'Body is not JSON'); }
    const fields = (body && body.fields) || {};
    const mask = many(query, 'updateMask.fieldPaths');
    const ifTime = one(query, 'currentDocument.updateTime');
    const exists = one(query, 'currentDocument.exists');
    const result = await store.transact(p.path, async tx => {
      const meta = await tx.meta();
      if (ifTime && (!meta || meta.updateTime !== ifTime)) throw precondition();
      if (exists === 'false' && meta) throw new HttpError(409, 'ALREADY_EXISTS', 'Document already exists: ' + p.path);
      if (exists === 'true' && !meta) throw new HttpError(404, 'NOT_FOUND', 'Document not found: ' + p.path);
      const plan = mask.length ? core.patchPlan(mask) : { needCurrent: [] };
      const current = {};
      if (plan.needCurrent.length) {
        const texts = await tx.fields(plan.needCurrent);
        for (const n of Object.keys(texts)) current[n] = JSON.parse(texts[n]);
      }
      const change = core.applyPatch(current, fields, mask);
      const updateTime = core.nextTime(meta && meta.updateTime, clock());
      const createTime = meta ? meta.createTime : updateTime;
      // What the time-ordered query reads for this document after the write.
      let qdate = meta ? meta.qdate || null : null;
      if (change.upserts.date !== undefined) qdate = core.queryDate(change.upserts);
      else if (change.deletes === null || change.deletes.includes('date')) qdate = null;
      const upserts = {};
      for (const n of Object.keys(change.upserts)) upserts[n] = JSON.stringify(change.upserts[n]);
      await tx.write({ collection: p.collection, upserts, deletes: change.deletes, createTime, updateTime, qdate });
      return { createTime, updateTime };
    });
    return json(200, { name: core.docName(p.path), createTime: result.createTime, updateTime: result.updateTime });
  }

  async function deleteDoc(p, query) {
    const ifTime = one(query, 'currentDocument.updateTime');
    await store.transact(p.path, async tx => {
      const meta = await tx.meta();
      if (ifTime && (!meta || meta.updateTime !== ifTime)) throw precondition();
      if (meta) await tx.remove();
    });
    return json(200, {});
  }

  async function runQuery(role, rawBody) {
    let body;
    try { body = JSON.parse(rawBody || '{}'); } catch (e) { throw new HttpError(400, 'INVALID_ARGUMENT', 'Body is not JSON'); }
    const q = core.parseRunQuery(body);
    if (!q) throw new HttpError(400, 'INVALID_ARGUMENT', 'Only a date ≥ query on one collection is supported');
    if (!core.allowed(role, 'read', q.collection + '/x')) throw new HttpError(403, 'PERMISSION_DENIED', 'Not allowed');
    const rows = await store.query(q.collection, q.since, q.descending, q.limit);
    const readTime = new Date(clock()).toISOString();
    if (!rows.length) return json(200, '[{"readTime":' + JSON.stringify(readTime) + '}]');
    return json(200, '[' + rows.map(r => '{"document":' + docJson(r.path, r.meta, r.fields) + ',"readTime":' + JSON.stringify(readTime) + '}').join(',') + ']');
  }

  async function handle(req) {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const rest = String(req.rest || '').replace(/^\/+/, '');
      const query = req.query || {};
      const role = await auth.identify(req.headers || {}, accounts ? accounts.tokenCurrent : null);

      if (method === 'GET' && rest === 'v1/health') return json(200, { ok: true, role: role || null });

      if (rest === 'v1/admin:setup' && method === 'POST') {
        if (role !== 'service') throw new HttpError(403, 'PERMISSION_DENIED', 'Not allowed');
        await store.setup();
        return json(200, { ok: true });
      }

      // The move from Firebase: a PUT for a file that keeps the id it already has, so the
      // registry's entries stay valid. Service only — nobody else chooses a file's id.
      if (rest === 'v1/admin:presignCopy' && method === 'POST') {
        if (role !== 'service') throw new HttpError(403, 'PERMISSION_DENIED', 'Not allowed');
        let b = {};
        try { b = JSON.parse(req.body || '{}'); } catch (e) { /* checked below */ }
        if (!/^[A-Za-z0-9_-]{6,80}$/.test(String(b.id || ''))) throw new HttpError(400, 'INVALID_ARGUMENT', 'A file id is required');
        return json(200, await files.presignUpload({ type: String(b.type || 'application/octet-stream'), id: String(b.id) }));
      }

      if (accounts && rest.startsWith('v1/auth:')) {
        let b = {};
        if (method === 'POST') { try { b = JSON.parse(req.body || '{}'); } catch (e) { throw new HttpError(400, 'INVALID_ARGUMENT', 'Body is not JSON'); } }
        const signIn = { status: 401, body: { error: 'Войдите в систему' } };
        let r = null;
        if (rest === 'v1/auth:login' && method === 'POST') r = await accounts.login({ username: b.username, password: b.password, ip: req.ip });
        else if (rest === 'v1/auth:accounts' && method === 'GET') r = role ? await accounts.list(role) : signIn;
        else if (rest === 'v1/auth:setAccount' && method === 'POST') r = role ? await accounts.setAccount(role, b) : signIn;
        if (r) return json(r.status, r.body);
      }

      if (images && (rest === 'v1/images:search' || rest === 'v1/images:fetch') && method === 'POST') {
        if (!role) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
        if (!IMAGE_ROLES.includes(role)) throw new HttpError(403, 'PERMISSION_DENIED', 'Not allowed');
        let b = {};
        try { b = JSON.parse(req.body || '{}'); } catch (e) { throw new HttpError(400, 'INVALID_ARGUMENT', 'Body is not JSON'); }
        if (rest === 'v1/images:search') {
          let results;
          try { results = await images.search(b.query, b.page, req.iamToken); }
          catch (e) { throw new HttpError(502, 'UNAVAILABLE', 'Поиск фото сейчас недоступен'); }
          return json(200, { results });
        }
        const got = await images.fetchImage({ url: String(b.url || ''), thumb: String(b.thumb || ''), sig: String(b.sig || '') });
        if (got && got.error) throw new HttpError(400, 'INVALID_ARGUMENT', 'Not an address from the search');
        if (!got) return json(422, { error: 'Это фото не удалось загрузить — выберите другое' });
        return json(200, got);
      }

      if (accounts && rest === 'v1/admin:importCredentials' && method === 'POST') {
        if (role !== 'service') throw new HttpError(403, 'PERMISSION_DENIED', 'Not allowed');
        let b = {};
        try { b = JSON.parse(req.body || '{}'); } catch (e) { /* defaults */ }
        const r = await accounts.importFromState({ force: !!b.force });
        return json(r.status, r.body);
      }

      if (rest === 'v1/documents:runQuery' && method === 'POST') return await runQuery(role, req.body);

      if (rest === 'v1/files:presign' && method === 'POST') {
        if (!core.allowed(role, 'file')) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
        let b = {};
        try { b = JSON.parse(req.body || '{}'); } catch (e) { /* defaults */ }
        return json(200, await files.presignUpload({ name: String(b.name || 'file'), type: String(b.type || 'application/octet-stream') }));
      }
      const fm = /^v1\/files\/([A-Za-z0-9_-]{6,80})$/.exec(rest);
      if (fm && method === 'DELETE') {
        if (!core.allowed(role, 'file')) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
        await files.remove(fm[1]);
        return json(200, {});
      }

      const dm = /^v1\/documents\/(.+)$/.exec(rest);
      if (dm) {
        const p = core.parseDocPath(decodeURIComponent(dm[1]));
        if (!p) throw new HttpError(400, 'INVALID_ARGUMENT', 'Not a document path: ' + dm[1]);
        const action = method === 'GET' ? 'read' : 'write';
        if (!core.allowed(role, action, p.path)) {
          throw role ? new HttpError(403, 'PERMISSION_DENIED', 'Not allowed: ' + p.path) : new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
        }
        if (method === 'GET') return await getDoc(p.path, query);
        if (method === 'PATCH') return await patchDoc(p, query, req.body);
        if (method === 'DELETE') return await deleteDoc(p, query);
      }
      throw new HttpError(404, 'NOT_FOUND', 'No such route: ' + method + ' ' + rest);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500 && typeof console !== 'undefined') console.error('data-api error', e && e.stack || e);
      return json(status, errorBody(e instanceof HttpError ? e : { status: 500, message: 'Internal error: ' + (e && e.message || e), statusText: 'INTERNAL' }));
    }
  }

  return { handle };
}

module.exports = { createApi, HttpError };
