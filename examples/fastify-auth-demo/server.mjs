// Production-shaped Fastify reference server for @mieweb/pulsevault:
// capability tokens ALWAYS on (refuses to boot without PULSEVAULT_SECRET),
// pulse-session grouping via relatedTo, WebVTT captions, Swagger UI,
// and a live artifact-event feed. Local filesystem storage.
// For the smallest possible mount (no auth, no hooks) see
// ../fastify-demo/server.mjs.

import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyCompress from "@fastify/compress";
import fastifyEtag from "@fastify/etag";
import underPressure from "@fastify/under-pressure";
import QRCode from "qrcode";
import { PrismaClient } from "@prisma/client";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
  createChecksumValidator,
  buildUploadLink,
  issueCapabilityToken,
  verifyCapabilityToken,
  createCapabilityAuthorize,
} from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
// The uploads feed lives on its own page (the Shorts/Reels-style vertical
// pager) at /library — everything else under public/ (favicon, assets) is
// served by @fastify/static below.
const libraryHtml = readFileSync(path.join(__dirname, "public/library.html"), "utf8");
const dataDir = path.join(__dirname, "data");

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// ---------------------------------------------------------------------------
// Capability-token auth (the library's secure-by-default option — see
// `PROTOCOL.md` §5.4 and the README's "Capability tokens" section).
//
// This demo runs with auth ALWAYS on: every upload/watch is gated by a real
// HMAC-signed, per-artifact, expiring token minted by `issueCapabilityToken`
// and checked by `createCapabilityAuthorize` — not a hand-rolled comparison.
// A generated fallback secret would silently invalidate every outstanding
// token on restart, so a missing secret is a hard boot failure instead.
// ---------------------------------------------------------------------------
const PULSEVAULT_SECRET = process.env.PULSEVAULT_SECRET;
if (!PULSEVAULT_SECRET) {
  console.error("PULSEVAULT_SECRET is required — this demo runs with capability tokens always on.");
  console.error("Generate one with:  openssl rand -hex 32");
  console.error("Then:               docker compose up --build   (compose reads .env — see .env.example)");
  process.exit(1);
}

// Postgres only — users/sessions and the artifact index live there, and
// `docker compose up` is the supported way to run this demo (compose wires
// DATABASE_URL to the bundled Postgres). Schema is owned by
// prisma/schema.prisma and applied by `prisma migrate deploy` (npm start).
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — this demo keeps users/sessions and the artifact index in Postgres.");
  console.error("Run the full stack:  docker compose up --build   (see compose.yaml)");
  console.error("Bare-metal dev:      npm run db:up  then  npm start   (uses .env — see .env.example)");
  process.exit(1);
}
const PULSEVAULT_KEY_ID = process.env.PULSEVAULT_KEY_ID || "demo-1";
const TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes — long enough for one upload session
const WATCH_TOKEN_TTL_SECONDS = 5 * 60; // short-lived — minted fresh per gallery load, never persisted

/**
 * A capability token's `issuer` claim is checked for exact string equality
 * (PROTOCOL.md §5.4) — it has to be the one fixed origin this server issues
 * tokens under, not derived per-request from whatever `Host` header a client
 * happened to send (that would make "issuer" meaningless as an identity
 * check). `PULSEVAULT_ISSUER` is required to set this properly for phones on
 * your LAN; falls back to localhost (desktop-browser-only testing) with a
 * loud warning and a list of candidate LAN addresses to copy from.
 */
function detectLanIPv4s() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

let ISSUER = process.env.PULSEVAULT_ISSUER || null;
if (!ISSUER) {
  ISSUER = `http://localhost:${port}`;
  console.warn(
    `\nPULSEVAULT_ISSUER is not set — tokens will be issued for ${ISSUER}.`,
  );
  console.warn("That only works from a browser/phone on this same machine.");
  const lan = detectLanIPv4s();
  if (lan.length) {
    console.warn("For phones on your LAN, restart with one of:");
    for (const ip of lan) console.warn(`  PULSEVAULT_ISSUER=http://${ip}:${port}`);
  }
  console.warn("");
}

function lookupSecret(kid) {
  return kid === PULSEVAULT_KEY_ID ? PULSEVAULT_SECRET : null;
}

