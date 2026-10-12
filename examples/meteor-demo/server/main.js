// The reference host integration: a small team app, shaped like the ones that embed PulseVault
// (TimeHuddle — mieweb/timehuddle — is the model), on @mieweb/pulsevault/core mounted through
// WebApp.connectHandlers.
//
// What the app owns: people (a name in a cookie — no passwords, it's a demo), a team feed and a
// few tickets, kept in one JSON file under the upload directory. What PulseVault owns: every
// upload, who it belongs to and where it goes (signed into the capability token as `context`),
// what state it's in (the status route), its poster (the poster route), and the delivery
// guarantee (a completion that's replayed until the app records it).
//
// One Pulse upload, from the button to where it lands:
//
//   1. The page asks `POST /api/reserve { destination }`. The server checks the destination,
//      mints an artifactId and a capability token carrying `{ userId, destination }`, and
//      returns the pairing link + QR. Nothing is written anywhere.
//   2. The person scans it with Pulse, records, uploads. Pulse sends the captions, beat manifest
//      and thumbnail (`relatedTo` the video), then the video. PulseVault holds every create to
//      that shape, and stores the token's context with each file.
//   3. `onUploadComplete` fires for the video with that context: the server posts it to the feed
//      or attaches it to the ticket, then `recordOutcome` says where it went. If the server
//      throws or restarts in between, PulseVault fires the hook again later.
//   4. Meanwhile the page polls `GET /api/uploads/:id/status` (the core's `getStatus`, after an
//      owner check that's a comparison on the context — no table): uploading 45% → processing →
//      done, "Posted to the feed".
//   5. The feed shows every video as a card: `GET /pulsevault/artifacts/:id/poster` for the
//      frame, the artifact route for playback, the pulse's captions as a <track>.
//
// There is no table of uploads, no shape check, no stale-upload cleanup, no SSE route and no
// content-type fix-up in this file. Each of those used to be the host's job.

import { Meteor } from "meteor/meteor";
import { WebApp } from "meteor/webapp";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import QRCode from "qrcode";
import {
  createPulseVaultCore,
  createLocalStorage,
  createCapabilityAuthorize,
  issueCapabilityToken,
  buildUploadLink,
} from "@mieweb/pulsevault/core";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

// Meteor bundles run from a generated build directory (wiped on every restart in development),
// not the source tree — so uploads never go next to the source. Set PULSEVAULT_DIR to persist
// them somewhere durable; the default is a tmpdir.
const workspaceDir = process.env.PULSEVAULT_DIR || path.join(os.tmpdir(), "pulsevault-meteor-demo-data");
// Signs the capability tokens. Any real deployment sets it (and rotates it: see `keys` below).
const SECRET = process.env.PULSEVAULT_SECRET || "dev-insecure-pulsevault-secret";
const KEY_ID = "v1";
const keys = { [KEY_ID]: SECRET };
// The token's `issuer` claim: this deployment's identity. Meteor sets ROOT_URL.
const ISSUER = process.env.ROOT_URL || "http://localhost:3000";
const BASE_PATH = "/pulsevault";
// A pairing link works for 30 minutes — one recording session.
const LINK_SECONDS = 30 * 60;

// ---------------------------------------------------------------------------------------------
// The app's own records: people, the feed, tickets. One JSON file, written atomically.
// ---------------------------------------------------------------------------------------------

