// The whole app on one computer of our own — what Yandex Cloud serves today, in one process:
//
//   /, /service-manager.html, /app-version     the page (no-cache; /app-version for update checks)
//   /vendor/…, /firebase-messaging-sw.js, /novoe the page's libraries, push worker, staff guide
//   /db/…                                      the data API — yandex/data-api/api.js unchanged,
//                                              over the disk (store-file.js, files-local.js)
//   /files/<id>, PUT /files-upload/<id>        photos and documents
//   /api/…                                     passed on to Vercel (the AI, the Telegram bot)
//
// Caddy sits in front of it for HTTPS (selfhost/Caddyfile). Settings come from the
// environment (selfhost/setup.sh writes /etc/sad-budushego/env):
//   PORT, DATA_DIR, APP_DIR, PUBLIC_ORIGIN, API_ORIGIN, AUTH_SECRET, SERVICE_KEY

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const APP_DIR = path.resolve(env.APP_DIR || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(APP_DIR, '..', 'data'));
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '127.0.0.1';
const PUBLIC_ORIGIN = String(env.PUBLIC_ORIGIN || 'https://www.sad-budushego.ru').replace(/\/+$/, '');
const API_ORIGIN = String(env.API_ORIGIN || 'https://api.sad-budushego.ru').replace(/\/+$/, '');
for (const k of ['AUTH_SECRET', 'SERVICE_KEY']) if (!env[k] || env[k].length < 32) { console.error(k + ' missing or too short'); process.exit(1); }

const API_SRC = path.join(APP_DIR, 'yandex', 'data-api');
const { createApi } = require(path.join(API_SRC, 'api'));
const auth = require(path.join(API_SRC, 'auth'));
const { createAccounts } = require(path.join(API_SRC, 'accounts'));
const { createFileStore } = require('./store-file');
const { createLocalFiles } = require('./files-local');

const store = createFileStore(path.join(DATA_DIR, 'db'));
const files = createLocalFiles({ dir: path.join(DATA_DIR, 'files'), publicBase: PUBLIC_ORIGIN, secret: crypto.createHash('sha256').update('files:' + env.AUTH_SECRET).digest('hex') });
const accounts = createAccounts({ store, auth });
// The product photo search is Yandex's (it needs Yandex's own credentials): not available here.
const images = { search: async () => { throw new Error('no image search here'); }, fetchImage: async () => null };
const api = createApi({ store, auth, files, accounts, images });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const NO_CACHE = 'no-store, no-cache, must-revalidate';
const FOREVER = 'public, max-age=31536000, immutable';

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(body);
}
const text = (res, status, msg) => send(res, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_CACHE }, msg);

// A file of the app, or null. Never outside the app folder.
function appFile(rel) {
  const full = path.resolve(APP_DIR, rel);
  if (!full.startsWith(APP_DIR + path.sep)) return null;
  try { const st = fs.statSync(full); return st.isFile() ? { full, st } : null; } catch (e) { return null; }
}
function serveStatic(req, res, rel, cache) {
  const f = appFile(rel);
  if (!f) return text(res, 404, 'Not found');
  const etag = '"' + f.st.size.toString(36) + '-' + Math.floor(f.st.mtimeMs).toString(36) + '"';
  const headers = { 'Content-Type': TYPES[path.extname(f.full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache, ETag: etag, 'Last-Modified': f.st.mtime.toUTCString(), 'Content-Length': f.st.size };
  if (req.headers['if-none-match'] === etag) return send(res, 304, headers);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f.full).pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
// Repeated query keys as arrays, as the API expects (mask.fieldPaths=a&mask.fieldPaths=b).
function queryObject(sp) {
  const q = {};
  for (const [k, v] of sp) q[k] = k in q ? [].concat(q[k], v) : v;
  return q;
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;

async function handleDb(req, res, url) {
  let body = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req, 20 * 1024 * 1024);
  const r = await api.handle({ method: req.method, rest: url.pathname.replace(/^\/db\//, ''), query: queryObject(url.searchParams), headers: req.headers, body, ip: clientIp(req) });
  send(res, r.status, r.headers || {}, r.body);
}

function serveFile(req, res, id) {
  const f = files.lookup(id);
  if (!f) return text(res, 404, 'Not found');
  const headers = { 'Content-Type': f.type, 'Content-Length': f.size, 'Cache-Control': 'public, max-age=31536000, immutable' };
  if (f.disposition) headers['Content-Disposition'] = f.disposition;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f.path).pipe(res);
}

// /api/… to Vercel as it came — method, headers, body; and the answer back as it comes.
function proxyApi(req, res, url) {
  const target = new URL(API_ORIGIN + url.pathname + url.search);
  const headers = Object.assign({}, req.headers, { host: target.host });
  delete headers.connection;
  const up = (target.protocol === 'http:' ? http : https).request(target, { method: req.method, headers, timeout: 150000 }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { if (!res.headersSent) text(res, 504, 'The AI service did not answer in time'); else res.end(); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  let url, p;
  try { url = new URL(req.url, 'http://local'); p = decodeURIComponent(url.pathname); } catch (e) { return text(res, 400, 'Bad request'); }
  try {
    if (p.startsWith('/db/')) return await handleDb(req, res, url);
    if (p.startsWith('/api/')) return proxyApi(req, res, url);
    const fm = /^\/files\/([a-z0-9]+)$/.exec(p);
    if (fm && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, fm[1]);
    const um = /^\/files-upload\/([a-z0-9]+)$/.exec(p);
    if (um && req.method === 'PUT') return files.acceptUpload(req, um[1], url.searchParams, (code, msg) => text(res, code, msg));
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
    if (p === '/' || p === '/service-manager.html' || p === '/app-version') return serveStatic(req, res, 'service-manager.html', NO_CACHE);
    if (p === '/firebase-messaging-sw.js') return serveStatic(req, res, 'firebase-messaging-sw.js', NO_CACHE);
    if (p === '/novoe' || p === '/novoe/') return serveStatic(req, res, 'novoe/index.html', NO_CACHE);
    if (p.startsWith('/novoe/img/')) return serveStatic(req, res, p.slice(1), 'public, max-age=86400');
    if (p.startsWith('/vendor/')) return serveStatic(req, res, p.slice(1), FOREVER);
    if (p === '/healthz') return text(res, 200, 'ok');
    return text(res, 404, 'Not found');
  } catch (e) {
    console.error(new Date().toISOString(), req.method, p, e && e.stack || e);
    if (!res.headersSent) text(res, e && e.status || 500, e && e.status === 413 ? 'Too large' : 'Server error');
    else res.end();
  }
});
server.requestTimeout = 0; // uploads of large videos
server.listen(PORT, HOST, () => console.log(`Sad Budushego on http://${HOST}:${PORT} — app ${APP_DIR}, data ${DATA_DIR}, ${store.docs.size} documents`));
