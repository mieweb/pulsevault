// Cloudflare Workers demo: a PROTOCOL.md-compatible control plane on a V8
// isolate, with R2 as the data plane via the §9 direct-upload profile.
//
// Why this is NOT `@mieweb/pulsevault` running on Workers: resumable TUS
// uploads need the tus datastore stack (@tus/file-store or @tus/s3-store),
// which requires node:fs — unavailable on Workers. The honest edge answer is
// the direct-upload profile: this Worker authorizes + reserves + presigns,
// the client PUTs bytes straight to R2, and playback redirects to a presigned
// GET. Uploads are single-PUT (retryable, not mid-file resumable) — for tus
// resumability, run the Node/Bun web handler instead (see ../hono-demo).
//
// Implements from the spec alone (PROTOCOL.md permits third-party servers):
//   GET    /pulsevault/capabilities            §2  (advertises directUpload)
//   POST   /pulsevault/direct-uploads          §9.1 (presigned PUT via aws4fetch)
//   POST   /pulsevault/direct-uploads/:id/complete §9.2 (R2 head + finalize)
//   GET    /pulsevault/artifacts/:id           §6.1 (presigned GET redirect)
//   DELETE /pulsevault/artifacts/:id           §6.2 (authorized cleanup)
//   GET    /deeplinks                          §3  (pairing link)
// Capability tokens (§5.4) verified with WebCrypto HMAC — same claims shape
// as `issueCapabilityToken` in @mieweb/pulsevault, so a Node control plane
// and this Worker can share secrets.
//
// Setup: wrangler.toml binds BUCKET (R2) and vars/secrets:
//   wrangler secret put PV_TOKEN_SECRET     # HMAC secret for kid "k1"
//   wrangler secret put R2_ACCESS_KEY_ID    # R2 S3-API credentials (presigning)
//   wrangler secret put R2_SECRET_ACCESS_KEY
//   vars: R2_ACCOUNT_ID, R2_BUCKET_NAME, PV_ISSUER
//
// Sidecar-equivalent metadata lives in R2 customMetadata on a small
// `.pulsevault/<id>.json` object — same layout idea as the S3 adapter.

import { AwsClient } from 'aws4fetch';

const KINDS = ['video', 'project', 'captions', 'thumbnail'];
const ALLOWED = {
  video: ['.mp4'],
  project: ['.pulse', '.zip'],
  captions: ['.vtt'],
  thumbnail: ['.jpg', '.jpeg', '.png'],
};
const MAX_UPLOAD = 5 * 1024 * 1024 * 1024;
const PRESIGN_TTL = 900;
const PREFIX = '/pulsevault';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.pulse': 'application/octet-stream',
  '.vtt': 'text/vtt',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'Protocol-Version': '1' },
  });
const fail = (status, error) => json(status, { ok: false, error });

// ---- capability tokens (§5.4): WebCrypto twin of verifyCapabilityToken ----

function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function hmac(secret, payload) {
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function verifyToken(token, env) {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  // `crypto.subtle.verify` re-computes the MAC and compares in constant time —
  // a string `!==` on the attacker-supplied signature would be a timing oracle.
  let sigBytes;
  try {
    sigBytes = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  const key = await hmacKey(env.PV_TOKEN_SECRET, ['verify']);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;
  let claims;
  try {
    claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  // Full claim-shape validation BEFORE the time checks — mirrors
  // verifyCapabilityToken: a null payload, missing/non-numeric iat/exp, or
  // missing kid/issuer must fail closed, not fall through comparisons.
  if (claims === null || typeof claims !== 'object') return null;
  if (typeof claims.artifactId !== 'string') return null;
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
  if (typeof claims.kid !== 'string' || typeof claims.issuer !== 'string') return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + 30 || claims.exp < now - 30) return null;
  if (claims.issuer !== env.PV_ISSUER) return null;
  return { artifactId: claims.artifactId };
}

async function issueToken(artifactId, env, expirySeconds = 1800) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    artifactId,
    iat: now,
    exp: now + expirySeconds,
    kid: 'k1',
    issuer: env.PV_ISSUER,
  };
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${payload}.${await hmac(env.PV_TOKEN_SECRET, payload)}`;
}

/** Bearer-token gate: allowed iff the token covers the artifact or its session anchor. */
async function authorize(request, env, artifactId, relatedTo) {
  const header = request.headers.get('authorization') ?? '';
  const url = new URL(request.url);
  const token = /^Bearer /i.test(header)
    ? header.slice('Bearer '.length)
    : (url.searchParams.get('token') ?? '');
  if (!token) return fail(401, 'Missing capability token');
  const verified = await verifyToken(token, env);
  if (!verified) return fail(403, 'Invalid or expired capability token');
  if (verified.artifactId !== artifactId && verified.artifactId !== relatedTo) {
    return fail(403, 'Token does not authorize this artifact');
  }
  return null;
}

// ---- R2 presigning (S3 API) via aws4fetch ----

function r2Client(env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

// Path-style, matching the S3 adapter's R2 convention (`account.r2…/<bucket>/<key>`).
function r2ObjectUrl(env, key) {
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`,
  );
}

