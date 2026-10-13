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

// ---- what each account is given ----
// The app's screens show every role its own part, but the server used to hand any signed-in
// account every shared document on request. Now the server itself gives each only its part.
// `who` is the caller as auth.whoIs gives it: { role, sub } (sub: a provider's id).
//
// The budgets. Личный бюджет (finance_tx_personal): the owner and the administrators — and the
// accountant its records other than cash (she pays the funds that go through a bank; cash never
// passes through her). Its payouts for employees' receipts (finance_settlements): the owner and
// the administrators. The files registry: without the documents of the records a role isn't
// given. Writes keep to the same part: the accountant's write of Личный бюджет keeps the cash
// records as the server has them; anyone else writing either field is refused.
//
// A provider (its own page and nothing else): of the shared state only its visits, its purchase
// requests, and the owner's address the app emails when it records one — a list of what it is
// given, so that whatever the state carries later stays out of it too; none of the budgets;
// of the files registry only the documents of its own records. It writes its visits and its
// requests (never another's, never an approval), and adds lines to the journal of actions it
// cannot read.
const STATE_DOC = 'appdata/state', LEDGER_DOC = 'appdata/finance_ledger', FILES_DOC = 'appdata/files_registry';
const BUDGET_ROLES = ['service', 'owner', 'admin', 'admin2'];
const CASH_FUND = 'Наличные';
const roleOf = who => (who && who.role) || null;
const limited = role => !BUDGET_ROLES.includes(role);
const strOf = v => (v && typeof v.stringValue === 'string' ? v.stringValue : '');
const listOf = v => (v && v.arrayValue && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : []);
const mapOf = v => (isMap(v) ? v.mapValue.fields || {} : {});
const entryField = (e, k) => mapOf(e)[k];
const entryId = e => strOf(entryField(e, 'id'));
const asList = values => ({ arrayValue: { values } });
const asMap = fields => ({ mapValue: { fields } });
// A record of Личный бюджет (a Firestore Value) this role is given.
// The warehouse keepers receive what Личный бюджет paid for their part ("после оплаты — на склад").
const KEEPER_PART = { storekeeper: 'tools', cleaning_head: 'cleaning' };
const personalSeen = (role, e) => !limited(role) || (role === 'accountant' && strOf(entryField(e, 'fund')) !== CASH_FUND)
  || (!!KEEPER_PART[role] && strOf(entryField(e, 'whIntake')) === KEEPER_PART[role]);

// -- the staff (every signed-in role but the owner, the administrators and the providers) --
// Of the shared state, not what only the owner and the administrator work with: Telegram (its
// settings, with the code that subscribes to the daily digest; the drafts; the bot's log) and the
// journal of everyone's actions — to which they still add their own lines, as the app does.
const STAFF_HIDDEN = ['telegram_config', 'telegram_drafts', 'telegram_log', 'telegram_processed_ids', 'telegram_drafts_run_at', 'activity_log', 'anthropic_api_key'];
// The kitchen's budget lives in the shared state; the ledger has nothing of theirs.
const NO_LEDGER_ROLES = ['kitchen', 'kitchen_worker'];
const staff = role => !!role && limited(role) && role !== 'provider';
// Lines added to the journal by someone who can't read it: new ones only, a few at a time, short.
function appendOnly(current, sent, kinds) {
  const had = new Set(listOf(current).map(entryId));
  const added = listOf(sent).filter(e => !had.has(entryId(e)));
  if (added.length > 5 || added.some(e => !entryId(e) || (kinds && !kinds.includes(strOf(entryField(e, 'type')))) || JSON.stringify(e).length > 4000)) return null;
  return asList(listOf(current).concat(added));
}

