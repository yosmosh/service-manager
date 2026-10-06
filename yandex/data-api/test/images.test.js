// images.js: reading Yandex's image search, the signatures that keep the fetch to addresses the
// search handed out, and the picture fetch itself — over stubbed network calls.
//
//   node yandex/data-api/test/images.test.js

'use strict';

process.env.AUTH_SECRET = 'test-secret-' + Math.random();

const assert = require('assert');
const images = require('../images');

const XML = `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><results><grouping>
<group><doc id="A">
<url>https://shop.example/img/drill.jpg?x=1&amp;y=2</url>
<image-properties><thumbnail-link>http://avatars.mds.yandex.net/i?id=abc-images-thumbs</thumbnail-link>
<original-width>800</original-width><original-height>600</original-height>
<html-link>https://shop.example/drill</html-link><mime-type>jpg</mime-type></image-properties>
<mime-type>text/html</mime-type></doc></group>
<group><doc id="B">
<url>https://shop.example/logo.svg</url>
<image-properties><thumbnail-link>http://avatars.mds.yandex.net/i?id=def-images-thumbs</thumbnail-link>
<mime-type>svg</mime-type></image-properties></doc></group>
<group><doc id="C">
<url>javascript:alert(1)</url>
<image-properties><thumbnail-link>http://avatars.mds.yandex.net/i?id=ghi</thumbnail-link><mime-type>png</mime-type></image-properties></doc></group>
</grouping></results></response></yandexsearch>`;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 2)]);
const respond = (status, buf, headers) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => (headers || {})[k.toLowerCase()] || null },
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  json: async () => JSON.parse(buf.toString()),
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('results: pictures only, with https thumbnails, entities decoded', () => {
  const r = images.parseResults(XML);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0], { url: 'https://shop.example/img/drill.jpg?x=1&y=2', thumb: 'https://avatars.mds.yandex.net/i?id=abc-images-thumbs', width: 800, height: 600, source: 'https://shop.example/drill' });
});

test('search: asks Yandex as the function, and signs every result', async () => {
  let sent = null;
  const fake = async (url, opts) => { sent = { url, opts }; return respond(200, Buffer.from(JSON.stringify({ rawData: Buffer.from(XML).toString('base64') }))); };
  const r = await images.search('Дрель Bosch', 0, 'iam-token', fake);
  assert.strictEqual(sent.opts.headers.Authorization, 'Bearer iam-token');
  const body = JSON.parse(sent.opts.body);
  assert.deepStrictEqual([body.query.queryText, body.query.familyMode, body.docsOnPage], ['Дрель Bosch', 'FAMILY_MODE_STRICT', '12']);
  assert.strictEqual(r.length, 1);
  assert.ok(r[0].sig && r[0].sig.length === 32);
  assert.deepStrictEqual(await images.search('   ', 0, 'iam-token', fake), []);
});

test('fetch: only signed addresses; original first, thumbnail when it fails; bytes decide the type', async () => {
  const [hit] = images.parseResults(XML);
  const sig = images.sign(hit.url, hit.thumb);
  const asked = [];
  const ok = async u => { asked.push(u); return respond(200, JPEG, { 'content-type': 'text/plain' }); };
  const got = await images.fetchImage({ url: hit.url, thumb: hit.thumb, sig }, ok);
  assert.deepStrictEqual([got.type, got.from, Buffer.from(got.data, 'base64').length], ['image/jpeg', 'original', JPEG.length]);

  assert.deepStrictEqual(await images.fetchImage({ url: 'http://169.254.169.254/latest', thumb: hit.thumb, sig }, ok), { error: 'bad signature' });
  assert.deepStrictEqual(await images.fetchImage({ url: hit.url, thumb: 'https://evil.example/x', sig }, ok), { error: 'bad signature' });

  const origDown = async u => (u === hit.url ? respond(404, Buffer.alloc(0)) : respond(200, PNG));
  const t = await images.fetchImage({ url: hit.url, thumb: hit.thumb, sig }, origDown);
  assert.deepStrictEqual([t.type, t.from], ['image/png', 'thumb']);

  const tooBig = async u => (u === hit.url ? respond(200, JPEG, { 'content-length': String(images.MAX_IMAGE_BYTES + 1) }) : respond(200, PNG));
  assert.strictEqual((await images.fetchImage({ url: hit.url, thumb: hit.thumb, sig }, tooBig)).from, 'thumb');

  const svg = async () => respond(200, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'), { 'content-type': 'image/svg+xml' });
  assert.strictEqual(await images.fetchImage({ url: hit.url, thumb: hit.thumb, sig }, svg), null);

  const throws = async () => { throw new Error('timeout'); };
  assert.strictEqual(await images.fetchImage({ url: hit.url, thumb: hit.thumb, sig }, throws), null);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
