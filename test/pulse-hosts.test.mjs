// What hosts used to rebuild around PulseVault (issue #80): the shape of a pulse at create, the
// richer hook context, reclaiming an idle unfinished upload, durable completion and the lock on
// finished pulses, the token's context, the status and poster routes, background web-ready,
// `getPulse`, and the content types phones need. Local storage throughout, and the S3 adapter
// (against the mock) where the adapter carries the behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pulseVault, {
  createLocalStorage,
  createS3Storage,
  createChecksumValidator,
  issueCapabilityToken,
  issueViewToken,
  createCapabilityAuthorize,
  createVideoValidator,
  MAX_CONTEXT_BYTES,
} from "../dist/app.js";
import { createHash } from "node:crypto";
import { makeMp4, tusCreate, tusPatch, tusDelete, uploadFull } from "./helpers.mjs";
import { startMockS3 } from "./mock-s3.mjs";

const PREFIX = "/pulsevault";
const BUCKET = "pulse-hosts-test";
const SECRET = "shh";
const ISSUER = "https://vault.example.test";
const KID = "k1";
const lookupSecret = (kid) => (kid === KID ? SECRET : null);
const VTT = Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

const hasCmd = (cmd) => {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const FFMPEG = hasCmd("ffmpeg") && hasCmd("ffprobe");

let mockS3;
let endpoint;
before(async () => {
  mockS3 = await startMockS3({ buckets: [BUCKET] });
  endpoint = mockS3.endpoint;
});
after(async () => {
  if (mockS3) await mockS3.close();
});

const mint = (artifactId, extra = {}) =>
  issueCapabilityToken(artifactId, SECRET, { keyId: KID, issuer: ISSUER, ...extra });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const authorize = (opts = {}) => createCapabilityAuthorize(lookupSecret, { issuer: ISSUER, ...opts });

async function startLocal({ pluginOptions = {} } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-hosts-"));
  const storage = createLocalStorage({ workspaceDir });
  return startApp(storage, pluginOptions, () => fs.rm(workspaceDir, { recursive: true, force: true }));
}

async function startS3({ pluginOptions = {} } = {}) {
  const storage = await createS3Storage({
    bucket: BUCKET,
    endpoint,
    region: "us-east-1",
    accessKeyId: "MOCKS3",
    secretAccessKey: "MOCKS3",
    forcePathStyle: true,
    clientConfig: {
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    },
  });
  return startApp(storage, pluginOptions, async () => {});
}

async function startApp(storage, pluginOptions, cleanup) {
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    // Tests drive the replay themselves.
    replayCompletions: false,
    ...pluginOptions,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    core: app.pulseVaultCore,
    storage,
    baseUrl,
    url: (p) => `${baseUrl}${PREFIX}${p}`,
    teardown: async () => {
      await app.close();
      await cleanup();
    },
  };
}

/** A whole pulse as the app sends it: captions, manifest and thumbnail, then the video. */
async function uploadPulse(ctx, videoId, token, { thumbnail = true } = {}) {
  const headers = bearer(token);
  const related = async (filename, kind, body) => {
    const artifactId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId, filename, kind, relatedTo: videoId, body, headers });
    return artifactId;
  };
  const captionsId = await related("draft.vtt", "captions", VTT);
  const manifestId = await related("draft-beats.pulse", "project", Buffer.from('{"version":1,"beats":[]}'));
  const thumbnailId = thumbnail ? await related("draft.jpg", "thumbnail", JPG) : null;
  await uploadFull(ctx.baseUrl, PREFIX, {
    artifactId: videoId,
    filename: "draft.mp4",
    kind: "video",
    name: "Standup plan",
    appVersion: "2.2.1 (60)",
    headers,
  });
  return { captionsId, manifestId, thumbnailId };
}

// ---------- §1 the shape of a pulse ----------

test("pulse shape: a video only under the token's own id, related files only under other ids", async () => {
  const ctx = await startLocal({ pluginOptions: { authorize: authorize() } });
  try {
    const videoId = randomUUID();
    const token = mint(videoId);
    const headers = bearer(token);

    // A video under another id, relatedTo the reserved one: never attached, converted and kept.
    const rogue = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: randomUUID(), filename: "x.mp4", size: 64, kind: "video", relatedTo: videoId, headers,
    });
    assert.equal(rogue.status, 403);
    assert.match((await rogue.json()).error, /video is uploaded under the token/);

    // A thumbnail under the video's own id: takes the id, so the real video 409s for good.
    const squat = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "x.jpg", size: 11, kind: "thumbnail", relatedTo: videoId, headers,
    });
    assert.equal(squat.status, 403);

    // A thumbnail under its own id but not relatedTo the token's video.
    const loose = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: randomUUID(), filename: "x.jpg", size: 11, kind: "thumbnail", headers,
    });
    assert.equal(loose.status, 403);

    // The real shape is accepted, and the video can still land under its id.
    const { thumbnailId } = await uploadPulse(ctx, videoId, token);
    assert.equal((await ctx.storage.describeArtifact(videoId)).ready, true);
    assert.equal((await ctx.storage.describeArtifact(thumbnailId)).relatedTo, videoId);
  } finally {
    await ctx.teardown();
  }
});

test("pulse shape holds structurally with the host's own authorize, and is off with pulseShape: false", async () => {
  const strict = await startLocal({ pluginOptions: { authorize: async () => {} } });
  try {
    const videoWithParent = await tusCreate(strict.baseUrl, PREFIX, {
      artifactId: randomUUID(), filename: "x.mp4", size: 64, kind: "video", relatedTo: randomUUID(),
    });
    assert.equal(videoWithParent.status, 403);
    const captionsAlone = await tusCreate(strict.baseUrl, PREFIX, {
      artifactId: randomUUID(), filename: "x.vtt", size: 8, kind: "captions",
    });
    assert.equal(captionsAlone.status, 403);
  } finally {
    await strict.teardown();
  }

  const loose = await startLocal({
    pluginOptions: { pulseShape: false, authorize: authorize({ pulseShape: false }) },
  });
  try {
    const anchor = randomUUID();
    const headers = bearer(mint(anchor));
    const captionsAlone = await tusCreate(loose.baseUrl, PREFIX, {
      artifactId: anchor, filename: "x.vtt", size: 8, kind: "captions", headers,
    });
    assert.equal(captionsAlone.status, 201);
    const videoRelated = await tusCreate(loose.baseUrl, PREFIX, {
      artifactId: randomUUID(), filename: "x.mp4", size: 64, kind: "video", relatedTo: anchor, headers,
    });
    assert.equal(videoRelated.status, 201);
  } finally {
    await loose.teardown();
  }
});

