// Meteor counterpart to ../fastify-auth-demo/server.mjs and ../express-demo/server.mjs
// — same demo (pairing page, QR codes, upload listing, optional bearer-token
// auth), built on @mieweb/pulsevault/core mounted via WebApp.connectHandlers
// instead of a framework of its own. The pairing page itself is Meteor's
// normal client bundle (client/main.html + client/main.js), not a
// hand-served static file — Meteor already serves that at "/".

import { Meteor } from "meteor/meteor";
import { WebApp } from "meteor/webapp";
import os from "node:os";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import QRCode from "qrcode";
import {
  createPulseVaultCore,
  createLocalStorage,
  createMp4Sniffer,
  createS3Storage,
  createS3Mp4Sniffer,
  buildUploadLink,
} from "@mieweb/pulsevault/core";

// Meteor bundles run from a generated build directory, not the source tree
// (and production bundles don't even ship the source tree) — so, unlike
// ../fastify-auth-demo and ../express-demo, this demo does not write uploads next to
// its own source. Defaults to a tmpdir; set PULSEVAULT_DIR to persist
// uploads somewhere durable.
const workspaceDir = process.env.PULSEVAULT_DIR || path.join(os.tmpdir(), "pulsevault-meteor-demo-data");

// Set DEMO_TOKEN to enable the auth demo: every upload + watch is verified
// against this token. Leave unset for an open demo with no authentication.
const DEMO_TOKEN = process.env.DEMO_TOKEN || null;

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
WebApp.connectHandlers.use("/reserve", (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ artifactId: randomUUID() }));
});

// List all uploads under dataDir. Reads each upload's sidecar to determine
// kind and subdir rather than hard-coding "video/" — handles video/project/captions.
WebApp.connectHandlers.use("/videos", async (_req, res) => {
  res.setHeader("content-type", "application/json");
  const pulsevaultMetaDir = path.join(workspaceDir, ".pulsevault");
  let entries;
  try {
    entries = await readdir(pulsevaultMetaDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      res.end("[]");
      return;
    }
    throw err;
  }

  const uploads = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".tmp"))
      .map(async (e) => {
        const artifactId = e.name.slice(0, -".json".length);
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
        const artifactFile = `${artifactId}${ext}`;
        const artifactPath = path.join(workspaceDir, kind, artifactFile);
        const tusJsonPath = `${artifactPath}.json`;

        const [artifactStat, tusMeta] = await Promise.all([
          stat(artifactPath).catch(() => null),
          readFile(tusJsonPath, "utf8")
            .then(JSON.parse)
            .catch(() => null),
        ]);
        if (!artifactStat || artifactStat.size === 0) return null;

        return {
          artifactId,
          kind,
          filename: sidecar.filename ?? tusMeta?.metadata?.filename ?? artifactFile,
          ext,
          size: artifactStat.size,
          creation_date:
            tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
        };
      }),
  );

  res.end(
    JSON.stringify(
      uploads
        .filter(Boolean)
        .sort((a, b) => b.creation_date.localeCompare(a.creation_date)),
    ),
  );
});

// One deeplink + matching QR per request. artifactId is generated server-side
// so it stays the source of truth. `server` must include the plugin's
// `basePath` ("/pulsevault") — the client builds every request as
// `${server}/<path>` with no prefix concept of its own.
WebApp.connectHandlers.use("/deeplinks", async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = `${proto}://${host}/pulsevault`;
  const artifactId = randomUUID();

  const upload = buildUploadLink({
    server,
    artifactId,
    ...(DEMO_TOKEN && { token: DEMO_TOKEN }),
  });

  const qrUpload = await QRCode.toDataURL(upload, {
    width: 224,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });

  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      upload,
      artifactId,
      qrUpload,
      authMode: Boolean(DEMO_TOKEN),
    }),
  );
});

// Storage backend. Defaults to the local filesystem; set STORAGE=s3 to stream
// uploads into Cloudflare R2 / AWS S3 instead and serve playback via presigned
// redirects. S3 mode needs the optional packages installed
// (`@aws-sdk/client-s3 @aws-sdk/s3-request-presigner @tus/s3-store`) and the
// S3_*/AWS_* env vars below — see `.env.example`. Note: the demo's /videos
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
  : createLocalStorage({ workspaceDir });

// Mount the core under /pulsevault so TUS is at POST /pulsevault/upload and
// artifact GET is at /pulsevault/artifacts/:artifactId — same routes as the
// Fastify plugin and the Express demo. `stripBasePath: false` because
// WebApp.connectHandlers.use(prefix, ...) already strips the mount prefix
// from req.url before calling the handler (same as Express); basePath is
// still used to build the tus Location header.
const pulseVault = createPulseVaultCore({
  basePath: "/pulsevault",
  stripBasePath: false,
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"], captions: [".srt", ".vtt"] },
  validatePayload: async (request, ctx) => {
    if (ctx.kind !== "video") return;
    const sniff = useS3 ? createS3Mp4Sniffer(pulseStorage) : createMp4Sniffer(pulseStorage);
    await sniff(request, ctx);
  },
  onUploadComplete: async (_req, { artifactId, kind, size }) => {
    console.log("pulsevault upload complete", { artifactId, kind, size });
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
      throw Object.assign(new Error("Forbidden: invalid demo token"), { statusCode: 403 });
    }
  },
});

WebApp.connectHandlers.use("/pulsevault", (req, res, next) => {
  pulseVault.handler(req, res, next).catch(next);
});

Meteor.startup(() => {
  console.log(`PulseVault Meteor demo — pulsevault mounted at /pulsevault, workspaceDir=${workspaceDir}`);
  if (DEMO_TOKEN) {
    console.log("Auth demo:                    ON  (DEMO_TOKEN is set)");
  } else {
    console.log("Auth demo:                    off (set DEMO_TOKEN=... to enable)");
  }
});

process.on("SIGINT", async () => {
  await pulseVault.shutdown();
  process.exit(0);
});
