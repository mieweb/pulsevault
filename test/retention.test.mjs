// Opt-in cleanup of abandoned uploads (`retention` / `sweepAbandonedUploads`), on both built-in
// storage adapters. Each scenario runs against its own workspace or its own mock bucket, so a
// sweep only ever sees what that scenario uploaded.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pulseVault, {
  createLocalStorage,
  createS3Storage,
  sweepAbandonedUploads,
} from "../dist/app.js";
import { makeMp4, tusCreate, tusPatch, tusHead, uploadFull } from "./helpers.mjs";
import { startRetentionSweep } from "../dist/lib/retention.js";
import { startMockS3 } from "./mock-s3.mjs";

const PREFIX = "/pulsevault";
const BUCKET = "pulse-retention-test";
const HOUR = 3600;
const VTT = Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");

let mockS3;
before(async () => {
  mockS3 = await startMockS3({ buckets: [BUCKET] });
});
after(async () => {
  if (mockS3) await mockS3.close();
});

async function startApp(storage, pluginOptions = {}) {
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...pluginOptions,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, baseUrl };
}

const localStorage = async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-retention-"));
  return {
    storage: createLocalStorage({ workspaceDir }),
    cleanup: () => fs.rm(workspaceDir, { recursive: true, force: true }),
  };
};

const s3Storage = async () => ({
  storage: await createS3Storage({
    bucket: BUCKET,
    endpoint: mockS3.endpoint,
    region: "us-east-1",
    accessKeyId: "MOCKS3",
    secretAccessKey: "MOCKS3",
    forcePathStyle: true,
    clientConfig: {
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    },
  }),
  cleanup: async () => {},
});

/** Start an upload and send part of it, then leave — a client that died mid-upload. */
async function abandonUpload(baseUrl, artifactId) {
  const body = makeMp4(4096);
  const create = await tusCreate(baseUrl, PREFIX, {
    artifactId,
    filename: "clip.mp4",
    size: body.length,
  });
  assert.equal(create.status, 201);
  const location = new URL(create.headers.get("location"), baseUrl).href;
  assert.equal((await tusPatch(location, 0, body.subarray(0, 1024))).status, 204);
  return location;
}

const uploadCaptions = (baseUrl, artifactId, relatedTo) =>
  uploadFull(baseUrl, PREFIX, {
    artifactId,
    filename: "clip.vtt",
    kind: "captions",
    relatedTo,
    body: VTT,
  });

for (const [name, makeStorage] of [
  ["local", localStorage],
  ["S3", s3Storage],
]) {
  test(`${name}: the sweep removes what abandoned uploads left, and only that`, async () => {
    const { storage, cleanup } = await makeStorage();
    const { app, baseUrl } = await startApp(storage);
    const get = (id) => fetch(`${baseUrl}${PREFIX}/artifacts/${id}`, { redirect: "manual" });
    try {
      // A client that died mid-upload.
      const abandoned = randomUUID();
      const abandonedLocation = await abandonUpload(baseUrl, abandoned);
      // A finished pulse: its video and captions.
      const video = randomUUID();
      const videoCaptions = randomUUID();
      await uploadFull(baseUrl, PREFIX, { artifactId: video });
      await uploadCaptions(baseUrl, videoCaptions, video);
      // Captions that finished before their video, which never did.
      const unfinishedVideo = randomUUID();
      const orphanedCaptions = randomUUID();
      await uploadCaptions(baseUrl, orphanedCaptions, unfinishedVideo);
      await abandonUpload(baseUrl, unfinishedVideo);
      // A thumbnail whose video doesn't exist at all.
      const strayThumbnail = randomUUID();
      await uploadFull(baseUrl, PREFIX, {
        artifactId: strayThumbnail,
        filename: "cover.jpg",
        kind: "thumbnail",
        relatedTo: randomUUID(),
        body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
      });

      // Nothing is old enough yet.
      assert.deepEqual(await sweepAbandonedUploads(storage, { abandonedAfterSeconds: HOUR }), []);

      // Two hours on, everything abandoned goes.
      const removed = await sweepAbandonedUploads(storage, {
        abandonedAfterSeconds: HOUR,
        now: Date.now() + 2 * HOUR * 1000,
      });
      assert.deepEqual(
        removed.sort(),
        [abandoned, unfinishedVideo, orphanedCaptions, strayThumbnail].sort(),
      );

      // The finished pulse is untouched.
      assert.notEqual((await get(video)).status, 404);
      assert.notEqual((await get(videoCaptions)).status, 404);
      // The abandoned upload is gone for good, and its id isn't wedged.
      assert.equal((await tusHead(abandonedLocation)).status, 404);
      assert.equal((await get(orphanedCaptions)).status, 404);
      const again = await tusCreate(baseUrl, PREFIX, {
        artifactId: abandoned,
        filename: "clip.mp4",
        size: 1024,
      });
      assert.equal(again.status, 201);
    } finally {
      await app.close();
      await cleanup();
    }
  });
}

