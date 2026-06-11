import path from "node:path";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import QRCode from "qrcode";
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
  buildUploadLink,
} from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const watchHtml = readFileSync(path.join(__dirname, "public/watch.html"), "utf8");
const dataDir = path.join(__dirname, "data");
const rangeLogs = [];
const MAX_RANGE_LOGS = 200;

function pushRangeLog(entry) {
  rangeLogs.push(entry);
  if (rangeLogs.length > MAX_RANGE_LOGS) {
    rangeLogs.splice(0, rangeLogs.length - MAX_RANGE_LOGS);
  }
}

function asHeaderString(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : null;
}

function extractPathname(url) {
  try {
    return new URL(url, "http://local").pathname;
  } catch {
    return url.split("?")[0] || url;
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Video GETs are served by the plugin mounted at /pulsevault, so media URLs
// look like /pulsevault/<uuid>. Returns the videoid or null.
function videoidFromVideoGetPath(pathname) {
  const match = pathname.match(/^\/pulsevault\/([0-9a-f-]{36})$/i);
  return match && isUuid(match[1]) ? match[1] : null;
}

// Set DEMO_TOKEN to enable the auth demo: every upload + watch is verified
// against this token. Leave unset for an open demo with no authentication.
const DEMO_TOKEN = process.env.DEMO_TOKEN || null;
const DEMO_STRICT_MP4 = process.env.DEMO_STRICT_MP4 === "1";

const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024, // max single PATCH chunk (RN app sends 1 MB chunks)
});

