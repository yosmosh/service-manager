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

// ---- what each account is given of the budgets ----
// The app's screens show every role its own part of the budgets, but the server used to hand any
// signed-in account the whole document on request: the kitchen, the storekeeper, any of the
// providers could read Личный бюджет with its cash records and the links to their documents
// (the receipts with passports among them). Now the server itself gives only that part:
//   Личный бюджет (finance_tx_personal): the owner and the administrators — and the accountant
//     its records other than cash (she pays the funds that go through a bank; cash never
//     passes through her);
//   its payouts for employees' receipts (finance_settlements): the owner and the administrators;
//   the files registry: without the documents of the records a role isn't given.
// Writes keep to the same part. The accountant's write of Личный бюджет keeps the cash records as
// the server has them; anyone else writing either field is refused.
const LEDGER_DOC = 'appdata/finance_ledger', FILES_DOC = 'appdata/files_registry';
const BUDGET_ROLES = ['service', 'owner', 'admin', 'admin2'];
const CASH_FUND = 'Наличные';
const limited = role => !BUDGET_ROLES.includes(role);
const strOf = v => (v && typeof v.stringValue === 'string' ? v.stringValue : '');
const listOf = v => (v && v.arrayValue && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : []);
const entryField = (e, k) => (isMap(e) && e.mapValue.fields ? e.mapValue.fields[k] : undefined);
const entryId = e => strOf(entryField(e, 'id'));
// A record of Личный бюджет (a Firestore Value) this role is given.
const personalSeen = (role, e) => !limited(role) || (role === 'accountant' && strOf(entryField(e, 'fund')) !== CASH_FUND);

// The files of the records a role isn't given — left out of the registry, and not its to write.
// ledger: the ledger document's fields, parsed (finance_tx_personal, finance_settlements).
function hiddenFileIds(role, ledger) {
  const ids = new Set();
  if (!limited(role)) return ids;
  const add = v => { const s = strOf(v); if (s) ids.add(s); };
  for (const e of listOf((ledger || {}).finance_tx_personal)) {
    if (personalSeen(role, e)) continue;
    for (const r of listOf(entryField(e, 'fileRefs'))) add(entryField(r, 'id'));
    add(entryField(entryField(e, 'fileRef'), 'id'));
  }
  for (const s of listOf((ledger || {}).finance_settlements)) for (const v of listOf(entryField(s, 'fileIds'))) add(v);
  return ids;
}
// Does this document's view depend on the role (and the registry's, on the ledger)?
const viewed = (role, path) => limited(role) && (path === LEDGER_DOC || path === FILES_DOC);

// A document's fields (name → JSON text, as stored) as this role is given them.
function viewFields(role, path, texts, ledger) {
  if (!viewed(role, path)) return texts;
  const out = Object.assign({}, texts);
  if (path === LEDGER_DOC) {
    delete out.finance_settlements;
    if (out.finance_tx_personal !== undefined) {
      if (role !== 'accountant') delete out.finance_tx_personal;
      else {
        const v = JSON.parse(out.finance_tx_personal);
        out.finance_tx_personal = JSON.stringify(v && v.arrayValue ? { arrayValue: { values: listOf(v).filter(e => personalSeen(role, e)) } } : v);
      }
    }
    return out;
  }
  if (out.files !== undefined) {
    const hidden = hiddenFileIds(role, ledger);
    const v = JSON.parse(out.files);
    if (hidden.size && isMap(v)) {
      const f = Object.assign({}, v.mapValue.fields || {});
      hidden.forEach(id => { delete f[id]; });
      out.files = JSON.stringify({ mapValue: { fields: f } });
    }
  }
  return out;
}

// A write by this role, within its part: null when it reaches beyond it; else the body's fields
// to write — the accountant's Личный бюджет completed with the cash records the server has, where
// they are. currentPersonal: that field as stored now (a Value, or undefined); ledger: as for
// hiddenFileIds.
function viewWrite(role, path, maskPaths, fields, currentPersonal, ledger) {
  if (!viewed(role, path)) return fields;
  if (!maskPaths || !maskPaths.length) return null;
  const paths = maskPaths.map(splitFieldPath);
  if (path === FILES_DOC) {
    const hidden = hiddenFileIds(role, ledger);
    return paths.every(s => s[0] !== 'files' || (s.length > 1 && !hidden.has(s[1]))) ? fields : null;
  }
  if (paths.some(s => s[0] === 'finance_settlements' || (s[0] === 'finance_tx_personal' && (role !== 'accountant' || s.length > 1)))) return null;
  if (!paths.some(s => s[0] === 'finance_tx_personal')) return fields;
  const sent = listOf((fields || {}).finance_tx_personal), current = listOf(currentPersonal);
  const kept = current.filter(e => !personalSeen(role, e));
  const keptIds = new Set(kept.map(entryId));
  // Only records she is given: never a cash record, new or one the server has.
  if (sent.some(e => !personalSeen(role, e) || keptIds.has(entryId(e)))) return null;
  const mine = new Map(sent.map(e => [entryId(e), e]));
  const merged = [];
  for (const e of current) {
    if (!personalSeen(role, e)) merged.push(e);
    else if (mine.has(entryId(e))) { merged.push(mine.get(entryId(e))); mine.delete(entryId(e)); }
  }
  for (const e of sent) if (mine.has(entryId(e))) { merged.push(e); mine.delete(entryId(e)); }
  return Object.assign({}, fields, { finance_tx_personal: { arrayValue: { values: merged } } });
}

// People's passport details, for the receipts printed when cash is handed over: the owner and
// the administrators who hand it over — not the kitchen, the providers or anyone else signed in.
const PRIVATE_ROLES = ['owner', 'admin', 'admin2'];

// Who may do what. service: the server functions — everything. A signed-in user: the
// app's documents and files. Nobody: only a share link's own document. Documents in
// collections starting with "_" (credentials, sessions) are the server's alone; those in
// "private", PRIVATE_ROLES' alone.
function allowed(role, action, docPath) {
  if (role === 'service') return true;
  const p = parseDocPath(docPath || '');
  if (action === 'file') return !!role;
  if (!p) return false;
  if (p.collection.startsWith('_')) return false;
  if (!role) return action === 'read' && p.collection === 'appdata' && p.id.startsWith('share_');
  if (p.collection === 'private') return PRIVATE_ROLES.includes(role);
  if (p.collection === 'appdata') return !p.id.startsWith('_auth');
  if (p.collection === 'telegram_messages') return action === 'read';
  return false;
}

module.exports = {
  DOC_PREFIX, splitFieldPath, getAt, putAt, maskFields, patchPlan, applyPatch, nextTime,
  parseDocPath, docName, parseRunQuery, queryDate, allowed,
  LEDGER_DOC, FILES_DOC, viewed, viewFields, viewWrite,
};
