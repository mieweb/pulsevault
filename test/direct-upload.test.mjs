// Direct-upload profile suite (PROTOCOL.md §9): reserve → presigned PUT
// straight to the (mock) bucket → complete → serve. Runs the Node core over
// real HTTP, the web core via Request objects, and the Fastify adapter's
// data-level delegation — all against mock-s3, so the presigned URL is
// genuinely PUT to and the stored object genuinely HEAD-verified.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pulseVaultPlugin from '../dist/fastify.js';
import {
  createPulseVaultCore,
  createS3Storage,
  createLocalStorage,
  createS3Mp4Sniffer,
  issueCapabilityToken,
  createCapabilityAuthorize,
} from '../dist/core.js';
import { createPulseVaultWebHandler } from '../dist/web.js';
import { makeMp4, serveCore } from './helpers.mjs';
import { startMockS3 } from './mock-s3.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PREFIX = '/pulsevault';
const BUCKET = 'pulse-direct-test';

let mockS3;
let endpoint;

before(async () => {
  mockS3 = await startMockS3({ buckets: [BUCKET] });
  endpoint = mockS3.endpoint;
});

after(async () => {
  if (mockS3) await mockS3.close();
});

async function makeS3Storage(extra = {}) {
  return createS3Storage({
    bucket: BUCKET,
    endpoint,
    region: 'us-east-1',
    accessKeyId: 'MOCKS3',
    secretAccessKey: 'MOCKS3',
    forcePathStyle: true,
    clientConfig: {
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    },
    ...extra,
  });
}

async function startNodeApp({ coreOptions = {} } = {}) {
  const storage = await makeS3Storage();
  const core = createPulseVaultCore({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...coreOptions,
  });
  const { baseUrl, close } = await serveCore(core);
  return {
    storage,
    baseUrl,
    teardown: async () => {
      await close();
      await core.shutdown();
    },
  };
}

const createDirect = (baseUrl, body, headers = {}) =>
  fetch(`${baseUrl}${PREFIX}/direct-uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const completeDirect = (baseUrl, artifactId, headers = {}) =>
  fetch(`${baseUrl}${PREFIX}/direct-uploads/${artifactId}/complete`, {
    method: 'POST',
    headers,
  });

test('direct: a TUS reservation never crosses into the direct profile (create 409s, complete 409s)', async () => {
  const ctx = await startNodeApp();
  const id = randomUUID();
  const body = makeMp4(4096);
  try {
    // Reserve via TUS — the sidecar has no expectedSize.
    const tusCreate = await fetch(`${ctx.baseUrl}${PREFIX}/upload`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(body.length),
        'Upload-Metadata': `artifactId ${Buffer.from(id).toString('base64')},filename ${Buffer.from('clip.mp4').toString('base64')}`,
      },
    });
    assert.equal(tusCreate.status, 201);

    // A direct create for the same id must NOT re-grant a presigned PUT over
    // the incomplete TUS reservation — same size or not.
    const cross = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      kind: 'video',
      size: body.length,
    });
    assert.equal(cross.status, 409);

    // And a direct complete must refuse the TUS reservation instead of
    // head-checking/finalizing it around the tus datastore.
    const crossComplete = await completeDirect(ctx.baseUrl, id);
    assert.equal(crossComplete.status, 409);
    const bodyText = await crossComplete.text();
    assert.match(bodyText, /TUS/i);
  } finally {
    await ctx.teardown();
  }
});

test('direct: concurrent completes finalize exactly once (idempotency under a retry race)', async () => {
  let completions = 0;
  const ctx = await startNodeApp({
    coreOptions: {
      onUploadComplete: async () => {
        completions += 1;
        // Widen the race window: both requests must observe pre-ready state
        // for the bug this guards against to fire.
        await new Promise((r) => setTimeout(r, 50));
      },
    },
  });
  const id = randomUUID();
  const body = makeMp4(4096);
  try {
    const grant = await (
      await createDirect(ctx.baseUrl, {
        artifactId: id,
        filename: 'clip.mp4',
        kind: 'video',
        size: body.length,
      })
    ).json();
    const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.headers, body });
    assert.equal(put.status, 200);

    const [a, b] = await Promise.all([
      completeDirect(ctx.baseUrl, id),
      completeDirect(ctx.baseUrl, id),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(completions, 1, 'onUploadComplete must fire exactly once');
  } finally {
    await ctx.teardown();
  }
});

test('direct: reserve → PUT to presigned URL → complete → GET serves the bytes', async () => {
  const ctx = await startNodeApp();
  const id = randomUUID();
  const body = makeMp4(4096);
  try {
    // Capabilities advertise the profile for direct-capable storage.
    const caps = await (await fetch(`${ctx.baseUrl}${PREFIX}/capabilities`)).json();
    assert.deepEqual(caps.directUpload, { enabled: true });

    const created = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      kind: 'video',
      size: body.length,
    });
    assert.equal(created.status, 201);
    const grant = await created.json();
    assert.equal(grant.ok, true);
    assert.ok(grant.uploadUrl.includes(BUCKET), 'URL points at the bucket');
    assert.equal(grant.headers['Content-Type'], 'video/mp4');

    // Completing before the PUT is a 409 — nothing stored yet.
    const early = await completeDirect(ctx.baseUrl, id);
    assert.equal(early.status, 409);

    const put = await fetch(grant.uploadUrl, {
      method: 'PUT',
      headers: grant.headers,
      body,
    });
    assert.equal(put.status, 200, 'presigned PUT stored the object');

    const done = await completeDirect(ctx.baseUrl, id);
    assert.equal(done.status, 200);

    // Idempotent: retrying a complete whose response was lost is safe.
    const again = await completeDirect(ctx.baseUrl, id);
    assert.equal(again.status, 200);

    // Duplicate create for the same artifactId conflicts, same as TUS.
    const dup = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(dup.status, 409);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${id}`, { redirect: 'manual' });
    assert.equal(get.status, 302);
    const direct = await fetch(get.headers.get('location'));
    assert.equal(direct.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await direct.arrayBuffer()), body), 0);
  } finally {
    await ctx.teardown();
  }
});

