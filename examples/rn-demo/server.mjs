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
  createS3Storage,
  createS3Mp4Sniffer,
  buildUploadLink,
} from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const dataDir = path.join(__dirname, "data");

// Set DEMO_TOKEN to enable the auth demo: every upload + watch is verified
// against this token. Leave unset for an open demo with no authentication.
const DEMO_TOKEN = process.env.DEMO_TOKEN || null;

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

// Storage backend. Defaults to the local filesystem; set STORAGE=s3 to stream
// uploads into Cloudflare R2 / AWS S3 instead and serve playback via presigned
// redirects. S3 mode needs the optional packages installed
// (`@aws-sdk/client-s3 @aws-sdk/s3-request-presigner @tus/s3-store`) and the
// S3_*/AWS_* env vars below — see `.env.example`. Note: the demo's GET /videos
// route lists local sidecars only, so it returns [] in S3 mode.
const useS3 = (process.env.STORAGE || "local").toLowerCase() === "s3";
const pulseStorage = useS3
  ? await createS3Storage({
      bucket: process.env.S3_BUCKET,
      // Set S3_ENDPOINT for R2 (https://<account>.r2.cloudflarestorage.com);
      // omit it and set AWS_REGION for AWS S3.
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.AWS_REGION,
      // Credentials are optional — omit both to use the AWS SDK default chain.
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      sessionToken: process.env.S3_SESSION_TOKEN,
      // Advanced (all optional): override path-style, presigned URL TTL, part size.
      ...(process.env.S3_FORCE_PATH_STYLE
        ? { forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }
        : {}),
      ...(process.env.S3_PRESIGN_TTL_SECONDS
        ? { presignTtlSeconds: Number(process.env.S3_PRESIGN_TTL_SECONDS) }
        : {}),
      ...(process.env.S3_PART_SIZE
        ? { partSize: Number(process.env.S3_PART_SIZE) }
        : {}),
    })
  : createLocalStorage({ workspaceDir: dataDir });

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and video GET is at /pulsevault/:videoid
await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  // Accept MP4 videos and Pulse draft bundles (.pulse) + diagnostic zips.
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"] },
  // Reject non-MP4 bytes on video uploads (magic-byte sniff). The S3 sniffer
  // does a ranged read of the object; the local one reads the file on disk.
  validatePayload: useS3
    ? createS3Mp4Sniffer(pulseStorage)
    : createMp4Sniffer(pulseStorage),
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
