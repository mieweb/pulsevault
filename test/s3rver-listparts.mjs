// s3rver does not implement the S3 `ListParts` operation, but `@tus/s3-store`
// calls it on every chunk write (to find the next part number / current
// offset). Without it every PATCH 500s. This shim teaches a running s3rver
// instance to answer `GET /<bucket>/<key>?uploadId=<id>` by reading the part
// files s3rver already wrote to disk for that multipart upload.
//
// It's test-only and leans on s3rver's on-disk layout, which is stable
// because s3rver is unmaintained/frozen. Everything else @tus/s3-store needs
// (CreateMultipartUpload, UploadPart, the incomplete-part PutObject, and
// CompleteMultipartUpload) is already supported by s3rver natively.

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

// s3rver stores multipart parts at:
//   <rootDirectory>/<bucket>/._S3rver_uploads/<uploadId>/<partNumber>
// with a sibling `<partNumber>.md5` holding the part's md5 hex (its ETag).
const UPLOADS_DIR = "._S3rver_uploads";

async function listParts(rootDirectory, bucket, uploadId) {
  const uploadDir = path.join(rootDirectory, bucket, UPLOADS_DIR, uploadId);
  let entries;
  try {
    entries = await readdir(uploadDir);
  } catch {
    // No directory → upload unknown / already completed / aborted: no parts.
    return [];
  }
  const partNumbers = entries
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);

  const parts = [];
  for (const n of partNumbers) {
    const size = (await stat(path.join(uploadDir, String(n)))).size;
    let etag = "";
    try {
      etag = (await readFile(path.join(uploadDir, `${n}.md5`), "utf8")).trim();
    } catch {
      /* leave etag empty — s3rver's CompleteMultipartUpload ignores it */
    }
    parts.push({ n, size, etag });
  }
  return parts;
}

function renderListPartsXml(bucket, key, uploadId, parts) {
  const partsXml = parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.n}</PartNumber>` +
        `<LastModified>${new Date().toISOString()}</LastModified>` +
        `<ETag>&quot;${p.etag}&quot;</ETag>` +
        `<Size>${p.size}</Size></Part>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>` +
    `<PartNumberMarker>0</PartNumberMarker>` +
    `<NextPartNumberMarker>${parts.length}</NextPartNumberMarker>` +
    `<MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>` +
    partsXml +
    `</ListPartsResult>`
  );
}

/**
 * Install the ListParts shim on an (un-started) S3rver instance. Must be called
 * before `instance.run()` so the middleware is composed ahead of s3rver's
 * router (we unshift it to the front of the Koa onion).
 */
export function installListPartsShim(s3rverInstance) {
  const shim = async (ctx, next) => {
    // ListParts is `GET /<bucket>/<key>?uploadId=<id>` (no `uploads` param,
    // which would be the bucket-level ListMultipartUploads).
    if (
      ctx.method === "GET" &&
      ctx.query.uploadId !== undefined &&
      ctx.query.uploads === undefined
    ) {
      const segments = ctx.path.replace(/^\//, "").split("/");
      const bucket = segments.shift();
      const key = segments.join("/");
      const rootDirectory = s3rverInstance.store.rootDirectory;
      const parts = await listParts(rootDirectory, bucket, ctx.query.uploadId);
      ctx.type = "application/xml";
      ctx.status = 200;
      ctx.body = renderListPartsXml(bucket, key, ctx.query.uploadId, parts);
      return;
    }
    await next();
  };
  // Run before s3rver's own router/middleware.
  s3rverInstance.middleware.unshift(shim);
  return s3rverInstance;
}
