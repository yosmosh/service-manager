// The part of Firestore's REST API the app and its server functions use, re-created over our
// own store in Yandex Cloud: read a document (whole, or only some fields), write some of its
// fields — optionally only if nobody else has written it since a known version — and find
// Telegram messages from a given time on. The app's own merge logic (service-manager.html,
// _flushState) is built on exactly these semantics, so it works unchanged on top of them.
//
// Pure: no I/O, no Node-only modules — tested in the browser against an in-memory store.
// A document is { createTime, updateTime, fields }, fields mapping a top-level name to a
// Firestore Value ({ stringValue }, { mapValue: { fields } }, …) kept as Firestore sends it.

'use strict';

const DOC_PREFIX = 'projects/sad-budushego/databases/(default)/documents/';

// A field path — "files", "files.abc", "`a.b`.c" — as its segments.
function splitFieldPath(p) {
  const out = [];
  let i = 0;
  const s = String(p);
  while (i < s.length) {
    if (s[i] === '`') {
      let j = i + 1, seg = '';
      while (j < s.length && s[j] !== '`') { if (s[j] === '\\' && j + 1 < s.length) j++; seg += s[j]; j++; }
      out.push(seg); i = j + 1;
    } else {
      let j = s.indexOf('.', i);
      if (j === -1) j = s.length;
      out.push(s.slice(i, j)); i = j;
    }
    if (s[i] === '.') i++;
  }
  return out.filter(x => x !== '');
}

const isMap = v => !!v && typeof v === 'object' && v.mapValue && typeof v.mapValue === 'object';

function getAt(fields, segs) {
  let cur = fields;
  for (let k = 0; k < segs.length; k++) {
    if (!cur || !Object.prototype.hasOwnProperty.call(cur, segs[k])) return undefined;
    const v = cur[segs[k]];
    if (k === segs.length - 1) return v;
    if (!isMap(v)) return undefined;
    cur = v.mapValue.fields || {};
  }
  return undefined;
}

// Sets (or, with value undefined, removes) the value at a path, creating maps on the way.
function putAt(fields, segs, value) {
  let cur = fields;
  for (let k = 0; k < segs.length - 1; k++) {
    let v = cur[segs[k]];
    if (!isMap(v)) {
      if (value === undefined) return;
      v = cur[segs[k]] = { mapValue: { fields: {} } };
    }
    v.mapValue.fields = v.mapValue.fields || {};
    cur = v.mapValue.fields;
  }
  const last = segs[segs.length - 1];
  if (value === undefined) delete cur[last]; else cur[last] = value;
}

// Only the masked paths of a document's fields, the way Firestore returns them.
function maskFields(fields, maskPaths) {
  if (!maskPaths || !maskPaths.length) return fields;
  const out = {};
  for (const p of maskPaths) {
    const segs = splitFieldPath(p);
    if (!segs.length) continue;
    const v = getAt(fields, segs);
    if (v !== undefined) putAt(out, segs, JSON.parse(JSON.stringify(v)));
  }
  return out;
}

// The top-level fields a write touches, and which of them it needs the current value of:
// a nested path ("files.abc") changes part of a top-level field, so that field is read first.
function patchPlan(maskPaths) {
  const touched = new Set(), needCurrent = new Set();
  for (const p of maskPaths) {
    const segs = splitFieldPath(p);
    if (!segs.length) continue;
    touched.add(segs[0]);
    if (segs.length > 1) needCurrent.add(segs[0]);
  }
  return { touched: [...touched], needCurrent: [...needCurrent] };
}