// -- a provider's own --
const PROVIDER_NOTIFY = ['enabled', 'owner_email', 'emailjs_key', 'emailjs_service', 'emailjs_template'];
const PROVIDER_LOG_TYPES = ['visit', 'request'];
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Its month of visits: svc_records["<id>_<year>_<month>"].
const ownVisitKey = (pid, k) => !!pid && new RegExp('^' + reEsc(pid) + '_\\d{4}_\\d{1,2}$').test(k);
const ownRequest = (pid, e) => !!pid && strOf(entryField(e, 'providerId')) === pid;
// What of the shared state it is given (parsed Values in, parsed Values out).
function providerState(pid, fields) {
  const out = {};
  if (fields.svc_records !== undefined) out.svc_records = asMap(Object.fromEntries(Object.entries(mapOf(fields.svc_records)).filter(([k]) => ownVisitKey(pid, k))));
  if (fields.purchase_requests !== undefined) out.purchase_requests = asList(listOf(fields.purchase_requests).filter(e => ownRequest(pid, e)));
  if (fields.notify_config !== undefined) out.notify_config = asMap(Object.fromEntries(Object.entries(mapOf(fields.notify_config)).filter(([k]) => PROVIDER_NOTIFY.includes(k))));
  return out;
}
// Every text inside a Value — where a provider's records name their documents.
function textsIn(v, out) {
  if (!v || typeof v !== 'object') return out;
  if (typeof v.stringValue === 'string') out.add(v.stringValue);
  for (const e of listOf(v)) textsIn(e, out);
  for (const k of Object.keys(mapOf(v))) textsIn(mapOf(v)[k], out);
  return out;
}

// The files of the records a budget-limited role isn't given — left out of the registry, and
// not its to write. ledger: the ledger document's fields, parsed.
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
  if (NO_LEDGER_ROLES.includes(role)) for (const e of listOf((ledger || {}).finance_tx_maintenance)) {
    for (const r of listOf(entryField(e, 'fileRefs'))) add(entryField(r, 'id'));
    add(entryField(entryField(e, 'fileRef'), 'id'));
  }
  return ids;
}

// Does this document's view depend on who asks — and what does working it out need:
// 'ledger' (the ledger's two budget fields) or 'state' (the provider's records)?
function viewed(who, path) {
  const role = roleOf(who);
  if (role === 'provider' || staff(role)) return path === STATE_DOC || path === LEDGER_DOC || path === FILES_DOC;
  return limited(role) && (path === LEDGER_DOC || path === FILES_DOC);
}
function viewNeeds(who, path) {
  if (path !== FILES_DOC || !viewed(who, path)) return null;
  return roleOf(who) === 'provider' ? 'state' : 'ledger';
}

// A document's fields (name → JSON text, as stored) as this caller is given them. ctx: what
// viewNeeds named — { ledger } or { state } (fields, parsed).
function viewFields(who, path, texts, ctx) {
  if (!viewed(who, path)) return texts;
  const role = roleOf(who);
  if (role === 'provider') {
    if (path === LEDGER_DOC) return {};
    if (path === STATE_DOC) {
      const parsed = {};
      for (const n of ['svc_records', 'purchase_requests', 'notify_config']) if (texts[n] !== undefined) parsed[n] = JSON.parse(texts[n]);
      const mine = providerState(who.sub, parsed), out = {};
      for (const n of Object.keys(mine)) out[n] = JSON.stringify(mine[n]);
      return out;
    }
    if (texts.files === undefined) return texts;
    const named = textsIn(asMap(providerState(who.sub, (ctx || {}).state || {})), new Set());
    const f = Object.fromEntries(Object.entries(mapOf(JSON.parse(texts.files))).filter(([id]) => named.has(id)));
    return Object.assign({}, texts, { files: JSON.stringify(asMap(f)) });
  }
  const out = Object.assign({}, texts);
  if (path === STATE_DOC) {
    STAFF_HIDDEN.forEach(n => { delete out[n]; });
    return out;
  }
  if (path === LEDGER_DOC) {
    if (NO_LEDGER_ROLES.includes(role)) return {};
    delete out.finance_settlements;
    if (out.finance_tx_personal !== undefined) {
      if (role !== 'accountant' && !KEEPER_PART[role]) delete out.finance_tx_personal;
      else {
        const v = JSON.parse(out.finance_tx_personal);
        out.finance_tx_personal = JSON.stringify(v && v.arrayValue ? asList(listOf(v).filter(e => personalSeen(role, e))) : v);
      }
    }
    return out;
  }
  if (out.files !== undefined) {
    const hidden = hiddenFileIds(role, (ctx || {}).ledger);
    const v = JSON.parse(out.files);
    if (hidden.size && isMap(v)) {
      const f = Object.assign({}, mapOf(v));
      hidden.forEach(id => { delete f[id]; });
      out.files = JSON.stringify(asMap(f));
    }
  }
  return out;
}

