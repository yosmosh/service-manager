// The documents on this computer's disk — the same contract as store-ydb.js (YDB in the cloud),
// so yandex/data-api/api.js runs over it unchanged.
//
// One JSON file per document in <dir>: {collection, createTime, updateTime, qdate, fields},
// each field's Firestore Value kept as JSON text, as in YDB. All documents are held in memory
// as well (the whole app is a few megabytes); every change is written to its file before the
// request is answered — to a temporary file first, flushed to disk, then renamed over the old
// one, so a power cut leaves either the old document or the new, never half of one.
// Changes to one document run one at a time, in order.

'use strict';

const fs = require('fs');
const path = require('path');

function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const docs = new Map();
  const fileOf = p => path.join(dir, encodeURIComponent(p) + '.json');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    docs.set(decodeURIComponent(f.slice(0, -5)), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  function persist(p, d) {
    const f = fileOf(p);
    if (!d) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } return; }
    const tmp = f + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(d)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
  }

  // One change at a time per document.
  const queues = new Map();
  function serial(p, fn) {
    const run = (queues.get(p) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(p, tail);
    tail.then(() => { if (queues.get(p) === tail) queues.delete(p); });
    return run;
  }
  const metaOf = d => (d ? { createTime: d.createTime, updateTime: d.updateTime, qdate: d.qdate || null } : null);

  return {
    docs,
    async read(p, names) {
      const d = docs.get(p);
      if (!d) return null;
      if (names && !names.length) return { meta: metaOf(d), fields: {} };
      const fields = {};
      for (const n of Object.keys(d.fields)) if (!names || names.includes(n)) fields[n] = d.fields[n];
      return { meta: metaOf(d), fields };
    },

    // The change is applied only when fn finishes without throwing — a refused precondition
    // leaves the document as it was.
    transact(p, fn) {
      return serial(p, async () => {
        const d = docs.get(p);
        let staged; // undefined: unchanged; null: removed; object: the new document
        const result = await fn({
          meta: async () => metaOf(d),
          fields: async names => { const o = {}; if (d) for (const n of names) if (n in d.fields) o[n] = d.fields[n]; return o; },
          write: async ({ collection, upserts, deletes, createTime, updateTime, qdate }) => {
            const next = d && deletes !== null ? Object.assign({}, d.fields) : {};
            for (const n of deletes || []) delete next[n];
            Object.assign(next, upserts);
            staged = { collection, createTime, updateTime, qdate: qdate || null, fields: next };
          },
          remove: async () => { staged = null; },
        });
        if (staged !== undefined) {
          persist(p, staged);
          if (staged) docs.set(p, staged); else docs.delete(p);
        }
        return result;
      });
    },

    // The one query in use: documents of a collection dated since a time, by date then name —
    // at most a thousand, as YDB answers it, then reversed when asked.
    async query(collection, since, descending, limit) {
      let rows = [];
      for (const [p, d] of docs) if (d.collection === collection && d.qdate && d.qdate >= since) rows.push([p, d]);
      rows.sort((a, b) => (a[1].qdate < b[1].qdate ? -1 : a[1].qdate > b[1].qdate ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      rows = rows.slice(0, 1000);
      if (descending) rows.reverse();
      if (limit) rows = rows.slice(0, limit);
      return rows.map(([p, d]) => ({ path: p, meta: metaOf(d), fields: Object.assign({}, d.fields) }));
    },

    async setup() {},
  };
}

module.exports = { createFileStore };