// ---------- §2 + §5 hook context and the token's context ----------

test("onUploadComplete and authorize receive relatedTo, name, appVersion, filename, ext and the token's context", async () => {
  const completions = [];
  const authorized = [];
  const owner = { userId: "u1", destination: { kind: "huddle", teamId: "t1" } };
  const ctx = await startLocal({
    pluginOptions: {
      authorize: async (request, c) => {
        authorized.push(c);
        return authorize()(request, c);
      },
      onUploadComplete: async (_req, c) => {
        completions.push(c);
      },
    },
  });
  try {
    const videoId = randomUUID();
    const token = mint(videoId, { context: owner });
    const { thumbnailId } = await uploadPulse(ctx, videoId, token);

    const video = completions.find((c) => c.artifactId === videoId);
    assert.deepEqual(
      { ...video, uploadId: undefined, size: undefined },
      {
        artifactId: videoId, kind: "video", filename: "draft.mp4", ext: ".mp4",
        name: "Standup plan", appVersion: "2.2.1 (60)", context: owner, replay: false,
        uploadId: undefined, size: undefined,
      },
    );
    assert.ok(video.size > 0);
    const thumb = completions.find((c) => c.artifactId === thumbnailId);
    assert.equal(thumb.kind, "thumbnail");
    assert.equal(thumb.relatedTo, videoId);
    assert.equal(thumb.ext, ".jpg");
    assert.deepEqual(thumb.context, owner, "a related file gets the same token's context");

    // On create, authorize sees what the client sent; on later phases, what storage holds.
    const create = authorized.find((c) => c.phase === "create" && c.artifactId === videoId);
    assert.equal(create.name, "Standup plan");
    assert.equal(create.filename, "draft.mp4");
    assert.equal(create.ext, ".mp4");
    assert.equal(create.context, undefined, "not stored yet on create");
    const get = await fetch(ctx.url(`/artifacts/${videoId}`), { headers: bearer(token) });
    assert.equal(get.status, 200);
    const resolve = authorized.find((c) => c.phase === "resolve" && c.artifactId === videoId);
    assert.deepEqual(resolve.context, owner);
    assert.equal(resolve.name, "Standup plan");

    // The context survives in the sidecar.
    assert.deepEqual((await ctx.storage.describeArtifact(videoId)).context, owner);
  } finally {
    await ctx.teardown();
  }
});

test("token context: capped, JSON only, and signed", () => {
  assert.throws(
    () => mint(randomUUID(), { context: "x".repeat(MAX_CONTEXT_BYTES) }),
    /at most \d+ bytes/,
  );
  assert.throws(() => mint(randomUUID(), { context: () => {} }), /JSON/);
  const token = mint(randomUUID(), { context: { a: 1 } });
  const [payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.ctx = { a: 2 };
  const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
  assert.equal(
    createCapabilityAuthorize(lookupSecret, { issuer: ISSUER }).length,
    2,
  );
  return assert.rejects(
    createCapabilityAuthorize(lookupSecret, { issuer: ISSUER })(
      { headers: { authorization: `Bearer ${forged}` } },
      { phase: "create", artifactId: claims.artifactId, kind: "video" },
    ),
    /Invalid or expired/,
  );
});

// ---------- §3 reclaim ----------

test("reclaim: a create with the same token takes over an idle unfinished upload; another token's can't", async () => {
  const ctx = await startLocal({
    pluginOptions: { authorize: authorize(), reclaim: { idleSeconds: 0 } },
  });
  try {
    const videoId = randomUUID();
    const token = mint(videoId);
    const headers = bearer(token);
    const first = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "draft.mp4", size: 1024, kind: "video", headers,
    });
    assert.equal(first.status, 201);
    const location = new URL(first.headers.get("location"), ctx.baseUrl).href;
    const body = makeMp4(1024);
    assert.equal((await tusPatch(location, 0, body.subarray(0, 512), headers)).status, 204);

    // The same token, same shape: the idle half-upload is replaced.
    const again = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "draft.mp4", size: 1024, kind: "video", headers,
    });
    assert.equal(again.status, 201);
    const relocation = new URL(again.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusPatch(relocation, 0, body, headers)).status, 204, "starts from byte 0 again");
    assert.equal((await ctx.storage.describeArtifact(videoId)).ready, true);

    // A thumbnail someone else started, relatedTo their own video. This token may create a
    // thumbnail relatedTo its video under any free id, but not take over one whose stored
    // `relatedTo` is another video: that upload was authorized by another token.
    const otherVideo = randomUUID();
    const otherThumb = randomUUID();
    const other = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: otherThumb, filename: "x.jpg", size: 11, kind: "thumbnail", relatedTo: otherVideo,
      headers: bearer(mint(otherVideo)),
    });
    assert.equal(other.status, 201);
    const steal = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: otherThumb, filename: "x.jpg", size: 11, kind: "thumbnail", relatedTo: videoId, headers,
    });
    assert.equal(steal.status, 409);
    assert.equal((await ctx.storage.describeArtifact(otherThumb)).relatedTo, otherVideo, "untouched");
  } finally {
    await ctx.teardown();
  }
});

test("reclaim: a fresh unfinished upload still 409s, and reclaim: false keeps the 409 for good", async () => {
  const fresh = await startLocal({ pluginOptions: { authorize: authorize() } });
  try {
    const videoId = randomUUID();
    const headers = bearer(mint(videoId));
    const create = { artifactId: videoId, filename: "draft.mp4", size: 1024, kind: "video", headers };
    assert.equal((await tusCreate(fresh.baseUrl, PREFIX, create)).status, 201);
    assert.equal((await tusCreate(fresh.baseUrl, PREFIX, create)).status, 409, "idle < 300 s");
  } finally {
    await fresh.teardown();
  }
  const off = await startLocal({ pluginOptions: { authorize: authorize(), reclaim: false } });
  try {
    const videoId = randomUUID();
    const headers = bearer(mint(videoId));
    const create = { artifactId: videoId, filename: "draft.mp4", size: 1024, kind: "video", headers };
    assert.equal((await tusCreate(off.baseUrl, PREFIX, create)).status, 201);
    assert.equal((await tusCreate(off.baseUrl, PREFIX, create)).status, 409);
  } finally {
    await off.teardown();
  }
});

