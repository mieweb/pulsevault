// Minimal Fastify demo for @mieweb/pulsevault — the smallest runnable server
// the Pulse app can pair with: plugin mount, QR pairing, flat upload listing.
// No auth, local filesystem storage. Start here; for the production-shaped
// reference (capability tokens, pulse grouping, captions, Swagger UI) see
// ../fastify-auth-demo/server.mjs.

import path from "node:path";
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
import pulseVault, { createLocalStorage, buildUploadLink } from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The route schema says `format: "uuid"` but Fastify's default Ajv doesn't
// enforce string formats — routes validate ids explicitly before they touch a
// filesystem path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const videosHtml = readFileSync(path.join(__dirname, "public/videos.html"), "utf8");
const dataDir = path.join(__dirname, "data");

// Resolve a path under dataDir and refuse anything that escapes it — the
// belt-and-suspenders companion to the UUID check above for every read that
// embeds a request-supplied id.
function insideDataDir(...segments) {
  const base = path.resolve(dataDir);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("path escapes the data directory");
  }
  return resolved;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// Deployment-wide default advertised via GET /pulsevault/capabilities — purely
// advisory; the plugin never enforces "segment" vs "merged", it just reports
// whichever value this server passes at registration (README "Upload unit").
// Default "merged" here so this demo exercises the full merged pipeline
// (video + captions + beat manifest + thumbnail); set UPLOAD_UNIT=segment to
// test per-clip uploads instead.
const uploadUnit = process.env.UPLOAD_UNIT === "segment" ? "segment" : "merged";

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
  // never sees it. It only bounds a *parsed* body (none in this demo). The real
  // per-request ceiling is the edge nginx `client_max_body_size` (2G); total
  // upload size is governed by `maxUploadSize` below.
  bodyLimit: 16 * 1024 * 1024,
});

// --- Security & delivery middleware ---
// All registered before any route so they cover the demo's own routes and the
// TUS/artifact routes the plugin mounts alike.

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
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

// CORS so a browser client / the Pulse app on another origin can drive the TUS
// upload + playback flow. `exposedHeaders` is the load-bearing part: without it
// the browser can't read Location/Upload-Offset and resumable uploads break.
// Open by default for demo ease; set CORS_ORIGIN to lock it down for a deployment.
await app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN ?? true,
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

// gzip/br for text responses (the /videos JSON, HTML pages, /subtitles VTT).
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
// default still guards the crawl-heavy /videos and /subtitles routes
// (OPERATIONS.md "Rate limiting"). Tune the ceilings via env for your traffic.
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
// their schemas are picked up — the pulsevault plugin ships full OpenAPI
// schemas, so /docs documents the whole wire contract for free.
await app.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "PulseVault Fastify (minimal demo)",
      description: "The smallest runnable Pulse-compatible server — no auth, local storage.",
      version: "0.0.1",
    },
    tags: [
      { name: "demo", description: "Demo server endpoints" },
      { name: "pulsevault", description: "Routes contributed by the `@mieweb/pulsevault` plugin" },
    ],
  },
});
await app.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
});

// Serve everything under public/ (favicon today, any CSS/JS/assets you add
// later) with correct content-types + caching. `index: false` so it doesn't
// register its own GET / and collide with the explicit pairing-page route below.
await app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/",
  index: false,
});

// Serve pairing page before the plugin so it isn't swallowed by /pulsevault/artifacts/:artifactId
app.get("/", { schema: { tags: ["demo"], summary: "Pairing page (HTML)" } }, (_req, reply) =>
  reply.type("text/html").send(html));

// The uploads live on their own page — /videos is the JSON API, so the page sits at /library.
app.get("/library", { schema: { tags: ["demo"], summary: "Uploads page (HTML)" } }, (_req, reply) =>
  reply.type("text/html").send(videosHtml));

// The Pulse app icon (referenced by <link rel="icon"> on the pages) is now
// served straight from public/favicon.png by @fastify/static above.

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
app.post("/reserve", { schema: { tags: ["demo"], summary: "Reserve a new artifactId" } }, async (_req, reply) =>
  reply.send({ artifactId: randomUUID() }));

// Serve a subtitles artifact as WebVTT — exactly the bytes the app uploaded,
// word-level cue timestamps (<00:00:01.500>word) and all. The wire protocol
// calls the kind "captions" (PROTOCOL.md), but user-facing they're subtitles —
// spoken-word transcript, not accessibility captions — so the demo names this
// route that way.
app.get(
  "/subtitles/:artifactId",
  {
    schema: {
      tags: ["demo"],
      summary: "Fetch a subtitles artifact as WebVTT",
      params: {
        type: "object",
        properties: { artifactId: { type: "string", format: "uuid" } },
        required: ["artifactId"],
      },
    },
    // On top of the global per-IP limit: this route does per-request filesystem
    // reads, so it gets its own tighter budget.
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  },
  async (req, reply) => {
    const { artifactId } = req.params;
    if (!UUID_RE.test(artifactId)) return reply.code(400).send();
    let sidecar;
    try {
      sidecar = JSON.parse(await readFile(insideDataDir(".pulsevault", `${artifactId}.json`), "utf8"));
    } catch {
      return reply.code(404).send();
    }
    // Only serve real, finished captions uploads — never hand a video body to text/vtt.
    if (sidecar.kind !== "captions" || sidecar.status !== "ready") return reply.code(404).send();
    const ext = sidecar.ext ?? ".vtt";
    let text;
    try {
      text = await readFile(insideDataDir("captions", `${artifactId}${ext}`), "utf8");
    } catch {
      return reply.code(404).send();
    }
    return reply.type("text/vtt").send(text);
  },
);

