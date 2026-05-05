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

// List all uploaded videos under dataDir. The TUS file-store layout is
// data/<videoid>/video/<videoid>.<ext>(+ .json sidecar with metadata).
const videoSummarySchema = {
  type: "object",
  properties: {
    videoid: { type: "string", format: "uuid" },
    filename: { type: "string" },
    size: { type: "integer", minimum: 0 },
    creation_date: { type: "string", format: "date-time" },
    token: { type: "string", description: "Present when this video requires a token to watch." },
  },
  required: ["videoid", "filename", "size", "creation_date"],
};

app.get(
  "/videos",
  {
    schema: {
      tags: ["demo"],
      summary: "List previously uploaded videos",
      description:
        "Enumerates completed uploads on disk by scanning the local data directory.",
      response: {
        200: {
          description: "Videos sorted by creation time, newest first.",
          type: "array",
          items: videoSummarySchema,
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
          const mp4 = files.find(
            (f) => f.endsWith(".mp4") && !f.endsWith(".mp4.json"),
          );
          if (!mp4) return null;

          const mp4Path = path.join(videoDir, mp4);
          const jsonPath = `${mp4Path}.json`;
          const [mp4Stat, meta] = await Promise.all([
            stat(mp4Path).catch(() => null),
            readFile(jsonPath, "utf8")
              .then(JSON.parse)
              .catch(() => null),
          ]);
          if (!mp4Stat || mp4Stat.size === 0) return null;

          return {
            videoid,
            filename: meta?.metadata?.filename ?? mp4,
            size: mp4Stat.size,
            creation_date:
              meta?.creation_date ?? mp4Stat.birthtime.toISOString(),
            ...(tokenStore.has(videoid) && { token: tokenStore.get(videoid) }),
          };
        }),
    );

    return reply.send(
      videos
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

// Mount plugin at root prefix so TUS is at POST /upload and video GET is at /:videoid
const pulseStorage = createLocalStorage({ workspaceDir: dataDir });
await app.register(pulseVault, {
  prefix: "",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  allowedExtensions: [".mp4"],
  // Reject anything that doesn't look like an MP4 at the final PATCH.
  validatePayload: createMp4Sniffer(pulseStorage),
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
          { videoid: ctx.videoid },
          "pulsevault authorize: token-protected videoid registered",
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
          { videoid: ctx.videoid },
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
