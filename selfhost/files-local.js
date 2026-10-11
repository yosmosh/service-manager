// Photos, videos and documents on this computer's disk — the same contract as
// yandex/data-api/files.js (the Yandex bucket): presignUpload() says where the browser is to PUT
// a new file and what its address will be; remove() deletes one.
//
//   <dir>/<id>        the file's bytes
//   <dir>/<id>.meta   {type, disposition} — what it is served with
//
// The upload address is this server's own (/files-upload/<id>), valid for 15 minutes and signed
// over the id, the expiry and the two headers the browser must send, as the bucket's presigned
// URLs were. A file is served at <publicBase>/files/<id> to anyone with the address, which can't
// be guessed (time + 20 random hex characters) — as the bucket served them.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^[a-z0-9]{8,64}$/;
const MAX_UPLOAD = 300 * 1024 * 1024;

function createLocalFiles({ dir, publicBase, secret, now }) {
  if (!secret) throw new Error('files: no signing secret');
  fs.mkdirSync(dir, { recursive: true });
  const clock = now || (() => Date.now());
  const sign = (id, exp, type, disposition) =>
    crypto.createHmac('sha256', secret).update([id, exp, type, disposition || ''].join('\n')).digest('base64url');
  const newId = () => Date.now().toString(36) + crypto.randomBytes(10).toString('hex');
  const fileOf = id => path.join(dir, id);

  async function presignUpload({ type, name, id: keepId }) {
    const id = keepId || newId();
    if (!ID.test(id)) throw new Error('bad file id');
    const contentType = type || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };
    if (name) headers['Content-Disposition'] = "inline; filename*=UTF-8''" + encodeURIComponent(String(name).slice(0, 200));
    const exp = Math.floor(clock() / 1000) + 900;
    const sig = sign(id, exp, contentType, headers['Content-Disposition']);
    // Relative: the page PUTs to whichever of the site's addresses it was opened on.
    const uploadUrl = '/files-upload/' + id + '?exp=' + exp + '&sig=' + sig;
    return { id, uploadUrl, headers, contentType, url: publicBase + '/files/' + id };
  }

  async function remove(id) {
    if (!ID.test(String(id))) return;
    for (const f of [fileOf(id), fileOf(id) + '.meta']) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }

  // PUT /files-upload/<id>?exp&sig — the browser's upload. → status code
  function acceptUpload(req, id, query, done) {
    const type = req.headers['content-type'] || '';
    const disposition = req.headers['content-disposition'] || '';
    const exp = Number(query.get('exp'));
    const sig = String(query.get('sig') || '');
    const want = ID.test(id) && exp ? sign(id, exp, type, disposition) : '';
    const okSig = want && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    if (!okSig) { req.resume(); return done(403, 'Signature does not match'); }
    if (clock() / 1000 > exp) { req.resume(); return done(403, 'Upload address expired'); }
    if (fs.existsSync(fileOf(id))) { req.resume(); return done(409, 'File already exists'); }
    const tmp = fileOf(id) + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (code, msg) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); req.resume(); done(code, msg); };
    req.on('data', chunk => { size += chunk.length; if (size > MAX_UPLOAD) fail(413, 'File too large'); });
    req.on('error', () => fail(400, 'Upload interrupted'));
    out.on('error', () => fail(500, 'Could not store the file'));
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      try {
        fs.writeFileSync(fileOf(id) + '.meta', JSON.stringify({ type: type || 'application/octet-stream', disposition }));
        fs.renameSync(tmp, fileOf(id));
        done(200, 'OK');
      } catch (e) { fail(500, 'Could not store the file'); }
    });
  }

  // → {path, size, type, disposition} or null
  function lookup(id) {
    if (!ID.test(String(id))) return null;
    let st;
    try { st = fs.statSync(fileOf(id)); } catch (e) { return null; }
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(fileOf(id) + '.meta', 'utf8')); } catch (e) {}
    return { path: fileOf(id), size: st.size, type: meta.type || 'application/octet-stream', disposition: meta.disposition || '' };
  }

  return { presignUpload, remove, acceptUpload, lookup, ID };
}

module.exports = { createLocalFiles };
