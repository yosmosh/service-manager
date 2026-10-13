// The app on our own computer, end to end: a small backup imported, accounts set up, the
// server started, and the page, the data, the files and the /api pass-through used as the
// browser and the Vercel functions use them.
//
//   node selfhost/test/selfhost.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sadb-'));
const DATA = path.join(tmp, 'data');
const env = Object.assign({}, process.env, {
  APP_DIR: ROOT, DATA_DIR: DATA, PUBLIC_ORIGIN: 'https://www.sad-budushego.ru',
  AUTH_SECRET: 'a'.repeat(40), SERVICE_KEY: 's'.repeat(40), HOST: '127.0.0.1',
});
const node = process.execPath;
const admin = (...args) => spawnSync(node, [path.join(ROOT, 'selfhost', 'admin.js'), ...args], { env, encoding: 'utf8' });

const OLD = 'https://storage.yandexcloud.net/sad-budushego-files/files/';
const FILE_ID = 'mabc123def4567890abcde';

function snapshot() {
  const t = '2026-10-11T00:00:00.000000Z';
  const doc = (collection, fields, qdate) => ({ collection, createTime: t, updateTime: t, qdate: qdate || null, fields });
  return {
    createdAt: '2026-10-11T00:05:00.000Z',
    documents: {
      'appdata/state': doc('appdata', { budget_released: true, maint_works: [{ id: 'w1', title: 'Забор', fileIds: [FILE_ID] }], sos_items: [] }),
      'appdata/files_registry': doc('appdata', { files: { [FILE_ID]: { id: FILE_ID, name: 'забор.jpg', type: 'image/jpeg', size: 4, url: OLD + FILE_ID } } }),
      'appdata/share_x1': doc('appdata', { html: '<img src="' + OLD + FILE_ID + '">' }),
      'telegram_messages/m1': doc('telegram_messages', { text: 'прорвало трубу', date: '2026-10-10T08:00:00Z' }, '2026-10-10T08:00:00Z'),
      'telegram_messages/m2': doc('telegram_messages', { text: 'старое', date: '2026-09-01T08:00:00Z' }, '2026-09-01T08:00:00Z'),
    },
  };
}

function req(port, method, p, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers || {} }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

