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
//   GET  /pulsevault/capabilities            §2  (advertises directUpload)
//   POST /pulsevault/direct-uploads          §9.1 (presigned PUT via aws4fetch)
//   POST /pulsevault/direct-uploads/:id/complete §9.2 (R2 head + finalize)
//   GET  /pulsevault/artifacts/:id           §6  (presigned GET redirect)
//   GET  /deeplinks                          §3  (pairing link)
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

import { AwsClient } from "aws4fetch";

const KINDS = ["video", "project", "captions", "thumbnail"];
const ALLOWED = {
  video: [".mp4"],
  project: [".pulse", ".zip"],
  captions: [".vtt"],
  thumbnail: [".jpg", ".jpeg", ".png"],
};
const MAX_UPLOAD = 5 * 1024 * 1024 * 1024;
const PRESIGN_TTL = 900;
const PREFIX = "/pulsevault";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".pulse": "application/octet-stream",
  ".vtt": "text/vtt",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "Protocol-Version": "1" },
  });
const fail = (status, error) => json(status, { ok: false, error });

// ---- capability tokens (§5.4): WebCrypto twin of verifyCapabilityToken ----

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function verifyToken(token, env) {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await hmac(env.PV_TOKEN_SECRET, payload);
  // Not length-hiding, but signatures are fixed-length base64url here.
  if (signature !== expected) return null;
  let claims;
  try {
    claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.artifactId !== "string") return null;
  if (claims.iat > now + 30 || claims.exp < now - 30) return null;
  if (claims.issuer !== env.PV_ISSUER) return null;
  return { artifactId: claims.artifactId };
}

async function issueToken(artifactId, env, expirySeconds = 1800) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { artifactId, iat: now, exp: now + expirySeconds, kid: "k1", issuer: env.PV_ISSUER };
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${payload}.${await hmac(env.PV_TOKEN_SECRET, payload)}`;
}

/** Bearer-token gate: allowed iff the token covers the artifact or its session anchor. */
async function authorize(request, env, artifactId, relatedTo) {
  const header = request.headers.get("authorization") ?? "";
  const url = new URL(request.url);
  const token = /^Bearer /i.test(header)
    ? header.slice("Bearer ".length)
    : (url.searchParams.get("token") ?? "");
  if (!token) return fail(401, "Missing capability token");
  const verified = await verifyToken(token, env);
  if (!verified) return fail(403, "Invalid or expired capability token");
  if (verified.artifactId !== artifactId && verified.artifactId !== relatedTo) {
    return fail(403, "Token does not authorize this artifact");
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

async function presign(env, method, key, ttl = PRESIGN_TTL) {
  const url = new URL(
    `https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`,
  );
  url.searchParams.set("X-Amz-Expires", String(ttl));
  const signed = await r2Client(env).sign(new Request(url, { method }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

// ---- sidecar-equivalent metadata on an R2 object ----

const metaKey = (id) => `.pulsevault/${id}.json`;

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
    httpMetadata: { contentType: "application/json" },
  });

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
    return fail(400, "Request body must be JSON");
  }
  const artifactId = String(body.artifactId ?? "").trim();
  if (!UUID_RE.test(artifactId)) return fail(400, "`artifactId` must be a valid UUID");
  const kind = KINDS.includes(body.kind) ? body.kind : "video";
  const filename = String(body.filename ?? "");
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED[kind].includes(ext)) {
    return fail(400, `\`filename\` for kind="${kind}" must end with one of: ${ALLOWED[kind].join(", ")}`);
  }
  const size = body.size;
  if (!Number.isSafeInteger(size) || size <= 0) return fail(400, "`size` must be a positive integer");
  if (size > MAX_UPLOAD) return fail(413, "`size` exceeds the maximum upload size");
  const relatedTo = UUID_RE.test(String(body.relatedTo ?? "")) ? body.relatedTo : undefined;

  const rejected = await authorize(request, env, artifactId, relatedTo);
  if (rejected) return rejected;

  if (await readMeta(env, artifactId)) return fail(409, `artifactId ${artifactId} already has an upload`);

  const key = `${kind}/${artifactId}${ext}`;
  await writeMeta(env, artifactId, {
    version: 1,
    ext,
    filename,
    status: "uploading",
    kind,
    relatedTo,
    expectedSize: size,
    reservedAt: Date.now(),
  });
  const uploadUrl = await presign(env, "PUT", key);
  return json(201, {
    ok: true,
    artifactId,
    uploadUrl,
    expiresAt: new Date(Date.now() + PRESIGN_TTL * 1000).toISOString(),
    headers: { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream", "Content-Length": String(size) },
  });
}

async function handleDirectComplete(request, env, artifactId) {
  if (!UUID_RE.test(artifactId)) return fail(400, "`artifactId` must be a valid UUID");
  const meta = await readMeta(env, artifactId);
  if (!meta) return fail(404, "Unknown artifactId — create the direct upload first");
  const rejected = await authorize(request, env, artifactId, meta.relatedTo);
  if (rejected) return rejected;
  if (meta.status === "ready") return json(200, { ok: true, artifactId });

  const key = `${meta.kind}/${artifactId}${meta.ext}`;
  const head = await env.BUCKET.head(key);
  if (!head) return fail(409, "No uploaded object found — PUT the bytes to the upload URL first");
  if (meta.expectedSize !== undefined && head.size !== meta.expectedSize) {
    await env.BUCKET.delete([key, metaKey(artifactId)]);
    return fail(422, `Uploaded size (${head.size}) does not match the declared size (${meta.expectedSize})`);
  }
  await writeMeta(env, artifactId, { ...meta, status: "ready" });
  return json(200, { ok: true, artifactId });
}

async function handleArtifactGet(request, env, artifactId) {
  if (!UUID_RE.test(artifactId)) return fail(400, "`artifactId` must be a valid UUID");
  const meta = await readMeta(env, artifactId);
  const rejected = await authorize(request, env, artifactId, meta?.relatedTo);
  if (rejected) return rejected;
  if (!meta || meta.status !== "ready") return fail(404, "Artifact not found");
  const url = await presign(env, "GET", `${meta.kind}/${artifactId}${meta.ext}`);
  return new Response(null, { status: 302, headers: { location: url, "Protocol-Version": "1" } });
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
    if (p === "/deeplinks" && request.method === "GET") return handleDeeplink(request, env);
    if (!p.startsWith(`${PREFIX}/`)) return new Response("Not Found", { status: 404 });
    const sub = p.slice(PREFIX.length);
    if (sub === "/capabilities" && request.method === "GET") return handleCapabilities();
    if (sub === "/direct-uploads" && request.method === "POST") return handleDirectCreate(request, env);
    const complete = sub.match(/^\/direct-uploads\/([^/]+)\/complete$/);
    if (complete && request.method === "POST") return handleDirectComplete(request, env, complete[1]);
    const artifact = sub.match(/^\/artifacts\/([^/]+)$/);
    if (artifact && request.method === "GET") return handleArtifactGet(request, env, artifact[1]);
    return new Response("Not Found", { status: 404 });
  },
};
