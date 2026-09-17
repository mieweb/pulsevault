// Termination cleanup + crash-debris reclaim suite.
//
// Covers the two halves of the "409-poisoned artifactId" fix:
//
//  1. TUS DELETE (termination) must sweep the adapter's `.pulsevault` sidecar,
//     not just the datastore's bytes/offset state — otherwise a cancelled
//     upload's artifactId stays reserved forever (POST_TERMINATE hook in
//     `lib/pulsevaultTus.ts`).
//  2. `reserveUpload` must tell a genuine collision (ready artifact, or an
//     in-flight upload with live datastore state) apart from crash debris (an
//     `"uploading"` sidecar with no datastore state — a kill between reserve
//     and datastore-create, or a termination handled by a pre-cleanup server)
//     and reclaim the debris instead of 409ing.
//
// Runs both storage backends: local filesystem and the in-process mock S3.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createPulseVaultCore,
  createLocalStorage,
  createS3Storage,
} from "../dist/core.js";
import { deriveDatastoreOptions } from "../dist/storage/s3.js";
import { makeMp4, tusCreate, tusPatch, uploadFull } from "./helpers.mjs";
import { startMockS3 } from "./mock-s3.mjs";

const PREFIX = "/pulsevault";
const BUCKET = "pulse-termination-test";

let mockS3;
let endpoint;

before(async () => {
  mockS3 = await startMockS3({ buckets: [BUCKET] });
  endpoint = mockS3.endpoint;
});

after(async () => {
  if (mockS3) await mockS3.close();
});

/** Poll until `check` resolves truthy or the deadline passes — the POST_TERMINATE
 * cleanup runs after the DELETE response is already on the wire, so tests must
 * wait for it rather than assert immediately. */
async function eventually(check, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function startLocalApp({ reclaimGraceMs } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-term-test-"));
  const storage = createLocalStorage({
    workspaceDir,
    ...(reclaimGraceMs !== undefined ? { reclaimGraceMs } : {}),
  });
  const core = createPulseVaultCore({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
  });
  const server = http.createServer((req, res) => {
    core.handler(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    storage,
    workspaceDir,
    baseUrl: `http://127.0.0.1:${port}`,
    sidecarPath: (id) => path.join(workspaceDir, ".pulsevault", `${id}.json`),
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve));
      await core.shutdown();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

async function startS3App({ reclaimGraceMs } = {}) {
  const storage = await createS3Storage({
    bucket: BUCKET,
    endpoint,
    region: "us-east-1",
    accessKeyId: "MOCKS3",
    secretAccessKey: "MOCKS3",
    forcePathStyle: true,
    ...(reclaimGraceMs !== undefined ? { reclaimGraceMs } : {}),
    clientConfig: {
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    },
  });
  const core = createPulseVaultCore({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
  });
  const server = http.createServer((req, res) => {
    core.handler(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    storage,
    baseUrl: `http://127.0.0.1:${port}`,
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve));
      await core.shutdown();
    },
  };
}

const fileExists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

async function tusDelete(url) {
  return fetch(url, { method: "DELETE", headers: { "Tus-Resumable": "1.0.0" } });
}

// ---------- local: termination sweeps the sidecar ----------

test("local: TUS DELETE mid-upload sweeps the sidecar and frees the artifactId", async () => {
  const ctx = await startLocalApp();
  const id = randomUUID();
  try {
    const body = makeMp4(2048);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: body.length,
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    // Half the bytes — the upload is genuinely mid-flight when cancelled.
    const patch = await tusPatch(location, 0, body.subarray(0, 1024));
    assert.equal(patch.status, 204);
    assert.ok(await fileExists(ctx.sidecarPath(id)), "sidecar exists mid-upload");

    const del = await tusDelete(location);
    assert.equal(del.status, 204);

    // POST_TERMINATE cleanup is post-response — poll for the sidecar sweep.
    await eventually(async () => !(await fileExists(ctx.sidecarPath(id))));
    assert.equal(await ctx.storage.getKind(id), null, "adapter forgot the artifact");

    // The artifactId is genuinely free again: a fresh create succeeds.
    const recreate = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: body.length,
    });
    assert.equal(recreate.status, 201, "artifactId reusable after termination");
  } finally {
    await ctx.teardown();
  }
});

