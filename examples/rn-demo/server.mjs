import path from "node:path";
import os from "node:os";
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
  createChecksumValidator,
  createS3ChecksumValidator,
  buildUploadLink,
  issueCapabilityToken,
  verifyCapabilityToken,
  createCapabilityAuthorize,
} from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const dataDir = path.join(__dirname, "data");

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// ---------------------------------------------------------------------------
// Capability-token auth (this demo's "secure-by-default" option — see
// `PROTOCOL.md` §5.4 and the README's "Capability tokens" section).
//
// Unset `PULSEVAULT_SECRET` -> open demo, no auth, same as before. Set it and
// every upload/watch is gated by a real HMAC-signed, per-artifact, expiring
// token minted by `issueCapabilityToken` and checked by
// `createCapabilityAuthorize` — not a hand-rolled comparison.
// ---------------------------------------------------------------------------
const PULSEVAULT_SECRET = process.env.PULSEVAULT_SECRET || null;
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
if (PULSEVAULT_SECRET && !ISSUER) {
  ISSUER = `http://localhost:${port}`;
  console.warn(
    `\nPULSEVAULT_SECRET is set but PULSEVAULT_ISSUER is not — tokens will be issued for ${ISSUER}.`,
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
// Upload-unit deployment default (README "Upload unit") — purely advertisory
// via `GET /pulsevault/capabilities`; the plugin never enforces "beat" vs
// "merged", it just reports whichever value this server passes at
// registration. The plugin bakes this in as a fixed option captured once at
// `register()` time — there's no live setter for it, so changing this
// deployment-wide default means restarting with a different env var
// (`UPLOAD_UNIT=merged npm start`), not a runtime toggle. To test both
// "beat" and "merged" without restarting, use the per-link `uploadUnit`
// override on `GET /deeplinks` / `buildUploadLink` instead (PROTOCOL.md §3,
// §8) — the pairing page's "Upload unit for this link" selector drives it.
// ---------------------------------------------------------------------------
const uploadUnitDefault = process.env.UPLOAD_UNIT === "merged" ? "merged" : "beat";

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

// Serve pairing page before the plugin so it isn't swallowed by /pulsevault/artifacts/:artifactId
app.get(
  "/",
  {
    schema: {
      tags: ["demo"],
      summary: "Pairing page (HTML)",
      description:
        "Returns the static pairing UI that renders the upload QR code, a live artifact-event feed, and the uploads gallery.",
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

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
app.post(
  "/reserve",
  {
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
    schema: {
      tags: ["demo"],
      summary: "Recent artifact events",
      description:
        "The last `onArtifactEvent` firings (authorize rejections, upload completions, validation rejections) — an in-memory feed for the pairing page, not a durable audit log.",
    },
  },
  async (_req, reply) => reply.send(recentEvents),
);

/**
 * Reads a finalized artifact's bytes as text, regardless of storage backend.
 * Used for parsing the ordering manifest (`kind=project`) and for
 * SRT->WebVTT conversion (`kind=captions`) — both small text files, so a
 * full read is fine (unlike video bytes, which the checksum
 * validators/sniffers stream instead of buffering).
 */
async function readArtifactText(artifactId) {
  if (useS3) {
    const buf = await pulseStorage.readAll(artifactId);
    return buf ? buf.toString("utf8") : null;
  }
  const localPath = await pulseStorage.getLocalPath(artifactId);
  if (!localPath) return null;
  try {
    return await readFile(localPath, "utf8");
  } catch {
    return null;
  }
}

/** Minimal SRT -> WebVTT conversion so the gallery's <video> can attach real, playable subtitles — browsers only understand WebVTT in a <track>, never SRT. */
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

app.get(
  "/captions/:artifactId",
  {
    schema: {
      tags: ["demo"],
      summary: "Fetch a captions artifact as WebVTT",
      description:
        "Demo-only convenience route (not part of the pulsevault plugin) that converts a `kind=captions` SRT upload to WebVTT so the gallery's <track> element can render it. Applies the same relatedTo-aware capability-token check as the plugin's own routes when auth is on.",
    },
  },
  async (req, reply) => {
    const { artifactId } = req.params;
    if (PULSEVAULT_SECRET) {
      const token = req.query?.token ?? "";
      const verified = token ? verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER }) : null;
      const relatedTo = (await pulseStorage.getRelatedTo?.(artifactId)) ?? null;
      const authorized = verified && (verified.artifactId === artifactId || verified.artifactId === relatedTo);
      if (!authorized) return reply.code(403).send();
    }
    const text = await readArtifactText(artifactId);
    if (text === null) return reply.code(404).send();
    return reply.type("text/vtt").send(srtToVtt(text));
  },
);

/**
 * List uploads grouped by *pulse* (the recording session a phone actually
 * produces), not as a flat list of unrelated files. Reconstructs the
 * grouping the wire protocol already encodes (`PROTOCOL.md` §8):
 *
 * - "beat" mode: a `kind=project` manifest (no `relatedTo` — it IS the
 *   session anchor) lists its beats' artifactIds in order; every beat
 *   video and caption declares `relatedTo` pointing at the manifest.
 * - "merged" mode: the single video itself has no `relatedTo` (it's its own
 *   anchor); any captions declare `relatedTo` pointing at it.
 *
 * When capability tokens are on, mints exactly ONE short-lived token per
 * pulse (scoped to the anchor artifactId) and reuses it for every beat's and
 * caption's playback URL — the same `relatedTo`-based session authorization
 * `PROTOCOL.md` §5.4 describes for uploads, exercised here for playback too.
 */
app.get(
  "/pulses",
  {
    schema: {
      tags: ["demo"],
      summary: "List uploads grouped by pulse (recording session)",
      description:
        "Groups beats + manifest + captions via `relatedTo` instead of listing every artifact as an unrelated flat entry.",
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

    const sidecars = (
      await Promise.all(
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
          }),
      )
    ).filter(Boolean);

    const byArtifactId = new Map(sidecars.map((s) => [s.artifactId, s]));
    const anchors = sidecars.filter((s) => !s.relatedTo);
    const childrenByAnchor = new Map();
    for (const s of sidecars) {
      if (!s.relatedTo) continue;
      if (!childrenByAnchor.has(s.relatedTo)) childrenByAnchor.set(s.relatedTo, []);
      childrenByAnchor.get(s.relatedTo).push(s);
    }

    const filenameStem = (filename) => filename.replace(/\.[^.]+$/, "");

    const pulses = await Promise.all(
      anchors.map(async (anchor) => {
        const children = childrenByAnchor.get(anchor.artifactId) ?? [];
        const captionsPool = children.filter((c) => c.kind === "captions");
        const videoChildren = children.filter((c) => c.kind === "video");

        // One token per pulse (not per artifact) — demonstrates relatedTo-based
        // session authorization from PROTOCOL.md §5.4 for playback, exactly as
        // it's used for uploads.
        const pulseToken = PULSEVAULT_SECRET
          ? issueCapabilityToken(anchor.artifactId, PULSEVAULT_SECRET, {
              keyId: PULSEVAULT_KEY_ID,
              issuer: ISSUER,
              expirySeconds: WATCH_TOKEN_TTL_SECONDS,
            })
          : null;
        const withToken = (url) => (pulseToken ? `${url}?token=${pulseToken}` : url);

        const attachCaptions = (videoLike) => {
          const stem = filenameStem(videoLike.filename);
          const idx = captionsPool.findIndex((c) => filenameStem(c.filename) === stem);
          if (idx < 0) return null;
          const [captions] = captionsPool.splice(idx, 1);
          return { artifactId: captions.artifactId, vttUrl: withToken(`/captions/${captions.artifactId}`) };
        };

        let mode;
        let manifest = null;
        let beats;

        if (anchor.kind === "project") {
          mode = "beat";
          manifest = { artifactId: anchor.artifactId, size: anchor.size };
          let order = null;
          try {
            const parsed = JSON.parse(await readArtifactText(anchor.artifactId));
            order = Array.isArray(parsed?.beats) ? parsed.beats : null;
          } catch {
            order = null;
          }
          const videoByArtifactId = new Map(videoChildren.map((v) => [v.artifactId, v]));
          const ordered = [];
          if (order) {
            for (const b of order) {
              const v = videoByArtifactId.get(b.artifactId);
              if (v) {
                ordered.push(v);
                videoByArtifactId.delete(b.artifactId);
              }
            }
          }
          // Any beat not listed in the manifest (shouldn't normally happen) — keep it
          // visible rather than silently dropping an uploaded video.
          ordered.push(...videoByArtifactId.values());
          beats = ordered;
        } else {
          mode = "merged";
          beats = [anchor];
        }

        const beatViews = beats.map((v, i) => ({
          artifactId: v.artifactId,
          filename: v.filename,
          size: v.size,
          order: i,
          checksumVerified: v.checksumVerified,
          playbackUrl: withToken(`/pulsevault/artifacts/${v.artifactId}`),
          captions: attachCaptions(v),
        }));

        const creation_date = [anchor, ...children].reduce(
          (latest, s) => (s.creation_date > latest ? s.creation_date : latest),
          anchor.creation_date,
        );

        return {
          anchorArtifactId: anchor.artifactId,
          mode,
          manifest,
          beats: beatViews,
          unmatchedCaptions: captionsPool.map((c) => ({
            artifactId: c.artifactId,
            filename: c.filename,
            vttUrl: withToken(`/captions/${c.artifactId}`),
          })),
          creation_date,
        };
      }),
    );

    return reply.send(pulses.sort((a, b) => b.creation_date.localeCompare(a.creation_date)));
  },
);

// One deeplink + matching QR per request. artifactId is generated server-side
// so it stays the source of truth. `server` must include the plugin's
// `prefix` ("/pulsevault") — the client builds every request as
// `${server}/<path>` with no prefix concept of its own.
//
// `?uploadUnit=beat|merged` lets this *one* pairing link override the
// deployment-wide default set above — demonstrates running "beat" and
// "merged" sessions concurrently (README "Upload unit") instead of one fixed
// value for every pairing. Omit it and behavior is unchanged: the link
// carries no override, and the client falls back to whatever `/capabilities`
// reports, same as before this param existed.
app.get("/deeplinks", async (req, reply) => {
  // In the open (no-auth) case, keep deriving `server` from request headers —
  // convenient, and there's no issuer consistency requirement to protect.
  // Once auth is on, `server` MUST be built from the same fixed ISSUER the
  // capability token's `issuer` claim uses, or verification would fail for
  // every request that didn't happen to arrive on the exact host header the
  // token was issued under.
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = PULSEVAULT_SECRET ? `${ISSUER}/pulsevault` : `${proto}://${host}/pulsevault`;
  const artifactId = randomUUID();

  const requestedUploadUnit = req.query?.uploadUnit;
  if (requestedUploadUnit !== undefined && requestedUploadUnit !== "beat" && requestedUploadUnit !== "merged") {
    return reply.code(400).send({ error: '`uploadUnit` query param must be "beat" or "merged"' });
  }

  const token = PULSEVAULT_SECRET
    ? issueCapabilityToken(artifactId, PULSEVAULT_SECRET, {
        keyId: PULSEVAULT_KEY_ID,
        issuer: ISSUER,
        expirySeconds: TOKEN_TTL_SECONDS,
      })
    : null;

  const upload = buildUploadLink({
    server,
    artifactId,
    ...(token && { token }),
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
    authMode: Boolean(PULSEVAULT_SECRET),
    keyId: PULSEVAULT_SECRET ? PULSEVAULT_KEY_ID : null,
    issuer: PULSEVAULT_SECRET ? ISSUER : null,
    tokenExpiresInSeconds: token ? TOKEN_TTL_SECONDS : null,
    storage: useS3 ? "s3" : "local",
  });
});

// Storage backend. Defaults to the local filesystem; set STORAGE=s3 to stream
// uploads into Cloudflare R2 / AWS S3 instead and serve playback via presigned
// redirects. S3 mode needs the optional packages installed
// (`@aws-sdk/client-s3 @aws-sdk/s3-request-presigner @tus/s3-store`) and the
// S3_*/AWS_* env vars below — see `.env.example`. Note: /pulses lists local
// sidecars only, so it returns [] in S3 mode.
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

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and
// artifact GET is at /pulsevault/artifacts/:artifactId.
await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: pulseStorage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  uploadUnit: uploadUnitDefault,
  // Accept MP4 videos, Pulse draft bundles (.pulse) + diagnostic zips, and SRT captions.
  allowedExtensions: { video: [".mp4"], project: [".pulse", ".zip"], captions: [".srt"] },
  // validatePayload runs for every kind, with ctx.kind telling you which.
  // For video: verify the client-supplied checksum first (the Pulse app
  // always sends one), then the MP4 magic-byte sniff — chained per the
  // README's `createChecksumValidator(createMp4Sniffer(storage))` pattern.
  // Project bundles and SRT captions get neither: they never start with an
  // ISOBMFF ftyp box, and the app doesn't checksum them.
  validatePayload: async (request, ctx) => {
    if (ctx.kind !== "video") return;
    const sniff = useS3 ? createS3Mp4Sniffer(pulseStorage) : createMp4Sniffer(pulseStorage);
    const withChecksum = useS3
      ? createS3ChecksumValidator(pulseStorage, sniff)
      : createChecksumValidator(sniff);
    await withChecksum(request, ctx);
  },
  // Fired once any artifact (video, project bundle, or captions) finishes
  // uploading. The bytes are opaque to the plugin — index them, relay them,
  // or leave them for a later request.
  onUploadComplete: async (_req, { artifactId, kind, size }) => {
    app.log.info({ artifactId, kind, size }, "pulsevault upload complete");
  },
  // One hook covers both ops metrics and a compliance audit trail (see
  // OPERATIONS.md "Monitoring and audit logging") — fed straight into the
  // in-memory feed `/events` exposes to the pairing page.
  onArtifactEvent: (event) => {
    app.log.info(event, "pulsevault artifact event");
    recordEvent(event);
  },
  /**
   * `createCapabilityAuthorize` — the library's secure-by-default auth
   * option (see README "Capability tokens" / PROTOCOL.md §5.4): a
   * stateless, HMAC-signed, expiring token per artifact (or artifact
   * family, via `relatedTo`). No server-side session table, so secrets can
   * rotate and TTLs can change entirely on this server's own schedule.
   *
   * `undefined` when `PULSEVAULT_SECRET` is unset — same as before, an open
   * demo with no authorization at all.
   */
  authorize: PULSEVAULT_SECRET ? createCapabilityAuthorize(lookupSecret, { issuer: ISSUER }) : undefined,
});

await app.listen({ port, host });
console.log(`\nPulseVault demo running on http://localhost:${port}/`);
console.log(`Swagger UI:                   http://localhost:${port}/docs`);
if (PULSEVAULT_SECRET) {
  console.log(`Capability tokens:            ON  (kid=${PULSEVAULT_KEY_ID}, issuer=${ISSUER})`);
} else {
  console.log("Capability tokens:            off (set PULSEVAULT_SECRET=... to enable)");
}
