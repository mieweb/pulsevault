// Meteor counterpart to ../fastify-demo/server.mjs — the same minimal, no-auth
// Pulse-compatible server (pairing page, QR codes, upload listing, subtitles),
// built on @mieweb/pulsevault/core mounted via WebApp.connectHandlers instead
// of a framework of its own. The pairing/library page itself is Meteor's normal
// client bundle (client/main.html + client/main.js), not a hand-served static
// file — Meteor already serves that at "/".
//
// No auth, local filesystem storage. For the production-shaped reference
// (capability tokens, S3, payload sniffing, Postgres index) see
// ../fastify-auth-demo.

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
  buildUploadLink,
} from "@mieweb/pulsevault/core";

// Meteor bundles run from a generated build directory, not the source tree
// (and production bundles don't even ship the source tree) — so, unlike
// ../fastify-demo, this demo does not write uploads next to its own source.
// Defaults to a tmpdir; set PULSEVAULT_DIR to persist uploads somewhere durable.
const workspaceDir = process.env.PULSEVAULT_DIR || path.join(os.tmpdir(), "pulsevault-meteor-demo-data");
const pulsevaultMetaDir = path.join(workspaceDir, ".pulsevault");

// Deployment-wide default advertised via GET /pulsevault/capabilities — purely
// advisory; the core never enforces "segment" vs "merged", it just reports
// whichever value this server passes at registration. Default "merged" so this
// demo exercises the full merged pipeline (video + captions + thumbnail); set
// UPLOAD_UNIT=segment to test per-clip uploads instead.
const uploadUnit = process.env.UPLOAD_UNIT === "segment" ? "segment" : "merged";

// The route params say `format: "uuid"` but nothing here runs Ajv, so routes
// that embed a request-supplied id in a filesystem path validate it explicitly.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve a path under workspaceDir and refuse anything that escapes it — the
// belt-and-suspenders companion to the UUID check for every read that embeds a
// request-supplied id.
function insideWorkspace(...segments) {
  const base = path.resolve(workspaceDir);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("path escapes the workspace directory");
  }
  return resolved;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// --- Static UI pages ---
// The pairing page (/) and the Instagram-style feed (/library) are the exact
// same self-contained React pages as ../fastify-demo, shipped verbatim under
// private/ and read via Meteor's Assets API. They pull React/htm/mermaid from a
// CDN at runtime (no bundler), so they're served as plain HTML rather than
// through Meteor's own client bundle. rawConnectHandlers runs *before* Meteor's
// boilerplate handler, so these win the "/" and "/library" routes.
const pages = {
  index: Assets.getTextAsync("index.html"),
  feed: Assets.getTextAsync("feed.html"),
};
async function servePage(pending, res, next) {
  try {
    const body = await pending;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch (err) {
    next(err);
  }
}

// Pairing page at exactly "/". A path-less handler sees every request, so it
// must forward anything that isn't the root (/pulsevault, /videos, the Meteor
// bundle, favicon, …) to the next handler untouched.
WebApp.rawConnectHandlers.use((req, res, next) => {
  if (req.method === "GET" && (req.url || "/").split("?")[0] === "/") {
    servePage(pages.index, res, next);
    return;
  }
  next();
});

// Feed page at /library (the JSON API lives at /videos, so the page sits here).
WebApp.rawConnectHandlers.use("/library", (req, res, next) => {
  if (req.method !== "GET") {
    next();
    return;
  }
  servePage(pages.feed, res, next);
});

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
WebApp.connectHandlers.use("/reserve", (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  json(res, 200, { artifactId: randomUUID() });
});

// Serve a subtitles artifact as WebVTT — exactly the bytes the app uploaded,
// word-level cue timestamps (<00:00:01.500>word) and all. The wire protocol
// calls the kind "captions" (PROTOCOL.md), but user-facing they're subtitles —
// spoken-word transcript, not accessibility captions — so the route is named
// that way. Mounted under "/subtitles", so req.url here is "/<artifactId>".
WebApp.connectHandlers.use("/subtitles", async (req, res) => {
  const artifactId = decodeURIComponent((req.url || "").split("?")[0].replace(/^\//, ""));
  if (!UUID_RE.test(artifactId)) {
    res.writeHead(400);
    res.end();
    return;
  }
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(insideWorkspace(".pulsevault", `${artifactId}.json`), "utf8"));
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  // Only serve real, finished captions uploads — never hand a video body to text/vtt.
  if (sidecar.kind !== "captions" || sidecar.status !== "ready") {
    res.writeHead(404);
    res.end();
    return;
  }
  const ext = sidecar.ext ?? ".vtt";
  let text;
  try {
    text = await readFile(insideWorkspace("captions", `${artifactId}${ext}`), "utf8");
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/vtt" });
  res.end(text);
});

// List all uploads under workspaceDir. Reads each upload's sidecar to determine
// kind and subdir rather than hard-coding "video/" — handles video/project/captions/thumbnail.
WebApp.connectHandlers.use("/videos", async (_req, res) => {
  let entries;
  try {
    entries = await readdir(pulsevaultMetaDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      json(res, 200, []);
      return;
    }
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
        const artifactPath = path.join(workspaceDir, kind, artifactFile);
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
          // their ordering manifest; a merged video's captions/thumbnail point at the
          // video) — lets the page group one pulse's artifacts together.
          relatedTo: sidecar.relatedTo ?? null,
          playbackUrl: `/pulsevault/artifacts/${artifactId}`,
          creation_date: tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
        };
      }),
  );

  const ready = uploads.filter(Boolean);

  // Pair each video with its subtitles (kind "captions" on the wire) the same
  // way fastify-demo does: within a pulse (shared `relatedTo ?? artifactId`
  // anchor), the app names the merged video's VTT after the video, so matching
  // filename stems pair them. Fallback: a pulse with exactly one video and one
  // subtitles file is an unambiguous pair even if the stems drifted.
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

  json(res, 200, ready.sort((a, b) => b.creation_date.localeCompare(a.creation_date)));
});

