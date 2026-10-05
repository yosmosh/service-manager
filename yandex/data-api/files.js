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

async function presignUpload({ type }) {
  const id = newId();
  const key = 'files/' + id;
  const contentType = type || 'application/octet-stream';
  const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: 900 });
  return { id, uploadUrl, contentType, url: PUBLIC_BASE + key };
}

async function remove(id) {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'files/' + id }));
}

module.exports = { presignUpload, remove, PUBLIC_BASE };
