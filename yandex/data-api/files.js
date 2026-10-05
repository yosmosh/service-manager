// Photos, videos and documents: Object Storage bucket sad-budushego-files, key files/<id>.
// Objects are readable by their exact address (as Firebase's tokened download links were) and
// the bucket can't be listed. Uploads go straight from the browser to the bucket on a
// presigned URL — a function can't take a video (it accepts 3.5 MB at most) — so the file
// never passes through here; only the address to put it at does.

'use strict';

const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.FILES_BUCKET || 'sad-budushego-files';
const PUBLIC_BASE = 'https://storage.yandexcloud.net/' + BUCKET + '/';

let client = null;
function s3() {
  if (!client) {
    client = new S3Client({
      region: 'ru-central1',
      endpoint: 'https://storage.yandexcloud.net',
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_KEY_ID, secretAccessKey: process.env.S3_SECRET },
      // Recent SDKs add a CRC32 checksum to every PUT, presigned ones included; the browser
      // can't send a checksum it was never told, so only when an operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

// The same id shape the app has always used for files (time, then random).
const newId = () => Date.now().toString(36) + crypto.randomBytes(10).toString('hex');

// `id` only for the copy from Firebase (admin:presignCopy, service only), which keeps ids.
// With a `name` the file opens in the browser under that name rather than downloading (as
// the app's Firebase uploads did). Both headers are part of the signature, so the PUT must
// send `headers` exactly as returned.
async function presignUpload({ type, name, id: keepId }) {
  const id = keepId || newId();
  const key = 'files/' + id;
  const headers = { 'Content-Type': type || 'application/octet-stream' };
  if (name) headers['Content-Disposition'] = "inline; filename*=UTF-8''" + encodeURIComponent(String(name).slice(0, 200));
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: headers['Content-Type'], ContentDisposition: headers['Content-Disposition'] });
  const uploadUrl = await getSignedUrl(s3(), cmd, { expiresIn: 900 });
  return { id, uploadUrl, headers, contentType: headers['Content-Type'], url: PUBLIC_BASE + key };
}

async function remove(id) {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'files/' + id }));
}

module.exports = { presignUpload, remove, PUBLIC_BASE };
