// S3 / R2 backend suite for @mieweb/pulsevault. Runs against the built
// `dist/` and the in-process, zero-dependency `mock-s3.mjs` double, so CI
// needs no real cloud credentials. A single mock is shared across tests; each
// test uses a fresh artifactId (the bucket persists between tests).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import pulseVault, {
  createS3Storage,
  createS3Mp4Sniffer,
  createS3ChecksumValidator,
} from "../dist/app.js";
import { makeMp4, tusCreate, tusPatch, tusHead, uploadFull } from "./helpers.mjs";
import { startMockS3 } from "./mock-s3.mjs";

const PREFIX = "/pulsevault";
const BUCKET = "pulse-test";

let mockS3;
let endpoint;

before(async () => {
  mockS3 = await startMockS3({ buckets: [BUCKET] });
  endpoint = mockS3.endpoint;
});

after(async () => {
  if (mockS3) await mockS3.close();
});

async function startApp({ pluginOptions = {}, withSniffer = false } = {}) {
  const storage = await createS3Storage({
    bucket: BUCKET,
    endpoint,
    region: "us-east-1",
    accessKeyId: "MOCKS3",
    secretAccessKey: "MOCKS3",
    forcePathStyle: true,
    // Keep the SDK from adding integrity-checksum headers/trailers (which would
    // switch bodies to aws-chunked framing) — the mock verifies bytes, not sums.
    clientConfig: {
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    },
  });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...(withSniffer ? { validatePayload: createS3Mp4Sniffer(storage) } : {}),
    ...pluginOptions,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    storage,
    baseUrl,
    teardown: async () => {
      await app.close();
    },
  };
}

const artifactUrl = (ctx, id) => `${ctx.baseUrl}${PREFIX}/artifacts/${id}`;

// ---------- tests ----------

test("full upload → GET 302-redirects to a presigned URL that serves the bytes", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    const { body } = await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, size: 2048 });

    // GET returns a redirect, not the bytes.
    const get = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(get.status, 302, "GET should 302-redirect");
    const location = get.headers.get("location");
    assert.ok(location, "Location header present");
    assert.ok(location.includes(BUCKET), "redirect points at the bucket");

    // Following the presigned URL returns the exact bytes from the bucket.
    const direct = await fetch(location);
    assert.equal(direct.status, 200);
    assert.equal(
      direct.headers.get("content-type"),
      "video/mp4",
      "presigned URL forces the right content-type",
    );
    const bytes = Buffer.from(await direct.arrayBuffer());
    assert.equal(bytes.length, body.length);
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("GET returns 404 while the upload is still in progress", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: 2048,
    });
    assert.equal(create.status, 201);

    const get = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("HEAD + resume PATCH completes the multipart upload", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    const body = makeMp4(4096);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: body.length,
    });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    const half = body.length / 2;

    const p1 = await tusPatch(location, 0, body.subarray(0, half));
    assert.equal(p1.status, 204);

    const head = await tusHead(location);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("upload-offset"), String(half));

    // Still in progress → GET must be 404.
    const midGet = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(midGet.status, 404);

    const p2 = await tusPatch(location, half, body.subarray(half));
    assert.equal(p2.status, 204);

    const get = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(get.status, 302);
    const direct = await fetch(get.headers.get("location"));
    const bytes = Buffer.from(await direct.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("second reserve for same artifactId returns 409", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    const first = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(first.status, 201);

    const dup = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dup.status, 409);
  } finally {
    await ctx.teardown();
  }
});

// Mirrors `plugin.test.mjs`'s concurrent-reserve test. `reserveUpload`'s collision guard
// uses `PutObjectCommand`'s `IfNoneMatch: "*"` to close the race atomically; `mock-s3.mjs`
// enforces conditional writes (412 on existing object) like real AWS S3/R2 does — the old
// `s3rver` double silently accepted both puts, so this couldn't be tested here before.
test("two truly concurrent reserves for the same artifactId: exactly one 201, one 409", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    const [a, b] = await Promise.all([
      tusCreate(ctx.baseUrl, PREFIX, { artifactId: id, filename: "clip.mp4", size: 1024 }),
      tusCreate(ctx.baseUrl, PREFIX, { artifactId: id, filename: "clip.mp4", size: 1024 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
  } finally {
    await ctx.teardown();
  }
});

test("createS3Mp4Sniffer rejects non-MP4 bytes and removes the object", async () => {
  const ctx = await startApp({ withSniffer: true });
  const id = randomUUID();
  try {
    // GIF header — deliberately not ISOBMFF.
    const fake = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(2048, 0xff)]);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "fake.mp4",
      size: fake.length,
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;

    const patch = await tusPatch(location, 0, fake);
    assert.ok(
      patch.status >= 400 && patch.status < 500,
      `expected 4xx, got ${patch.status}`,
    );

    const get = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(get.status, 404, "rejected upload is not served");
  } finally {
    await ctx.teardown();
  }
});