// List all uploads under dataDir. Reads each upload's sidecar to determine
// kind and subdir rather than hard-coding "video/" — handles video/project/captions.
app.get("/videos", {
  schema: { tags: ["demo"], summary: "List finished uploads (flat)" },
  // Crawls every sidecar on disk per request — tighter per-IP budget than the
  // global limit (the feed polls this every 8s, so 60/min is still generous).
  config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
}, async (_req, reply) => {
  const pulsevaultMetaDir = path.join(dataDir, ".pulsevault");
  let entries;
  try {
    entries = await readdir(pulsevaultMetaDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return reply.send([]);
    throw err;
  }

  const uploads = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".tmp"))
      .map(async (e) => {
        const artifactId = e.name.slice(0, -".json".length);
        let sidecar;
        try {
          sidecar = JSON.parse(await readFile(path.join(pulsevaultMetaDir, e.name), "utf8"));
        } catch {
          return null;
        }
        // Only list ready uploads; skip in-progress ones.
        if (sidecar.status !== "ready") return null;

        const kind = sidecar.kind ?? "video";
        const ext = sidecar.ext ?? ".mp4";
        const artifactFile = `${artifactId}${ext}`;
        const artifactPath = path.join(dataDir, kind, artifactFile);
        const [artifactStat, tusMeta] = await Promise.all([
          stat(artifactPath).catch(() => null),
          readFile(`${artifactPath}.json`, "utf8").then(JSON.parse).catch(() => null),
        ]);
        if (!artifactStat || artifactStat.size === 0) return null;

        return {
          artifactId,
          kind,
          filename: sidecar.filename ?? tusMeta?.metadata?.filename ?? artifactFile,
          ext,
          size: artifactStat.size,
          // Session anchor this artifact belongs to (a segment session's clips point at
          // their ordering manifest; a merged video's captions/beat manifest/thumbnail
          // point at the video) — lets the library page group one pulse's artifacts
          // together instead of listing them flat.
          relatedTo: sidecar.relatedTo ?? null,
          playbackUrl: `/pulsevault/artifacts/${artifactId}`,
          creation_date: tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
        };
      }),
  );

  const ready = uploads.filter(Boolean);

  // Pair each video with its subtitles (kind "captions" on the wire) the same
  // way fastify-auth-demo does: within a pulse (shared `relatedTo ?? artifactId`
  // anchor), the app names the merged video's VTT after the video (`<draftId>.mp4`
  // / `<draftId>.vtt`), so matching filename stems pair them. Fallback: a pulse
  // with exactly one video and one subtitles file is an unambiguous pair even if
  // the stems drifted. (Only merged sessions carry captions; segment sessions
  // upload clips with no captions at all.)
  const stem = (filename) => filename.replace(/\.[^.]+$/, "");
  const byAnchor = new Map();
  for (const u of ready) {
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
      video.subtitlesUrl = matched ? `/subtitles/${matched.artifactId}` : null;
    }
  }

  return reply.send(ready.sort((a, b) => b.creation_date.localeCompare(a.creation_date)));
});

// One deeplink + matching QR per request. artifactId is generated server-side
// so it stays the source of truth. `server` must include the plugin's
// `prefix` ("/pulsevault") — the client builds every request as
// `${server}/<path>` with no prefix concept of its own. With no auth there's
// no issuer to stay consistent with, so deriving `server` from request
// headers is fine here.
//
// `?uploadUnit=segment|merged` lets this *one* pairing link override the
// deployment-wide default set above (PROTOCOL.md §3, §8) — handy for testing
// both modes without restarting the server. Omit it and the link carries no
// override; the client falls back to whatever `/capabilities` reports.
app.get("/deeplinks", { schema: { tags: ["demo"], summary: "Mint a pairing deep link + QR code" } }, async (req, reply) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const requestHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = `${proto}://${requestHost}/pulsevault`;
  const artifactId = randomUUID();

  const requestedUploadUnit = req.query?.uploadUnit;
  if (requestedUploadUnit !== undefined && requestedUploadUnit !== "segment" && requestedUploadUnit !== "merged") {
    return reply.code(400).send({ error: '`uploadUnit` query param must be "segment" or "merged"' });
  }

  const upload = buildUploadLink({
    server,
    artifactId,
    ...(requestedUploadUnit && { uploadUnit: requestedUploadUnit }),
  });
  const qrUpload = await QRCode.toDataURL(upload, {
    width: 224,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return reply.send({ upload, artifactId, qrUpload });
});

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and
// artifact GET is at /pulsevault/artifacts/:artifactId. This is the smallest
// working mount — no authorize, no validatePayload, no hooks.
await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: createLocalStorage({ workspaceDir: dataDir }),
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  uploadUnit,
  // All kinds stay enabled — a merged-mode session uploads a .pulse beat
  // manifest, .vtt captions and a .jpg thumbnail alongside the video (and a
  // segment-mode session uploads a .pulse ordering manifest); rejecting any of
  // those would make this a broken pairing target.
  allowedExtensions: {
    video: [".mp4"],
    project: [".pulse", ".zip"],
    captions: [".vtt"],
    thumbnail: [".jpg", ".jpeg", ".png"],
  },
});

await app.listen({ port, host });
console.log(`\nPulseVault fastify-demo running on http://localhost:${port}/`);
