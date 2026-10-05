// The documents, in YDB (Yandex Database, serverless).
//
//   doc_meta   (path PK, collection, create_time, update_time, qdate) — one row per document:
//              its version, and for time-ordered collections the `date` the query filters on.
//   doc_fields (path, field PK, value) — one row per top-level field, its Firestore Value as
//              JSON text. A read of a few fields reads only those rows; a version check reads
//              none. A removed field keeps its row with value NULL: every write is then a single
//              UPSERT per table, which YDB applies atomically with the version check before it.
//
// Every write runs in a serializable transaction: the version is read and checked, and the
// commit fails (and is retried from the start) if anything else wrote that document meanwhile.

'use strict';

const { Driver, getCredentialsFromEnv, TypedValues, Types, Column, TableDescription } = require('ydb-sdk');

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
const optU = v => (v == null ? TypedValues.optionalNull(Types.UTF8) : TypedValues.optional(TypedValues.utf8(v)));
const listU = arr => TypedValues.list(Types.UTF8, arr);
const FIELD_ROW = Types.struct({ field: Types.UTF8, value: Types.optional(Types.UTF8) });

// A decoded YDB value carries only the field that was sent as its own property; every other
// field reads as its default through the prototype (nullFlagValue among them), so presence is
// what tells a text from a NULL.
const cell = item => (item && Object.prototype.hasOwnProperty.call(item, 'textValue') ? item.textValue : null);
// A result set as rows of named text values. A truncated set (over YDB's 1000-row limit) is
// an error, never a silently shorter answer.
function rowsOf(resultSet) {
  if (!resultSet) return [];
  if (resultSet.truncated) throw new Error('YDB: result truncated');
  const names = (resultSet.columns || []).map(c => c.name);
  return (resultSet.rows || []).map(r => {
    const o = {};
    (r.items || []).forEach((it, k) => { o[names[k]] = cell(it); });
    return o;
  });
}
const metaOf = r => (r ? { createTime: r.create_time, updateTime: r.update_time, qdate: r.qdate } : null);

const Q_META = `DECLARE $path AS Utf8;
SELECT create_time, update_time, qdate FROM doc_meta WHERE path = $path;`;
const Q_FIELDS = `DECLARE $path AS Utf8; DECLARE $names AS List<Utf8>;
SELECT field, value FROM doc_fields WHERE path = $path AND field IN $names AND value IS NOT NULL;`;
const Q_ALL_FIELDS = `DECLARE $path AS Utf8;
SELECT field, value FROM doc_fields WHERE path = $path AND value IS NOT NULL;`;
const Q_FIELD_NAMES = `DECLARE $path AS Utf8;
SELECT field FROM doc_fields WHERE path = $path AND value IS NOT NULL;`;
const Q_WRITE = `DECLARE $path AS Utf8; DECLARE $coll AS Utf8; DECLARE $ct AS Utf8; DECLARE $ut AS Utf8; DECLARE $qd AS Utf8?;
DECLARE $rows AS List<Struct<field: Utf8, value: Utf8?>>;
UPSERT INTO doc_fields SELECT $path AS path, field, value FROM AS_TABLE($rows);
UPSERT INTO doc_meta (path, collection, create_time, update_time, qdate) VALUES ($path, $coll, $ct, $ut, $qd);`;
const Q_REMOVE = `DECLARE $path AS Utf8; DECLARE $rows AS List<Struct<field: Utf8, value: Utf8?>>;
UPSERT INTO doc_fields SELECT $path AS path, field, value FROM AS_TABLE($rows);
DELETE FROM doc_meta WHERE path = $path;`;

const fieldsMap = rows => { const o = {}; rows.forEach(r => { o[r.field] = r.value; }); return o; };

async function read(path, names) {
  const d = await driver();
  return d.tableClient.withSessionRetry(async session => {
    const meta = metaOf(rowsOf((await session.executeQuery(Q_META, { $path: U(path) })).resultSets[0])[0]);
    if (!meta) return null;
    if (names && !names.length) return { meta, fields: {} };
    const res = names
      ? await session.executeQuery(Q_FIELDS, { $path: U(path), $names: listU(names) })
      : await session.executeQuery(Q_ALL_FIELDS, { $path: U(path) });
    return { meta, fields: fieldsMap(rowsOf(res.resultSets[0])) };
  });
}

