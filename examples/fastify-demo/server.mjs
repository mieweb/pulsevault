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
import QRCode from "qrcode";
import pulseVault, { createLocalStorage, buildUploadLink } from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const videosHtml = readFileSync(path.join(__dirname, "public/videos.html"), "utf8");
const favicon = readFileSync(path.join(__dirname, "public/favicon.png"));
const dataDir = path.join(__dirname, "data");

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// Deployment-wide default advertised via GET /pulsevault/capabilities — purely
// advisory; the plugin never enforces "beat" vs "merged", it just reports
// whichever value this server passes at registration (README "Upload unit").
const uploadUnit = process.env.UPLOAD_UNIT === "merged" ? "merged" : "beat";

const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024, // max single PATCH chunk (RN app sends 1 MB chunks)
});

// Registered before any route so every one of them — the demo's own and the
// TUS/artifact routes the plugin mounts — is covered by a global per-IP
// limit (OPERATIONS.md "Rate limiting" recommends exactly this). Generous
// enough for one phone's normal HEAD/PATCH resume retries, not for a scraper
// hammering /videos or /pulsevault/artifacts/:id.
await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });

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

// Serve pairing page before the plugin so it isn't swallowed by /pulsevault/artifacts/:artifactId
app.get("/", { schema: { tags: ["demo"], summary: "Pairing page (HTML)" } }, (_req, reply) =>
  reply.type("text/html").send(html));

// The uploads live on their own page — /videos is the JSON API, so the page sits at /library.
app.get("/library", { schema: { tags: ["demo"], summary: "Uploads page (HTML)" } }, (_req, reply) =>
  reply.type("text/html").send(videosHtml));

// The Pulse app icon, resized — referenced by <link rel="icon"> on the page.
app.get("/favicon.png", { schema: { tags: ["demo"], summary: "Favicon (PNG)" } }, (_req, reply) =>
  reply.type("image/png").send(favicon));

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
app.post("/reserve", { schema: { tags: ["demo"], summary: "Reserve a new artifactId" } }, async (_req, reply) =>
  reply.send({ artifactId: randomUUID() }));

// Minimal SRT -> WebVTT conversion (same as fastify-auth-demo) — older Pulse apps
// upload SRT, but browsers only understand WebVTT, whether in a <track> or fetched raw.
// Newer apps upload WebVTT directly (with word-level cue timestamps) and skip this.
function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^﻿/, "")
    .split(/\n\n+/)
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      if (/^\d+$/.test(lines[0])) lines.shift(); // SRT's numeric cue index — WebVTT doesn't need it
      return lines.join("\n");
    })
    .join("\n\n");
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}\n`;
}

// Serve a subtitles artifact as WebVTT. The wire protocol calls the kind
// "captions" (PROTOCOL.md), but user-facing they're subtitles — spoken-word
// transcript, not accessibility captions — so the demo names this route that way.
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
  },
  async (req, reply) => {
    const { artifactId } = req.params;
    let sidecar;
    try {
      sidecar = JSON.parse(await readFile(path.join(dataDir, ".pulsevault", `${artifactId}.json`), "utf8"));
    } catch {
      return reply.code(404).send();
    }
    // Only convert real, finished captions uploads — never hand a video body to text/vtt.
    if (sidecar.kind !== "captions" || sidecar.status !== "ready") return reply.code(404).send();
    const ext = sidecar.ext ?? ".srt";
    let text;
    try {
      text = await readFile(path.join(dataDir, "captions", `${artifactId}${ext}`), "utf8");
    } catch {
      return reply.code(404).send();
    }
    // Native VTT passes through untouched — it may carry word-level cue timestamps
    // (<00:00:01.500>word) that a lossy round-trip would destroy. Only SRT converts.
    return reply.type("text/vtt").send(ext === ".vtt" ? text : srtToVtt(text));
  },
);

// List all uploads under dataDir. Reads each upload's sidecar to determine
// kind and subdir rather than hard-coding "video/" — handles video/project/captions.
app.get("/videos", { schema: { tags: ["demo"], summary: "List finished uploads (flat)" } }, async (_req, reply) => {
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
          // Session anchor this artifact belongs to (beat videos/captions point at their
          // manifest; a merged video's captions point at the video) — lets the library page
          // group one pulse's artifacts together instead of listing them flat.
          relatedTo: sidecar.relatedTo ?? null,
          playbackUrl: `/pulsevault/artifacts/${artifactId}`,
          creation_date: tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
        };
      }),
  );

  const ready = uploads.filter(Boolean);

  // Pair each video with its subtitles (kind "captions" on the wire) the same
  // way fastify-auth-demo does: within a pulse (shared `relatedTo ?? artifactId`
  // anchor), the app names a beat's SRT after its video, so matching filename
  // stems pair them. Fallback: a pulse with exactly one video and one subtitles
  // file is an unambiguous pair even if the stems drifted.
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
// `?uploadUnit=beat|merged` lets this *one* pairing link override the
// deployment-wide default set above (PROTOCOL.md §3, §8) — handy for testing
// both modes without restarting the server. Omit it and the link carries no
// override; the client falls back to whatever `/capabilities` reports.
app.get("/deeplinks", { schema: { tags: ["demo"], summary: "Mint a pairing deep link + QR code" } }, async (req, reply) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const requestHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = `${proto}://${requestHost}/pulsevault`;
  const artifactId = randomUUID();

  const requestedUploadUnit = req.query?.uploadUnit;
  if (requestedUploadUnit !== undefined && requestedUploadUnit !== "beat" && requestedUploadUnit !== "merged") {
    return reply.code(400).send({ error: '`uploadUnit` query param must be "beat" or "merged"' });
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
  // All three kinds stay enabled — a beat-mode session from the real app
  // uploads a .pulse ordering manifest and .vtt (or legacy .srt) captions alongside its videos;
  // rejecting those would make this a broken pairing target.
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"], captions: [".srt", ".vtt"] },
});

await app.listen({ port, host });
console.log(`\nPulseVault fastify-demo running on http://localhost:${port}/`);