// ---------------------------------------------------------------------------
// Dashboard auth (Better Auth, https://better-auth.com) — two auth systems on
// purpose, guarding two different audiences:
//
//   - Better Auth (email + password, sessions in SQLite) guards the HUMAN
//     dashboard: minting pairing links, browsing uploads, the event feed.
//   - Capability tokens guard the VAULT routes the Pulse app talks to — the
//     app never logs in; it only redeems the bearer token carried on the
//     pairing link (PROTOCOL.md §5).
//
// Users/sessions live in Postgres through Prisma (prisma/schema.prisma holds
// the canonical Better Auth models). Migrations are applied by
// `prisma migrate deploy` before the server boots — see `npm start`.
// ---------------------------------------------------------------------------
const prismaClient = new PrismaClient();
const auth = betterAuth({
  baseURL: ISSUER,
  // Reuses the (required) vault secret unless a dedicated one is provided.
  secret: process.env.BETTER_AUTH_SECRET || PULSEVAULT_SECRET,
  database: prismaAdapter(prismaClient, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  // The dashboard may be reached via the LAN issuer or plain localhost.
  trustedOrigins: [ISSUER, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
});

// ---------------------------------------------------------------------------
// Artifact index — the same database also indexes completed uploads, so
// /videos is one query instead of re-reading every filesystem sidecar on
// every request (O(uploads), forever). Rows are written once by
// `onUploadComplete`, pruned when a delete is authorized, and reconciled
// from disk at boot — the sidecars stay the source of truth; the table is a
// disposable index over them.
// ---------------------------------------------------------------------------
const artifactIndex = {
  upsert: (a) =>
    prismaClient.artifact.upsert({
      where: { artifactId: a.artifactId },
      update: {},
      create: {
        artifactId: a.artifactId,
        kind: a.kind,
        filename: a.filename,
        ext: a.ext,
        size: BigInt(a.size),
        relatedTo: a.relatedTo,
        checksumVerified: a.checksumVerified,
        createdAt: new Date(a.creation_date),
      },
    }),
  remove: (artifactId) => prismaClient.artifact.deleteMany({ where: { artifactId } }),
  all: async () =>
    (await prismaClient.artifact.findMany()).map((r) => ({
      artifactId: r.artifactId,
      kind: r.kind,
      filename: r.filename,
      ext: r.ext,
      size: Number(r.size),
      relatedTo: r.relatedTo,
      checksumVerified: r.checksumVerified,
      creation_date: r.createdAt.toISOString(),
    })),
};

/** Reads one finished artifact's metadata from its filesystem sidecars, or null. */
async function readArtifactFromDisk(artifactId) {
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(path.join(dataDir, ".pulsevault", `${artifactId}.json`), "utf8"));
  } catch {
    return null;
  }
  if (sidecar.status !== "ready") return null;

  const kind = sidecar.kind ?? "video";
  const ext = sidecar.ext ?? ".mp4";
  const artifactPath = path.join(dataDir, kind, `${artifactId}${ext}`);
  const [artifactStat, tusMeta] = await Promise.all([
    stat(artifactPath).catch(() => null),
    readFile(`${artifactPath}.json`, "utf8").then(JSON.parse).catch(() => null),
  ]);
  if (!artifactStat || artifactStat.size === 0) return null;

  return {
    artifactId,
    kind,
    filename: sidecar.filename ?? tusMeta?.metadata?.filename ?? `${artifactId}${ext}`,
    ext,
    size: artifactStat.size,
    relatedTo: sidecar.relatedTo ?? null,
    checksumVerified: Boolean(sidecar.checksum),
    creation_date: tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
  };
}

/** Boot-time reconcile: index sidecars the table doesn't know, drop rows whose files are gone. */
async function reconcileArtifactIndex() {
  const metaDir = path.join(dataDir, ".pulsevault");
  let entries = [];
  try {
    entries = await readdir(metaDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const onDisk = (
    await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".tmp"))
        .map((e) => readArtifactFromDisk(e.name.slice(0, -".json".length))),
    )
  ).filter(Boolean);

  for (const row of onDisk) await artifactIndex.upsert(row);
  const diskIds = new Set(onDisk.map((r) => r.artifactId));
  for (const indexed of await artifactIndex.all()) {
    if (!diskIds.has(indexed.artifactId)) await artifactIndex.remove(indexed.artifactId);
  }
}

/** Node request headers -> WHATWG Headers, as Better Auth's fetch-style API expects. */
function toWebHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.append(key, String(value));
  }
  return headers;
}