test("createS3Mp4Sniffer accepts a valid MP4 payload", async () => {
  const ctx = await startApp({ withSniffer: true });
  const id = randomUUID();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, size: 2048 });
    const get = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(get.status, 302);
  } finally {
    await ctx.teardown();
  }
});

test("createS3ChecksumValidator accepts a matching digest and rejects a mismatch", async () => {
  // createS3ChecksumValidator needs the same storage instance the plugin
  // uses, so this test builds the app directly rather than via `startApp`.
  const storage = await createS3Storage({
    bucket: BUCKET,
    endpoint,
    region: "us-east-1",
    accessKeyId: "S3RVER",
    secretAccessKey: "S3RVER",
    forcePathStyle: true,
    clientConfig: {
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    },
  });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    validatePayload: createS3ChecksumValidator(storage),
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const goodId = randomUUID();
    const body = makeMp4(2048);
    const digest = createHash("sha256").update(body).digest("hex");
    await uploadFull(baseUrl, PREFIX, { artifactId: goodId, body, checksum: `sha256:${digest}` });
    const get = await fetch(`${baseUrl}${PREFIX}/artifacts/${goodId}`, { redirect: "manual" });
    assert.equal(get.status, 302, "matching checksum is accepted");

    const badId = randomUUID();
    const create = await tusCreate(baseUrl, PREFIX, {
      artifactId: badId,
      filename: "clip.mp4",
      size: body.length,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    const location = new URL(create.headers.get("location"), baseUrl).href;
    const patch = await tusPatch(location, 0, body);
    assert.equal(patch.status, 422, "mismatched checksum is rejected");
  } finally {
    await app.close();
  }
});

test("DELETE removes the object; second DELETE is 404", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, size: 2048 });

    const pre = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(pre.status, 302);

    const del = await fetch(artifactUrl(ctx, id), { method: "DELETE" });
    assert.equal(del.status, 204);

    const post = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(post.status, 404);

    const del2 = await fetch(artifactUrl(ctx, id), { method: "DELETE" });
    assert.equal(del2.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("kind=project lands under project/ and GET /artifacts/:id 302-redirects there too", async () => {
  const ctx = await startApp();
  const id = randomUUID();
  try {
    // A .pulse bundle is opaque bytes — no MP4 sniffing for projects.
    const body = Buffer.alloc(2048, 0x42);
    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "draft.pulse",
      kind: "project",
      body,
    });

    const get = await fetch(artifactUrl(ctx, id), { redirect: "manual" });
    assert.equal(get.status, 302);
    const location = get.headers.get("location");
    assert.ok(location.includes(`project/${id}.pulse`), "redirect points at project key");

    const direct = await fetch(location);
    const bytes = Buffer.from(await direct.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("kind=captions lands under captions/ with relatedTo recorded", async () => {
  const ctx = await startApp();
  const videoId = randomUUID();
  const captionsId = randomUUID();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: videoId, size: 2048 });
    const vtt = Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: captionsId,
      filename: "clip.vtt",
      kind: "captions",
      relatedTo: videoId,
      body: vtt,
    });

    assert.equal(await ctx.storage.getKind(captionsId), "captions");
    assert.equal(await ctx.storage.getRelatedTo(captionsId), videoId);

    const get = await fetch(artifactUrl(ctx, captionsId), { redirect: "manual" });
    assert.equal(get.status, 302);
    const direct = await fetch(get.headers.get("location"));
    assert.equal(direct.headers.get("content-type"), "text/vtt");
  } finally {
    await ctx.teardown();
  }
});

test("onUploadComplete fires once with the right ctx", async () => {
  const calls = [];
  const ctx = await startApp({
    pluginOptions: {
      onUploadComplete: async (_req, info) => {
        calls.push(info);
      },
    },
  });
  const id = randomUUID();
  try {
    const { body } = await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, size: 2048 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].artifactId, id);
    assert.equal(calls[0].kind, "video");
    assert.equal(calls[0].size, body.length);
    assert.equal(typeof calls[0].uploadId, "string");
  } finally {
    await ctx.teardown();
  }
});