async function transact(path, fn) {
  const d = await driver();
  return d.tableClient.withSessionRetry(async session => {
    const tx = await session.beginTransaction({ serializableReadWrite: {} });
    const txc = { txId: tx.id };
    const q = async (text, params) => (await session.executeQuery(text, params, txc)).resultSets;
    const api = {
      meta: async () => metaOf(rowsOf((await q(Q_META, { $path: U(path) }))[0])[0]),
      fields: async names => (names.length ? fieldsMap(rowsOf((await q(Q_FIELDS, { $path: U(path), $names: listU(names) }))[0])) : {}),
      write: async ({ collection, upserts, deletes, createTime, updateTime, qdate }) => {
        let gone = deletes;
        if (gone === null) gone = rowsOf((await q(Q_FIELD_NAMES, { $path: U(path) }))[0]).map(r => r.field).filter(n => !(n in upserts));
        const rows = Object.keys(upserts).map(n => ({ field: n, value: upserts[n] })).concat(gone.map(n => ({ field: n, value: null })));
        await q(Q_WRITE, { $path: U(path), $coll: U(collection), $ct: U(createTime), $ut: U(updateTime), $qd: optU(qdate), $rows: TypedValues.list(FIELD_ROW, rows) });
      },
      remove: async () => {
        const names = rowsOf((await q(Q_FIELD_NAMES, { $path: U(path) }))[0]).map(r => r.field);
        await q(Q_REMOVE, { $path: U(path), $rows: TypedValues.list(FIELD_ROW, names.map(n => ({ field: n, value: null }))) });
      },
    };
    try {
      const result = await fn(api);
      await session.commitTransaction(txc);
      return result;
    } catch (e) {
      try { await session.rollbackTransaction(txc); } catch (_) { /* already gone */ }
      throw e;
    }
  });
}

// Messages from the same second come in document-name order, as Firestore returns them.
const Q_QUERY = `DECLARE $coll AS Utf8; DECLARE $since AS Utf8;
SELECT path, create_time, update_time, qdate FROM doc_meta WHERE collection = $coll AND qdate >= $since ORDER BY qdate, path LIMIT 1000;`;
const Q_MANY_FIELDS = `DECLARE $paths AS List<Utf8>;
SELECT path, field, value FROM doc_fields WHERE path IN $paths AND value IS NOT NULL;`;

async function query(collection, since, descending, limit) {
  const d = await driver();
  return d.tableClient.withSessionRetry(async session => {
    let metas = rowsOf((await session.executeQuery(Q_QUERY, { $coll: U(collection), $since: U(since) })).resultSets[0]);
    if (descending) metas.reverse();
    if (limit) metas = metas.slice(0, limit);
    const out = metas.map(m => ({ path: m.path, meta: metaOf(m), fields: {} }));
    const byPath = new Map(out.map(o => [o.path, o]));
    for (let k = 0; k < out.length; k += 80) {
      const chunk = out.slice(k, k + 80).map(o => o.path);
      rowsOf((await session.executeQuery(Q_MANY_FIELDS, { $paths: listU(chunk) })).resultSets[0])
        .forEach(r => { byPath.get(r.path).fields[r.field] = r.value; });
    }
    return out;
  });
}

const optUtf8 = name => new Column(name, Types.optional(Types.UTF8));

async function setup() {
  const d = await driver();
  await d.tableClient.withSessionRetry(async session => {
    const exists = async name => { try { await session.describeTable(name); return true; } catch (e) { return false; } };
    if (!(await exists('doc_meta'))) {
      await session.createTable('doc_meta', new TableDescription()
        .withColumns(optUtf8('path'), optUtf8('collection'), optUtf8('create_time'), optUtf8('update_time'), optUtf8('qdate'))
        .withPrimaryKey('path'));
    }
    if (!(await exists('doc_fields'))) {
      await session.createTable('doc_fields', new TableDescription()
        .withColumns(optUtf8('path'), optUtf8('field'), optUtf8('value'))
        .withPrimaryKeys('path', 'field'));
    }
  });
}

module.exports = { read, transact, query, setup };