/** preHandler guarding dashboard routes: 401 with the protocol's error shape when not signed in. */
async function requireSignIn(req, reply) {
  const session = await auth.api.getSession({ headers: toWebHeaders(req.headers) });
  if (!session) return reply.code(401).send({ ok: false, error: "Sign in required" });
  req.session = session;
}

// ---------------------------------------------------------------------------
// Low-frequency artifact event feed — `onArtifactEvent` fires on authorize
// rejection, upload completion, and payload-validation rejection (never per
// chunk). Kept as an in-memory ring buffer so the pairing page can render a
// small "what's actually happening on this server" live feed — the same
// events an operator would otherwise only see in structured logs.
// ---------------------------------------------------------------------------
const MAX_EVENTS = 60;
const recentEvents = [];
function recordEvent(event) {
  recentEvents.unshift({ ...event, at: new Date().toISOString() });
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
}

// ---------------------------------------------------------------------------
// Upload-unit deployment default (README "Upload unit") — purely advisory
// via `GET /pulsevault/capabilities`; the plugin never enforces "segment" vs
// "merged", it just reports whichever value this server passes at
// registration. The plugin bakes this in as a fixed option captured once at
// `register()` time — there's no live setter for it, so changing this
// deployment-wide default means restarting with a different env var
// (`UPLOAD_UNIT=segment npm start`), not a runtime toggle. To test both
// "segment" and "merged" without restarting, use the per-link `uploadUnit`
// override on `GET /deeplinks` / `buildUploadLink` instead (PROTOCOL.md §3,
// §8) — the pairing page's "Upload unit for this link" selector drives it.
//
// Default "merged" here (mirrors ../fastify-demo) so this demo exercises the
// full merged pipeline — video + captions + beat manifest + thumbnail; set
// UPLOAD_UNIT=segment to test per-clip uploads instead.
// ---------------------------------------------------------------------------
const uploadUnitDefault = process.env.UPLOAD_UNIT === "segment" ? "segment" : "merged";

const app = Fastify({
  // Behind the opensource-server edge nginx (which sets X-Forwarded-For/-Proto/
  // -Host). Trust it so `request.ip` is the real client rather than the shared
  // proxy IP — otherwise every client lands in one rate-limit bucket — and so
  // forwarded proto/host are honored.
  trustProxy: true,
  // `LOG_LEVEL=warn` in production drops the per-request log line, which on a
  // fast upload (many PATCHes) is real CPU + rootfs write I/O; "info" locally.
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // NOTE: not a TUS chunk cap. The PATCH body is streamed straight to
  // @tus/server on a hijacked socket, bypassing Fastify body parsing, so this
  // never sees it. It only bounds a *parsed* body (the Better Auth JSON posts).
  // The real per-request ceiling for uploads is the edge nginx
  // `client_max_body_size`; total upload size is governed by `maxUploadSize`.
  bodyLimit: 16 * 1024 * 1024,
});

// --- Security & delivery middleware ---
// All registered before any route so they cover the demo's own routes (the
// dashboard, the auth-protected /deeplinks, /videos, /events, /captions) and
// the TUS/artifact routes the plugin mounts alike. Mirrors ../fastify-demo.

// Shed load with a 503 (instead of falling over) when the process is genuinely
// under pressure. Also exposes a liveness route at GET /health. maxRssBytes is
// sized to the container (default assumes ~4 GB RAM → 3 GB) — TUS streams chunks
// to disk so RSS stays low, and a too-low threshold would false-503 uploads.
// Override MAX_RSS_MB to match the container's allocation.
await app.register(underPressure, {
  maxEventLoopDelay: 1000,
  maxRssBytes: Number(process.env.MAX_RSS_MB ?? 3072) * 1024 * 1024,
  maxEventLoopUtilization: 0.98,
  exposeStatusRoute: "/health",
});