// A provider's write of the shared state, completed with everything else the server has; null
// when it reaches beyond its own. current: those fields as stored now (parsed Values).
function providerStateWrite(pid, paths, fields, current) {
  const out = Object.assign({}, fields);
  for (const segs of paths) {
    const name = segs[0];
    if (segs.length > 1 || !['svc_records', 'purchase_requests', 'activity_log'].includes(name)) return null;
    const cur = current[name];
    if (name === 'svc_records') {
      const sent = mapOf(fields.svc_records);
      if (Object.keys(sent).some(k => !ownVisitKey(pid, k))) return null;
      const merged = Object.fromEntries(Object.entries(mapOf(cur)).filter(([k]) => !ownVisitKey(pid, k)));
      out.svc_records = asMap(Object.assign(merged, sent));
    } else if (name === 'purchase_requests') {
      const sent = listOf(fields.purchase_requests), was = new Map(listOf(cur).map(e => [entryId(e), e]));
      // Its own only; never an approval: a request keeps the status the server has, a new one is pending.
      for (const e of sent) {
        const old = was.get(entryId(e));
        if (!ownRequest(pid, e) || !entryId(e)) return null;
        if (old ? !ownRequest(pid, old) || strOf(entryField(e, 'status')) !== strOf(entryField(old, 'status')) : strOf(entryField(e, 'status')) !== 'pending') return null;
      }
      const mine = new Map(sent.map(e => [entryId(e), e]));
      const merged = [];
      for (const e of listOf(cur)) {
        if (!ownRequest(pid, e)) merged.push(e);
        else if (mine.has(entryId(e))) { merged.push(mine.get(entryId(e))); mine.delete(entryId(e)); }
        else if (strOf(entryField(e, 'status')) !== 'pending') return null; // only a pending one is its to take back
      }
      for (const e of sent) if (mine.has(entryId(e))) { merged.push(e); mine.delete(entryId(e)); }
      out.purchase_requests = asList(merged);
    } else {
      // The journal: it adds its own lines (a visit, a request), never reads, changes or removes one.
      out.activity_log = appendOnly(cur, fields.activity_log, PROVIDER_LOG_TYPES);
      if (!out.activity_log) return null;
    }
  }
  return out;
}