test("reclaim on S3: idleness counts from the last part received, not from the reservation", async () => {
  const ctx = await startS3({ pluginOptions: { authorize: authorize(), reclaim: { idleSeconds: 2 } } });
  try {
    const videoId = randomUUID();
    const headers = bearer(mint(videoId));
    const body = makeMp4(6 * 1024 * 1024);
    const create = { artifactId: videoId, filename: "draft.mp4", size: body.length, kind: "video", headers };
    const first = await tusCreate(ctx.baseUrl, PREFIX, create);
    assert.equal(first.status, 201);
    const reservedAt = (await ctx.storage.describeArtifact(videoId)).updatedAt;
    assert.ok(reservedAt > 0, "the mock reports when the sidecar was written");
    await new Promise((r) => setTimeout(r, 2100));
    // A part lands after the reservation went idle: the upload is active again.
    const location = new URL(first.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusPatch(location, 0, body.subarray(0, 5 * 1024 * 1024), headers)).status, 204);
    const active = await ctx.storage.describeArtifact(videoId);
    assert.ok(active.updatedAt > reservedAt, "last activity moved with the part");
    assert.equal((await tusCreate(ctx.baseUrl, PREFIX, create)).status, 409, "not idle: not reclaimed");
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal((await tusCreate(ctx.baseUrl, PREFIX, create)).status, 201, "idle again: reclaimed");
  } finally {
    await ctx.teardown();
  }
});

// ---------- §4 durable completion and lockWhenReady ----------

test("durable completion: a hook that throws is replayed with replay: true until it succeeds", async () => {
  const seen = [];
  let fail = true;
  const ctx = await startLocal({
    pluginOptions: {
      onUploadComplete: async (_req, c) => {
        seen.push(c);
        if (fail) throw new Error("db down");
      },
    },
  });
  try {
    const videoId = randomUUID();
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "draft.mp4", size: 1024, kind: "video", name: "Plan",
    });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    const patch = await tusPatch(location, 0, makeMp4(1024));
    assert.equal(patch.status, 500, "the client learns the host didn't record it");
    assert.equal((await ctx.core.getStatus(videoId)).state, "ready", "the bytes serve");
    assert.equal((await ctx.core.getStatus(videoId)).acknowledged, false);

    assert.deepEqual(await ctx.core.replayCompletions(), [videoId], "tried again (and failed again)");
    assert.equal(seen.length, 2);
    assert.equal(seen[1].replay, true);
    assert.equal(seen[1].name, "Plan");

    fail = false;
    assert.deepEqual(await ctx.core.replayCompletions(), [videoId]);
    assert.equal((await ctx.core.getStatus(videoId)).acknowledged, true);
    assert.deepEqual(await ctx.core.replayCompletions(), [], "acknowledged: nothing left to settle");
    assert.equal(seen.length, 3);
  } finally {
    await ctx.teardown();
  }
});

test("durable completion: an acknowledged completion is not fired again by a retried final PATCH", async () => {
  let fired = 0;
  const ctx = await startLocal({
    pluginOptions: { onUploadComplete: async () => { fired++; } },
  });
  try {
    const videoId = randomUUID();
    const body = makeMp4(1024);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "draft.mp4", size: body.length, kind: "video",
    });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusPatch(location, 0, body)).status, 204);
    assert.equal(fired, 1);
    // The app lost the 204 and sends the (now empty) tail again.
    const retry = await tusPatch(location, body.length, Buffer.alloc(0));
    assert.equal(retry.status, 204);
    assert.equal(fired, 1, "completion is once per acknowledged upload");
  } finally {
    await ctx.teardown();
  }
});

test("a retried final PATCH after a web-ready rewrite skips payload validation, so a checksum validator can't remove a delivered video", { skip: !FFMPEG }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-retry-"));
  const recorded = path.join(dir, "recorded.mp4");
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", recorded,
  ], { stdio: "ignore" });
  const body = await fs.readFile(recorded);
  let fired = 0;
  let ctx;
  try {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-hosts-"));
    const storage = createLocalStorage({ workspaceDir });
    ctx = await startApp(
      storage,
      {
        validatePayload: createChecksumValidator(),
        webReady: true,
        onUploadComplete: async () => { fired++; },
      },
      () => fs.rm(workspaceDir, { recursive: true, force: true }),
    );
    const videoId = randomUUID();
    const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "draft.mp4", size: body.length, kind: "video", checksum,
    });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusPatch(location, 0, body)).status, 204);
    assert.equal(fired, 1);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await ctx.core.getStatus(videoId)).state !== "ready") {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notDeepEqual(await fs.readFile(await storage.getLocalPath(videoId)), body, "the bytes were remuxed");
    // The client lost the 204 and sends the (empty) tail again: the checksum of the rewritten
    // bytes no longer matches, but the finished upload isn't validated — or removed — again.
    const retry = await tusPatch(location, body.length, Buffer.alloc(0));
    assert.equal(retry.status, 204);
    assert.equal(fired, 1);
    assert.equal((await ctx.core.getStatus(videoId)).state, "ready");
    assert.equal((await fetch(ctx.url(`/artifacts/${videoId}`))).status, 200);
  } finally {
    await ctx?.teardown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("replay with completeAfter converts before the hook, even when the process stopped before the conversion was recorded", { skip: !FFMPEG }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-replay-"));
  const recorded = path.join(dir, "recorded.mp4");
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", recorded,
  ], { stdio: "ignore" });
  const body = await fs.readFile(recorded);
  const completions = [];
  const ctx = await startLocal({
    pluginOptions: {
      webReady: { completeAfter: true },
      onUploadComplete: async (_req, c) => { completions.push(c); },
    },
  });
  try {
    // The state a crash between markReady and the queue leaves behind: ready, unacknowledged,
    // not processing — written straight into storage.
    const videoId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "draft.mp4", kind: "video", body });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await ctx.core.getStatus(videoId)).acknowledged) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(completions.length, 1);
    await fs.writeFile(await ctx.storage.getLocalPath(videoId), body); // the original bytes again
    await ctx.storage.patchArtifact(videoId, { acknowledged: false, converted: false });

    assert.deepEqual(await ctx.core.replayCompletions(), [videoId]);
    const done = Date.now() + 20_000;
    while (Date.now() < done && completions.length < 2) await new Promise((r) => setTimeout(r, 100));
    assert.equal(completions.length, 2);
    assert.equal(completions[1].replay, true);
    assert.equal(completions[1].webReady?.action, "remuxed", "converted before the hook ran");
    // The acknowledgement is recorded once the hook has returned, a moment after it ran.
    while (Date.now() < done && !(await ctx.core.getStatus(videoId)).acknowledged) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await ctx.core.getStatus(videoId)).acknowledged, true);
  } finally {
    await ctx.teardown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const [name, start] of [["local", startLocal], ["S3", startS3]]) {
  test(`patchArtifact (${name}): concurrent flag writes don't lose each other`, async () => {
    const ctx = await start();
    try {
      const videoId = randomUUID();
      await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "draft.mp4", kind: "video" });
      await ctx.storage.patchArtifact(videoId, { acknowledged: false, converted: false });
      await Promise.all([
        ctx.storage.patchArtifact(videoId, { acknowledged: true }),
        ctx.storage.patchArtifact(videoId, { converted: true }),
        ctx.storage.patchArtifact(videoId, { outcome: { state: "done" } }),
      ]);
      const meta = await ctx.storage.describeArtifact(videoId);
      assert.equal(meta.acknowledged, true);
      assert.equal(meta.converted, true);
      assert.deepEqual(meta.outcome, { state: "done" });
      assert.ok(meta.readyAt > 0, "readyAt is recorded at markReady");
    } finally {
      await ctx.teardown();
    }
  });
}