// Standard security headers. The CSP is tailored to what the demo pages
// actually load — React/htm from esm.sh and mermaid from jsdelivr (as inline
// module scripts) plus inline <style>. `crossOriginResourcePolicy` is relaxed
// to "cross-origin" so, once CORS (below) allows it, a page on another origin
// can embed /pulsevault/artifacts/:id as a <video>.
await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "https://esm.sh", "https://cdn.jsdelivr.net"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "media-src": ["'self'"],
      "connect-src": ["'self'", "https://esm.sh", "https://cdn.jsdelivr.net"],
      // Helmet turns on `upgrade-insecure-requests` by default, which makes the
      // browser upgrade same-origin fetches to HTTPS. Browsers exempt localhost,
      // but over a LAN IP (http://<ip>:3000) it upgrades /deeplinks, /videos, etc.
      // to https://<ip>:3000 — which has no TLS — so those requests fail and the
      // page never renders. Disable it so the demo works over plain HTTP on a
      // LAN. In prod the TLS-terminating edge serves everything over HTTPS
      // anyway, so nothing is lost.
      "upgrade-insecure-requests": null,
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

// CORS so a browser client / the Pulse app on another origin can drive the TUS
// upload + playback flow. `exposedHeaders` is the load-bearing part: without it
// the browser can't read Location/Upload-Offset and resumable uploads break.
// Open by default for demo ease; set CORS_ORIGIN to lock it down for a deployment.
// `|| true` (not `??`) so an empty CORS_ORIGIN — which compose passes when the var
// is unset — reads as "open", not as the invalid empty-string origin @fastify/cors
// rejects.
await app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN || true,
  methods: ["GET", "POST", "PATCH", "HEAD", "DELETE", "OPTIONS"],
  exposedHeaders: [
    "Location",
    "Tus-Resumable",
    "Upload-Offset",
    "Upload-Length",
    "Upload-Metadata",
    "Tus-Version",
    "Tus-Extension",
    "Tus-Max-Size",
    "Upload-Expires",
  ],
});

// gzip/br for text responses (the /videos JSON, HTML pages, /captions VTT).
// Artifact bytes are streamed on a hijacked socket by the plugin, so they
// bypass this onSend hook entirely — video is never re-compressed here.
await app.register(fastifyCompress, { global: true });

// ETag + conditional-GET (304) for the demo's own responses. Artifact bytes
// already get ETag/range via @fastify/send inside the plugin (hijacked, so this
// hook never sees them); this covers the HTML / JSON / VTT routes.
await app.register(fastifyEtag);

// Global per-IP limit — meaningful now that trustProxy makes `request.ip` the
// real client (behind the edge nginx it would otherwise be one shared bucket).
// The TUS upload path and artifact playback get a much larger budget on purpose:
// a fast chunked upload is many PATCHes (at 1 MB chunks a flat 300/min would cap
// throughput to ~5 MB/s), and range-scrubbing a video is many GETs. The tight
// default still guards the crawl-heavy dashboard routes (OPERATIONS.md "Rate
// limiting"). Tune the ceilings via env for your traffic.
const UPLOAD_RATE_MAX = Number(process.env.UPLOAD_RATE_MAX ?? 6000);
const DEFAULT_RATE_MAX = Number(process.env.DEFAULT_RATE_MAX ?? 300);
await app.register(fastifyRateLimit, {
  timeWindow: "1 minute",
  max: (req) =>
    req.url.startsWith("/pulsevault/upload") || req.url.startsWith("/pulsevault/artifacts")
      ? UPLOAD_RATE_MAX
      : DEFAULT_RATE_MAX,
});

// Swagger MUST be registered before any route (including the plugin's) so
// their schemas are picked up for the generated OpenAPI spec.
await app.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "PulseVault Fastify (auth demo)",
      description:
        "Production-shaped reference server pairing the Pulse app with `@mieweb/pulsevault` — capability tokens always on.",
      version: "0.0.1",
    },
    tags: [
      { name: "demo", description: "Demo server endpoints" },
      {
        name: "pulsevault",
        description: "Routes contributed by the `@mieweb/pulsevault` plugin",
      },
    ],
  },
});

await app.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
});

// Serve everything under public/ (favicon, and any CSS/JS/assets you add later)
// with correct content-types + caching. `index: false` so it doesn't register
// its own GET / and collide with the explicit pairing-page route below.
await app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/",
  index: false,
});

