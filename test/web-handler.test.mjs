// Web-standard (Request → Response) core suite: drives
// `createPulseVaultWebHandler().handler` with WHATWG Requests directly — no
// HTTP server, no framework — proving the fetch-native surface is
// protocol-correct on Bun/Deno/edge-shaped runtimes. Mirrors the key
// assertions of http-adapter.test.mjs plus the Range/HEAD serving this
// surface implements itself (the Node core delegates that to @fastify/send).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPulseVaultWebHandler } from '../dist/web.js';
import {
  createLocalStorage,
  issueCapabilityToken,
  createCapabilityAuthorize,
} from '../dist/core.js';
import { makeMp4, b64 } from './helpers.mjs';

const PREFIX = '/pulsevault';
const BASE = 'http://vault.test';

async function startWebApp({ options = {} } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-web-test-'));
  const storage = createLocalStorage({ workspaceDir });
  await storage.initialize?.();
  const vault = createPulseVaultWebHandler({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...options,
  });
  return {
    vault,
    storage,
    workspaceDir,
    teardown: async () => {
      await vault.shutdown();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

function createRequest({ artifactId, filename = 'clip.mp4', size, kind, token }) {
  const parts = [`artifactId ${b64(artifactId)}`, `filename ${b64(filename)}`];
  if (kind) parts.push(`kind ${b64(kind)}`);
  return new Request(`${BASE}${PREFIX}/upload`, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': parts.join(','),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** Create + single-PATCH a full upload through the web handler; returns the resource URL. */
async function uploadFullWeb(vault, { artifactId, body, token }) {
  const create = await vault.handler(createRequest({ artifactId, size: body.length, token }));
  assert.equal(create.status, 201, 'create');
  const location = new URL(create.headers.get('location'), `${BASE}${PREFIX}/upload`).href;
  const patch = await vault.handler(
    new Request(location, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    }),
  );
  assert.equal(patch.status, 204, 'patch');
  return location;
}

const artifactUrl = (id, token) =>
  `${BASE}${PREFIX}/artifacts/${id}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

test('web: full tus upload → GET streams the exact bytes with Protocol-Version', async () => {
  const ctx = await startWebApp();
  const id = randomUUID();
  try {
    const body = makeMp4(4096);
    await uploadFullWeb(ctx.vault, { artifactId: id, body });

    const get = await ctx.vault.handler(new Request(artifactUrl(id)));
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('protocol-version'), '1');
    assert.equal(get.headers.get('content-type'), 'video/mp4');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(get.headers.get('accept-ranges'), 'bytes');
    assert.equal(Number(get.headers.get('content-length')), body.length);
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test('web: GET is 404 while the upload is still in progress', async () => {
  const ctx = await startWebApp();
  const id = randomUUID();
  try {
    const create = await ctx.vault.handler(createRequest({ artifactId: id, size: 2048 }));
    assert.equal(create.status, 201);
    const get = await ctx.vault.handler(new Request(artifactUrl(id)));
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test('web: Range requests — 206 bounded/suffix/open, 416 unsatisfiable, HEAD headers', async () => {
  const ctx = await startWebApp();
  const id = randomUUID();
  try {
    const body = makeMp4(1000);
    await uploadFullWeb(ctx.vault, { artifactId: id, body });
    const url = artifactUrl(id);
    const range = (header) => ctx.vault.handler(new Request(url, { headers: { range: header } }));

    const bounded = await range('bytes=0-99');
    assert.equal(bounded.status, 206);
    assert.equal(bounded.headers.get('content-range'), `bytes 0-99/1000`);
    assert.equal(Number(bounded.headers.get('content-length')), 100);
    assert.equal(
      Buffer.compare(Buffer.from(await bounded.arrayBuffer()), body.subarray(0, 100)),
      0,
    );

    const suffix = await range('bytes=-100');
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), `bytes 900-999/1000`);
    assert.equal(Buffer.compare(Buffer.from(await suffix.arrayBuffer()), body.subarray(900)), 0);

    const open = await range('bytes=950-');
    assert.equal(open.status, 206);
    assert.equal(open.headers.get('content-range'), `bytes 950-999/1000`);

    const unsatisfiable = await range('bytes=5000-6000');
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */1000');

    // Disjoint multi-range: this handler serves single ranges only — answering
    // 206 with just the first range would silently drop the rest, so it must
    // ignore the header and serve the full body with 200.
    const multi = await range('bytes=0-9,20-29');
    assert.equal(multi.status, 200);
    assert.equal(multi.headers.get('content-range'), null);
    assert.equal((await multi.arrayBuffer()).byteLength, 1000);

    // Malformed range header degrades to a full 200, per RFC 9110 (ignore).
    const malformed = await range('bytes=nonsense');
    assert.equal(malformed.status, 200);

    const head = await ctx.vault.handler(new Request(url, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), 1000);
    assert.equal(await head.text(), '');
  } finally {
    await ctx.teardown();
  }
});

test('web: capabilities payload — no directUpload for local storage', async () => {
  const ctx = await startWebApp();
  try {
    const res = await ctx.vault.handler(new Request(`${BASE}${PREFIX}/capabilities`));
    assert.equal(res.status, 200);
    const caps = await res.json();
    assert.equal(caps.protocolVersion, 1);
    assert.deepEqual(caps.kinds, ['video', 'project', 'captions', 'thumbnail']);
    assert.equal(caps.directUpload, undefined, 'local storage cannot presign');
  } finally {
    await ctx.teardown();
  }
});

test('web: direct-uploads JSON body is capped at 64 KiB (413, not a memory buffer)', async () => {
  const ctx = await startWebApp();
  try {
    // Declared oversize: rejected from the Content-Length header alone.
    const declared = await ctx.vault.handler(
      new Request(`${BASE}${PREFIX}/direct-uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) },
        body: 'x', // body irrelevant — the declared length trips first
      }),
    );
    assert.equal(declared.status, 413);

    // Undeclared oversize (chunked-style): capped while buffering.
    const big = `{"artifactId":"${'a'.repeat(80 * 1024)}"}`;
    const streamed = await ctx.vault.handler(
      new Request(`${BASE}${PREFIX}/direct-uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
        duplex: 'half',
      }),
    );
    assert.equal(streamed.status, 413);
  } finally {
    await ctx.teardown();
  }
});

test('web: DELETE artifact removes it; unmatched prefix and unknown routes 404', async () => {
  const ctx = await startWebApp();
  const id = randomUUID();
  try {
    const body = makeMp4(1024);
    await uploadFullWeb(ctx.vault, { artifactId: id, body });

    const del = await ctx.vault.handler(new Request(artifactUrl(id), { method: 'DELETE' }));
    assert.equal(del.status, 204);
    const get = await ctx.vault.handler(new Request(artifactUrl(id)));
    assert.equal(get.status, 404);

    const outside = await ctx.vault.handler(new Request(`${BASE}/other/thing`));
    assert.equal(outside.status, 404);
    const unknown = await ctx.vault.handler(new Request(`${BASE}${PREFIX}/nope`));
    assert.equal(unknown.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test('web: capability-token authorize — wrong token rejected on create, watch token honored on GET', async () => {
  const SECRET = 'web-secret';
  const ISSUER = 'https://vault.test';
  const ctx = await startWebApp({
    options: {
      authorize: createCapabilityAuthorize((kid) => (kid === 'k1' ? SECRET : null), {
        issuer: ISSUER,
      }),
    },
  });
  const id = randomUUID();
  const other = randomUUID();
  try {
    const token = issueCapabilityToken(id, SECRET, { keyId: 'k1', issuer: ISSUER });
    const wrongToken = issueCapabilityToken(other, SECRET, { keyId: 'k1', issuer: ISSUER });

    const rejected = await ctx.vault.handler(
      createRequest({ artifactId: id, size: 1024, token: wrongToken }),
    );
    assert.equal(rejected.status, 403, 'token for a different artifact is rejected');

    const body = makeMp4(1024);
    await uploadFullWeb(ctx.vault, { artifactId: id, body, token });

    const noToken = await ctx.vault.handler(new Request(artifactUrl(id)));
    assert.equal(noToken.status, 401, 'watch without token rejected');
    const withToken = await ctx.vault.handler(new Request(artifactUrl(id, token)));
    assert.equal(withToken.status, 200, 'watch with ?token= succeeds');
  } finally {
    await ctx.teardown();
  }
});

test('web: a zero-byte artifact serves an empty 200 (and 416s an unsatisfiable range)', async () => {
  const ctx = await startWebApp();
  const id = randomUUID();
  try {
    // A zero-length upload is valid TUS; materialize its end state directly
    // through the storage contract (reserve → empty bytes → ready).
    const rel = await ctx.storage.reserveUpload({
      artifactId: id,
      kind: 'video',
      ext: '.mp4',
      filename: 'empty.mp4',
    });
    await fs.writeFile(path.join(ctx.workspaceDir, rel), Buffer.alloc(0));
    await ctx.storage.markReady(id);

    // GET: an empty 200, not a stream error (fs.createReadStream rejects end:-1).
    const get = await ctx.vault.handler(new Request(artifactUrl(id)));
    assert.equal(get.status, 200);
    assert.equal(Number(get.headers.get('content-length')), 0);
    assert.equal((await get.arrayBuffer()).byteLength, 0);

    // HEAD agrees.
    const head = await ctx.vault.handler(new Request(artifactUrl(id), { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), 0);

    // No byte satisfies any range of an empty file — RFC 9110 §14.4.
    const range = await ctx.vault.handler(
      new Request(artifactUrl(id), { headers: { range: 'bytes=0-' } }),
    );
    assert.equal(range.status, 416);
    assert.equal(range.headers.get('content-range'), 'bytes */0');
  } finally {
    await ctx.teardown();
  }
});