test('direct: re-creating an incomplete upload re-grants a fresh URL (200), mismatched shape 409s', async () => {
  const ctx = await startNodeApp();
  const id = randomUUID();
  const body = makeMp4(2048);
  try {
    const created = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(created.status, 201);

    // Same shape again — the app-kill / expired-grant retry — gets a fresh
    // grant with 200, not a dead-end 409.
    const regrant = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(regrant.status, 200);
    const grant2 = await regrant.json();
    assert.ok(grant2.uploadUrl, 'fresh grant returned');

    // A different declared size is a different upload — genuine conflict.
    const mismatched = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length + 5,
    });
    assert.equal(mismatched.status, 409);

    // The re-granted URL works end to end.
    await fetch(grant2.uploadUrl, { method: 'PUT', headers: grant2.headers, body });
    const done = await completeDirect(ctx.baseUrl, id);
    assert.equal(done.status, 200);
  } finally {
    await ctx.teardown();
  }
});

test('direct: size mismatch on complete is 422, wipes the upload, and spends the artifactId', async () => {
  const ctx = await startNodeApp();
  const id = randomUUID();
  const body = makeMp4(4096);
  try {
    const created = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length + 1000, // declares more than will be uploaded
    });
    assert.equal(created.status, 201);
    const grant = await created.json();
    // PUT different bytes than declared (mock doesn't enforce signed length —
    // exactly the case complete() must catch server-side).
    const put = await fetch(grant.uploadUrl, { method: 'PUT', body });
    assert.equal(put.status, 200);

    const done = await completeDirect(ctx.baseUrl, id);
    assert.equal(done.status, 422);

    // Fail-closed cleanup: nothing is served, and the id is spent — the
    // client mints a fresh one rather than retrying under it.
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${id}`, { redirect: 'manual' });
    assert.equal(get.status, 404);
    const recreate = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(recreate.status, 409, 'artifactId stays spent after mismatch cleanup');
    const fresh = await createDirect(ctx.baseUrl, {
      artifactId: randomUUID(),
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(fresh.status, 201);
  } finally {
    await ctx.teardown();
  }
});

test('direct: validatePayload (S3 mp4 sniffer) rejects non-MP4 bytes at complete', async () => {
  const storage = await makeS3Storage();
  const core = createPulseVaultCore({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    validatePayload: createS3Mp4Sniffer(storage),
  });
  const { baseUrl, close } = await serveCore(core);
  const id = randomUUID();
  const junk = Buffer.alloc(2048, 0x42); // right size, not an MP4
  try {
    const created = await createDirect(baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: junk.length,
    });
    assert.equal(created.status, 201);
    const grant = await created.json();
    await fetch(grant.uploadUrl, { method: 'PUT', body: junk });

    const done = await completeDirect(baseUrl, id);
    assert.equal(done.status, 422);
    const err = await done.json();
    assert.match(err.error, /not a valid MP4/);
  } finally {
    await close();
    await core.shutdown();
  }
});

test('direct: request validation — bad body, bad extension, oversize, unknown complete', async () => {
  const ctx = await startNodeApp();
  try {
    const badBody = await fetch(`${ctx.baseUrl}${PREFIX}/direct-uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(badBody.status, 400);

    const badExt = await createDirect(ctx.baseUrl, {
      artifactId: randomUUID(),
      filename: 'clip.exe',
      size: 100,
    });
    assert.equal(badExt.status, 400);

    const oversize = await createDirect(ctx.baseUrl, {
      artifactId: randomUUID(),
      filename: 'clip.mp4',
      size: 100 * 1024 * 1024 * 1024,
    });
    assert.equal(oversize.status, 413);

    const unknown = await completeDirect(ctx.baseUrl, randomUUID());
    assert.equal(unknown.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test('direct: capability tokens gate create and complete', async () => {
  const SECRET = 'direct-secret';
  const ISSUER = 'https://vault.test';
  const ctx = await startNodeApp({
    coreOptions: {
      authorize: createCapabilityAuthorize((kid) => (kid === 'k1' ? SECRET : null), {
        issuer: ISSUER,
      }),
    },
  });
  const id = randomUUID();
  const body = makeMp4(2048);
  const token = issueCapabilityToken(id, SECRET, { keyId: 'k1', issuer: ISSUER });
  const otherToken = issueCapabilityToken(randomUUID(), SECRET, { keyId: 'k1', issuer: ISSUER });
  try {
    const noToken = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(noToken.status, 401);

    const wrongToken = await createDirect(
      ctx.baseUrl,
      { artifactId: id, filename: 'clip.mp4', size: body.length },
      { authorization: `Bearer ${otherToken}` },
    );
    assert.equal(wrongToken.status, 403);

    const created = await createDirect(
      ctx.baseUrl,
      { artifactId: id, filename: 'clip.mp4', size: body.length },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(created.status, 201);
    const grant = await created.json();
    await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.headers, body });

    const wrongComplete = await completeDirect(ctx.baseUrl, id, {
      authorization: `Bearer ${otherToken}`,
    });
    assert.equal(wrongComplete.status, 403);

    const done = await completeDirect(ctx.baseUrl, id, { authorization: `Bearer ${token}` });
    assert.equal(done.status, 200);
  } finally {
    await ctx.teardown();
  }
});

test('direct: local-filesystem storage answers 501 and does not advertise the profile', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-direct-local-'));
  const storage = createLocalStorage({ workspaceDir });
  const core = createPulseVaultCore({ basePath: PREFIX, storage, maxUploadSize: 1e7 });
  const { baseUrl, close } = await serveCore(core);
  try {
    const caps = await (await fetch(`${baseUrl}${PREFIX}/capabilities`)).json();
    assert.equal(caps.directUpload, undefined);
    const created = await createDirect(baseUrl, {
      artifactId: randomUUID(),
      filename: 'clip.mp4',
      size: 100,
    });
    assert.equal(created.status, 501);
  } finally {
    await close();
    await core.shutdown();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('direct: web core serves the same profile from Request objects', async () => {
  const storage = await makeS3Storage();
  const vault = createPulseVaultWebHandler({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
  });
  const id = randomUUID();
  const body = makeMp4(2048);
  const BASE = 'http://vault.test';
  try {
    const created = await vault.handler(
      new Request(`${BASE}${PREFIX}/direct-uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId: id, filename: 'clip.mp4', size: body.length }),
      }),
    );
    assert.equal(created.status, 201);
    const grant = await created.json();
    // The presigned URL targets the real (mock) bucket — PUT with global fetch.
    const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.headers, body });
    assert.equal(put.status, 200);

    const done = await vault.handler(
      new Request(`${BASE}${PREFIX}/direct-uploads/${id}/complete`, { method: 'POST' }),
    );
    assert.equal(done.status, 200);

    const get = await vault.handler(
      new Request(`${BASE}${PREFIX}/artifacts/${id}`, { redirect: 'manual' }),
    );
    assert.equal(get.status, 302, 'S3-backed playback is a presigned redirect');
  } finally {
    await vault.shutdown();
  }
});

test('direct: fastify adapter delegates the routes (parsed-body path)', async () => {
  const storage = await makeS3Storage();
  const app = Fastify({ logger: false });
  await app.register(pulseVaultPlugin, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const id = randomUUID();
  const body = makeMp4(2048);
  try {
    const created = await createDirect(baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('protocol-version'), '1');
    const grant = await created.json();
    await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.headers, body });
    const done = await completeDirect(baseUrl, id);
    assert.equal(done.status, 200);
  } finally {
    await app.close();
  }
});

test('direct: a grant that outlives its deleted reservation can never publish anything', async () => {
  const ctx = await startNodeApp();
  const id = randomUUID();
  const staleBytes = makeMp4(4096);
  try {
    const first = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: staleBytes.length,
    });
    assert.equal(first.status, 201);
    const staleGrant = await first.json();

    // The reservation is torn down (client gave up / operator DELETE). A
    // presigned URL cannot be revoked — but the id is tombstoned, so nothing
    // can ever reserve it again and nothing will ever serve it.
    const del = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const again = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: staleBytes.length,
    });
    assert.equal(again.status, 409, 'deleted id stays spent');

    // The old (still unexpired) URL fires anyway and lands its bytes …
    const stalePut = await fetch(staleGrant.uploadUrl, {
      method: 'PUT',
      headers: staleGrant.headers,
      body: staleBytes,
    });
    assert.equal(stalePut.status, 200);

    // … which are orphaned: complete has no reservation to confirm, and the
    // artifact is never served. Bucket lifecycle rules clean the object.
    assert.equal((await completeDirect(ctx.baseUrl, id)).status, 404);
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${id}`, { redirect: 'manual' });
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test('direct: re-grant reads storage truth, not this instance\u2019s cache (cross-instance ready)', async () => {
  // Two server instances sharing one bucket — the deployment shape the
  // per-process metadata cache must never make decisions against.
  const a = await startNodeApp();
  const b = await startNodeApp();
  const id = randomUUID();
  const body = makeMp4(2048);
  try {
    // Instance B takes the reservation (B's cache: "uploading").
    const created = await createDirect(b.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(created.status, 201);
    const grant = await created.json();
    const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.headers, body });
    assert.equal(put.status, 200);

    // Instance A completes it — the bucket sidecar flips to ready, but B's
    // in-memory cache still says "uploading".
    const done = await completeDirect(a.baseUrl, id);
    assert.equal(done.status, 200);

    // A same-shape create on B must NOT re-grant a PUT over the finished,
    // validated object off its stale cache — storage truth says ready → 409.
    const regrant = await createDirect(b.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(regrant.status, 409);
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

test('direct: re-grant requires the SAME session anchor, not just the same shape', async () => {
  const ctx = await startNodeApp();
  const id = randomUUID();
  const anchorA = randomUUID();
  const anchorB = randomUUID();
  const body = makeMp4(2048);
  try {
    const created = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
      relatedTo: anchorA,
    });
    assert.equal(created.status, 201);

    // Same shape, DIFFERENT anchor — the relation is part of the reservation's
    // identity; handing this a fresh grant would let a token scoped to anchor B
    // take over anchor A's incomplete reservation.
    const crossAnchor = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
      relatedTo: anchorB,
    });
    assert.equal(crossAnchor.status, 409);

    // No anchor at all is a different identity too.
    const noAnchor = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
    });
    assert.equal(noAnchor.status, 409);

    // The true owner still re-grants.
    const regrant = await createDirect(ctx.baseUrl, {
      artifactId: id,
      filename: 'clip.mp4',
      size: body.length,
      relatedTo: anchorA,
    });
    assert.equal(regrant.status, 200);
  } finally {
    await ctx.teardown();
  }
});