// Better Auth owns everything under /api/auth/* (sign-up, sign-in, session,
// sign-out, ...). It speaks fetch-style Request/Response, so this route is a
// thin Node<->WHATWG bridge — the same shape as its documented Fastify
// integration.
app.route({
  method: ["GET", "POST"],
  url: "/api/auth/*",
  schema: {
    tags: ["demo"],
    summary: "Better Auth dashboard sign-in API",
    description:
      "Email+password auth for the HUMAN dashboard (sign-up, sign-in, get-session, sign-out — see better-auth.com for the route catalog). The Pulse app never calls these: uploads stay authorized by capability tokens.",
  },
  handler: async (req, reply) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const request = new Request(url, {
      method: req.method,
      headers: toWebHeaders(req.headers),
      ...(req.body !== undefined && req.body !== null ? { body: JSON.stringify(req.body) } : {}),
    });
    const response = await auth.handler(request);
    reply.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (key !== "set-cookie") reply.header(key, value);
    }
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) reply.header("set-cookie", setCookies);
    return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
  },
});

// Serve pairing page before the plugin so it isn't swallowed by /pulsevault/artifacts/:artifactId
app.get(
  "/",
  {
    schema: {
      tags: ["demo"],
      summary: "Pairing page (HTML)",
      description:
        "Returns the static dashboard UI that renders the upload QR code and a live artifact-event feed. The uploads themselves play on the /library feed.",
      response: {
        200: {
          description: "HTML pairing page.",
          type: "string",
        },
      },
    },
  },
  (_req, reply) => reply.type("text/html").send(html),
);

// The uploads live on their own page — /videos is the JSON API, so the feed
// (a Shorts/Reels-style vertical pager) sits at /library.
app.get(
  "/library",
  { schema: { tags: ["demo"], summary: "Uploads feed (HTML)" } },
  (_req, reply) => reply.type("text/html").send(libraryHtml),
);

// The Pulse app icon (referenced by <link rel="icon"> on the pages) is now
// served straight from public/favicon.png by @fastify/static above.

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
app.post(
  "/reserve",
  {
    preHandler: requireSignIn,
    schema: {
      tags: ["demo"],
      summary: "Reserve a new artifactId",
      description:
        "Generates a fresh UUID for the client to use as the `artifactId` metadata entry on its TUS upload.",
      response: {
        200: {
          description: "A newly minted artifactId.",
          type: "object",
          properties: {
            artifactId: { type: "string", format: "uuid" },
          },
          required: ["artifactId"],
        },
      },
    },
  },
  async (_req, reply) => {
    const artifactId = randomUUID();
    return reply.send({ artifactId });
  },
);

app.get(
  "/events",
  {
    preHandler: requireSignIn,
    schema: {
      tags: ["demo"],
      summary: "Recent artifact events",
      description:
        "The last `onArtifactEvent` firings (authorize rejections, upload completions, validation rejections) — an in-memory feed for the pairing page, not a durable audit log.",
      response: {
        200: {
          description: "Newest-first ring buffer of artifact events.",
          type: "array",
          items: {
            type: "object",
            properties: {
              phase: { type: "string", enum: ["authorize", "complete", "reject"] },
              artifactId: { type: "string", format: "uuid" },
              kind: { type: "string", enum: ["video", "project", "captions", "thumbnail"] },
              size: { type: "number" },
              reason: { type: "string" },
              at: { type: "string", format: "date-time" },
            },
            required: ["phase", "artifactId", "kind", "at"],
          },
        },
      },
    },
  },
  async (_req, reply) => reply.send(recentEvents),
);

/**
 * Reads a finalized artifact's bytes as text. Used for parsing the ordering
 * manifest (`kind=project`) and for serving WebVTT captions
 * (`kind=captions`) — both small text files, so a full read is fine (unlike
 * video bytes, which the checksum validator/sniffer stream instead of
 * buffering).
 */
