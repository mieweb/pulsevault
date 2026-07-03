// Parity suite for the framework-agnostic core (`@mieweb/pulsevault/core`).
// Same assertions as test/plugin.test.mjs, but boots a bare `http.createServer`
// around `core.handler` instead of a Fastify instance — proves the core is
// protocol-correct on its own, independent of any host framework.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createPulseVaultCore,
  createLocalStorage,
  createMp4Sniffer,
  createChecksumValidator,
  issueCapabilityToken,
  createCapabilityAuthorize,
} from "../dist/core.js";
import {
  makeMp4,
  tusCreate as tusCreateRaw,
  tusPatch,
  tusHead,
  uploadFull,
} from "./helpers.mjs";

const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PREFIX = "/pulsevault";

const tusCreate = (baseUrl, opts) => tusCreateRaw(baseUrl, PREFIX, opts);
const uploadFullMp4 = (ctx, artifactId, size = 1024) =>
  uploadFull(ctx.baseUrl, PREFIX, { artifactId, size });
const artifactUrl = (ctx, id) => `${ctx.baseUrl}${PREFIX}/artifacts/${id}`;

async function startApp({ coreOptions = {}, withSniffer = false } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-http-test-"));
  const storage = createLocalStorage({ workspaceDir });
  const core = createPulseVaultCore({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...(withSniffer ? { validatePayload: createMp4Sniffer(storage) } : {}),
    ...coreOptions,
  });
  const server = http.createServer((req, res) => {
    core.handler(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    core,
    storage,
    baseUrl: `http://127.0.0.1:${port}`,
    workspaceDir,
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve));
      await core.shutdown();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

test("reserve + full upload flips sidecar to ready and GET streams the bytes", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1);

    const sidecar = JSON.parse(
      await fs.readFile(
        path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`),
        "utf8",
      ),
    );
    assert.equal(sidecar.status, "ready");

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("protocol-version"), "1");
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(bytes.length, body.length);
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("GET returns 404 while the upload is still in progress", async () => {
  const ctx = await startApp();
  try {
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 201);

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("HEAD + resume PATCH completes the upload", async () => {
  const ctx = await startApp();
  try {
    const body = makeMp4(4096);
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
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

    const midGet = await fetch(artifactUrl(ctx, ID1));
    assert.equal(midGet.status, 404);

    const p2 = await tusPatch(location, half, body.subarray(half));
    assert.equal(p2.status, 204);

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 200);
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("second reserve for same artifactId returns 409", async () => {
  const ctx = await startApp();
  try {
    const first = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(first.status, 201);

    const dup = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(dup.status, 409);
  } finally {
    await ctx.teardown();
  }
});

test("non-allowed extension is rejected at create", async () => {
  const ctx = await startApp();
  try {
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "evil.exe",
      size: 1024,
    });
    assert.ok(
      create.status >= 400 && create.status < 500,
      `expected 4xx, got ${create.status}`,
    );
  } finally {
    await ctx.teardown();
  }
});

test("range GET returns 206 with the requested slice", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1, 2048);

    const range = await fetch(artifactUrl(ctx, ID1), {
      headers: { Range: "bytes=0-99" },
    });
    assert.equal(range.status, 206);
    const slice = Buffer.from(await range.arrayBuffer());
    assert.equal(slice.length, 100);
    assert.equal(Buffer.compare(slice, body.subarray(0, 100)), 0);
  } finally {
    await ctx.teardown();
  }
});

test("GET of an unknown artifactId returns 404", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(artifactUrl(ctx, ID1));
    assert.equal(res.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("OPTIONS /upload (tus preflight) is handled, not 404", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.baseUrl}${PREFIX}/upload`, {
      method: "OPTIONS",
      headers: { "Tus-Resumable": "1.0.0" },
    });
    assert.notEqual(res.status, 404);
    assert.equal(res.headers.get("tus-version"), "1.0.0");
  } finally {
    await ctx.teardown();
  }
});