// A write by this caller, within its part: null when it reaches beyond it; else the body's
// fields to write, completed with what the server has of the rest. current(names): those
// fields as stored now, parsed (within the write). ctx: for the files registry —
// { ledger } (a budget-limited role), or { state, registry, orphan(id) } (a provider).
async function viewWrite(who, path, maskPaths, fields, current, ctx) {
  if (!viewed(who, path)) return fields;
  if (!maskPaths || !maskPaths.length) return null;
  const role = roleOf(who), paths = maskPaths.map(splitFieldPath);
  if (role === 'provider') {
    if (path === STATE_DOC) return providerStateWrite(who.sub, paths, fields, await current(['svc_records', 'purchase_requests', 'activity_log']));
    if (path !== FILES_DOC) return null;
    // A document of its own records, one it has just uploaded (new to the registry), or one no
    // record names any more (its own photo, taken off a visit).
    const named = textsIn(asMap(providerState(who.sub, ctx.state || {})), new Set());
    for (const s of paths) {
      if (s[0] !== 'files' || s.length !== 2) return null;
      if (!(named.has(s[1]) || !ctx.registry.has(s[1]) || await ctx.orphan(s[1]))) return null;
    }
    return fields;
  }
  if (path === FILES_DOC) {
    const hidden = hiddenFileIds(role, (ctx || {}).ledger);
    return paths.every(s => s[0] !== 'files' || (s.length > 1 && !hidden.has(s[1]))) ? fields : null;
  }
  if (path === STATE_DOC) {
    // What the staff aren't given they don't write — but the journal, where they add their lines.
    if (paths.some(s => STAFF_HIDDEN.includes(s[0]) && (s[0] !== 'activity_log' || s.length > 1))) return null;
    if (!paths.some(s => s[0] === 'activity_log')) return fields;
    const log = appendOnly((await current(['activity_log'])).activity_log, (fields || {}).activity_log, null);
    return log ? Object.assign({}, fields, { activity_log: log }) : null;
  }
  if (NO_LEDGER_ROLES.includes(role)) return null;
  if (paths.some(s => s[0] === 'finance_settlements' || (s[0] === 'finance_tx_personal' && (role !== 'accountant' || s.length > 1)))) return null;
  if (!paths.some(s => s[0] === 'finance_tx_personal')) return fields;
  const sent = listOf((fields || {}).finance_tx_personal), cur = listOf((await current(['finance_tx_personal'])).finance_tx_personal);
  const keptIds = new Set(cur.filter(e => !personalSeen(role, e)).map(entryId));
  // Only records she is given: never a cash record, new or one the server has.
  if (sent.some(e => !personalSeen(role, e) || keptIds.has(entryId(e)))) return null;
  const mine = new Map(sent.map(e => [entryId(e), e]));
  const merged = [];
  for (const e of cur) {
    if (!personalSeen(role, e)) merged.push(e);
    else if (mine.has(entryId(e))) { merged.push(mine.get(entryId(e))); mine.delete(entryId(e)); }
  }
  for (const e of sent) if (mine.has(entryId(e))) { merged.push(e); mine.delete(entryId(e)); }
  return Object.assign({}, fields, { finance_tx_personal: asList(merged) });
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
  // A provider: the shared state, the files registry and the budgets (each only its part — see
  // viewFields), a share page; and it writes its part of the first two, and the connection check.
  if (role === 'provider') {
    if (p.collection !== 'appdata') return false;
    if (action === 'read') return ['state', 'files_registry', 'finance_ledger'].includes(p.id) || p.id.startsWith('share_');
    return ['state', 'files_registry', '_ping'].includes(p.id);
  }
  if (p.collection === 'appdata') {
    if (p.id.startsWith('_auth')) return false;
    // A share page is public — whoever writes one writes a page on the site's own address:
    // the owner and the administrators, who share the reports.
    if (p.id.startsWith('share_')) return action === 'read' || SHARE_ROLES.includes(role);
    const only = APPDATA_ROLES[p.id];
    return only ? only.includes(role) : true;
  }
  // The Telegram messages are the server functions' alone (the bot, the digest); no screen reads them.
  return false;
}
const SHARE_ROLES = ['owner', 'admin', 'admin2'];
// Documents of appdata for some roles only (the server functions — 'service' — have them all):
// the warehouse, for those who keep it (and the owner and the administrators); the backups' report,
// for the owner's settings; the AI's daily count and the Telegram lease, the functions' own.
const WAREHOUSE_DOC_ROLES = ['owner', 'admin', 'admin2', 'storekeeper', 'cleaning_head'];
const APPDATA_ROLES = {
  warehouse: WAREHOUSE_DOC_ROLES, warehouse_docs: WAREHOUSE_DOC_ROLES,
  backup_status: ['owner', 'admin', 'admin2'],
  _scan_quota: [], _drafts_lease: [],
};

module.exports = {
  DOC_PREFIX, splitFieldPath, getAt, putAt, maskFields, patchPlan, applyPatch, nextTime,
  parseDocPath, docName, parseRunQuery, queryDate, allowed,
  STATE_DOC, LEDGER_DOC, FILES_DOC, viewed, viewNeeds, viewFields, viewWrite,
};