(async () => {
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('ok ' + name); };
  let server, stub;
  try {
    // A stand-in for Vercel behind /api.
    stub = http.createServer((q, s) => { let b = ''; q.on('data', c => { b += c; }); q.on('end', () => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ path: q.url, method: q.method, host: q.headers.host, body: b })); }); });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    env.API_ORIGIN = 'http://127.0.0.1:' + stub.address().port;

    const snapFile = path.join(tmp, 'snap.json.gz');
    fs.writeFileSync(snapFile, zlib.gzipSync(JSON.stringify(snapshot())));
    const filesDir = path.join(tmp, 'files');
    fs.mkdirSync(filesDir);
    fs.writeFileSync(path.join(filesDir, FILE_ID), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    await t('file store: names differing only in capitals stay two documents (Windows), and come back', async () => {
      const { createFileStore, nameOf } = require('../store-file');
      const dir = path.join(tmp, 'case');
      const s = createFileStore(dir);
      const put = (p, v) => s.transact(p, tx => tx.write({ collection: 'c', upserts: { v: JSON.stringify({ stringValue: v }) }, deletes: null, createTime: 't', updateTime: 't', qdate: null }));
      await put('c/AbC', 'upper');
      await put('c/abc', 'lower');
      await put('c/Ж*:?', 'odd');
      assert.strictEqual(fs.readdirSync(dir).length, 3);
      assert.ok(fs.readdirSync(dir).every(f => /^[a-z0-9._%A-F-]+$/.test(f)), fs.readdirSync(dir).join(' '));
      assert.strictEqual(nameOf('appdata/state'), 'appdata%2Fstate');
      const again = createFileStore(dir);
      assert.deepStrictEqual(['c/AbC', 'c/abc', 'c/Ж*:?'].map(p => JSON.parse(again.docs.get(p).fields.v).stringValue), ['upper', 'lower', 'odd']);
    });

    await t('import: documents, files, file addresses moved here', async () => {
      const r = admin('import', snapFile, '--files', filesDir);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(/Documents: 5/.test(r.stdout) && /file addresses moved here: 2/.test(r.stdout) && /Files: 1 copied/.test(r.stdout), r.stdout);
      assert.strictEqual(fs.readFileSync(path.join(DATA, 'files', FILE_ID)).length, 4);
      const again = admin('import', snapFile);
      assert.notStrictEqual(again.status, 0, 'a second import without --force is refused');
    });

    await t('accounts: everyone gets a random password; the owner sets one', async () => {
      const r = admin('init-credentials');
      assert.strictEqual(r.status, 0, r.stderr);
      Object.assign(process.env, { AUTH_SECRET: env.AUTH_SECRET });
      const { createFileStore } = require('../store-file');
      const { createAccounts } = require(path.join(ROOT, 'yandex', 'data-api', 'accounts'));
      const auth = require(path.join(ROOT, 'yandex', 'data-api', 'auth'));
      const acc = createAccounts({ store: createFileStore(path.join(DATA, 'db')), auth });
      const s = await acc.setAccount('owner', { kind: 'role', id: 'owner', user: 'yosef', password: 'owner-test-pass' });
      assert.strictEqual(s.status, 200, JSON.stringify(s.body));
      // As deploy/selfhost-deploy.ps1 sends it: name and password twice, on the input.
      const piped = spawnSync(node, [path.join(ROOT, 'selfhost', 'admin.js'), 'set-password', 'storekeeper'], { env, encoding: 'utf8', input: 'sklad1\nstore-pass-123\nstore-pass-123\n' });
      assert.strictEqual(piped.status, 0, piped.stderr + piped.stdout);
      assert.ok(!piped.stdout.includes('store-pass-123'), 'the password is never echoed');
      const short = spawnSync(node, [path.join(ROOT, 'selfhost', 'admin.js'), 'set-password', 'admin'], { env, encoding: 'utf8', input: 'admin\nshort\nshort\n' });
      assert.notStrictEqual(short.status, 0, 'a short password is refused');
      const mismatch = spawnSync(node, [path.join(ROOT, 'selfhost', 'admin.js'), 'set-password', 'admin'], { env, encoding: 'utf8', input: 'admin\nlong-enough-1\nlong-enough-2\n' });
      assert.notStrictEqual(mismatch.status, 0, 'two different passwords are refused');
      const list = admin('accounts');
      assert.ok(/role     storekeeper\s+sklad1/.test(list.stdout), list.stdout);
      assert.ok(/role     owner\s+yosef/.test(list.stdout) && /provider mosoblgaz\s+mosoblgaz/.test(list.stdout), list.stdout);
    });

    await t('reset-passwords: everyone but the owner, names kept, the list only in its file', async () => {
      const file = path.join(tmp, 'passwords.txt');
      const r = admin('reset-passwords', file);
      assert.strictEqual(r.status, 0, r.stderr);
      const text = fs.readFileSync(file, 'utf8');
      const rows = text.split(/\r\n/).filter(l => /логин: /.test(l));
      const { ACCOUNTS, PROVIDER_IDS } = require(path.join(ROOT, 'yandex', 'data-api', 'accounts'));
      assert.strictEqual(rows.length, ACCOUNTS.length - 1 + PROVIDER_IDS.length, text);
      assert.ok(!rows.some(l => /логин: yosef/.test(l)), 'the owner keeps his');
      const pw = l => /пароль: (\S+)/.exec(l)[1];
      const keeper = rows.find(l => /логин: sklad1 /.test(l));
      assert.ok(keeper && /^Склад: инструменты/.test(keeper), 'the keeper keeps the name sklad1');
      assert.ok(rows.some(l => /^Мособлгаз АО\s+логин: mosoblgaz /.test(l)), 'providers by their names');
      assert.ok(rows.every(l => /^[a-z]+-\d{5}-[a-z]+$/.test(pw(l))), 'word-digits-word');
      assert.ok(!rows.some(l => r.stdout.includes(pw(l)) || r.stderr.includes(pw(l))), 'no password is printed');
      const { createFileStore } = require('../store-file');
      const { createAccounts } = require(path.join(ROOT, 'yandex', 'data-api', 'accounts'));
      const acc = createAccounts({ store: createFileStore(path.join(DATA, 'db')), auth: require(path.join(ROOT, 'yandex', 'data-api', 'auth')) });
      assert.strictEqual((await acc.login({ username: 'sklad1', password: pw(keeper), ip: '1.1.1.1' })).status, 200);
      assert.strictEqual((await acc.login({ username: 'sklad1', password: 'store-pass-123', ip: '1.1.1.1' })).status, 401, 'the old one no longer works');
      assert.strictEqual((await acc.login({ username: 'yosef', password: 'owner-test-pass', ip: '1.1.1.1' })).status, 200, 'the owner\'s unchanged');
    });

    // The server, started after the data is in place (it reads it once, at start).
    env.PORT = '0';
    server = spawn(node, [path.join(ROOT, 'selfhost', 'server.js')], { env: Object.assign({}, env, { PORT: String(40000 + Math.floor(Math.random() * 20000)) }) });
    let out = '';
    const port = await new Promise((resolve, reject) => {
      server.stdout.on('data', d => { out += d; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      server.stderr.on('data', d => { out += d; });
      server.on('exit', c => reject(new Error('server exited ' + c + ': ' + out)));
      setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    });
    assert.ok(/ [5-7] documents/.test(out), out); // + _auth/credentials, _auth/throttle

    await t('the page, its update check, its libraries; nothing outside the app', async () => {
      const page = await req(port, 'GET', '/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('<title>') && /no-store/.test(page.headers['cache-control']));
      const head = await req(port, 'HEAD', '/app-version');
      assert.ok(head.status === 200 && head.headers.etag && head.headers['last-modified']);
      const v = await req(port, 'GET', '/vendor/flatpickr-4.6.13/flatpickr.min.js');
      assert.ok(v.status === 200 && /immutable/.test(v.headers['cache-control']) && /javascript/.test(v.headers['content-type']));
      assert.strictEqual((await req(port, 'GET', '/novoe')).status, 200);
      for (const p of ['/../selfhost/server.js', '/%2e%2e/selfhost/server.js', '/vendor/../selfhost/admin.js', '/selfhost/server.js', '/yandex/data-api/auth.js']) {
        assert.strictEqual((await req(port, 'GET', p)).status, 404, p);
      }
    });

    // A visitor who breaks off mid-download (bots do, all day): the server lets go of the file.
    // It used to hold it open for good — and then the page could not be replaced.
    await t('a download broken off: the file is let go', async () => {
      await new Promise((resolve, reject) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.once('data', () => { r.destroy(); resolve(); }); });
        r.on('error', e => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      });
      await new Promise(r => setTimeout(r, 300));
      if (process.platform === 'win32') {
        const ps = `try { $f = [IO.File]::Open('${path.join(ROOT, 'service-manager.html')}', 'Open', 'Read', 'None'); $f.Close(); 'free' } catch { 'held' }`;
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
        assert.strictEqual(r.stdout.trim(), 'free', r.stderr);
      }
      assert.strictEqual((await req(port, 'GET', '/')).status, 200, 'and serves it on');
    });

    let token;
    await t('sign-in: the owner with the new password; nobody with a default', async () => {
      const bad = await req(port, 'POST', '/db/v1/auth:login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
      assert.strictEqual(bad.status, 401);
      const prov = await req(port, 'POST', '/db/v1/auth:login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'mosoblgaz', password: '1234' }) });
      assert.strictEqual(prov.status, 401);
      const ok = await req(port, 'POST', '/db/v1/auth:login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'yosef', password: 'owner-test-pass' }) });
      assert.strictEqual(ok.status, 200, ok.text);
      assert.strictEqual(ok.json.role, 'owner');
      token = ok.json.token;
    });

    await t('data: read, a masked read, a guarded write, the query; unsigned callers refused', async () => {
      const A = { Authorization: 'Bearer ' + token };
      const s = await req(port, 'GET', '/db/v1/documents/appdata/state', { headers: A });
      assert.strictEqual(s.status, 200, s.text);
      assert.strictEqual(s.json.fields.maint_works.arrayValue.values[0].mapValue.fields.title.stringValue, 'Забор');
      const masked = await req(port, 'GET', '/db/v1/documents/appdata/state?mask.fieldPaths=sos_items&mask.fieldPaths=budget_released', { headers: A });
      assert.deepStrictEqual(Object.keys(masked.json.fields).sort(), ['budget_released', 'sos_items']);
      const body = JSON.stringify({ fields: { sos_items: { arrayValue: { values: [{ mapValue: { fields: { id: { stringValue: 's1' }, title: { stringValue: 'Протечка' } } } }] } } } });
      const w = await req(port, 'PATCH', '/db/v1/documents/appdata/state?updateMask.fieldPaths=sos_items&currentDocument.updateTime=' + encodeURIComponent(s.json.updateTime), { headers: Object.assign({ 'Content-Type': 'application/json' }, A), body });
      assert.strictEqual(w.status, 200, w.text);
      const stale = await req(port, 'PATCH', '/db/v1/documents/appdata/state?updateMask.fieldPaths=sos_items&currentDocument.updateTime=' + encodeURIComponent(s.json.updateTime), { headers: Object.assign({ 'Content-Type': 'application/json' }, A), body });
      assert.strictEqual(stale.status, 400, 'a write against an old version is refused');
      const after = await req(port, 'GET', '/db/v1/documents/appdata/state', { headers: A });
      assert.strictEqual(after.json.fields.sos_items.arrayValue.values[0].mapValue.fields.title.stringValue, 'Протечка');
      assert.strictEqual(after.json.fields.maint_works.arrayValue.values.length, 1, 'other fields kept');
      const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'db', encodeURIComponent('appdata/state') + '.json'), 'utf8'));
      assert.ok(onDisk.fields.sos_items.includes('Протечка'), 'written to disk before the answer');
      // The Telegram messages: the server functions' (the bot's) alone — not even the owner's sign-in.
      const query = JSON.stringify({ structuredQuery: { from: [{ collectionId: 'telegram_messages' }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: '2026-10-01T00:00:00Z' } } }, orderBy: [{ field: { fieldPath: 'date' } }] } });
      assert.strictEqual((await req(port, 'POST', '/db/v1/documents:runQuery', { headers: Object.assign({ 'Content-Type': 'application/json' }, A), body: query })).status, 403);
      const q = await req(port, 'POST', '/db/v1/documents:runQuery', { headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.SERVICE_KEY }, body: query });
      assert.strictEqual(q.status, 200, q.text);
      assert.deepStrictEqual(q.json.filter(r => r.document).map(r => r.document.name.split('/').pop()), ['m1']);
      assert.strictEqual((await req(port, 'GET', '/db/v1/documents/appdata/state')).status, 401);
      assert.strictEqual((await req(port, 'GET', '/db/v1/documents/_auth/credentials', { headers: A })).status, 403);
      const svc = await req(port, 'GET', '/db/v1/documents/appdata/state?mask.fieldPaths=budget_released', { headers: { 'X-Service-Key': env.SERVICE_KEY } });
      assert.strictEqual(svc.status, 200, 'the Vercel functions with the service key');
    });

    await t('files: the moved addresses, an upload on a signed address, a refused one', async () => {
      const A = { Authorization: 'Bearer ' + token };
      const reg = await req(port, 'GET', '/db/v1/documents/appdata/files_registry', { headers: A });
      assert.strictEqual(reg.json.fields.files.mapValue.fields[FILE_ID].mapValue.fields.url.stringValue, 'https://www.sad-budushego.ru/files/' + FILE_ID);
      const share = await req(port, 'GET', '/db/v1/documents/appdata/share_x1');
      assert.ok(share.status === 200 && share.text.includes('https://www.sad-budushego.ru/files/' + FILE_ID) && !share.text.includes(OLD), 'shared reports open without signing in, with the new addresses');
      const f = await req(port, 'GET', '/files/' + FILE_ID);
      assert.ok(f.status === 200 && f.headers['content-type'] === 'image/jpeg' && f.buf.length === 4 && /filename\*=UTF-8''/.test(f.headers['content-disposition']));
      const pr = await req(port, 'POST', '/db/v1/files:presign', { headers: Object.assign({ 'Content-Type': 'application/json' }, A), body: JSON.stringify({ name: 'акт.pdf', type: 'application/pdf' }) });
      assert.strictEqual(pr.status, 200, pr.text);
      assert.ok(pr.json.uploadUrl.startsWith('/files-upload/') && pr.json.url === 'https://www.sad-budushego.ru/files/' + pr.json.id);
      const bad = await req(port, 'PUT', pr.json.uploadUrl, { headers: { 'Content-Type': 'image/png', 'Content-Disposition': pr.json.headers['Content-Disposition'] }, body: 'x' });
      assert.strictEqual(bad.status, 403, 'other headers than signed are refused');
      const tampered = await req(port, 'PUT', pr.json.uploadUrl.replace(pr.json.id, pr.json.id.slice(0, -1) + (pr.json.id.endsWith('a') ? 'b' : 'a')), { headers: pr.json.headers, body: 'x' });
      assert.strictEqual(tampered.status, 403);
      const up = await req(port, 'PUT', pr.json.uploadUrl, { headers: pr.json.headers, body: '%PDF-1.4 test' });
      assert.strictEqual(up.status, 200, up.text);
      const got = await req(port, 'GET', '/files/' + pr.json.id);
      assert.ok(got.status === 200 && got.text === '%PDF-1.4 test' && got.headers['content-type'] === 'application/pdf');
      assert.strictEqual((await req(port, 'PUT', pr.json.uploadUrl, { headers: pr.json.headers, body: 'again' })).status, 409, 'a file is never overwritten');
      const del = await req(port, 'DELETE', '/db/v1/files/' + pr.json.id, { headers: A });
      assert.strictEqual(del.status, 200, del.text);
      assert.strictEqual((await req(port, 'GET', '/files/' + pr.json.id)).status, 404);
      assert.strictEqual((await req(port, 'GET', '/files/..%2Fdb')).status, 404);
      // A page, or an SVG, uploaded by someone signed in: a download, never run as the site.
      for (const [name, type, body] of [['x.html', 'text/html', '<script>alert(1)</script>'], ['x.svg', 'image/svg+xml', '<svg onload="alert(1)"/>']]) {
        const p = await req(port, 'POST', '/db/v1/files:presign', { headers: Object.assign({ 'Content-Type': 'application/json' }, A), body: JSON.stringify({ name, type }) });
        assert.strictEqual((await req(port, 'PUT', p.json.uploadUrl, { headers: p.json.headers, body })).status, 200, name);
        const g = await req(port, 'GET', '/files/' + p.json.id);
        assert.deepStrictEqual([g.headers['content-type'], /^attachment/.test(g.headers['content-disposition']), g.headers['x-content-type-options']], ['application/octet-stream', true, 'nosniff'], name);
      }
      assert.strictEqual(f.headers['content-security-policy'], 'sandbox', 'a photo opened on its own runs nothing');
      const page = await req(port, 'GET', '/');
      assert.deepStrictEqual([page.headers['x-frame-options'], page.headers['content-security-policy']], ['SAMEORIGIN', "frame-ancestors 'self'"], 'the app in no one else\'s frame');
    });

    await t('/api/… goes on to Vercel as it came', async () => {
      const r = await req(port, 'POST', '/api/kitchen/scan-invoice?x=1', { headers: { 'Content-Type': 'application/json' }, body: '{"purpose":"warehouse"}' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([r.json.path, r.json.method, r.json.body], ['/api/kitchen/scan-invoice?x=1', 'POST', '{"purpose":"warehouse"}']);
      assert.ok(r.json.host.startsWith('127.0.0.1:'), 'the host is Vercel\'s own, not ours');
    });

    await t('snapshot: the same format as the cloud backup, and it imports back', async () => {
      const r = admin('snapshot', path.join(tmp, 'bk'));
      assert.strictEqual(r.status, 0, r.stderr);
      const f = fs.readdirSync(path.join(tmp, 'bk'))[0];
      const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'bk', f))));
      assert.ok(!Object.keys(s.documents).some(p => p.startsWith('_auth/')), 'no passwords in a backup');
      assert.strictEqual(s.documents['appdata/state'].fields.sos_items[0].title, 'Протечка');
      const env2 = Object.assign({}, env, { DATA_DIR: path.join(tmp, 'data2') });
      const r2 = spawnSync(node, [path.join(ROOT, 'selfhost', 'admin.js'), 'import', path.join(tmp, 'bk', f)], { env: env2, encoding: 'utf8' });
      assert.strictEqual(r2.status, 0, r2.stderr);
    });

    console.log(n + ' passed');
  } finally {
    if (server) server.kill();
    if (stub) stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