// Applies a write. With a mask, only the masked paths change: set from the body where the
// body has them, removed where it doesn't (Firestore's rule). Without one, the body replaces
// the document's fields. `current` holds at least the fields patchPlan asked for.
// Returns { upserts: { name: Value }, deletes: [name] } — top-level fields to write.
function applyPatch(current, body, maskPaths) {
  body = body || {};
  if (!maskPaths || !maskPaths.length) {
    const upserts = {};
    for (const k of Object.keys(body)) upserts[k] = body[k];
    return { upserts, deletes: null }; // null: every other field goes
  }
  const plan = patchPlan(maskPaths);
  const next = {};
  for (const name of plan.touched) {
    if (current[name] !== undefined) next[name] = JSON.parse(JSON.stringify(current[name]));
  }
  for (const p of maskPaths) {
    const segs = splitFieldPath(p);
    if (!segs.length) continue;
    putAt(next, segs, getAt(body, segs));
  }
  const upserts = {}, deletes = [];
  for (const name of plan.touched) {
    if (next[name] === undefined) deletes.push(name); else upserts[name] = next[name];
  }
  return { upserts, deletes };
}

// Versions: strictly increasing, distinct per write — Firestore's updateTime, which the
// app compares for equality only. Microseconds, so two writes in one millisecond differ.
function nextTime(prev, nowMs) {
  const ms = nowMs == null ? Date.now() : nowMs;
  let candidate = new Date(ms).toISOString().replace('Z', '000Z');
  if (prev && candidate <= prev) {
    // Same millisecond (or a clock step back): one microsecond past the previous version.
    const m = /^(.*\.)(\d{6})Z$/.exec(prev);
    if (m) {
      let micros = Number(m[2]) + 1;
      if (micros > 999999) return nextTime(null, Date.parse(prev) + 1);
      candidate = m[1] + String(micros).padStart(6, '0') + 'Z';
    } else {
      candidate = new Date(Date.parse(prev) + 1).toISOString().replace('Z', '000Z');
    }
  }
  return candidate;
}

// "appdata/state" → { collection: "appdata", id: "state" }. Only collection/document pairs.
function parseDocPath(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  if (!/^[A-Za-z0-9_\-]{1,100}$/.test(parts[0]) || !/^[A-Za-z0-9_\-.]{1,200}$/.test(parts[1])) return null;
  return { collection: parts[0], id: parts[1], path: parts[0] + '/' + parts[1] };
}

const docName = path => DOC_PREFIX + path;

// The one query in use: a collection's documents with `date` at or after a time, by date.
function parseRunQuery(body) {
  const q = body && body.structuredQuery;
  if (!q || !Array.isArray(q.from) || q.from.length !== 1) return null;
  const collection = q.from[0].collectionId;
  const f = q.where && q.where.fieldFilter;
  if (!collection || !f || !f.field || f.field.fieldPath !== 'date' || f.op !== 'GREATER_THAN_OR_EQUAL') return null;
  const v = f.value || {};
  const since = v.timestampValue || v.stringValue;
  if (!since) return null;
  const order = (q.orderBy || [])[0];
  const descending = !!(order && order.direction === 'DESCENDING');
  const limit = q.limit ? Number(q.limit.value != null ? q.limit.value : q.limit) : 0;
  return { collection, since: String(since), descending, limit: limit > 0 ? limit : 0 };
}

// A document's `date` as stored for querying: a timestamp or ISO string value.
function queryDate(fields) {
  const v = fields && fields.date;
  if (!v) return null;
  return v.timestampValue || v.stringValue || null;
}

// Who may do what. service: the server functions — everything. A signed-in user: the
// app's documents and files. Nobody: only a share link's own document. Documents in
// collections starting with "_" (credentials, sessions) are the server's alone.
function allowed(role, action, docPath) {
  if (role === 'service') return true;
  const p = parseDocPath(docPath || '');
  if (action === 'file') return !!role;
  if (!p) return false;
  if (p.collection.startsWith('_')) return false;
  if (!role) return action === 'read' && p.collection === 'appdata' && p.id.startsWith('share_');
  if (p.collection === 'appdata') return !p.id.startsWith('_auth');
  if (p.collection === 'telegram_messages') return action === 'read';
  return false;
}

module.exports = {
  DOC_PREFIX, splitFieldPath, getAt, putAt, maskFields, patchPlan, applyPatch, nextTime,
  parseDocPath, docName, parseRunQuery, queryDate, allowed,
};
