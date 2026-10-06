// Photos of products for the warehouse catalogue: Yandex's image search for an item's name,
// and the chosen picture fetched here for the browser (which can show a picture from another
// site but not read it, so it could not keep it).
//
//   search(query, page, iamToken) → [{ thumb, url, width, height, source, sig }]
//   fetchImage({ url, thumb, sig })  → { type, data (base64), from: 'original' | 'thumb' }
//
// Only addresses this service handed out itself are fetched: each result carries a signature
// (HMAC with AUTH_SECRET) over its two addresses, so the fetch can't be pointed anywhere else.
// The search runs as the function's service account (role search-api.webSearch.user).

'use strict';

const crypto = require('crypto');

const SEARCH_URL = 'https://searchapi.api.cloud.yandex.net/v2/image/search';
const FOLDER_ID = process.env.FOLDER_ID || 'b1gomtpk23dslrh2dhk6';
const PER_PAGE = 12;
// The function can answer with 3.5 MB at most, and base64 adds a third.
const MAX_IMAGE_BYTES = 2400 * 1024;
const FETCH_TIMEOUT_MS = 8000;

function sign(url, thumb) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET not configured');
  return crypto.createHmac('sha256', secret).update('img\n' + url + '\n' + thumb).digest('base64url').slice(0, 32);
}
function signedOk(url, thumb, sig) {
  const want = Buffer.from(sign(url, thumb)), got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const unescapeXml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml); return m ? unescapeXml(m[1].trim()) : ''; };
const httpsOf = u => (/^http:\/\/avatars\.mds\.yandex\.net\//.test(u) ? 'https://' + u.slice(7) : u);

// The search's XML (rawData) as results. Pictures only (jpg/png/webp/gif), each with a
// thumbnail on Yandex's own image servers, which open quickly in Russia.
function parseResults(xml) {
  const out = [];
  const docs = String(xml).match(/<doc [\s\S]*?<\/doc>/g) || [];
  for (const d of docs) {
    const props = (/<image-properties>([\s\S]*?)<\/image-properties>/.exec(d) || [])[1] || '';
    const url = tag(d, 'url');
    const thumb = httpsOf(tag(props, 'thumbnail-link'));
    const format = tag(props, 'mime-type').toLowerCase();
    if (!/^https?:\/\//.test(url) || !/^https:\/\//.test(thumb)) continue;
    if (format && !['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(format)) continue;
    out.push({
      url, thumb,
      width: Number(tag(props, 'original-width')) || 0,
      height: Number(tag(props, 'original-height')) || 0,
      source: tag(props, 'html-link'),
    });
  }
  return out;
}

async function search(query, page, iamToken, fetchImpl) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];
  if (!iamToken) throw new Error('no IAM token for the search');
  const r = await (fetchImpl || fetch)(SEARCH_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + iamToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { searchType: 'SEARCH_TYPE_RU', queryText: q, familyMode: 'FAMILY_MODE_STRICT', page: String(Math.max(0, Math.min(9, Number(page) || 0))) },
      docsOnPage: String(PER_PAGE),
      folderId: FOLDER_ID,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.rawData) throw new Error('image search → ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  const xml = Buffer.from(j.rawData, 'base64').toString('utf8');
  return parseResults(xml).map(x => Object.assign(x, { sig: sign(x.url, x.thumb) }));
}

// What the bytes are, whatever the server said they were. SVG is refused: it is a document,
// not a picture, and could carry a script.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

async function download(url, fetchImpl) {
  const r = await (fetchImpl || fetch)(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: 'image/*' },
  });
  if (!r.ok) return null;
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const type = sniff(buf);
  return type ? { type, buf } : null;
}

// The original if it can be had and isn't too big, else the thumbnail; null if neither.
async function fetchImage({ url, thumb, sig }, fetchImpl) {
  if (!signedOk(url, thumb, sig)) return { error: 'bad signature' };
  for (const [from, u] of [['original', url], ['thumb', thumb]]) {
    try {
      const got = await download(u, fetchImpl);
      if (got) return { type: got.type, data: got.buf.toString('base64'), from };
    } catch (e) { /* next */ }
  }
  return null;
}

module.exports = { search, fetchImage, parseResults, sign, sniff, MAX_IMAGE_BYTES };