test("the retention option sweeps on its own timer", async () => {
  const { storage, cleanup } = await localStorage();
  const { app, baseUrl } = await startApp(storage, {
    retention: { abandonedAfterSeconds: 0.05, sweepIntervalSeconds: 0.05 },
  });
  try {
    const abandoned = randomUUID();
    const location = await abandonUpload(baseUrl, abandoned);
    const deadline = Date.now() + 3000;
    while ((await tusHead(location)).status !== 404) {
      if (Date.now() > deadline) assert.fail("the abandoned upload was never swept");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await app.close();
    await cleanup();
  }
});

test("retention refuses settings that can't work, at boot", async () => {
  const { storage, cleanup } = await localStorage();
  try {
    for (const retention of [
      { abandonedAfterSeconds: 0 },
      { abandonedAfterSeconds: -1 },
      { abandonedAfterSeconds: Number.NaN },
      { abandonedAfterSeconds: HOUR, sweepIntervalSeconds: 0 },
      // Past what a Node timer can wait: it would fire every millisecond instead.
      { abandonedAfterSeconds: HOUR, sweepIntervalSeconds: 30 * 24 * HOUR },
    ]) {
      await assert.rejects(() => startApp(storage, { retention }), TypeError);
    }
    // An adapter that can't list its artifacts can't be swept.
    const { listArtifacts: _unlisted, ...unlistable } = storage;
    await assert.rejects(
      () => startApp(unlistable, { retention: { abandonedAfterSeconds: HOUR } }),
      /listArtifacts/,
    );
  } finally {
    await cleanup();
  }
});

test("the sweep keeps anything newer than the cutoff, even from an adapter that lists everything", async () => {
  const now = Date.now();
  const old = now - 2 * HOUR * 1000;
  const records = [
    { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: old },
    { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: now - 1000 },
    { artifactId: randomUUID(), kind: "captions", relatedTo: randomUUID(), ready: true, updatedAt: now },
  ];
  const removed = [];
  const storage = {
    // Ignores `changedBefore`, which an adapter is allowed to do.
    async *listArtifacts() {
      yield* records;
    },
    resolve: async () => null,
    remove: async (artifactId) => {
      removed.push(artifactId);
      return true;
    },
  };
  assert.deepEqual(
    await sweepAbandonedUploads(storage, { abandonedAfterSeconds: HOUR, now }),
    [records[0].artifactId],
  );
  assert.deepEqual(removed, [records[0].artifactId]);
});

/** A storage that lists `records` and removes whatever it's asked to, recording the ids. */
function listedStorage(records, { finished = () => false, failRemove = () => false } = {}) {
  const removed = [];
  return {
    removed,
    storage: {
      async *listArtifacts() {
        yield* records;
      },
      resolve: async (artifactId) => (finished(artifactId) ? { kind: "stream" } : null),
      remove: async (artifactId) => {
        if (failRemove(artifactId)) throw new Error("EACCES");
        removed.push(artifactId);
        return true;
      },
    },
  };
}
const quiet = { info() {}, error() {} };

test("a cutoff that isn't a positive number is refused, not taken as \"everything is old\"", async () => {
  const { storage, removed } = listedStorage([
    { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: Date.now() },
  ]);
  for (const abandonedAfterSeconds of [Number.NaN, undefined, 0, -1, "3600"]) {
    await assert.rejects(() => sweepAbandonedUploads(storage, { abandonedAfterSeconds }), TypeError);
  }
  assert.deepEqual(removed, []);
});

test("a record without a usable timestamp is kept", async () => {
  const { storage, removed } = listedStorage([
    { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: "2026-01-01T00:00:00Z" },
    { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: Number.NaN },
    { artifactId: randomUUID(), kind: "video", ready: false },
  ]);
  assert.deepEqual(await sweepAbandonedUploads(storage, { abandonedAfterSeconds: HOUR }), []);
  assert.deepEqual(removed, []);
});

test("a finished video is never removed, even when what it's relatedTo is gone", async () => {
  const old = Date.now() - 2 * HOUR * 1000;
  const reply = { artifactId: randomUUID(), kind: "video", relatedTo: randomUUID(), ready: true, updatedAt: old };
  const captions = { artifactId: randomUUID(), kind: "captions", relatedTo: randomUUID(), ready: true, updatedAt: old };
  const { storage, removed } = listedStorage([reply, captions]);
  assert.deepEqual(
    await sweepAbandonedUploads(storage, { abandonedAfterSeconds: HOUR }),
    [captions.artifactId],
  );
  assert.deepEqual(removed, [captions.artifactId]);
});

test("one artifact that can't be removed doesn't stop the sweep; each removal is reported", async () => {
  const old = Date.now() - 2 * HOUR * 1000;
  const stuck = { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: old };
  const next = { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: old };
  const { storage } = listedStorage([stuck, next], {
    failRemove: (id) => id === stuck.artifactId,
  });
  const errors = [];
  const reported = [];
  const removed = await sweepAbandonedUploads(storage, {
    abandonedAfterSeconds: HOUR,
    logger: { info() {}, error: (obj) => errors.push(obj.artifactId) },
    onRemoved: (record) => reported.push(record.artifactId),
  });
  assert.deepEqual(removed, [next.artifactId]);
  assert.deepEqual(errors, [stuck.artifactId]);
  assert.deepEqual(reported, [next.artifactId]);
});

test("stopping the timer waits for a sweep in progress, which stops early", async () => {
  const old = Date.now() - 2 * HOUR * 1000;
  let listed = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const removed = [];
  const storage = {
    async *listArtifacts() {
      for (let i = 0; i < 3; i++) {
        listed++;
        if (i === 1) await gate;
        yield { artifactId: randomUUID(), kind: "video", ready: false, updatedAt: old };
      }
    },
    resolve: async () => null,
    remove: async (id) => {
      removed.push(id);
      return true;
    },
  };
  const sweep = startRetentionSweep(storage, { abandonedAfterSeconds: HOUR, sweepIntervalSeconds: 0.01 }, quiet);
  while (listed < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  let stopped = false;
  const stopping = sweep.stop().then(() => (stopped = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "stop waits for the sweep in progress");
  release();
  await stopping;
  // It stopped at the next artifact instead of finishing the listing.
  assert.equal(removed.length, 1);
});

test("local: an upload still receiving bytes isn't abandoned, however long ago it started", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-retention-"));
  const storage = createLocalStorage({ workspaceDir });
  const { app, baseUrl } = await startApp(storage);
  try {
    const id = randomUUID();
    await abandonUpload(baseUrl, id);
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR * 1000);
    // Started two hours ago (the sidecar), but bytes arrived just now.
    await fs.utimes(path.join(workspaceDir, ".pulsevault", `${id}.json`), twoHoursAgo, twoHoursAgo);
    assert.deepEqual(await sweepAbandonedUploads(storage, { abandonedAfterSeconds: HOUR }), []);

    // Nothing written for two hours either: now it's abandoned.
    await fs.utimes(path.join(workspaceDir, "video", `${id}.mp4`), twoHoursAgo, twoHoursAgo);
    assert.deepEqual(await sweepAbandonedUploads(storage, { abandonedAfterSeconds: HOUR }), [id]);
  } finally {
    await app.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("the retention option reports each removal on onArtifactEvent", async () => {
  const { storage, cleanup } = await localStorage();
  const events = [];
  const { app, baseUrl } = await startApp(storage, {
    retention: { abandonedAfterSeconds: 0.05, sweepIntervalSeconds: 0.05 },
    onArtifactEvent: (event) => {
      if (event.phase === "remove") events.push(event);
    },
  });
  try {
    const abandoned = randomUUID();
    await abandonUpload(baseUrl, abandoned);
    const deadline = Date.now() + 3000;
    while (events.length === 0) {
      if (Date.now() > deadline) assert.fail("no remove event");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(events, [
      { phase: "remove", artifactId: abandoned, kind: "video", reason: "abandoned" },
    ]);
  } finally {
    await app.close();
    await cleanup();
  }
});
