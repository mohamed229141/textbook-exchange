// Listing photos.
//   PHOTO_BUCKET set -> PRIVATE Amazon S3 bucket (Floci / AWS). The API reads the
//                       photo and returns it, so the bucket never has to be public.
//   not set          -> the database (Neon Postgres on Vercel, JSON file on your PC):
//                       Vercel has no S3 and its disk is temporary, so the photo
//                       (max 1 MB, base64) is stored as a row in the Photos table.
const config = require('../../config');
const { tables } = require('../../store');

let s3;

function client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    // Floci needs path-style URLs (http://localhost:4566/bucket/key)
    s3 = new S3Client({ forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL || process.env.S3_FORCE_PATH_STYLE) });
  }
  return s3;
}

async function putPhoto(key, buffer, contentType) {
  if (!config.photoBucket) {
    await tables.photos.create({ id: key, contentType, data: buffer.toString('base64'), createdAt: new Date().toISOString() });
    return;
  }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new PutObjectCommand({
    Bucket: config.photoBucket, Key: key, Body: buffer, ContentType: contentType,
    ServerSideEncryption: 'AES256'
  }));
}

async function getPhoto(key) {
  if (!config.photoBucket) {
    const row = await tables.photos.get(key);
    return row ? { buffer: Buffer.from(row.data, 'base64'), contentType: row.contentType } : null;
  }
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const out = await client().send(new GetObjectCommand({ Bucket: config.photoBucket, Key: key }));
    const buffer = Buffer.from(await out.Body.transformToByteArray());
    return { buffer, contentType: out.ContentType };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function deletePhoto(key) {
  if (!key) return;
  if (!config.photoBucket) { await tables.photos.remove(key).catch(() => {}); return; }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new DeleteObjectCommand({ Bucket: config.photoBucket, Key: key })).catch(() => {});
}

// Detect the real file type from its first bytes (do not trust the client's content type)
function sniffImageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

module.exports = { putPhoto, getPhoto, deletePhoto, sniffImageType };