// One deeplink + matching QR per request. artifactId is generated server-side
// so it stays the source of truth. `server` must include the core's `basePath`
// ("/pulsevault") — the client builds every request as `${server}/<path>` with
// no prefix concept of its own.
//
// `?uploadUnit=segment|merged` lets this one pairing link override the
// deployment-wide default (PROTOCOL.md §8) — handy for testing both modes
// without restarting. Omit it and the link carries no override; the client
// falls back to whatever `/capabilities` reports.
WebApp.connectHandlers.use("/deeplinks", async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = `${proto}://${host}/pulsevault`;
  const artifactId = randomUUID();

  const requestedUploadUnit = new URL(req.url, "http://localhost").searchParams.get("uploadUnit") ?? undefined;
  if (requestedUploadUnit !== undefined && requestedUploadUnit !== "segment" && requestedUploadUnit !== "merged") {
    json(res, 400, { error: '`uploadUnit` query param must be "segment" or "merged"' });
    return;
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

  json(res, 200, { upload, artifactId, qrUpload });
});

// Mount the core under /pulsevault so TUS is at POST /pulsevault/upload and
// artifact GET is at /pulsevault/artifacts/:artifactId — same routes as the
// Fastify plugin and the Express demo. `stripBasePath: false` because
// WebApp.connectHandlers.use(prefix, ...) already strips the mount prefix from
// req.url before calling the handler (same as Express); basePath is still used
// to build the tus Location header. This is the smallest working mount — no
// authorize, no validatePayload, no hooks.
const pulseVault = createPulseVaultCore({
  basePath: "/pulsevault",
  stripBasePath: false,
  storage: createLocalStorage({ workspaceDir }),
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

WebApp.connectHandlers.use("/pulsevault", (req, res, next) => {
  pulseVault.handler(req, res, next).catch(next);
});

Meteor.startup(() => {
  console.log(`PulseVault Meteor demo — pulsevault mounted at /pulsevault`);
  console.log(`  pairing page: /   ·   feed: /library`);
  console.log(`  workspaceDir: ${workspaceDir}`);
  console.log(`  upload unit:  ${uploadUnit} (set UPLOAD_UNIT=segment to switch)`);
});

process.on("SIGINT", async () => {
  await pulseVault.shutdown();
  process.exit(0);
});