async function readArtifactText(artifactId) {
  const localPath = await pulseStorage.getLocalPath(artifactId);
  if (!localPath) return null;
  // The storage layer already rejects non-UUID ids before building any path;
  // this containment check is defense in depth — a resolved path outside the
  // data directory is never read. (Strictly inside: every artifact path is a
  // file under a kind subdirectory, so it can never equal the root itself.)
  const base = path.resolve(dataDir);
  const resolved = path.resolve(localPath);
  if (!resolved.startsWith(`${base}${path.sep}`)) return null;
  try {
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

app.get(
  "/captions/:artifactId",
  {
    schema: {
      tags: ["demo"],
      summary: "Fetch a captions artifact (WebVTT)",
      description:
        "Demo-only convenience route (not part of the pulsevault plugin) that serves a `kind=captions` WebVTT upload — byte-for-byte, word-level cue timestamps intact — so the gallery's <track> element can render it. Applies the same relatedTo-aware capability-token check as the plugin's own routes (token via `?token=`, like the plugin's resolve phase — NOT a dashboard session, so it works for any client).",
      params: {
        type: "object",
        properties: { artifactId: { type: "string", format: "uuid" } },
        required: ["artifactId"],
      },
      querystring: {
        type: "object",
        properties: { token: { type: "string", description: "Capability token for this artifact or its relatedTo anchor." } },
      },
    },
    // On top of the global per-IP limit: this route verifies a token and reads
    // the filesystem per request, so it gets its own tighter budget.
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  },
  async (req, reply) => {
    const { artifactId } = req.params;
    const token = req.query?.token ?? "";
    const verified = token ? verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER }) : null;
    const relatedTo = (await pulseStorage.getRelatedTo?.(artifactId)) ?? null;
    const authorized = verified && (verified.artifactId === artifactId || verified.artifactId === relatedTo);
    if (!authorized) return reply.code(403).send();
    const text = await readArtifactText(artifactId);
    if (text === null) return reply.code(404).send();
    return reply.type("text/vtt").send(text);
  },
);

/**
 * List finished uploads as a flat array — the same shape ../fastify-demo's
 * GET /videos returns, so the /library feed groups them into pulses
 * client-side the identical way. Two auth-demo deltas over the no-auth demo:
 *
 *  1. Source: reads the Postgres artifact index (one query) instead of
 *     crawling every sidecar on disk per request.
 *  2. Auth: every playbackUrl / subtitlesUrl carries a short-lived capability
 *     token. Exactly ONE token is minted per pulse (scoped to the session
 *     anchor = `relatedTo ?? artifactId`) and reused for every artifact in
 *     that pulse — `createCapabilityAuthorize` accepts an anchor-scoped token
 *     for any child via `relatedTo` (PROTOCOL.md §5.4), the same session
 *     authorization uploads use, exercised here for playback too.
 */
app.get(
  "/videos",
  {
    preHandler: requireSignIn,
    schema: {
      tags: ["demo"],
      summary: "List finished uploads (flat), with tokenized playback URLs",
      description:
        "Flat list of ready artifacts (one indexed query over the Postgres artifact index). Every playbackUrl and subtitlesUrl carries a fresh short-lived capability token, minted once per pulse (session anchor) and reused across it. The /library feed groups these into pulses client-side.",
      response: {
        200: {
          description: "Ready uploads, newest first.",
          type: "array",
          items: {
            type: "object",
            properties: {
              artifactId: { type: "string", format: "uuid" },
              kind: { type: "string", enum: ["video", "project", "captions", "thumbnail"] },
              filename: { type: "string" },
              ext: { type: "string" },
              size: { type: "number" },
              relatedTo: { type: ["string", "null"] },
              playbackUrl: { type: "string" },
              subtitlesUrl: { type: ["string", "null"] },
              creation_date: { type: "string" },
            },
            required: ["artifactId", "kind", "filename", "size", "playbackUrl", "creation_date"],
          },
        },
      },
    },
    // On top of the global per-IP limit: this route mints tokens per request —
    // a tighter budget (the feed polls it every 8s, so 60/min is still generous).
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  },
  async (_req, reply) => {
    // One indexed query — the artifact table replaces the per-request sidecar
    // crawl the no-auth demo does (see "Artifact index" above).
    const artifacts = await artifactIndex.all();

    // One watch token per pulse (session anchor = `relatedTo ?? artifactId`),
    // reused for every artifact in that pulse. createCapabilityAuthorize accepts
    // an anchor-scoped token for any child via relatedTo (PROTOCOL.md §5.4).
    const tokenByAnchor = new Map();
    const tokenFor = (anchorId) => {
      let token = tokenByAnchor.get(anchorId);
      if (!token) {
        token = issueCapabilityToken(anchorId, PULSEVAULT_SECRET, {
          keyId: PULSEVAULT_KEY_ID,
          issuer: ISSUER,
          expirySeconds: WATCH_TOKEN_TTL_SECONDS,
        });
        tokenByAnchor.set(anchorId, token);
      }
      return token;
    };

    const items = artifacts.map((a) => {
      const anchorId = a.relatedTo ?? a.artifactId;
      return {
        artifactId: a.artifactId,
        kind: a.kind,
        filename: a.filename,
        ext: a.ext,
        size: a.size,
        relatedTo: a.relatedTo ?? null,
        playbackUrl: `/pulsevault/artifacts/${a.artifactId}?token=${tokenFor(anchorId)}`,
        creation_date: a.creation_date,
      };
    });

    // Pair each video with its subtitles (kind "captions" on the wire) exactly
    // as ../fastify-demo does: within a pulse (shared `relatedTo ?? artifactId`
    // anchor), the app names the merged video's VTT after the video, so matching
    // filename stems pair them. Fallback: a pulse with exactly one video and one
    // subtitles file is an unambiguous pair even if the stems drifted. The
    // caption URL carries the same anchor token — /captions authorizes it via
    // the caption's relatedTo.
    const stem = (filename) => filename.replace(/\.[^.]+$/, "");
    const byAnchor = new Map();
    for (const u of items) {
      const anchorId = u.relatedTo ?? u.artifactId;
      if (!byAnchor.has(anchorId)) byAnchor.set(anchorId, []);
      byAnchor.get(anchorId).push(u);
    }
    for (const group of byAnchor.values()) {
      const videos = group.filter((u) => u.kind === "video");
      const subsPool = group.filter((u) => u.kind === "captions");
      for (const video of videos) {
        const idx = subsPool.findIndex((s) => stem(s.filename) === stem(video.filename));
        const matched =
          idx >= 0
            ? subsPool.splice(idx, 1)[0]
            : videos.length === 1 && subsPool.length === 1
              ? subsPool.pop()
              : null;
        const anchorId = video.relatedTo ?? video.artifactId;
        video.subtitlesUrl = matched
          ? `/captions/${matched.artifactId}?token=${tokenFor(anchorId)}`
          : null;
      }
    }

    return reply.send(items.sort((a, b) => b.creation_date.localeCompare(a.creation_date)));
  },
);