const appFile = path.join(workspaceDir, ".demo", "app.json");
let app = { posts: [], tickets: [] };
let appLoaded = (async () => {
  // Seed only when there is no file. An unreadable or malformed one is a fault to look at, not
  // something to overwrite: it holds posts and attachments whose completions were acknowledged.
  try {
    app = JSON.parse(await readFile(appFile, "utf8"));
    return;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  app = {
    posts: [],
    tickets: [
      { id: "T-101", title: "Onboarding checklist", attachments: [], createdAt: new Date().toISOString() },
      { id: "T-102", title: "Export fails on large files", attachments: [], createdAt: new Date().toISOString() },
    ],
  };
  await saveApp();
})();
// Every change to the records is one transaction, run one at a time: copy the current records,
// apply the change, write the copy to its own temp file, rename it into place, and only then
// publish it as the current records. A failed save publishes nothing, and a change queued
// behind it starts from the records that were actually saved.
let transaction = Promise.resolve();
function commit(change) {
  const run = transaction.catch(() => {}).then(async () => {
    const next = structuredClone(app);
    const result = change(next);
    await mkdir(path.dirname(appFile), { recursive: true });
    const tmp = `${appFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, appFile);
    app = next;
    return result;
  });
  transaction = run;
  return run;
}
const saveApp = () => commit(() => {});

// ---------------------------------------------------------------------------------------------
// Destinations: where a Pulse video can land. One entry per kind — `check` runs when the link
// is minted (so a bad destination fails before anyone records) and again at delivery, `deliver`
// carries it out. Idempotent on `videoId`: a completion can be replayed.
// ---------------------------------------------------------------------------------------------

const DESTINATIONS = {
  feed: {
    describe: () => "the team feed",
    check() {
      return {};
    },
    async deliver(userId, _destination, video) {
      await commit((next) => {
        if (next.posts.some((p) => p.videoId === video.artifactId)) return; // a replay
        next.posts.unshift({
          id: randomUUID(),
          author: userId,
          text: video.name || "A Pulse video",
          videoId: video.artifactId,
          createdAt: new Date().toISOString(),
        });
      });
      return "Posted to the feed";
    },
  },
  ticket: {
    describe: ({ id }) => `ticket ${id}`,
    check({ id }) {
      const ticket = app.tickets.find((t) => t.id === id);
      if (!ticket) throw httpError(404, `Ticket ${id} doesn't exist`);
      return { id };
    },
    async deliver(userId, { id }, video) {
      await commit((next) => {
        const ticket = next.tickets.find((t) => t.id === id);
        if (!ticket) throw httpError(404, `Ticket ${id} was deleted while the video was uploading`);
        if (ticket.attachments.some((a) => a.videoId === video.artifactId)) return; // a replay
        ticket.attachments.push({
          videoId: video.artifactId,
          name: video.name || "A Pulse video",
          by: userId,
          createdAt: new Date().toISOString(),
        });
      });
      return `Attached to ticket ${id}`;
    },
  },
};

function resolveDestination(destination) {
  const kind = DESTINATIONS[destination?.kind];
  if (!kind) throw httpError(400, "Unknown destination");
  return { kind: destination.kind, ...kind.check(destination) };
}

// ---------------------------------------------------------------------------------------------
// PulseVault
// ---------------------------------------------------------------------------------------------

const storage = createLocalStorage({ workspaceDir });

// The secure-by-default authorize: the capability token in the QR code, scoped to one pulse and
// holding every create to its shape. Playback is public here, as in most team apps — a
// viewer-scoped resolve is the next step (pulsevault#80).
const verifyToken = createCapabilityAuthorize((kid) => keys[kid] ?? null, { issuer: ISSUER });

const core = createPulseVaultCore({
  storage,
  basePath: BASE_PATH,
  // WebApp.connectHandlers.use(prefix, …) strips the mount prefix before calling the handler.
  stripBasePath: false,
  maxUploadSize: 2 * 1024 * 1024 * 1024, // 2 GiB
  // Uploads a client abandoned, and the related files of a video that never finished, go after
  // a day — well above the link's lifetime, past which no upload can continue anyway.
  retention: { abandonedAfterSeconds: 24 * 60 * 60 },
  // A pulse that landed stays: its pairing token can't delete it.
  lockWhenReady: true,
  // Every video is conformed to one web-playable format in the background (a Pulse upload is left
  // as is), and the feed only learns about it once that's done: nobody is handed a video
  // mid-rewrite.
  webReady: { completeAfter: true },
  authorize: async (request, ctx) => {
    if (ctx.phase === "resolve") return; // public playback
    return verifyToken(request, ctx);
  },
  // Delivery. `ctx.context` is what `/api/reserve` signed into the token: the owner and the
  // destination. Runs once per video, and again (`ctx.replay`) if it didn't finish.
  onUploadComplete: async (_request, ctx) => {
    if (ctx.kind !== "video") return; // captions, manifest and thumbnail are found at read time
    await appLoaded;
    const { userId, destination } = ctx.context ?? {};
    if (!userId || !destination) {
      await core.recordOutcome(ctx.artifactId, { state: "kept", reason: "No destination on this upload" });
      return;
    }
    try {
      const kind = DESTINATIONS[destination.kind];
      kind.check(destination);
      const note = await kind.deliver(userId, destination, ctx);
      await core.recordOutcome(ctx.artifactId, { state: "done", note });
      console.log(`[demo] ${ctx.replay ? "replayed: " : ""}${note} (${ctx.artifactId}, ${ctx.webReady?.action ?? "no conversion"})`);
    } catch (err) {
      // Only a destination that's gone for good settles the upload as kept (the video stays in
      // storage, and the page says why). Anything else — the records file couldn't be written,
      // a bug — is thrown, so PulseVault replays the completion instead of recording it done.
      if (err.statusCode !== 404) throw err;
      await core.recordOutcome(ctx.artifactId, { state: "kept", reason: err.message });
      console.warn(`[demo] kept ${ctx.artifactId}: ${err.message}`);
    }
  },
  onArtifactEvent: (event) => {
    if (event.phase === "processed" && event.webReady?.action !== "none") {
      console.log(`[demo] web-ready ${event.artifactId}: ${event.webReady?.reason}`);
    }
  },
});

WebApp.connectHandlers.use(BASE_PATH, (req, res, next) => {
  core.handler(req, res, next).catch(next);
});

// ---------------------------------------------------------------------------------------------
// The app's JSON API
// ---------------------------------------------------------------------------------------------

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const MAX_JSON_BODY = 16 * 1024; // every API body here is a name, a title or a destination
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw httpError(413, "Body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Body must be JSON");
  }
}
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}
/** Who's asking: the name they chose once. */
function userOf(req) {
  const name = cookies(req).pv_user;
  if (!name) throw httpError(401, "Pick a name first");
  return name;
}
/** The public origin, for the pairing link the phone uses — behind a proxy, the forwarded one. */
function originOf(req) {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const api = {
  // Who am I / become someone.
  async "GET /me"(req) {
    return { name: cookies(req).pv_user ?? null };
  },
  async "POST /me"(req, res) {
    const { name } = await readJson(req);
    const clean = String(name ?? "").trim().slice(0, 40);
    if (!clean) throw httpError(400, "A name is required");
    res.setHeader("set-cookie", `pv_user=${encodeURIComponent(clean)}; Path=/; SameSite=Lax; Max-Age=31536000`);
    return { name: clean };
  },

  // Reserve an upload: check the destination, sign who and where into the token, hand back the
  // link. PulseVault keeps the context with the upload from here on.
  async "POST /reserve"(req) {
    const userId = userOf(req);
    await appLoaded;
    const { destination } = await readJson(req);
    const resolved = resolveDestination(destination);
    const artifactId = randomUUID();
    const token = issueCapabilityToken(artifactId, keys[KEY_ID], {
      keyId: KEY_ID,
      issuer: ISSUER,
      expirySeconds: LINK_SECONDS,
      context: { userId, destination: resolved },
    });
    const link = buildUploadLink({ server: `${originOf(req)}${BASE_PATH}`, artifactId, token });
    const qr = await QRCode.toDataURL(link, { width: 224, margin: 1 });
    return { artifactId, link, qr, destination: DESTINATIONS[resolved.kind].describe(resolved), expiresInSeconds: LINK_SECONDS };
  },

  // Where an upload is. The owner check is a comparison on the context PulseVault stored —
  // no lookup table. `outcome` is what `onUploadComplete` recorded.
  async "GET /uploads/:id/status"(req, _res, { id }) {
    const userId = userOf(req);
    const status = await core.getStatus(id);
    if (status.state === "unknown") return status; // nothing uploaded yet: still waiting for Pulse
    const { video } = await core.getPulse(id);
    if (video?.context?.userId !== userId) throw httpError(403, "Not your upload");
    return status;
  },

  // The feed and the tickets, with each video's related files for the player (captions as a
  // <track>). Posters come from the poster route by the video's id — nothing is copied here.
  async "GET /feed"(req) {
    await appLoaded;
    const posts = await Promise.all(app.posts.map(async (p) => ({ ...p, pulse: await describePulse(p.videoId) })));
    const tickets = await Promise.all(
      app.tickets.map(async (t) => ({
        ...t,
        attachments: await Promise.all(t.attachments.map(async (a) => ({ ...a, pulse: await describePulse(a.videoId) }))),
      })),
    );
    return { me: cookies(req).pv_user ?? null, posts, tickets };
  },
  async "POST /tickets"(req) {
    userOf(req);
    await appLoaded;
    const { title } = await readJson(req);
    const clean = String(title ?? "").trim().slice(0, 80);
    if (!clean) throw httpError(400, "A title is required");
    return commit((next) => {
      const ticket = { id: `T-${100 + next.tickets.length + 1}`, title: clean, attachments: [], createdAt: new Date().toISOString() };
      next.tickets.push(ticket);
      return ticket;
    });
  },
};

/** What the player needs about a video: its playback URL, poster URL and captions, from `getPulse`. */
async function describePulse(videoId) {
  const { video, captions, manifest } = await core.getPulse(videoId);
  return {
    ready: Boolean(video?.ready),
    name: video?.name ?? null,
    src: `${BASE_PATH}/artifacts/${videoId}`,
    poster: `${BASE_PATH}/artifacts/${videoId}/poster`,
    captions: captions ? `${BASE_PATH}/artifacts/${captions.artifactId}` : null,
    manifest: manifest ? `${BASE_PATH}/artifacts/${manifest.artifactId}` : null,
  };
}

WebApp.connectHandlers.use("/api", async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const statusMatch = url.match(/^\/uploads\/([^/]+)\/status$/);
  let handler;
  let params = {};
  if (statusMatch) {
    if (!UUID_RE.test(statusMatch[1])) {
      json(res, 400, { error: "Not an upload id" });
      return;
    }
    handler = api["GET /uploads/:id/status"];
    params = { id: statusMatch[1] };
    if (req.method !== "GET") handler = null;
  } else {
    handler = api[`${req.method} ${url}`];
  }
  if (!handler) {
    json(res, 404, { error: "Not found" });
    return;
  }
  try {
    json(res, 200, await handler(req, res, params));
  } catch (err) {
    json(res, err.statusCode ?? 500, { error: err.statusCode ? err.message : "Something went wrong" });
    if (!err.statusCode) console.error("[demo] api error:", err);
  }
});

// ---------------------------------------------------------------------------------------------
// The page: one self-contained React page (no bundler) served at "/", ahead of Meteor's own
// client bundle. rawConnectHandlers runs before Meteor's boilerplate handler.
// ---------------------------------------------------------------------------------------------

const page = Assets.getTextAsync("index.html");
WebApp.rawConnectHandlers.use((req, res, next) => {
  if (req.method === "GET" && (req.url || "/").split("?")[0] === "/") {
    page.then((body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    }, next);
    return;
  }
  next();
});

Meteor.startup(async () => {
  await storage.initialize();
  await appLoaded;
  // Completions the app never recorded (it threw, or restarted mid-delivery) are delivered now,
  // and every five minutes after; this is the explicit pass at boot.
  const replayed = await core.replayCompletions();
  console.log(`PulseVault Meteor demo — pulsevault mounted at ${BASE_PATH}`);
  console.log(`  app: /   ·   uploads: ${workspaceDir}   ·   issuer: ${ISSUER}`);
  if (replayed.length) console.log(`  replayed ${replayed.length} completion(s): ${replayed.join(", ")}`);
});

process.on("SIGINT", async () => {
  await core.shutdown();
  process.exit(0);
});