test("an adapter without describeArtifact still gets onUploadComplete on every completion", async () => {
  let fired = 0;
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-hosts-"));
  const { describeArtifact: _d, patchArtifact: _p, listRelated: _l, ...minimal } = createLocalStorage({ workspaceDir });
  const ctx = await startApp(
    minimal,
    { onUploadComplete: async () => { fired++; } },
    () => fs.rm(workspaceDir, { recursive: true, force: true }),
  );
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: randomUUID(), filename: "a.mp4", kind: "video" });
    assert.equal(fired, 1);
    assert.deepEqual(await ctx.core.replayCompletions(), [], "nothing to replay from, nothing replayed");
  } finally {
    await ctx.teardown();
  }
});

test("replay is refused at boot for an adapter that can find unacknowledged artifacts but not record them", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-hosts-"));
  const { patchArtifact: _p, ...cannotRecord } = createLocalStorage({ workspaceDir });
  try {
    await assert.rejects(
      startApp(cannotRecord, { replayCompletions: { intervalSeconds: 60 } }, async () => {}),
      /needs a storage adapter with `patchArtifact`/,
    );
    const ctx = await startApp(cannotRecord, {}, async () => {}); // replay off (the test default): fine
    await ctx.teardown();
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("the poster URL is revalidated on every request, whatever cache policy the artifact URLs have", async () => {
  const ctx = await startLocal({ pluginOptions: { cache: { cacheControl: true, maxAge: "1y", immutable: true } } });
  try {
    const videoId = randomUUID();
    await uploadPulse(ctx, videoId, mint(videoId));
    const artifact = await fetch(ctx.url(`/artifacts/${videoId}`));
    assert.match(artifact.headers.get("cache-control"), /immutable/);
    const poster = await fetch(ctx.url(`/artifacts/${videoId}/poster`));
    assert.equal(poster.status, 200);
    assert.match(poster.headers.get("cache-control"), /max-age=0/);
    assert.doesNotMatch(poster.headers.get("cache-control"), /immutable/);
  } finally {
    await ctx.teardown();
  }
});

test("sidecars from before the acknowledged flag read as acknowledged, so an upgrade replays nothing", async () => {
  const ctx = await startLocal({ pluginOptions: { onUploadComplete: async () => {} } });
  try {
    const legacyId = randomUUID();
    const sidecar = path.join(ctx.storage.workspaceRoot, ".pulsevault", `${legacyId}.json`);
    await fs.mkdir(path.dirname(sidecar), { recursive: true });
    await fs.writeFile(
      sidecar,
      JSON.stringify({ version: 1, ext: ".mp4", filename: "old.mp4", status: "ready", kind: "video" }),
    );
    assert.equal((await ctx.storage.describeArtifact(legacyId)).acknowledged, true);
    assert.deepEqual(await ctx.core.replayCompletions(), []);
  } finally {
    await ctx.teardown();
  }
});

test("lockWhenReady: a finished pulse can't be deleted with its pairing token, an unfinished one can", async () => {
  const ctx = await startLocal({ pluginOptions: { authorize: authorize(), lockWhenReady: true } });
  try {
    const videoId = randomUUID();
    const token = mint(videoId);
    const headers = bearer(token);
    const { thumbnailId } = await uploadPulse(ctx, videoId, token);

    const del = await fetch(ctx.url(`/artifacts/${videoId}`), { method: "DELETE", headers });
    assert.equal(del.status, 403);
    assert.match((await del.json()).error, /locked/);
    const delThumb = await fetch(ctx.url(`/artifacts/${thumbnailId}`), { method: "DELETE", headers });
    assert.equal(delThumb.status, 403, "a related file of a finished video is locked too");
    assert.equal((await ctx.storage.describeArtifact(videoId)).ready, true);

    // A new captions upload for the finished video, still in flight: its TUS DELETE (a cancel)
    // is refused as well — it belongs to a landed pulse.
    const lateCaptions = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: randomUUID(), filename: "x.vtt", size: VTT.length, kind: "captions", relatedTo: videoId, headers,
    });
    assert.equal(lateCaptions.status, 201);
    const lateUrl = new URL(lateCaptions.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusDelete(lateUrl, headers)).status, 403);

    // An unfinished pulse (no video yet) can still be cancelled.
    const otherVideo = randomUUID();
    const otherHeaders = bearer(mint(otherVideo));
    const inFlight = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: otherVideo, filename: "draft.mp4", size: 1024, kind: "video", headers: otherHeaders,
    });
    const inFlightUrl = new URL(inFlight.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusDelete(inFlightUrl, otherHeaders)).status, 204);

    // The host can still remove it through storage, on its own terms.
    assert.equal(await ctx.storage.remove(videoId), true);
  } finally {
    await ctx.teardown();
  }
});

// ---------- §6 status ----------

