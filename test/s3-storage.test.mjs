// S3 / R2 backend suite for @mieweb/pulsevault. Runs against the built
// `dist/` and an in-process `s3rver` S3 mock, so CI needs no real cloud
// credentials. A single s3rver is shared across tests; each test uses a fresh
// videoid (the bucket persists between tests).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import S3rver from "s3rver";
import Fastify from "fastify";
import pulseVault, {
  createS3Storage,
  createS3Mp4Sniffer,
} from "../dist/app.js";
import { makeMp4, tusCreate, tusPatch, tusHead, uploadFull } from "./helpers.mjs";
import { installListPartsShim } from "./s3rver-listparts.mjs";

const PREFIX = "/pulsevault";
const BUCKET = "pulse-test";

let s3rverInstance;
let s3Dir;
let endpoint;

before(async () => {
  s3Dir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-s3rver-"));
  s3rverInstance = new S3rver({
    address: "127.0.0.1",
    port: 0,
    silent: true,
    directory: s3Dir,
    // Presigned URLs from the SDK and modern checksum behavior don't always
    // match s3rver's SigV4 expectations byte-for-byte; accept them.
    allowMismatchedSignatures: true,
    configureBuckets: [{ name: BUCKET }],
  });
  // s3rver lacks ListParts, which @tus/s3-store needs on every write.
  installListPartsShim(s3rverInstance);
  const { port } = await s3rverInstance.run();
  endpoint = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (s3rverInstance) await s3rverInstance.close();
  if (s3Dir) await fs.rm(s3Dir, { recursive: true, force: true });
});

async function startApp({ pluginOptions = {}, withSniffer = false } = {}) {
  const storage = await createS3Storage({
    bucket: BUCKET,
    endpoint,
    region: "us-east-1",
    accessKeyId: "S3RVER",
    secretAccessKey: "S3RVER",
    forcePathStyle: true,
    // s3rver does not implement the SDK's default integrity checksums.
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

// ---------- tests ----------

test("full upload → GET 302-redirects to a presigned URL that serves the bytes", async () => {
  const ctx = await startApp();
  const vid = randomUUID();
  try {
    const { body } = await uploadFull(ctx.baseUrl, PREFIX, { videoid: vid, size: 2048 });

    // GET returns a redirect, not the bytes.
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
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
  const vid = randomUUID();
  try {
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      videoid: vid,
      filename: "clip.mp4",
      size: 2048,
    });
    assert.equal(create.status, 201);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("HEAD + resume PATCH completes the multipart upload", async () => {
  const ctx = await startApp();
  const vid = randomUUID();
  try {
    const body = makeMp4(4096);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      videoid: vid,
      filename: "clip.mp4",
      size: body.length,
    });
    const location = create.headers.get("location");
    const half = body.length / 2;

    const p1 = await tusPatch(location, 0, body.subarray(0, half));
    assert.equal(p1.status, 204);

    const head = await tusHead(location);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("upload-offset"), String(half));

    // Still in progress → GET must be 404.
    const midGet = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(midGet.status, 404);

    const p2 = await tusPatch(location, half, body.subarray(half));
    assert.equal(p2.status, 204);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(get.status, 302);
    const direct = await fetch(get.headers.get("location"));
    const bytes = Buffer.from(await direct.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("second reserve for same videoid returns 409", async () => {
  const ctx = await startApp();
  const vid = randomUUID();
  try {
    const first = await tusCreate(ctx.baseUrl, PREFIX, {
      videoid: vid,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(first.status, 201);

    const dup = await tusCreate(ctx.baseUrl, PREFIX, {
      videoid: vid,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dup.status, 409);
  } finally {
    await ctx.teardown();
  }
});

test("createS3Mp4Sniffer rejects non-MP4 bytes and removes the object", async () => {
  const ctx = await startApp({ withSniffer: true });
  const vid = randomUUID();
  try {
    // GIF header — deliberately not ISOBMFF.
    const fake = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(2048, 0xff)]);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      videoid: vid,
      filename: "fake.mp4",
      size: fake.length,
    });
    assert.equal(create.status, 201);
    const location = create.headers.get("location");

    const patch = await tusPatch(location, 0, fake);
    assert.ok(
      patch.status >= 400 && patch.status < 500,
      `expected 4xx, got ${patch.status}`,
    );

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(get.status, 404, "rejected upload is not served");
  } finally {
    await ctx.teardown();
  }
});

test("createS3Mp4Sniffer accepts a valid MP4 payload", async () => {
  const ctx = await startApp({ withSniffer: true });
  const vid = randomUUID();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { videoid: vid, size: 2048 });
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(get.status, 302);
  } finally {
    await ctx.teardown();
  }
});

test("DELETE removes the object; second DELETE is 404", async () => {
  const ctx = await startApp();
  const vid = randomUUID();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { videoid: vid, size: 2048 });

    const pre = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(pre.status, 302);

    const del = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { method: "DELETE" });
    assert.equal(del.status, 204);

    const post = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(post.status, 404);

    const del2 = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { method: "DELETE" });
    assert.equal(del2.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("kind=project lands under project/ and GET /project/:id 302-redirects", async () => {
  const ctx = await startApp();
  const vid = randomUUID();
  try {
    // A .pulse bundle is opaque bytes — no MP4 sniffing for projects.
    const body = Buffer.alloc(2048, 0x42);
    await uploadFull(ctx.baseUrl, PREFIX, {
      videoid: vid,
      filename: "draft.pulse",
      kind: "project",
      body,
    });

    // Video route must not serve a project artifact.
    const videoGet = await fetch(`${ctx.baseUrl}${PREFIX}/${vid}`, { redirect: "manual" });
    assert.equal(videoGet.status, 404);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/project/${vid}`, { redirect: "manual" });
    assert.equal(get.status, 302);
    const location = get.headers.get("location");
    assert.ok(location.includes(`project/${vid}.pulse`), "redirect points at project key");

    const direct = await fetch(location);
    const bytes = Buffer.from(await direct.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
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
  const vid = randomUUID();
  try {
    const { body } = await uploadFull(ctx.baseUrl, PREFIX, { videoid: vid, size: 2048 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].videoid, vid);
    assert.equal(calls[0].size, body.length);
    assert.equal(typeof calls[0].uploadId, "string");
  } finally {
    await ctx.teardown();
  }
});