/**
 * Presign an object operation. `headers` (e.g. the grant's `Content-Type`)
 * are signed into the URL — they land in `X-Amz-SignedHeaders`, so R2 rejects
 * a PUT whose headers don't match the grant. (`Content-Length` is a
 * fetch-forbidden header that runtimes may strip before signing, so the
 * declared size is enforced at `complete` via the stored object's size
 * instead — same fail-closed 422 as the core.)
 */
async function presign(env, method, key, headers = undefined, ttl = PRESIGN_TTL) {
  const url = r2ObjectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(ttl));
  const signed = await r2Client(env).sign(new Request(url, { method, headers }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

// ---- sidecar-equivalent metadata on an R2 object ----

const metaKey = (id) => `.pulsevault/${id}.json`;

/**
 * The object key a reservation's bytes live at. Every reservation gets its own
 * random suffix: deleting a reservation cannot revoke its still-valid presigned
 * PUT, so fencing the KEY is what stops a superseded grant from writing into a
 * newer reservation's (or a ready artifact's) object.
 */
const dataKey = (id, meta) =>
  `${meta.kind}/${id}.${meta.objectSuffix ?? 'g0'}${meta.ext}`;

async function readMeta(env, id) {
  const obj = await env.BUCKET.get(metaKey(id));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

const writeMeta = (env, id, meta) =>
  env.BUCKET.put(metaKey(id), JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  });

/**
 * Create the reservation metadata atomically: a signed S3-API PUT with
 * `If-None-Match: *` (R2 supports conditional writes) fails with 412 if a
 * rival create already wrote it. The R2 binding's plain `put` would be a
 * read-then-write — two concurrent creates for one artifactId could both
 * observe "absent" and both claim 201, violating §9.1's collision rules.
 */
async function createMetaAtomic(env, id, meta) {
  const res = await r2Client(env).fetch(r2ObjectUrl(env, metaKey(id)), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-none-match': '*' },
    body: JSON.stringify(meta),
  });
  if (res.status === 412) return false;
  if (!res.ok) throw new Error(`reservation write failed (${res.status})`);
  return true;
}

// ---- routes ----

async function handleCapabilities() {
  return json(200, {
    protocolVersion: 1,
    minSupportedVersion: 1,
    maxSupportedVersion: 1,
    kinds: KINDS,
    allowedExtensions: ALLOWED,
    maxUploadSize: MAX_UPLOAD,
    directUpload: { enabled: true },
  });
}

async function handleDirectCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Request body must be JSON');
  }
  const artifactId = String(body.artifactId ?? '').trim();
  if (!UUID_RE.test(artifactId)) return fail(400, '`artifactId` must be a valid UUID');
  const kind = KINDS.includes(body.kind) ? body.kind : 'video';
  const filename = String(body.filename ?? '');
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED[kind].includes(ext)) {
    return fail(
      400,
      `\`filename\` for kind="${kind}" must end with one of: ${ALLOWED[kind].join(', ')}`,
    );
  }
  const size = body.size;
  if (!Number.isSafeInteger(size) || size <= 0)
    return fail(400, '`size` must be a positive integer');
  if (size > MAX_UPLOAD) return fail(413, '`size` exceeds the maximum upload size');
  const relatedTo = UUID_RE.test(String(body.relatedTo ?? '')) ? body.relatedTo : undefined;

  const rejected = await authorize(request, env, artifactId, relatedTo);
  if (rejected) return rejected;

  // §9.1 re-grant: an incomplete reservation with the SAME shape gets a fresh
  // presigned URL (the client lost the response or let the grant expire) — a
  // blanket 409 would permanently poison the artifactId. Anything else
  // (already completed, or different size/kind/ext, or a different session
  // anchor — the relation is part of the reservation's identity, so a token
  // for anchor A can't re-grant anchor B's reservation by submitting A) is a
  // real conflict.
  const sameShape = (meta) =>
    meta &&
    meta.status !== 'ready' &&
    meta.kind === kind &&
    meta.ext === ext &&
    meta.expectedSize === size &&
    meta.relatedTo === relatedTo;
  const grantResponse = async (meta, statusCode) =>
    json(statusCode, {
      ok: true,
      artifactId,
      uploadUrl: await presign(env, 'PUT', dataKey(artifactId, meta), {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      }),
      expiresAt: new Date(Date.now() + PRESIGN_TTL * 1000).toISOString(),
      headers: {
        'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': String(size),
      },
    });

  const existing = await readMeta(env, artifactId);
  if (existing) {
    if (!sameShape(existing)) return fail(409, `artifactId ${artifactId} already has an upload`);
    return grantResponse(existing, 200);
  }

  const meta = {
    version: 1,
    ext,
    filename,
    status: 'uploading',
    kind,
    relatedTo,
    expectedSize: size,
    reservedAt: Date.now(),
    // Per-reservation object key suffix — see `dataKey`.
    objectSuffix: `g${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
  };
  if (!(await createMetaAtomic(env, artifactId, meta))) {
    // Lost a concurrent create for this artifactId — apply the same
    // arbitration to the winner's reservation (a same-shape rival is this
    // client's own retry racing itself; grant against the WINNER's key).
    const winner = await readMeta(env, artifactId);
    if (!sameShape(winner)) return fail(409, `artifactId ${artifactId} already has an upload`);
    return grantResponse(winner, 200);
  }
  return grantResponse(meta, 201);
}

async function handleDirectComplete(request, env, artifactId) {
  if (!UUID_RE.test(artifactId)) return fail(400, '`artifactId` must be a valid UUID');
  const meta = await readMeta(env, artifactId);
  if (!meta) return fail(404, 'Unknown artifactId — create the direct upload first');
  const rejected = await authorize(request, env, artifactId, meta.relatedTo);
  if (rejected) return rejected;
  if (meta.status === 'ready') return json(200, { ok: true, artifactId });

  const key = dataKey(artifactId, meta);
  const head = await env.BUCKET.head(key);
  if (!head) return fail(409, 'No uploaded object found — PUT the bytes to the upload URL first');
  if (meta.expectedSize !== undefined && head.size !== meta.expectedSize) {
    await env.BUCKET.delete([key, metaKey(artifactId)]);
    return fail(
      422,
      `Uploaded size (${head.size}) does not match the declared size (${meta.expectedSize})`,
    );
  }
  await writeMeta(env, artifactId, { ...meta, status: 'ready' });
  return json(200, { ok: true, artifactId });
}

async function handleArtifactGet(request, env, artifactId) {
  if (!UUID_RE.test(artifactId)) return fail(400, '`artifactId` must be a valid UUID');
  const meta = await readMeta(env, artifactId);
  const rejected = await authorize(request, env, artifactId, meta?.relatedTo);
  if (rejected) return rejected;
  if (!meta || meta.status !== 'ready') return fail(404, 'Artifact not found');
  const url = await presign(env, 'GET', dataKey(artifactId, meta));
  return new Response(null, { status: 302, headers: { location: url, 'Protocol-Version': '1' } });
}

/** §6.2 — authorized delete: drop the bytes and the reservation metadata. */
async function handleArtifactDelete(request, env, artifactId) {
  if (!UUID_RE.test(artifactId)) return fail(400, '`artifactId` must be a valid UUID');
  const meta = await readMeta(env, artifactId);
  const rejected = await authorize(request, env, artifactId, meta?.relatedTo);
  if (rejected) return rejected;
  if (!meta) return fail(404, 'Artifact not found');
  await env.BUCKET.delete([dataKey(artifactId, meta), metaKey(artifactId)]);
  return new Response(null, { status: 204, headers: { 'Protocol-Version': '1' } });
}

async function handleDeeplink(request, env) {
  const artifactId = crypto.randomUUID();
  const token = await issueToken(artifactId, env);
  const origin = new URL(request.url).origin;
  const server = `${origin}${PREFIX}`;
  const link = `pulsecam://?v=1&artifactId=${artifactId}&server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`;
  return json(200, { artifactId, link });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === '/deeplinks' && request.method === 'GET') return handleDeeplink(request, env);
    if (!p.startsWith(`${PREFIX}/`)) return new Response('Not Found', { status: 404 });
    const sub = p.slice(PREFIX.length);
    if (sub === '/capabilities' && request.method === 'GET') return handleCapabilities();
    // Deliberately non-conforming to PROTOCOL §9's "MUST still support TUS":
    // Workers can't host the tus datastore stack (node:fs), so this control
    // plane is direct-upload-only. Answer explicitly instead of 404ing so a
    // conforming client gets a diagnosable error — pair it only with clients
    // known to use the direct profile (see the header comment).
    if (sub === '/upload' || sub.startsWith('/upload/')) {
      return new Response('TUS is not available on this control plane — direct uploads only', {
        status: 501,
        // §2: every protocol response other than capabilities carries the version.
        headers: { 'Protocol-Version': '1' },
      });
    }
    if (sub === '/direct-uploads' && request.method === 'POST')
      return handleDirectCreate(request, env);
    const complete = sub.match(/^\/direct-uploads\/([^/]+)\/complete$/);
    if (complete && request.method === 'POST')
      return handleDirectComplete(request, env, complete[1]);
    const artifact = sub.match(/^\/artifacts\/([^/]+)$/);
    if (artifact && request.method === 'GET') return handleArtifactGet(request, env, artifact[1]);
    if (artifact && request.method === 'DELETE')
      return handleArtifactDelete(request, env, artifact[1]);
    return new Response('Not Found', { status: 404, headers: { 'Protocol-Version': '1' } });
  },
};
