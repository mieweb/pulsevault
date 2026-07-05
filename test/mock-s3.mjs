// Zero-dependency, in-memory S3-compatible test double.
//
// Replaces the unmaintained `s3rver` (whose dependency chain carried open
// high-severity advisories — busboy/dicer — and whose fast-xml-parser pin
// needed a compat shim, and which lacked ListParts entirely, needing a second
// shim). Instead of emulating all of S3, this implements exactly the eleven
// operations the code under test uses — `@tus/s3-store`'s multipart lifecycle
// plus `src/storage/s3.ts`'s object/sidecar traffic:
//
//   PutObject (incl. `If-None-Match: *` conditional create), GetObject (incl.
//   Range), HeadObject, DeleteObject, DeleteObjects, CreateMultipartUpload,
//   UploadPart, ListParts, CompleteMultipartUpload, AbortMultipartUpload,
//   ListMultipartUploads.
//
// Path-style addressing only (`/<bucket>/<key>` — the tests set
// `forcePathStyle: true`). No signature verification: it binds to 127.0.0.1
// and exists to exercise the adapter's wire behavior, not S3's auth. Unlike
// s3rver it DOES enforce `If-None-Match: *` (412 on existing object), so the
// adapter's atomic reserve collision guard is genuinely exercised here.
//
// Response XML is hand-built and error codes (`NoSuchKey`, `NoSuchBucket`,
// `NoSuchUpload`, `PreconditionFailed`, `InvalidRange`) follow the S3 REST
// shapes the AWS SDK v3 deserializer maps back onto typed errors (`err.name`,
// `$metadata`).
//
// KNOWN-LOOSER THAN REAL S3 (deliberate — irrelevant to the code under test,
// but don't rely on the mock to catch these): CompleteMultipartUpload accepts
// parts in any order (real S3 rejects non-ascending PartNumber lists with
// `InvalidPartOrder`) and doesn't enforce the 5 MiB minimum for non-final
// parts (`EntityTooSmall`). A part-size config regression would pass here and
// fail against real S3/R2.

import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

function md5Hex(buf) {
  return createHash('md5').update(buf).digest('hex');
}

function xmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function xmlUnescape(s) {
  return String(s)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function sendXml(res, status, body) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  res.writeHead(status, {
    'content-type': 'application/xml',
    'content-length': Buffer.byteLength(xml),
  });
  res.end(xml);
}

function sendError(res, status, code, message) {
  sendXml(
    res,
    status,
    `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`,
  );
}

/**
 * Decode `Content-Encoding: aws-chunked` framing (`<hex-size>[;chunk-signature=…]\r\n<bytes>\r\n`,
 * terminated by a 0-size chunk and optional trailers). The SDK only uses it for
 * streaming signed/trailing-checksum uploads; the tests configure checksums off,
 * but decoding defensively keeps the mock correct if a future SDK flips defaults.
 */
function decodeAwsChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const header = buf.subarray(i, lineEnd).toString('latin1');
    const size = Number.parseInt(header.split(';')[0], 16);
    if (!Number.isFinite(size)) break;
    if (size === 0) break; // terminal chunk; anything after is trailers
    const start = lineEnd + 2;
    out.push(buf.subarray(start, start + size));
    i = start + size + 2; // skip trailing \r\n
  }
  return Buffer.concat(out);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const encoding = String(req.headers['content-encoding'] ?? '');
  return encoding.includes('aws-chunked') ? decodeAwsChunked(raw) : raw;
}

/**
 * Collect `x-amz-meta-*` request headers into a metadata record. `@tus/s3-store`
 * round-trips its upload state (the multipart UploadId, tus version) through
 * object Metadata on the `.info` object, so dropping these breaks every PATCH.
 */
function readAmzMeta(req) {
  const meta = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith('x-amz-meta-')) meta[name.slice('x-amz-meta-'.length)] = String(value);
  }
  return meta;
}

/**
 * Parse a `Range` header like S3 does: `bytes=a-b`, `bytes=a-`, and the suffix
 * form `bytes=-n`. Returns `[start, endInclusive]`, `'unsatisfiable'` (start
 * beyond EOF → the caller must answer 416 like real S3, not silently serve the
 * full body — that would mask consumer offset bugs), or `null` for no/foreign
 * range (full-body 200).
 */