test("trailing slash on /upload/ still routes to the tus handler", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.baseUrl}${PREFIX}/upload/`, {
      method: "OPTIONS",
      headers: { "Tus-Resumable": "1.0.0" },
    });
    assert.notEqual(res.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("authorize rejection blocks create, GET, and DELETE", async () => {
  const ctx = await startApp({
    coreOptions: {
      authorize: async (_req, { phase }) => {
        throw Object.assign(new Error(`no ${phase}`), { statusCode: 403 });
      },
    },
  });
  try {
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 403);

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 403);

    const del = await fetch(artifactUrl(ctx, ID1), { method: "DELETE" });
    assert.equal(del.status, 403);
  } finally {
    await ctx.teardown();
  }
});

test("DELETE removes the artifact; second DELETE is 404", async () => {
  const ctx = await startApp();
  try {
    await uploadFullMp4(ctx, ID1);

    const preGet = await fetch(artifactUrl(ctx, ID1));
    assert.equal(preGet.status, 200);

    const del = await fetch(artifactUrl(ctx, ID1), { method: "DELETE" });
    assert.equal(del.status, 204);

    const postGet = await fetch(artifactUrl(ctx, ID1));
    assert.equal(postGet.status, 404);

    const del2 = await fetch(artifactUrl(ctx, ID1), { method: "DELETE" });
    assert.equal(del2.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("createMp4Sniffer rejects non-MP4 bytes and removes the artifact", async () => {
  const ctx = await startApp({ withSniffer: true });
  try {
    const fake = Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.alloc(1024, 0xff),
    ]);
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
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

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("onUploadComplete fires exactly once with the right ctx", async () => {
  const calls = [];
  const ctx = await startApp({
    coreOptions: {
      onUploadComplete: async (_req, info) => {
        calls.push(info);
      },
    },
  });
  try {
    const { body } = await uploadFullMp4(ctx, ID1);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].artifactId, ID1);
    assert.equal(calls[0].kind, "video");
    assert.equal(calls[0].size, body.length);
  } finally {
    await ctx.teardown();
  }
});

test("GET /capabilities is unauthenticated and reports the configured uploadUnit", async () => {
  const authorizeCalls = [];
  const ctx = await startApp({
    coreOptions: {
      uploadUnit: "merged",
      authorize: async (_req, ctx) => {
        authorizeCalls.push(ctx.phase);
      },
    },
  });
  try {
    const res = await fetch(`${ctx.baseUrl}${PREFIX}/capabilities`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.uploadUnit, "merged");
    assert.deepEqual(body.kinds.sort(), ["captions", "project", "video"]);
    assert.equal(body.maxUploadSize, 10 * 1024 * 1024);
    assert.ok(Array.isArray(body.checksum.algorithms));
    assert.equal(authorizeCalls.length, 0, "capabilities must not run authorize");
  } finally {
    await ctx.teardown();
  }
});

test("checksum validator accepts a matching digest and rejects a mismatched one", async () => {
  const ctx = await startApp({
    coreOptions: { validatePayload: createChecksumValidator() },
  });
  try {
    const body = makeMp4(1024);
    const digest = createHash("sha256").update(body).digest("hex");

    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: ID1,
      body,
      checksum: `sha256:${digest}`,
    });
    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 200, "matching checksum is accepted");

    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID2,
      filename: "clip.mp4",
      size: body.length,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    const location = create.headers.get("location");
    const patch = await tusPatch(location, 0, body);
    assert.equal(patch.status, 422, "mismatched checksum is rejected");
  } finally {
    await ctx.teardown();
  }
});

test("createCapabilityAuthorize: valid token authorizes its own artifact and a related one, rejects others", async () => {
  const secret = "test-secret";
  const issuer = "https://vault.example.test";
  const lookupSecret = (kid) => (kid === "k1" ? secret : null);
  const ctx = await startApp({
    coreOptions: {
      authorize: createCapabilityAuthorize(lookupSecret, { issuer }),
    },
  });
  try {
    const token = issueCapabilityToken(ID1, secret, { keyId: "k1", issuer });

    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: ID1,
      headers: { Authorization: `Bearer ${token}` },
    });
    const get1 = await fetch(artifactUrl(ctx, ID1), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(get1.status, 200);

    const captionsCreate = await tusCreateRaw(ctx.baseUrl, PREFIX, {
      artifactId: ID2,
      filename: "clip.vtt",
      size: 10,
      kind: "captions",
      relatedTo: ID1,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(captionsCreate.status, 201, "related artifact authorized by the session token");

    const unrelatedToken = issueCapabilityToken(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      secret,
      { keyId: "k1", issuer },
    );
    const rejected = await tusCreateRaw(ctx.baseUrl, PREFIX, {
      artifactId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      filename: "clip.mp4",
      size: 1024,
      headers: { Authorization: `Bearer ${unrelatedToken}` },
    });
    assert.equal(rejected.status, 403);
  } finally {
    await ctx.teardown();
  }
});

test("old root-level paths return 404", async () => {
  const ctx = await startApp();
  try {
    const uploadRoot = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": "1024",
        "Upload-Metadata": `artifactId ${Buffer.from(ID1).toString("base64")}`,
      },
    });
    assert.equal(uploadRoot.status, 404);

    const getRoot = await fetch(`${ctx.baseUrl}/artifacts/${ID1}`);
    assert.equal(getRoot.status, 404);
  } finally {
    await ctx.teardown();
  }
});