// Swagger MUST be registered before any route (including the plugin's) so
// their schemas are picked up for the generated OpenAPI spec.
await app.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "PulseVault Fastify",
      description:
        "Reference server pairing the React Native demo app with `@mieweb/pulsevault`.",
      version: "0.0.1",
    },
    tags: [
      { name: "demo", description: "RN demo server endpoints" },
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

// Serve pairing page before the plugin so it isn't swallowed by /:videoid
app.get(
  "/",
  {
    schema: {
      tags: ["demo"],
      summary: "Pairing page (HTML)",
      description:
        "Returns the static pairing UI that renders the upload QR code.",
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

// Reserve a videoid for an upload. The server owns ID generation so it can
// later attach auth tokens, quotas, or other server-side state here.
app.post(
  "/reserve",
  {
    schema: {
      tags: ["demo"],
      summary: "Reserve a new videoid",
      description:
        "Generates a fresh UUID for the client to use as the `videoid` metadata entry on its TUS upload.",
      response: {
        200: {
          description: "A newly minted videoid.",
          type: "object",
          properties: {
            videoid: { type: "string", format: "uuid" },
          },
          required: ["videoid"],
        },
      },
    },
  },
  async (_req, reply) => {
    const videoid = randomUUID();
    return reply.send({ videoid });
  },
);

// List all uploads under dataDir. Reads each upload's sidecar to determine
// kind and subdir rather than hard-coding "video/" — handles video + project.
const uploadSummarySchema = {
  type: "object",
  properties: {
    videoid: { type: "string", format: "uuid" },
    kind: { type: "string", enum: ["video", "project"], description: "Artifact kind." },
    filename: { type: "string" },
    ext: { type: "string" },
    size: { type: "integer", minimum: 0 },
    creation_date: { type: "string", format: "date-time" },
  },
  required: ["videoid", "kind", "filename", "ext", "size", "creation_date"],
};

app.get(
  "/videos",
  {
    schema: {
      tags: ["demo"],
      summary: "List previously uploaded artifacts",
      description:
        "Enumerates completed uploads on disk by reading each upload's sidecar. Returns both `kind=video` and `kind=project` artifacts.",
      response: {
        200: {
          description: "Uploads sorted by creation time, newest first.",
          type: "array",
          items: uploadSummarySchema,
        },
      },
    },
  },
  async (_req, reply) => {
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
          const videoid = e.name.slice(0, -".json".length);
          const sidecarFilePath = path.join(pulsevaultMetaDir, e.name);
          let sidecar;
          try {
            sidecar = JSON.parse(await readFile(sidecarFilePath, "utf8"));
          } catch {
            return null;
          }
          // Only list ready uploads; skip in-progress ones.
          if (sidecar.status !== "ready") return null;

          const kind = sidecar.kind ?? "video";
          const ext = sidecar.ext ?? ".mp4";
          const artifactFile = `${videoid}${ext}`;
          const artifactPath = path.join(dataDir, kind, artifactFile);
          const tusJsonPath = `${artifactPath}.json`;

          const [artifactStat, tusMeta] = await Promise.all([
            stat(artifactPath).catch(() => null),
            readFile(tusJsonPath, "utf8")
              .then(JSON.parse)
              .catch(() => null),
          ]);
          if (!artifactStat || artifactStat.size === 0) return null;

          return {
            videoid,
            kind,
            filename: sidecar.filename ?? tusMeta?.metadata?.filename ?? artifactFile,
            ext,
            size: artifactStat.size,
            creation_date:
              tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
          };
        }),
    );

    return reply.send(
      uploads
        .filter(Boolean)
        .sort((a, b) => b.creation_date.localeCompare(a.creation_date)),
    );
  },
);

// Standalone watch page for a single video.
app.get("/watch/:videoid", async (req, reply) => {
  const { videoid } = req.params;
  if (typeof videoid !== "string" || !isUuid(videoid)) {
    return reply.code(400).type("text/plain").send("Invalid videoid");
  }

  return reply.type("text/html").send(
    watchHtml
      .replaceAll("__VIDEOID__", videoid)
      .replaceAll("__VIDEO_SRC__", `/pulsevault/${videoid}`),
  );
});

// One deeplink + matching QR per request. videoid is generated server-side so
// it stays the source of truth.
app.get("/deeplinks", async (req, reply) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = `${proto}://${host}`;
  const videoid = randomUUID();

  const upload = buildUploadLink({
    server,
    videoid,
    ...(DEMO_TOKEN && { token: DEMO_TOKEN }),
  });

  const qrUpload = await QRCode.toDataURL(upload, {
    width: 224,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return reply.send({
    upload,
    videoid,
    qrUpload,
    authMode: Boolean(DEMO_TOKEN),
  });
});

// Expose recent video GET responses so the demo UI can show seek->range traffic.
app.get("/range-logs", async (req, reply) => {
  const requestedVideoid = (req.query || {}).videoid;
  if (typeof requestedVideoid !== "string" || !requestedVideoid) {
    return reply.send(rangeLogs);
  }
  return reply.send(rangeLogs.filter((item) => item.videoid === requestedVideoid));
});

app.delete("/range-logs", async (_req, reply) => {
  rangeLogs.length = 0;
  return reply.code(204).send();
});

app.addHook("onResponse", async (request, reply) => {
  if (request.method !== "GET") return;

  const pathname = extractPathname(request.raw.url || request.url || "");
  const videoid = videoidFromVideoGetPath(pathname);
  if (!videoid) return;
  const rangeHeader = request.headers.range;
  const contentRange = asHeaderString(reply.getHeader("content-range"));
  const contentLength = asHeaderString(reply.getHeader("content-length"));
  const acceptRanges = asHeaderString(reply.getHeader("accept-ranges"));

  pushRangeLog({
    at: new Date().toISOString(),
    method: request.method,
    videoid,
    url: request.raw.url || request.url,
    range: typeof rangeHeader === "string" ? rangeHeader : null,
    status: reply.statusCode,
    acceptRanges,
    contentRange,
    contentLength,
  });
});

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and video GET is at /pulsevault/:videoid
const pulseStorage = createLocalStorage({ workspaceDir: dataDir });
await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  // Accept MP4 videos and Pulse draft bundles (.pulse) + diagnostic zips.
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"] },
  // Strict fast-start MP4 validation is opt-in for the demo so non-fast-start
  // test files still upload unless DEMO_STRICT_MP4=1 is set.
  ...(DEMO_STRICT_MP4 ? { validatePayload: createMp4Sniffer(pulseStorage) } : {}),
  // Fired when a project bundle finishes uploading. The bundle is opaque
  // to the plugin — index it, relay it, or leave it for a later request.
  onProjectUploadComplete: async (_req, { videoid, size }) => {
    app.log.info({ videoid, size }, "pulsevault project upload complete");
  },
  /**
   * authorize hook — the demo's auth proof-of-concept.
   *
   * When DEMO_TOKEN is unset (default), this is a no-op and the server accepts
   * every request. When DEMO_TOKEN is set, every TUS create/patch must carry
   * `Authorization: Bearer <DEMO_TOKEN>` and every watch must carry
   * `?token=<DEMO_TOKEN>`. Swap this body with your real auth — sessions, JWT,
   * mTLS, etc.
   */
  authorize: async (request, ctx) => {
    if (!DEMO_TOKEN) return;

    const supplied =
      ctx.phase === "resolve"
        ? ctx.token
        : (request.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (supplied !== DEMO_TOKEN) {
      throw { statusCode: 403, message: "Forbidden: invalid demo token" };
    }
  },
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
console.log(`\nPulseVault demo running on http://localhost:${port}/`);
console.log(`Swagger UI:                   http://localhost:${port}/docs`);
if (DEMO_TOKEN) {
  console.log(`Auth demo:                    ON  (DEMO_TOKEN is set)`);
} else {
  console.log(`Auth demo:                    off (set DEMO_TOKEN=... to enable)`);
}
if (DEMO_STRICT_MP4) {
  console.log(`MP4 validation:               ON  (DEMO_STRICT_MP4=1)`);
} else {
  console.log(`MP4 validation:               off (set DEMO_STRICT_MP4=1 to enforce)`);
}
