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
  buildConfigureDestinationLink,
  buildUploadLink,
} from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const dataDir = path.join(__dirname, "data");

/**
 * In-memory token store: maps videoid → token for token-protected uploads.
 * Populated in the authorize hook during the 'create' phase when the app
 * sends a Bearer token that matches SESSION_TOKEN.
 * No persistence — tokens are lost when the server restarts.
 */
const tokenStore = new Map();

/**
 * A single server-level session token generated at startup.
 * Embed it in the configure-destination QR so the Pulse app stores it
 * alongside the server URL. Every upload made with that saved destination
 * will include the token as a Bearer header, registering the video as
 * token-protected.
 */
const SESSION_TOKEN = randomUUID();
console.log(`[auth] Session token: ${SESSION_TOKEN}`);

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
        "Returns the static pairing UI that renders the configure-destination and upload QR codes.",
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
    token: { type: "string", description: "Present when this upload requires a token to watch." },
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
    let entries;
    try {
      entries = await readdir(dataDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return reply.send([]);
      throw err;
    }

    const uploads = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const videoid = e.name;
          const sidecarPath = path.join(dataDir, videoid, ".pulsevault.json");
          let sidecar;
          try {
            sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
          } catch {
            return null; // not a managed upload directory
          }
          // Only list ready uploads; skip in-progress ones.
          if (sidecar.status !== "ready") return null;

          const kind = sidecar.kind ?? "video";
          const ext = sidecar.ext ?? ".mp4";
          const artifactDir = path.join(dataDir, videoid, kind);
          const artifactFile = `${videoid}${ext}`;
          const artifactPath = path.join(artifactDir, artifactFile);
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
            ...(tokenStore.has(videoid) && { token: tokenStore.get(videoid) }),
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

// Return pre-built deep links for the pairing page.
// draftId and videoid are generated here so the server is the single source of truth.
app.get(
  "/deeplinks",
  {
    schema: {
      tags: ["demo"],
      summary: "Deep links + QR codes for RN pairing",
      description:
        "Builds a configure-destination link and a videoid-scoped upload link, then encodes both as data-URL PNG QR codes.",
      response: {
        200: {
          description: "Deep links and their QR-code renderings.",
          type: "object",
          properties: {
            configureDestination: { type: "string", format: "uri" },
            upload: { type: "string", format: "uri" },
            videoid: { type: "string", format: "uuid" },
            qrConfigure: {
              type: "string",
              description:
                "data:image/png;base64 QR for `configureDestination`.",
            },
            qrUpload: {
              type: "string",
              description: "data:image/png;base64 QR for `upload`.",
            },
          },
          required: [
            "configureDestination",
            "upload",
            "videoid",
            "qrConfigure",
            "qrUpload",
          ],
        },
      },
    },
  },
  async (req, reply) => {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const server = `${proto}://${host}`;
    const videoid = randomUUID();

    const configureDestination = buildConfigureDestinationLink({
      server,
      name: "Demo Server",
    });
    const upload = buildUploadLink({ server, videoid });

    const qrOpts = {
      width: 224,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    };
    const [qrConfigure, qrUpload] = await Promise.all([
      QRCode.toDataURL(configureDestination, qrOpts),
      QRCode.toDataURL(upload, qrOpts),
    ]);

    return reply.send({
      configureDestination,
      upload,
      videoid,
      qrConfigure,
      qrUpload,
    });
  },
);

// Token-protected server-configuration QR: uses buildConfigureDestinationLink
// (same as Section 1) but embeds SESSION_TOKEN so the Pulse app stores the
// token alongside the server URL. Uploads made with this saved destination
// send "Authorization: Bearer <token>", which the authorize hook uses to
// register the videoid as token-protected before the bytes are written.
app.get(
  "/deeplinks-token",
  {
    schema: {
      tags: ["demo"],
      summary: "Token-protected server-config QR",
      description:
        "Returns a configure-destination deep link that embeds the server-level session token. " +
        "Scanning this QR saves the server + token in the app. Any subsequent upload from that " +
        "saved destination will be token-protected: the server registers the videoid in its token " +
        "store and rejects watch requests that omit the correct token.",
      response: {
        200: {
          description: "Token-scoped configure-destination link and QR code.",
          type: "object",
          properties: {
            configureDestination: { type: "string", format: "uri" },
            token: { type: "string", description: "The session token embedded in the QR." },
            qrConfigure: { type: "string", description: "data:image/png;base64 QR for the token-scoped configure-destination link." },
          },
          required: ["configureDestination", "token", "qrConfigure"],
        },
      },
    },
  },
  async (req, reply) => {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const server = `${proto}://${host}`;

    const configureDestination = buildConfigureDestinationLink({
      server,
      name: "Demo Server (Token Auth)",
      token: SESSION_TOKEN,
    });

    const qrOpts = { width: 224, margin: 1, color: { dark: "#000000", light: "#ffffff" } };
    const qrConfigure = await QRCode.toDataURL(configureDestination, qrOpts);

    return reply.send({ configureDestination, token: SESSION_TOKEN, qrConfigure });
  },
);

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and video GET is at /pulsevault/:videoid
const pulseStorage = createLocalStorage({ workspaceDir: dataDir });
await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  // Accept MP4 videos and Pulse draft bundles (.pulse) + diagnostic zips.
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"] },
  // Reject non-MP4 bytes on video uploads (magic-byte sniff).
  validatePayload: createMp4Sniffer(pulseStorage),
  // Fired when a project bundle finishes uploading. The bundle is opaque
  // to the plugin — index it, relay it, or leave it for a later request.
  onProjectUploadComplete: async (_req, { videoid, size }) => {
    app.log.info({ videoid, size }, "pulsevault project upload complete");
  },
  /**
   * Authorization hook — called before every create/patch/resolve/delete.
   *
   * For the "resolve" phase the mobile app forwards any upload token as
   * `?token=<value>` in the watch URL; the plugin surfaces it here as
   * `ctx.token` so the parent server can validate it without a separate
   * browser login.
   *
   * This demo server has no real auth store, so it accepts all requests.
   * A production deployment would look up the token in a DB/session store
   * and throw to reject (e.g. `throw { statusCode: 403, message: "Forbidden" }`).
   */
  authorize: async (request, ctx) => {
    if (ctx.phase === "create") {
      // When the app uploads using the token-protected saved destination it
      // sends "Authorization: Bearer <SESSION_TOKEN>". Register this videoid
      // in the token store so the resolve phase can protect it.
      const authHeader = request.headers["authorization"];
      const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
      if (bearer !== undefined && bearer === SESSION_TOKEN) {
        tokenStore.set(ctx.videoid, SESSION_TOKEN);
        app.log.info(
          { videoid: ctx.videoid, kind: ctx.kind },
          "pulsevault authorize: token-protected upload registered",
        );
      }
    } else if (ctx.phase === "resolve") {
      const expectedToken = tokenStore.get(ctx.videoid);
      if (expectedToken !== undefined) {
        // This videoid requires a token to watch.
        if (ctx.token !== expectedToken) {
          throw { statusCode: 403, message: "Invalid or missing watch token" };
        }
        app.log.info(
          { videoid: ctx.videoid, kind: ctx.kind },
          "pulsevault authorize: token-protected watch request verified",
        );
      }
    }
  },
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
console.log(`\nRN demo server running.`);
console.log(`Pairing page: http://localhost:${port}/`);
console.log(`Swagger UI:   http://localhost:${port}/docs`);
console.log(
  `From your phone (same WiFi): open http://<your-laptop-ip>:${port}/ in the browser`,
);
