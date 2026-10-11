// Looking after the app on our own computer. Run on the server through the wrapper setup.sh
// installs (it loads /etc/sad-budushego/env and runs as the service's user):
//
//   sadb-admin import <snapshot.json.gz> [--files <dir>] [--force]
//        Loads a backup — the same data/<date>.json.gz the nightly Yandex backup writes — and,
//        with --files, the photos and documents from a folder of <id> files. File addresses in
//        the data are moved from the Yandex bucket to this server's /files/<id>.
//   sadb-admin init-credentials
//        Every account (staff and providers) gets a new random password nobody knows — the
//        backup holds no passwords. Then set the owner's, and the owner sets the rest in Настройки.
//   sadb-admin set-password <account>      e.g. owner, admin, storekeeper, mosoblgaz
//        Asks for the name and the new password (typed, never shown).
//   sadb-admin accounts                    the account names (no passwords)
//   sadb-admin snapshot [<dir>]            a backup in the same format; run nightly by cron

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');

const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, '..', 'data'));
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || 'https://www.sad-budushego.ru').replace(/\/+$/, '');
const API_SRC = path.join(APP_DIR, 'yandex', 'data-api');
const core = require(path.join(API_SRC, 'core'));
const auth = require(path.join(API_SRC, 'auth'));
const { createAccounts, hashPassword, ACCOUNTS, PROVIDER_IDS } = require(path.join(API_SRC, 'accounts'));
const { decodeValue, encodeValue } = require(path.join(APP_DIR, 'yandex', 'backup', 'backup'));
const { createFileStore } = require('./store-file');

const OLD_FILE_PREFIXES = ['https://storage.yandexcloud.net/sad-budushego-files/files/'];
const CRED_PATH = '_auth/credentials';
const die = msg => { console.error(msg); process.exit(1); };

function openStore() { return createFileStore(path.join(DATA_DIR, 'db')); }

async function writeDoc(store, p, doc) {
  await store.transact(p, async tx => {
    await tx.write({ collection: doc.collection, upserts: doc.fields, deletes: null, createTime: doc.createTime, updateTime: doc.updateTime, qdate: doc.qdate || null });
  });
}

async function cmdImport(args) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) die('Usage: import <snapshot.json.gz> [--files <dir>] [--force]');
  const fi = args.indexOf('--files');
  const filesDir = fi >= 0 ? args[fi + 1] : null;
  const store = openStore();
  const existing = Array.from(store.docs.keys()).filter(p => !p.startsWith('_auth/'));
  if (existing.length && !args.includes('--force')) die(`There is data here already (${existing.length} documents). Add --force to replace it with the backup.`);
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const newBase = PUBLIC_ORIGIN + '/files/';
  let n = 0, moved = 0;
  for (const [p, d] of Object.entries(snap.documents || {})) {
    if (p.startsWith('_auth/')) continue;
    const fields = {};
    for (const [name, value] of Object.entries(d.fields || {})) {
      let t = JSON.stringify(encodeValue(value));
      for (const old of OLD_FILE_PREFIXES) if (t.includes(old)) { moved += t.split(old).length - 1; t = t.split(old).join(newBase); }
      fields[name] = t;
    }
    await writeDoc(store, p, { collection: d.collection, createTime: d.createTime, updateTime: d.updateTime, qdate: d.qdate, fields });
    n++;
  }
  console.log(`Documents: ${n} (backup of ${snap.createdAt}); file addresses moved here: ${moved}`);
  if (filesDir) {
    const reg = (snap.documents['appdata/files_registry'] || { fields: {} }).fields.files || {};
    const dest = path.join(DATA_DIR, 'files');
    fs.mkdirSync(dest, { recursive: true });
    let copied = 0, kept = 0;
    for (const id of fs.readdirSync(filesDir)) {
      if (!/^[a-z0-9]{8,64}$/.test(id)) continue;
      const target = path.join(dest, id);
      if (fs.existsSync(target)) { kept++; continue; }
      fs.copyFileSync(path.join(filesDir, id), target + '.part');
      const r = reg[id] || {};
      const meta = { type: r.type || 'application/octet-stream', disposition: r.name ? "inline; filename*=UTF-8''" + encodeURIComponent(String(r.name).slice(0, 200)) : '' };
      fs.writeFileSync(target + '.meta', JSON.stringify(meta));
      fs.renameSync(target + '.part', target);
      copied++;
    }
    console.log(`Files: ${copied} copied, ${kept} already here`);
  }
}

