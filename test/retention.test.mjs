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
