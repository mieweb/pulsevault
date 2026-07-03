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

// The Pulse app icon, resized — referenced by <link rel="icon"> on the page.
app.get("/favicon.png", { schema: { tags: ["demo"], summary: "Favicon (PNG)" } }, (_req, reply) =>
  reply.type("image/png").send(favicon));

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
app.post("/reserve", { schema: { tags: ["demo"], summary: "Reserve a new artifactId" } }, async (_req, reply) =>
  reply.send({ artifactId: randomUUID() }));

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
          playbackUrl: `/pulsevault/artifacts/${artifactId}`,
          creation_date: tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
        };
      }),
  );

  return reply.send(
    uploads.filter(Boolean).sort((a, b) => b.creation_date.localeCompare(a.creation_date)),
  );
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
  // uploads a .pulse ordering manifest and .srt captions alongside its videos;
  // rejecting those would make this a broken pairing target.
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"], captions: [".srt"] },
});

await app.listen({ port, host });
console.log(`\nPulseVault fastify-demo running on http://localhost:${port}/`);
