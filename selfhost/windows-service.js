// The app on a Windows computer, kept running. Started at boot by the scheduled task
// «SadBudushego Server» that deploy/selfhost-windows.ps1 makes, as the low-rights account
// LOCAL SERVICE (so it runs before anyone signs in, and can't touch anyone's files):
//
//   <root>\node\node.exe <root>\app\selfhost\windows-service.js <root>
//
// It runs the server (selfhost/server.js, settings from <root>\env) and Caddy in front of it
// for HTTPS (<root>\caddy\caddy.exe, <root>\Caddyfile), starts either again whenever it stops,
// keeps their output in <root>\logs, and takes a snapshot of the data every night at 00:30
// (<root>\data\backups, sixty kept) — and soon after starting, if the last is over a day old.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const LOGS = path.join(ROOT, 'logs');
const CADDY = path.join(ROOT, 'caddy', 'caddy.exe');
fs.mkdirSync(LOGS, { recursive: true });

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const settings = readEnv(path.join(ROOT, 'env'));
const APP = settings.APP_DIR || path.join(ROOT, 'app');
const DATA = settings.DATA_DIR || path.join(ROOT, 'data');
const appEnv = Object.assign({}, process.env, settings, { APP_DIR: APP, DATA_DIR: DATA });
// Caddy gets none of the secrets.
const caddyEnv = Object.assign({}, process.env, { XDG_DATA_HOME: path.join(ROOT, 'caddy-data'), XDG_CONFIG_HOME: path.join(ROOT, 'caddy-data') });

// <root>\logs\<name>.log; the 5 MB before it in <name>.log.1.
function logger(name) {
  const file = path.join(LOGS, name + '.log');
  return text => {
    try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch (e) {}
    try { fs.appendFileSync(file, text); } catch (e) {}
  };
}
const serviceLog = logger('service');
const say = msg => serviceLog(new Date().toISOString() + ' ' + msg + '\n');

let stopping = false;
const running = new Set();

// Runs cmd for good: started again whenever it stops — at once if it had run a minute or more,
// otherwise after a pause that doubles each time (up to a minute), so a broken start can't spin.
function keep(name, cmd, args, env) {
  const log = logger(name);
  let pause = 1000;
  function start() {
    if (stopping) return;
    const startedAt = Date.now();
    let ended = false;
    const child = spawn(cmd, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    const end = why => {
      if (ended) return;
      ended = true;
      running.delete(child);
      if (stopping) return;
      pause = Date.now() - startedAt >= 60000 ? 1000 : Math.min(pause * 2, 60000);
      say(`${name} stopped (${why}); starting it again in ${pause / 1000} s`);
      setTimeout(start, pause);
    };
    child.on('error', e => end(e.message));
    child.on('exit', (code, signal) => end(signal || 'exit code ' + code));
  }
  start();
}

// A Caddy left from before — this process ended without the chance to stop it — would hold
// the ports.
function endLeftovers() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process caddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${CADDY.replace(/'/g, "''")}' } | Stop-Process -Force`],
    { windowsHide: true, timeout: 60000, stdio: 'ignore' });
  } catch (e) {}
}

function snapshot() {
  const log = logger('backup');
  const child = spawn(process.execPath, [path.join(APP, 'selfhost', 'admin.js'), 'snapshot'], { cwd: ROOT, env: appEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = d => log(new Date().toISOString() + ' ' + d);
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('error', e => say('snapshot could not start: ' + e.message));
}
function nightly() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { snapshot(); nightly(); }, next - now);
}
function snapshotOverdue() {
  try { if (!fs.readdirSync(path.join(DATA, 'db')).length) return false; } catch (e) { return false; }
  const dir = path.join(DATA, 'backups');
  try {
    const last = fs.readdirSync(dir).filter(n => /^\d{4}-\d\d-\d\d\.json\.gz$/.test(n)).sort().pop();
    return !last || Date.now() - fs.statSync(path.join(dir, last)).mtimeMs > 26 * 3600 * 1000;
  } catch (e) { return true; }
}

function stop() {
  stopping = true;
  for (const c of running) { try { c.kill(); } catch (e) {} }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGBREAK', stop);
process.on('uncaughtException', e => { say('failed: ' + (e && e.stack || e)); stop(); });

say(`starting: ${ROOT}, node ${process.version}`);
endLeftovers();
keep('server', process.execPath, [path.join(APP, 'selfhost', 'server.js')], Object.assign({}, appEnv, { SADB_PARENT_PID: String(process.pid) }));
keep('caddy', CADDY, ['run', '--config', path.join(ROOT, 'Caddyfile'), '--adapter', 'caddyfile'], caddyEnv);
nightly();
if (snapshotOverdue()) setTimeout(snapshot, 2 * 60 * 1000);