function parseRange(header, size) {
  if (!header) return null;
  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (suffix) {
    const n = Number(suffix[1]);
    if (n === 0) return 'unsatisfiable';
    return [Math.max(0, size - n), size - 1];
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return 'unsatisfiable';
  return [start, end];
}

/**
 * Start the mock. Returns `{ endpoint, port, close() }`. State is per-instance
 * and in-memory only — a fresh instance is a clean bucket.
 */
export async function startMockS3({ buckets = [] } = {}) {
  /** @type {Map<string, { body: Buffer, etag: string, contentType: string, metadata: Record<string, string> }>} key: `<bucket> <key>` (space-separated; S3 bucket names cannot contain spaces) */
  const objects = new Map();
  /** @type {Map<string, { bucket: string, key: string, contentType: string, metadata: Record<string, string>, parts: Map<number, { body: Buffer, etag: string }> }>} */
  const uploads = new Map();
  const bucketSet = new Set(buckets);

  const objKey = (bucket, key) => `${bucket} ${key}`;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://mock-s3');
      // Path-style: /<bucket>/<key…>. Decode after splitting off the bucket so
      // encoded characters inside the key can't shift the bucket boundary.
      const path = url.pathname.replace(/^\//, '');
      const slash = path.indexOf('/');
      const bucket = decodeURIComponent(slash < 0 ? path : path.slice(0, slash));
      const key = slash < 0 ? '' : decodeURIComponent(path.slice(slash + 1));
      const q = url.searchParams;

      if (!bucketSet.has(bucket)) {
        sendError(res, 404, 'NoSuchBucket', `Bucket ${bucket} does not exist`);
        return;
      }

      // ---- Multipart lifecycle (distinguished by query params, not x-id) ----

      if (req.method === 'POST' && q.has('uploads')) {
        // CreateMultipartUpload
        const uploadId = randomUUID();
        uploads.set(uploadId, {
          bucket,
          key,
          contentType: req.headers['content-type'] ?? 'application/octet-stream',
          metadata: readAmzMeta(req),
          parts: new Map(),
        });
        sendXml(
          res,
          200,
          `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }

      if (req.method === 'PUT' && q.has('partNumber') && q.has('uploadId')) {
        // UploadPart
        const upload = uploads.get(q.get('uploadId'));
        if (!upload) {
          sendError(res, 404, 'NoSuchUpload', 'Upload not found');
          return;
        }
        const body = await readBody(req);
        const etag = `"${md5Hex(body)}"`;
        upload.parts.set(Number(q.get('partNumber')), { body, etag });
        res.writeHead(200, { etag, 'content-length': 0 });
        res.end();
        return;
      }

      if (req.method === 'GET' && q.has('uploadId')) {
        // ListParts
        const upload = uploads.get(q.get('uploadId'));
        if (!upload) {
          sendError(res, 404, 'NoSuchUpload', 'Upload not found');
          return;
        }
        const parts = [...upload.parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(
            ([n, p]) =>
              `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag}</ETag><Size>${p.body.length}</Size></Part>`,
          )
          .join('');
        sendXml(
          res,
          200,
          `<ListPartsResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${q.get('uploadId')}</UploadId><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`,
        );
        return;
      }

      if (req.method === 'POST' && q.has('uploadId')) {
        // CompleteMultipartUpload — assemble in the order the request lists parts.
        const uploadId = q.get('uploadId');
        const upload = uploads.get(uploadId);
        if (!upload) {
          sendError(res, 404, 'NoSuchUpload', 'Upload not found');
          return;
        }
        const body = (await readBody(req)).toString('utf8');
        const partNumbers = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) =>
          Number(m[1]),
        );
        const pieces = [];
        for (const n of partNumbers) {
          const part = upload.parts.get(n);
          if (!part) {
            sendError(res, 400, 'InvalidPart', `Part ${n} not found`);
            return;
          }
          pieces.push(part.body);
        }
        const assembled = Buffer.concat(pieces);
        objects.set(objKey(bucket, key), {
          body: assembled,
          etag: `"${md5Hex(assembled)}-${partNumbers.length}"`,
          contentType: upload.contentType,
          metadata: upload.metadata,
        });
        uploads.delete(uploadId);
        const location = `http://mock-s3/${bucket}/${key}`;
        sendXml(
          res,
          200,
          `<CompleteMultipartUploadResult><Location>${xmlEscape(location)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(objects.get(objKey(bucket, key)).etag)}</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }

      if (req.method === 'DELETE' && q.has('uploadId')) {
        // AbortMultipartUpload — idempotent, like S3.
        uploads.delete(q.get('uploadId'));
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && !key && q.has('uploads')) {
        // ListMultipartUploads — only used by @tus/s3-store's expiration sweep.
        const items = [...uploads.entries()]
          .filter(([, u]) => u.bucket === bucket)
          .map(
            ([id, u]) =>
              `<Upload><Key>${xmlEscape(u.key)}</Key><UploadId>${id}</UploadId><Initiated>1970-01-01T00:00:00.000Z</Initiated></Upload>`,
          )
          .join('');
        sendXml(
          res,
          200,
          `<ListMultipartUploadsResult><Bucket>${xmlEscape(bucket)}</Bucket><IsTruncated>false</IsTruncated>${items}</ListMultipartUploadsResult>`,
        );
        return;
      }

      // ---- Plain object operations ----

      if (req.method === 'POST' && !key && q.has('delete')) {
        // DeleteObjects (batch)
        const body = (await readBody(req)).toString('utf8');
        const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1]));
        const deleted = keys
          .map((k) => {
            objects.delete(objKey(bucket, k));
            return `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`;
          })
          .join('');
        sendXml(res, 200, `<DeleteResult>${deleted}</DeleteResult>`);
        return;
      }

      if (req.method === 'PUT' && key) {
        // PutObject — enforces `If-None-Match: *` (the reserve collision guard).
        if (req.headers['if-none-match'] === '*' && objects.has(objKey(bucket, key))) {
          // Drain the body first so the client isn't left writing into a closed socket.
          await readBody(req);
          sendError(res, 412, 'PreconditionFailed', 'Object already exists');
          return;
        }
        const body = await readBody(req);
        objects.set(objKey(bucket, key), {
          body,
          etag: `"${md5Hex(body)}"`,
          contentType: req.headers['content-type'] ?? 'application/octet-stream',
          metadata: readAmzMeta(req),
        });
        res.writeHead(200, { etag: objects.get(objKey(bucket, key)).etag, 'content-length': 0 });
        res.end();
        return;
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && key) {
        const obj = objects.get(objKey(bucket, key));
        if (!obj) {
          if (req.method === 'HEAD') {
            res.writeHead(404);
            res.end();
          } else {
            sendError(res, 404, 'NoSuchKey', `Key ${key} does not exist`);
          }
          return;
        }
        const range = req.method === 'GET' ? parseRange(req.headers.range, obj.body.length) : null;
        if (range === 'unsatisfiable') {
          sendError(res, 416, 'InvalidRange', 'The requested range is not satisfiable');
          return;
        }
        const slice = range ? obj.body.subarray(range[0], range[1] + 1) : obj.body;
        const headers = {
          // Real S3 honors the presign-time `response-content-type` query override
          // (the adapter's resolve() forces the served type this way).
          'content-type': q.get('response-content-type') ?? obj.contentType,
          'content-length': slice.length,
          etag: obj.etag,
          'accept-ranges': 'bytes',
        };
        // Echo object metadata back as x-amz-meta-* — the SDK surfaces these as
        // `Metadata`, which @tus/s3-store depends on to recover its upload state.
        for (const [name, value] of Object.entries(obj.metadata ?? {})) {
          headers[`x-amz-meta-${name}`] = value;
        }
        if (range) headers['content-range'] = `bytes ${range[0]}-${range[1]}/${obj.body.length}`;
        res.writeHead(range ? 206 : 200, headers);
        res.end(req.method === 'HEAD' ? undefined : slice);
        return;
      }

      if (req.method === 'DELETE' && key) {
        // DeleteObject — S3 returns 204 whether or not the key existed.
        objects.delete(objKey(bucket, key));
        res.writeHead(204);
        res.end();
        return;
      }

      sendError(res, 400, 'InvalidRequest', `Unsupported: ${req.method} ${req.url}`);
    } catch (err) {
      sendError(res, 500, 'InternalError', err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