test("local: TUS DELETE after completion removes bytes, sidecar, and serving", async () => {
  const ctx = await startLocalApp();
  const id = randomUUID();
  try {
    const { location } = await uploadFull(ctx.baseUrl, PREFIX, { artifactId: id, size: 1024 });

    const del = await tusDelete(location);
    assert.equal(del.status, 204);

    await eventually(async () => !(await fileExists(ctx.sidecarPath(id))));
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${id}`);
    assert.equal(get.status, 404, "terminated artifact no longer served");
  } finally {
    await ctx.teardown();
  }
});

// ---------- local: reserve reclaims debris, still 409s live state ----------

test("local: reserve reclaims an aged 'uploading' sidecar with no datastore state (crash debris)", async () => {
  const ctx = await startLocalApp({ reclaimGraceMs: 10 });
  const id = randomUUID();
  try {
    // Simulate a kill between reserveUpload and the datastore's create: the
    // sidecar lands, the datastore `.json` never does. Wait out the (test-tuned)
    // reclaim grace so the debris is old enough to reclaim.
    await ctx.storage.reserveUpload({
      artifactId: id,
      filename: "clip.mp4",
      ext: ".mp4",
      kind: "video",
    });
    assert.ok(await fileExists(ctx.sidecarPath(id)), "debris sidecar in place");
    await new Promise((r) => setTimeout(r, 40));

    const recreate = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(recreate.status, 201, "debris reclaimed instead of 409");
  } finally {
    await ctx.teardown();
  }
});

test("local: a FRESH datastore-less sidecar still 409s (concurrent create, not debris)", async () => {
  // Default grace (60s): a sidecar written milliseconds ago must conflict — it may
  // be a concurrent create that simply hasn't written its datastore state yet.
  const ctx = await startLocalApp();
  const id = randomUUID();
  try {
    await ctx.storage.reserveUpload({
      artifactId: id,
      filename: "clip.mp4",
      ext: ".mp4",
      kind: "video",
    });
    const dup = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dup.status, 409, "within-grace sidecar still conflicts");
  } finally {
    await ctx.teardown();
  }
});

test("local: reserve still 409s a genuinely in-flight upload and a ready artifact", async () => {
  const ctx = await startLocalApp();
  const inflight = randomUUID();
  const finished = randomUUID();
  try {
    // In-flight: real create (datastore `.json` exists), no DELETE.
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: inflight,
      filename: "clip.mp4",
      size: 2048,
    });
    assert.equal(create.status, 201);
    const dupInflight = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: inflight,
      filename: "clip.mp4",
      size: 2048,
    });
    assert.equal(dupInflight.status, 409, "live in-flight upload still conflicts");

    // Ready: full upload, then attempt to re-reserve.
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: finished, size: 1024 });
    const dupFinished = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: finished,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dupFinished.status, 409, "finished artifact still conflicts");
  } finally {
    await ctx.teardown();
  }
});

// ---------- S3: same invariants against the mock bucket ----------

test("s3: TUS DELETE mid-upload sweeps the sidecar object and frees the artifactId", async () => {
  const ctx = await startS3App();
  const id = randomUUID();
  try {
    const body = makeMp4(2048);
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: body.length,
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;

    const del = await tusDelete(location);
    assert.equal(del.status, 204);

    await eventually(async () => (await ctx.storage.getKind(id)) === null);

    const recreate = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: body.length,
    });
    assert.equal(recreate.status, 201, "artifactId reusable after termination");
  } finally {
    await ctx.teardown();
  }
});

test("s3: reserve reclaims aged crash debris but 409s live, fresh, and ready uploads", async () => {
  const ctx = await startS3App({ reclaimGraceMs: 10 });
  const debris = randomUUID();
  const inflight = randomUUID();
  const finished = randomUUID();
  try {
    // Debris: sidecar object only, no datastore `.info`, aged past the grace.
    await ctx.storage.reserveUpload({
      artifactId: debris,
      filename: "clip.mp4",
      ext: ".mp4",
      kind: "video",
    });
    await new Promise((r) => setTimeout(r, 40));
    const reclaimed = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: debris,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(reclaimed.status, 201, "aged debris reclaimed instead of 409");

    // Live in-flight: real create → duplicate create conflicts (has `.info`,
    // regardless of age).
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: inflight,
      filename: "clip.mp4",
      size: 2048,
    });
    assert.equal(create.status, 201);
    await new Promise((r) => setTimeout(r, 40));
    const dupInflight = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: inflight,
      filename: "clip.mp4",
      size: 2048,
    });
    assert.equal(dupInflight.status, 409, "live in-flight upload still conflicts");

    // Ready artifact conflicts.
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: finished, size: 1024 });
    const dupFinished = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: finished,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dupFinished.status, 409, "finished artifact still conflicts");
  } finally {
    await ctx.teardown();
  }
});

test("s3: a FRESH datastore-less sidecar still 409s (concurrent create, not debris)", async () => {
  const ctx = await startS3App(); // default 60s grace
  const id = randomUUID();
  try {
    await ctx.storage.reserveUpload({
      artifactId: id,
      filename: "clip.mp4",
      ext: ".mp4",
      kind: "video",
    });
    const dup = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: id,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dup.status, 409, "within-grace sidecar still conflicts");
  } finally {
    await ctx.teardown();
  }
});

// ---------- R2 datastore-option derivation ----------

test("deriveDatastoreOptions applies R2 requirements only for R2 endpoints", () => {
  // R2 endpoint → equal-part-size multipart + tagging off.
  const r2 = deriveDatastoreOptions({
    endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
  });
  assert.deepEqual(r2, {
    partSize: 8 * 1024 * 1024,
    minPartSize: 8 * 1024 * 1024,
    useTags: false,
  });

  // Explicit overrides win over the R2 defaults.
  const r2Custom = deriveDatastoreOptions({
    endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
    partSize: 16 * 1024 * 1024,
    useTags: true,
    maxMultipartParts: 1000,
  });
  assert.deepEqual(r2Custom, {
    partSize: 16 * 1024 * 1024,
    minPartSize: 16 * 1024 * 1024,
    useTags: true,
    maxMultipartParts: 1000,
  });

  // AWS (no endpoint) → no implicit options at all.
  assert.deepEqual(deriveDatastoreOptions({}), {});

  // Non-R2 custom endpoint (e.g. MinIO) → passthrough only, no R2 defaults.
  assert.deepEqual(deriveDatastoreOptions({ endpoint: "http://127.0.0.1:9000" }), {});

  // A hostname merely containing the R2 suffix as a substring must not match.
  assert.deepEqual(
    deriveDatastoreOptions({ endpoint: "https://evil-r2.cloudflarestorage.com.attacker.example" }),
    {},
  );
});