async function cmdInitCredentials() {
  const store = openStore();
  const doc = await store.read(CRED_PATH, ['roles', 'providers']);
  const have = { roles: {}, providers: {} };
  if (doc) for (const k of ['roles', 'providers']) if (doc.fields[k]) Object.assign(have[k], (JSON.parse(doc.fields[k]).mapValue || {}).fields || {});
  const entry = async user => ({ mapValue: { fields: { user: { stringValue: user }, hash: { stringValue: await hashPassword(crypto.randomBytes(24).toString('base64url')) }, gen: { integerValue: '1' } } } });
  let added = 0;
  for (const a of ACCOUNTS) if (!have.roles[a.role]) { have.roles[a.role] = await entry(a.defUser); added++; }
  for (const pid of PROVIDER_IDS) if (!have.providers[pid]) { have.providers[pid] = await entry(pid); added++; }
  await store.transact(CRED_PATH, async tx => {
    const meta = await tx.meta();
    const t = core.nextTime(meta && meta.updateTime, Date.now());
    await tx.write({ collection: '_auth', upserts: { roles: JSON.stringify({ mapValue: { fields: have.roles } }), providers: JSON.stringify({ mapValue: { fields: have.providers } }) }, deletes: [], createTime: meta ? meta.createTime : t, updateTime: t, qdate: null });
  });
  console.log(`Accounts with a new random password: ${added}. Now: sadb-admin set-password owner`);
}

// Answers come from the keyboard, or — when the owner's computer sends them over SSH — all at
// once on the input, one per line.
let piped = null;
function ask(q, hidden) {
  if (!process.stdin.isTTY) {
    if (!piped) piped = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    process.stdout.write(q + (hidden ? '***' : '') + '\n');
    return Promise.resolve(piped.length ? piped.shift() : '');
  }
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { process.stdout.write(s.startsWith(q) ? q : s.includes('\n') ? '\n' : '*'); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

async function cmdSetPassword(args) {
  const id = args[0];
  if (!id) die('Usage: set-password <account>   (owner, admin, kitchen, storekeeper, … or a provider id)');
  const kind = ACCOUNTS.some(a => a.role === id) ? 'role' : PROVIDER_IDS.includes(id) ? 'provider' : null;
  if (!kind) die('No such account: ' + id);
  const store = openStore();
  const accounts = createAccounts({ store, auth });
  const list = await accounts.list('owner');
  const current = kind === 'role' ? list.body.roles[id] : list.body.providers[id];
  const user = (await ask(`Имя пользователя [${current ? current.user : id}]: `)).trim() || (current ? current.user : id);
  const p1 = await ask('Новый пароль: ', true);
  const p2 = await ask('Ещё раз: ', true);
  if (!p1 || p1 !== p2) die('Пароли не совпадают — ничего не изменено.');
  if (p1.length < 8) die('Слишком короткий пароль (нужно 8 символов или больше) — ничего не изменено.');
  const r = await accounts.setAccount('owner', { kind, id, user, password: p1 });
  if (r.status !== 200) die('Не сохранено: ' + (r.body && r.body.error));
  console.log(`Сохранено: ${id} → ${user}`);
}

async function cmdAccounts() {
  const store = openStore();
  const r = await createAccounts({ store, auth }).list('owner');
  if (r.status !== 200) die(r.body && r.body.error);
  for (const [k, v] of Object.entries(r.body.roles || {})) console.log('role     ' + k.padEnd(16) + v.user);
  for (const [k, v] of Object.entries(r.body.providers || {})) console.log('provider ' + k.padEnd(16) + v.user);
}

// The same format as the cloud backup (yandex/backup): every document but the passwords.
async function cmdSnapshot(args) {
  const store = openStore();
  const dir = path.resolve(args[0] || path.join(DATA_DIR, 'backups'));
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const documents = {};
  for (const [p, d] of store.docs) {
    if (p.startsWith('_auth/')) continue;
    const fields = {};
    for (const [n, t] of Object.entries(d.fields)) fields[n] = decodeValue(JSON.parse(t));
    documents[p] = { collection: d.collection, createTime: d.createTime, updateTime: d.updateTime, qdate: d.qdate || null, fields };
  }
  const out = path.join(dir, createdAt.slice(0, 10) + '.json.gz');
  fs.writeFileSync(out + '.part', zlib.gzipSync(Buffer.from(JSON.stringify({ createdAt, note: 'Сад Будущего — резервная копия данных (без паролей).', documents }))));
  fs.renameSync(out + '.part', out);
  // Sixty days of them.
  const old = fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.json\.gz$/.test(f)).sort().slice(0, -60);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  console.log(`Snapshot ${out}: ${Object.keys(documents).length} documents`);
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const cmds = { import: cmdImport, 'init-credentials': cmdInitCredentials, 'set-password': cmdSetPassword, accounts: cmdAccounts, snapshot: cmdSnapshot };
  if (!cmds[cmd]) die('Commands: ' + Object.keys(cmds).join(', '));
  await cmds[cmd](args);
})().catch(e => die(e && e.stack || String(e)));