// One deeplink + matching QR per request. artifactId is generated server-side
// so it stays the source of truth. `server` must include the plugin's
// `prefix` ("/pulsevault") — the client builds every request as
// `${server}/<path>` with no prefix concept of its own.
//
// `server` is built from the same fixed ISSUER the capability token's
// `issuer` claim uses — never derived from request headers, or verification
// would fail for every request that didn't happen to arrive on the exact
// host header the token was issued under.
//
// `?uploadUnit=segment|merged` lets this *one* pairing link override the
// deployment-wide default set above — demonstrates running "segment" and
// "merged" sessions concurrently (README "Upload unit") instead of one fixed
// value for every pairing. Omit it and behavior is unchanged: the link
// carries no override, and the client falls back to whatever `/capabilities`
// reports.
app.get(
  "/deeplinks",
  {
    preHandler: requireSignIn,
    schema: {
      tags: ["demo"],
      summary: "Mint a pairing deep link + QR code",
      description:
        "Generates a fresh artifactId, issues a session-scoped capability token, and returns the `pulsecam://` deep link (plus a QR data URL) the Pulse app pairs with.",
      querystring: {
        type: "object",
        properties: {
          uploadUnit: {
            type: "string",
            enum: ["segment", "merged"],
            description: "Per-link override of the deployment-wide upload-unit default.",
          },
        },
      },
      response: {
        200: {
          description: "One pairing link and its QR code.",
          type: "object",
          properties: {
            upload: { type: "string", description: "pulsecam:// deep link" },
            artifactId: { type: "string", format: "uuid" },
            qrUpload: { type: "string", description: "QR code as a data: URL" },
            authMode: { type: "boolean" },
            keyId: { type: "string" },
            issuer: { type: "string" },
            tokenExpiresInSeconds: { type: "number" },
          },
          required: ["upload", "artifactId", "qrUpload", "authMode", "keyId", "issuer", "tokenExpiresInSeconds"],
        },
      },
    },
  },
  async (req, reply) => {
    const server = `${ISSUER}/pulsevault`;
    const artifactId = randomUUID();
    const requestedUploadUnit = req.query?.uploadUnit;

    const token = issueCapabilityToken(artifactId, PULSEVAULT_SECRET, {
      keyId: PULSEVAULT_KEY_ID,
      issuer: ISSUER,
      expirySeconds: TOKEN_TTL_SECONDS,
    });

    const upload = buildUploadLink({
      server,
      artifactId,
      token,
      ...(requestedUploadUnit && { uploadUnit: requestedUploadUnit }),
    });

    const qrUpload = await QRCode.toDataURL(upload, {
      width: 224,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return reply.send({
      upload,
      artifactId,
      qrUpload,
      authMode: true,
      keyId: PULSEVAULT_KEY_ID,
      issuer: ISSUER,
      tokenExpiresInSeconds: TOKEN_TTL_SECONDS,
    });
  },
);

// Local filesystem storage: uploads land under ./data with one sidecar per
// artifact (see README "Storage layout"). For S3/R2, swap in
// `createS3Storage(...)` — options documented in the README's S3 section.
const pulseStorage = createLocalStorage({ workspaceDir: dataDir });

// validatePayload for video uploads: verify the client-supplied checksum
// first (the Pulse app always sends one), then the MP4 magic-byte sniff —
// chained per the README's `createChecksumValidator(createMp4Sniffer(storage))`
// pattern. Composed once here, not per request. Project bundles and WebVTT
// captions get neither: they never start with an ISOBMFF ftyp box, and the
// app doesn't checksum them.
const validateVideo = createChecksumValidator(createMp4Sniffer(pulseStorage));

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and
// artifact GET is at /pulsevault/artifacts/:artifactId.
await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  uploadUnit: uploadUnitDefault,
  // All kinds stay enabled — a merged-mode session uploads a .pulse beat
  // manifest, .vtt captions and a .jpg thumbnail alongside the video (and a
  // segment-mode session uploads a .pulse ordering manifest); rejecting any of
  // those would make this a broken pairing target. Mirrors ../fastify-demo.
  allowedExtensions: {
    video: [".mp4"],
    project: [".pulse", ".zip"],
    captions: [".vtt"],
    thumbnail: [".jpg", ".jpeg", ".png"],
  },
  // validatePayload runs for every kind, with ctx.kind telling you which.
  validatePayload: async (request, ctx) => {
    if (ctx.kind !== "video") return;
    await validateVideo(request, ctx);
  },
  // Fired once any artifact (video, project bundle, captions or thumbnail)
  // finishes uploading. This is where the artifact index gets its rows — one
  // write per completed upload, so /videos never has to crawl the filesystem.
  onUploadComplete: async (_req, { artifactId, kind, size }) => {
    app.log.info({ artifactId, kind, size }, "pulsevault upload complete");
    const row = await readArtifactFromDisk(artifactId);
    if (row) await artifactIndex.upsert(row);
  },
  // One hook covers both ops metrics and a compliance audit trail (see
  // OPERATIONS.md "Monitoring and audit logging") — fed straight into the
  // in-memory feed `/events` exposes to the pairing page.
  onArtifactEvent: (event) => {
    app.log.info(event, "pulsevault artifact event");
    recordEvent(event);
  },
  // `createCapabilityAuthorize` — the library's secure-by-default auth
  // option (see README "Capability tokens" / PROTOCOL.md §5.4): a
  // stateless, HMAC-signed, expiring token per artifact (or artifact
  // family, via `relatedTo`). No server-side session table, so secrets can
  // rotate and TTLs can change entirely on this server's own schedule.
  //
  // Wrapped to prune the artifact index when a delete is authorized — the
  // plugin has no post-delete hook (onArtifactEvent phases are
  // authorize/complete/reject), and the boot-time reconcile corrects any
  // drift a failed delete could leave behind.
  authorize: (() => {
    const capabilityAuthorize = createCapabilityAuthorize(lookupSecret, { issuer: ISSUER });
    return async (request, ctx) => {
      await capabilityAuthorize(request, ctx);
      if (ctx.phase === "delete") await artifactIndex.remove(ctx.artifactId);
    };
  })(),
});

// Bring the index in line with what's actually on disk before serving:
// uploads that predate the table (or landed while it was rebuilt) get
// indexed, rows whose files are gone get dropped.
await reconcileArtifactIndex();

await app.listen({ port, host });
console.log(`\nPulseVault auth demo running on http://localhost:${port}/`);
console.log(`Swagger UI:                   http://localhost:${port}/docs`);
console.log(`Capability tokens:            ON  (kid=${PULSEVAULT_KEY_ID}, issuer=${ISSUER})`);
console.log("Dashboard + artifact index:   Better Auth + Prisma on Postgres");