test("status route: unknown, uploading with progress, ready with the host's outcome; view token suffices", async () => {
  const ctx = await startLocal({ pluginOptions: { authorize: authorize() } });
  try {
    const videoId = randomUUID();
    const token = mint(videoId);
    const headers = bearer(token);

    const unauthenticated = await fetch(ctx.url(`/artifacts/${videoId}/status`));
    assert.equal(unauthenticated.status, 401);

    let res = await fetch(ctx.url(`/artifacts/${videoId}/status`), { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { artifactId: videoId, state: "unknown" });

    const body = makeMp4(2048);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: videoId, filename: "draft.mp4", size: body.length, kind: "video", name: "Plan", headers,
    });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    assert.equal((await tusPatch(location, 0, body.subarray(0, 1024), headers)).status, 204);
    res = await fetch(ctx.url(`/artifacts/${videoId}/status?token=${encodeURIComponent(token)}`));
    let status = await res.json();
    assert.equal(status.state, "uploading");
    assert.equal(status.bytesReceived, 1024);
    assert.equal(status.size, 2048);
    assert.equal(status.name, "Plan");
    assert.equal(status.kind, "video");

    assert.equal((await tusPatch(location, 1024, body.subarray(1024), headers)).status, 204);
    assert.equal(await ctx.core.recordOutcome(videoId, { state: "done", note: "Posted to Huddle" }), true);
    const view = issueViewToken(videoId, SECRET, { keyId: KID, issuer: ISSUER, expirySeconds: 60 });
    res = await fetch(ctx.url(`/artifacts/${videoId}/status?token=${encodeURIComponent(view)}`));
    status = await res.json();
    assert.equal(status.state, "ready");
    assert.equal(status.bytesReceived, 2048);
    assert.equal(status.acknowledged, true);
    assert.deepEqual(status.outcome, { state: "done", note: "Posted to Huddle" });

    assert.equal(await ctx.core.recordOutcome(videoId, null), true);
    assert.equal((await ctx.core.getStatus(videoId)).outcome, undefined);
    assert.equal(await ctx.core.recordOutcome(randomUUID(), "x"), false);

    // The token's context reaches the host's server-side read, never the route.
    const owned = randomUUID();
    const ownedToken = mint(owned, { context: { userId: "u1" } });
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: owned, filename: "o.mp4", kind: "video", headers: bearer(ownedToken) });
    assert.deepEqual((await ctx.core.getStatus(owned)).context, { userId: "u1" });
    const routed = await (await fetch(ctx.url(`/artifacts/${owned}/status`), { headers: bearer(ownedToken) })).json();
    assert.equal(routed.context, undefined);
  } finally {
    await ctx.teardown();
  }
});

// ---------- §7 background web-ready ----------

