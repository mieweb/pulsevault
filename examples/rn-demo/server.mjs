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

function isVideoGetPath(pathname) {
  return /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pathname);
}

// Set DEMO_TOKEN to enable the auth demo: every upload + watch is verified
// against this token. Leave unset for an open demo with no authentication.
const DEMO_TOKEN = process.env.DEMO_TOKEN || null;
const DEMO_STRICT_MP4 = process.env.DEMO_STRICT_MP4 === "1";

const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024, // max single PATCH chunk (RN app sends 1 MB chunks)
});

await app.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "PulseVault demo",
      description: "Reference server pairing the Pulse RN app with @mieweb/pulsevault.",
      version: "0.0.1",
    },
  },
});
await app.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
});

// Pairing page — registered before the plugin so it isn't swallowed by /:videoid
app.get("/", (_req, reply) => reply.type("text/html").send(html));

// Standalone watch page for a single video.
app.get("/watch/:videoid", async (req, reply) => {
  const { videoid } = req.params;
  if (typeof videoid !== "string" || !isVideoGetPath(`/${videoid}`)) {
    return reply.code(400).type("text/plain").send("Invalid videoid");
  }

  return reply.type("text/html").send(
    watchHtml
      .replaceAll("__VIDEOID__", videoid)
      .replaceAll("__VIDEO_SRC__", `/${videoid}`),
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

// List uploaded videos by scanning the on-disk TUS layout: data/<videoid>/video/<videoid>.mp4 + .json sidecar.
app.get("/videos", async (_req, reply) => {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return reply.send([]);
    throw err;
  }

  const videos = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const videoid = e.name;
        const videoDir = path.join(dataDir, videoid, "video");
        let files;
        try {
          files = await readdir(videoDir);
        } catch {
          return null;
        }
        const mp4 = files.find((f) => f.endsWith(".mp4") && !f.endsWith(".mp4.json"));
        if (!mp4) return null;

        const mp4Path = path.join(videoDir, mp4);
        const [mp4Stat, meta] = await Promise.all([
          stat(mp4Path).catch(() => null),
          readFile(`${mp4Path}.json`, "utf8").then(JSON.parse).catch(() => null),
        ]);
        if (!mp4Stat || mp4Stat.size === 0) return null;

        return {
          videoid,
          filename: meta?.metadata?.filename ?? mp4,
          size: mp4Stat.size,
          creation_date: meta?.creation_date ?? mp4Stat.birthtime.toISOString(),
        };
      }),
  );

  return reply.send(
    videos.filter(Boolean).sort((a, b) => b.creation_date.localeCompare(a.creation_date)),
  );
});

// Expose recent GET /:videoid responses so the demo UI can show seek->range traffic.
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
  if (!isVideoGetPath(pathname)) return;

  const videoid = pathname.slice(1);
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

// Mount the plugin at root so TUS is at POST /upload and watch is GET /:videoid
const pulseStorage = createLocalStorage({ workspaceDir: dataDir });
await app.register(pulseVault, {
  prefix: "",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  allowedExtensions: [".mp4"],
  ...(DEMO_STRICT_MP4 ? { validatePayload: createMp4Sniffer(pulseStorage) } : {}),

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