test("webReady: the final PATCH is answered before the conversion; completeAfter delays the hook until it's done", { skip: !FFMPEG }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-webready-"));
  const recorded = path.join(dir, "recorded.mp4");
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", recorded,
  ], { stdio: "ignore" });
  const body = await fs.readFile(recorded);

  const completions = [];
  const events = [];
  const ctx = await startLocal({
    pluginOptions: {
      webReady: { completeAfter: true },
      onUploadComplete: async (_req, c) => { completions.push(c); },
      onArtifactEvent: (e) => { events.push(e); },
    },
  });
  try {
    const videoId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "draft.mp4", kind: "video", body });
    const right = await ctx.core.getStatus(videoId);
    assert.ok(["processing", "ready"].includes(right.state));
    assert.equal(completions.length === 0 || completions[0].webReady !== undefined, true);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await ctx.core.getStatus(videoId)).acknowledged) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await ctx.core.getStatus(videoId);
    assert.equal(done.state, "ready");
    assert.equal(done.acknowledged, true);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].webReady.action, "remuxed");
    const processed = events.find((e) => e.phase === "processed" && e.artifactId === videoId);
    assert.equal(processed.webReady.action, "remuxed");
    assert.ok(events.findIndex((e) => e.phase === "complete") < events.indexOf(processed));
  } finally {
    await ctx.teardown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** An MP4 made by ffmpeg from lavfi sources (MP4 needs a seekable output, so via a tmp file). */
async function encodeMp4(args) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-fixture-"));
  try {
    const p = path.join(dir, "fixture.mp4");
    execFileSync("ffmpeg", ["-v", "error", ...args, "-movflags", "+faststart", "-y", p], { stdio: "ignore" });
    return await fs.readFile(p);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Poll the status until the conversion has recorded what it did. */
async function waitForWebReady(ctx, artifactId) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await ctx.core.getStatus(artifactId);
    if (status.webReady || Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("webReady: a WebM is conformed to MP4 and served as video/mp4 at the same artifact URL", { skip: !FFMPEG }, async (t) => {
  let body;
  try {
    // Written to a pipe, like a browser's MediaRecorder: no duration in the header.
    body = execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libvpx-vp9", "-b:v", "200k", "-c:a", "libopus",
      "-f", "webm", "pipe:1",
    ]);
  } catch {
    return t.skip("ffmpeg build lacks libvpx/libopus");
  }
  const completions = [];
  const ctx = await startLocal({
    pluginOptions: {
      webReady: true,
      validatePayload: createVideoValidator(),
      onUploadComplete: async (_req, c) => { completions.push(c); },
    },
  });
  try {
    assert.equal(await ctx.core.conformAvailable(), true);
    const videoId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "Screen Recording.webm", kind: "video", body });
    const status = await waitForWebReady(ctx, videoId);
    assert.equal(status.state, "ready");
    assert.equal(status.webReady.action, "conformed");
    assert.match(status.webReady.reason, /container \.webm → mp4/);

    const res = await fetch(ctx.url(`/artifacts/${videoId}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    const served = Buffer.from(await res.arrayBuffer());
    assert.equal(served.toString("latin1", 4, 8), "ftyp");

    const videoDir = path.join(ctx.storage.workspaceRoot, "video");
    assert.ok((await fs.readdir(videoDir)).includes(`${videoId}.mp4`));
    assert.ok(!(await fs.readdir(videoDir)).includes(`${videoId}.webm`), "the original is removed once switched");
    const meta = await ctx.storage.describeArtifact(videoId);
    assert.equal(meta.ext, ".mp4");
    assert.equal(meta.sourceExt, ".webm", "the upload keeps its own extension");

    // A replayed hook still describes the upload: its filename, extension and tus id.
    await ctx.storage.patchArtifact(videoId, { acknowledged: false });
    await ctx.core.replayCompletions();
    const replayed = completions.find((c) => c.replay);
    assert.equal(replayed.filename, "Screen Recording.webm");
    assert.equal(replayed.ext, ".webm");
    assert.equal(replayed.uploadId, `video/${videoId}.webm`);

    // Removing the artifact removes every file it had, including tus's record of the upload.
    assert.equal(await ctx.storage.remove(videoId), true);
    assert.deepEqual((await fs.readdir(videoDir)).filter((f) => f.startsWith(videoId)), []);
  } finally {
    await ctx.teardown();
  }
});

test("webReady: a video still being converted is revalidated instead of the configured immutable cache", { skip: !FFMPEG }, async () => {
  const body = await encodeMp4(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const ctx = await startLocal({ pluginOptions: { webReady: true, cache: { maxAge: "365d", immutable: true } } });
  try {
    const videoId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "clip.mp4", kind: "video", body });
    await waitForWebReady(ctx, videoId);
    const cacheOf = async () => (await fetch(ctx.url(`/artifacts/${videoId}`))).headers.get("cache-control");
    assert.match(await cacheOf(), /immutable/, "a converted video takes the configured cache");
    // As it is between the final PATCH and the end of its conversion.
    await ctx.storage.patchArtifact(videoId, { converted: false });
    const converting = await cacheOf();
    assert.match(converting, /max-age=0/);
    assert.doesNotMatch(converting, /immutable/);
  } finally {
    await ctx.teardown();
  }
});

test("webReady: a conversion that times out keeps serving the original and the status says why", { skip: !FFMPEG }, async () => {
  const body = await encodeMp4([
    "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40", "-pix_fmt", "yuv420p",
  ]);
  const ctx = await startLocal({ pluginOptions: { webReady: { timeoutSeconds: 0.05 } } });
  try {
    const videoId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "big.mp4", kind: "video", body });
    const status = await waitForWebReady(ctx, videoId);
    assert.equal(status.state, "ready");
    assert.equal(status.webReady.action, "skipped");
    assert.match(status.webReady.reason, /timed out/);
    const served = Buffer.from(await (await fetch(ctx.url(`/artifacts/${videoId}`))).arrayBuffer());
    assert.ok(served.equals(body), "the original bytes serve");
  } finally {
    await ctx.teardown();
  }
});

test("createVideoValidator: a renamed non-video and a too-long video are refused with plain reasons", { skip: !FFMPEG }, async () => {
  const clip = await encodeMp4([
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]);
  const ctx = await startLocal({ pluginOptions: { validatePayload: createVideoValidator({ maxDurationSeconds: 1 }) } });
  try {
    const refused = async (filename, body) => {
      const create = await tusCreate(ctx.baseUrl, PREFIX, { artifactId: randomUUID(), filename, size: body.length, kind: "video" });
      assert.equal(create.status, 201);
      const patch = await tusPatch(new URL(create.headers.get("location"), ctx.baseUrl).href, 0, body);
      return { status: patch.status, text: (await patch.text()).trim() };
    };
    assert.deepEqual(await refused("notes.mp4", Buffer.from("%PDF-1.7 definitely not a video")), {
      status: 422,
      text: "That file isn't a video.",
    });
    // A picture isn't a video, whatever it's named.
    const png = execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
    ]);
    assert.deepEqual(await refused("photo.mp4", png), { status: 422, text: "That file isn't a video." });
    assert.deepEqual(await refused("long.mp4", clip), {
      status: 422,
      text: "That video is longer than the limit of 1 second.",
    });
  } finally {
    await ctx.teardown();
  }
});

test("an upload over maxUploadSize is refused in plain words, and conformAvailable is false without webReady", async () => {
  const ctx = await startLocal();
  try {
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: randomUUID(),
      filename: "huge.mov",
      size: 11 * 1024 * 1024,
      kind: "video",
    });
    assert.equal(create.status, 413);
    assert.equal((await create.text()).trim(), "That file is larger than 10 MB.");
    assert.equal(await ctx.core.conformAvailable(), false);
  } finally {
    await ctx.teardown();
  }
});

test("local storage: a delete racing a conversion's switch to a new file leaves nothing behind", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-switch-race-"));
  const storage = createLocalStorage({ workspaceDir });
  await storage.initialize();
  try {
    for (let i = 0; i < 50; i++) {
      const id = randomUUID();
      const rel = await storage.reserveUpload({ artifactId: id, filename: "r.webm", ext: ".webm", kind: "video" });
      await fs.writeFile(path.join(workspaceDir, rel), "webm");
      await storage.markReady(id);
      const output = path.join(workspaceDir, "video", `${id}.mp4`);
      await fs.writeFile(output, "mp4");
      // What the completion runner does once the conversion wrote `<id>.mp4`.
      const switchOver = async () => {
        const switched = await storage.patchArtifact(id, { ext: ".mp4", converted: true });
        await fs.rm(switched ? path.join(workspaceDir, rel) : output, { force: true });
      };
      await Promise.all(i % 2 ? [storage.remove(id), switchOver()] : [switchOver(), storage.remove(id)]);
      assert.equal(await storage.describeArtifact(id), null, "the removed artifact stays removed");
      assert.deepEqual((await fs.readdir(path.join(workspaceDir, "video"))).filter((f) => f.startsWith(id)), []);
    }
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("local storage, two instances on one workspace: a delete or a stale acknowledgement racing a switch to a new file", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-two-instances-"));
  // Two adapters over one directory: two servers on a shared disk, each with its own memory.
  const a = createLocalStorage({ workspaceDir });
  const b = createLocalStorage({ workspaceDir });
  await a.initialize();
  try {
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      const rel = await a.reserveUpload({ artifactId: id, filename: "r.webm", ext: ".webm", kind: "video" });
      await fs.writeFile(path.join(workspaceDir, rel), "webm");
      await a.markReady(id);
      await b.describeArtifact(id);
      const output = path.join(workspaceDir, "video", `${id}.mp4`);
      await fs.writeFile(output, "mp4");
      const switchOver = async () => {
        await a.patchArtifact(id, { ext: ".mp4", converted: true, unlessConverted: true });
        const recorded = await a.describeArtifact(id);
        if (!recorded) await fs.rm(output, { force: true });
        else await fs.rm(recorded.ext === ".mp4" ? path.join(workspaceDir, rel) : output, { force: true });
      };
      if (i % 2) {
        // A delete on the other instance: nothing may come back.
        await Promise.all([b.remove(id), switchOver()]);
        assert.equal(await a.describeArtifact(id), null);
        assert.deepEqual((await fs.readdir(path.join(workspaceDir, "video"))).filter((f) => f.startsWith(id)), []);
      } else {
        // An acknowledgement on the other instance: it must not put the old extension back.
        await Promise.all([b.patchArtifact(id, { acknowledged: true }), switchOver()]);
        const meta = await b.describeArtifact(id);
        assert.equal(meta.ext, ".mp4");
        assert.equal(meta.acknowledged, true);
        const resolved = await b.resolve(id);
        assert.equal(resolved?.filename, `video/${id}.mp4`, "the record and the file agree");
      }
    }
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("local storage: a conversion record with unlessConverted never replaces one already made", async () => {
  const ctx = await startLocal();
  try {
    const id = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, filename: "a.mp4", kind: "video" });
    await ctx.storage.patchArtifact(id, { converted: false });
    const done = { action: "conformed", reason: "first pass" };
    assert.equal(await ctx.storage.patchArtifact(id, { converted: true, webReady: done, unlessConverted: true }), true);
    assert.equal(
      await ctx.storage.patchArtifact(id, { converted: true, webReady: { action: "skipped", reason: "late failure" }, unlessConverted: true }),
      false,
      "a condition that doesn't hold changes nothing",
    );
    assert.deepEqual((await ctx.storage.describeArtifact(id)).webReady, done);
  } finally {
    await ctx.teardown();
  }
});

test("local storage: a patch for an earlier reservation of the id changes nothing, and installs no file", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-generation-"));
  const storage = createLocalStorage({ workspaceDir });
  await storage.initialize();
  try {
    const id = randomUUID();
    const reserve = async () => {
      const rel = await storage.reserveUpload({ artifactId: id, filename: "r.webm", ext: ".webm", kind: "video" });
      await fs.writeFile(path.join(workspaceDir, rel), "bytes");
      await storage.markReady(id);
    };
    await reserve();
    const first = (await storage.describeArtifact(id)).generation;
    assert.ok(first);
    // A conversion begins on the first upload; the id is removed and reserved again meanwhile.
    await storage.remove(id);
    await reserve();
    const second = (await storage.describeArtifact(id)).generation;
    assert.notEqual(second, first);
    const converted = path.join(workspaceDir, "video", ".webready-stale.mp4");
    await fs.writeFile(converted, "old upload, converted");
    const applied = await storage.patchArtifact(id, { converted: true, generation: first, file: converted, ext: ".mp4" });
    assert.equal(applied, false);
    const meta = await storage.describeArtifact(id);
    assert.equal(meta.ext, ".webm");
    assert.equal(meta.converted, false);
    assert.equal(await fs.readFile(path.join(workspaceDir, "video", `${id}.webm`), "utf8"), "bytes", "the new upload's bytes are untouched");
    assert.ok(await fs.stat(converted), "the file is left for the caller to drop");
    // The same patch for the current reservation installs it and drops the old extension's file.
    assert.equal(await storage.patchArtifact(id, { converted: true, generation: second, file: converted, ext: ".mp4" }), true);
    assert.equal(await fs.readFile(path.join(workspaceDir, "video", `${id}.mp4`), "utf8"), "old upload, converted");
    await assert.rejects(fs.stat(path.join(workspaceDir, "video", `${id}.webm`)));
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("local storage, two instances: a reservation racing a removal of the same id keeps its own bytes", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-reserve-race-"));
  const a = createLocalStorage({ workspaceDir });
  const b = createLocalStorage({ workspaceDir });
  await a.initialize();
  try {
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      const params = { artifactId: id, filename: "r.mp4", ext: ".mp4", kind: "video" };
      await fs.writeFile(path.join(workspaceDir, await a.reserveUpload(params)), "old");
      await a.markReady(id);
      const reserveAgain = async () => {
        try {
          await fs.writeFile(path.join(workspaceDir, await b.reserveUpload(params)), "new");
          return true;
        } catch (err) {
          if (err.statusCode === 409) return false;
          throw err;
        }
      };
      const [, reserved] = await Promise.all([a.remove(id), reserveAgain()]);
      if (reserved) {
        assert.ok(await b.describeArtifact(id), "the new reservation's sidecar survives");
        assert.equal(await fs.readFile(path.join(workspaceDir, "video", `${id}.mp4`), "utf8"), "new");
      }
    }
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("local storage: a sidecar lock is waited for while its holder lives, and taken over once it's stale", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-lock-"));
  const storage = createLocalStorage({ workspaceDir });
  await storage.initialize();
  try {
    const id = randomUUID();
    await storage.reserveUpload({ artifactId: id, filename: "a.mp4", ext: ".mp4", kind: "video" });
    const lockPath = path.join(workspaceDir, ".pulsevault", `${id}.json.lock`);
    // Another instance holds the lock and is alive: the patch waits until it's released.
    await fs.writeFile(lockPath, "another-holder");
    let done = false;
    const patched = storage.patchArtifact(id, { acknowledged: true }).then((ok) => { done = true; return ok; });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(done, false, "waits for a live holder");
    await fs.rm(lockPath);
    assert.equal(await patched, true);
    // A holder that died 60 s ago: its lock is taken over, and the patch's own lock is gone after.
    await fs.writeFile(lockPath, "dead-holder");
    const longAgo = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, longAgo, longAgo);
    assert.equal(await storage.patchArtifact(id, { outcome: { ok: true } }), true);
    assert.deepEqual((await storage.describeArtifact(id)).outcome, { ok: true });
    await assert.rejects(fs.stat(lockPath));
    assert.deepEqual((await fs.readdir(path.join(workspaceDir, ".pulsevault"))).filter((f) => f.includes(".lock")), []);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("an upload that grows past maxUploadSize mid-stream (deferred length) gets the plain 413 too", async () => {
  const ctx = await startLocal();
  try {
    const create = await fetch(ctx.url("/upload"), {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Defer-Length": "1",
        "Upload-Metadata": `artifactId ${Buffer.from(randomUUID()).toString("base64")},filename ${Buffer.from("big.mp4").toString("base64")},kind ${Buffer.from("video").toString("base64")}`,
      },
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    // With a Content-Length tus refuses the chunk before reading it…
    const declared = await tusPatch(location, 0, Buffer.alloc(11 * 1024 * 1024));
    assert.equal(declared.status, 413);
    assert.equal((await declared.text()).trim(), "That file is larger than 10 MB.");
    // …and a chunked body (no Content-Length) is cut off as it streams past the limit.
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const streamed = await fetch(location, {
      method: "PATCH",
      headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
      duplex: "half",
      body: new ReadableStream({
        pull(controller) {
          if (sent++ < 11) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    });
    assert.equal(streamed.status, 413);
    assert.equal((await streamed.text()).trim(), "That file is larger than 10 MB.");
    // A chunk past the length the client itself declared is its own bug: tus's words stay.
    const small = await tusCreate(ctx.baseUrl, PREFIX, { artifactId: randomUUID(), filename: "s.mp4", size: 100, kind: "video" });
    const overrun = await tusPatch(new URL(small.headers.get("location"), ctx.baseUrl).href, 0, Buffer.alloc(200));
    assert.equal(overrun.status, 413);
    assert.notEqual((await overrun.text()).trim(), "That file is larger than 10 MB.");
  } finally {
    await ctx.teardown();
  }
});

test("GET resolves again once when the resolved file is gone (a conversion replaced it)", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-reresolve-"));
  const storage = createLocalStorage({ workspaceDir });
  let resolves = 0;
  // The first resolution names a file that no longer exists, as a conversion's switch leaves it.
  const racing = {
    ...storage,
    resolve: async (id) => (resolves++ === 0 ? { kind: "stream", root: workspaceDir, filename: `video/${id}.webm` } : storage.resolve(id)),
  };
  const ctx = await startApp(racing, {}, () => fs.rm(workspaceDir, { recursive: true, force: true }));
  try {
    const id = randomUUID();
    const { body } = await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, filename: "a.mp4", kind: "video" });
    resolves = 0;
    const res = await fetch(ctx.url(`/artifacts/${id}`));
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body));
    assert.equal(resolves, 2);
  } finally {
    await ctx.teardown();
  }
});

test("webReady needs the local adapter", async () => {
  await assert.rejects(startS3({ pluginOptions: { webReady: true } }), /getLocalPath/);
});

// ---------- §8 getPulse and the poster route ----------

for (const [name, start] of [["local", startLocal], ["S3", startS3]]) {
  test(`getPulse and the poster route (${name}): derived from relatedTo, before or after the video`, async () => {
    const ctx = await start({ pluginOptions: { authorize: authorize() } });
    try {
      const videoId = randomUUID();
      const token = mint(videoId);
      const headers = bearer(token);

      const none = await fetch(ctx.url(`/artifacts/${videoId}/poster`), { headers });
      assert.equal(none.status, 404, "nothing yet");

      // Poster first (the app's order), then the video.
      const { captionsId, manifestId, thumbnailId } = await uploadPulse(ctx, videoId, token);
      const pulse = await ctx.core.getPulse(videoId);
      assert.equal(pulse.video.artifactId, videoId);
      assert.equal(pulse.video.name, "Standup plan");
      assert.equal(pulse.thumbnail.artifactId, thumbnailId);
      assert.equal(pulse.captions.artifactId, captionsId);
      assert.equal(pulse.manifest.artifactId, manifestId);

      const poster = await fetch(ctx.url(`/artifacts/${videoId}/poster`), { headers, redirect: "manual" });
      if (name === "local") {
        assert.equal(poster.status, 200);
        assert.equal(poster.headers.get("content-type"), "image/jpeg");
        assert.deepEqual(Buffer.from(await poster.arrayBuffer()), JPG);
      } else {
        assert.equal(poster.status, 302);
        assert.match(poster.headers.get("location"), new RegExp(`thumbnail/${thumbnailId}\\.jpg`));
      }

      // A later poster (a retry) replaces the earlier one; a view token opens it.
      const laterThumb = randomUUID();
      await uploadFull(ctx.baseUrl, PREFIX, {
        artifactId: laterThumb, filename: "later.jpg", kind: "thumbnail", relatedTo: videoId, body: JPG, headers,
      });
      assert.equal((await ctx.core.getPulse(videoId)).thumbnail.artifactId, laterThumb);
      const view = issueViewToken(videoId, SECRET, { keyId: KID, issuer: ISSUER, expirySeconds: 60 });
      const viewed = await fetch(ctx.url(`/artifacts/${videoId}/poster?token=${encodeURIComponent(view)}`), {
        redirect: "manual",
      });
      assert.ok([200, 302].includes(viewed.status));

      // Removing a related file drops it from the pulse.
      await ctx.storage.remove(laterThumb);
      assert.equal((await ctx.core.getPulse(videoId)).thumbnail.artifactId, thumbnailId);

      assert.deepEqual(await ctx.core.getPulse(randomUUID()), { video: null });
    } finally {
      await ctx.teardown();
    }
  });
}

// ---------- §9 content types ----------

test("content types: the .pulse manifest is JSON; .mov/.m4v/.srt are served right when a host allows them", async () => {
  const ctx = await startLocal({
    pluginOptions: {
      allowedExtensions: { video: [".mp4", ".mov", ".m4v"], captions: [".vtt", ".srt"] },
    },
  });
  try {
    const caps = await (await fetch(ctx.url("/capabilities"))).json();
    assert.deepEqual(caps.allowedExtensions.video, [".mp4", ".mov", ".m4v"]);
    assert.deepEqual(caps.allowedExtensions.project, [".pulse", ".zip"], "the defaults are what Pulse sends");

    const videoId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, filename: "IMG_0001.mov", kind: "video" });
    const mov = await fetch(ctx.url(`/artifacts/${videoId}`));
    assert.equal(mov.headers.get("content-type"), "video/quicktime");

    const m4vId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: m4vId, filename: "clip.m4v", kind: "video" });
    assert.equal((await fetch(ctx.url(`/artifacts/${m4vId}`))).headers.get("content-type"), "video/x-m4v");

    const srtId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: srtId, filename: "clip.srt", kind: "captions", relatedTo: videoId,
      body: Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nHello\n"),
    });
    assert.equal((await fetch(ctx.url(`/artifacts/${srtId}`))).headers.get("content-type"), "application/x-subrip");

    const manifestId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: manifestId, filename: "clip-beats.pulse", kind: "project", relatedTo: videoId,
      body: Buffer.from('{"version":1,"type":"beat-manifest","durationMs":0,"beats":[]}'),
    });
    assert.equal((await fetch(ctx.url(`/artifacts/${manifestId}`))).headers.get("content-type"), "application/json");
  } finally {
    await ctx.teardown();
  }
});
