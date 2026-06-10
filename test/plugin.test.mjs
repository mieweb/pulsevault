// Smoke suite for @mieweb/pulsevault. Runs against the built `dist/` so a
// consumer exercising the public exports would see the same surface. Each
// test spins up a fresh Fastify instance on a random port with a tmpdir
// workspace and tears it all down in `finally` — no shared state.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
} from "../dist/app.js";

// Reusable UUIDs. Each test uses its own workspace, so collisions across
// tests are impossible — these just need to be valid UUIDs.
const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// All plugin-owned routes are mounted under this prefix.
const PREFIX = "/pulsevault";

// ---------- helpers ----------

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

// Minimal ISOBMFF header: "ftyp" box with brand "isom". Enough bytes for
// `sniffMp4` to accept and for realistic-looking upload sizes.
const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // box size + "ftyp"
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // brand "isom" + version
]);

function makeMp4(size) {
  if (size < MP4_HEADER.length) {
    throw new Error(`makeMp4: size ${size} < header ${MP4_HEADER.length}`);
  }
  const body = Buffer.alloc(size);
  MP4_HEADER.copy(body, 0);
  for (let i = MP4_HEADER.length; i < body.length; i++) {
    body[i] = i & 0xff;
  }
  return body;
}

async function startApp({ pluginOptions = {}, withSniffer = false } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-test-"));
  const storage = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...(withSniffer ? { validatePayload: createMp4Sniffer(storage) } : {}),
    ...pluginOptions,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    storage,
    baseUrl,
    workspaceDir,
    teardown: async () => {
      await app.close();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

async function tusCreate(baseUrl, { videoid, filename, size }) {
  const metadata = [
    `videoid ${b64(videoid)}`,
    `filename ${b64(filename)}`,
  ].join(",");
  return fetch(`${baseUrl}${PREFIX}/upload`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": metadata,
    },
  });
}

async function tusPatch(url, offset, body) {
  return fetch(url, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(offset),
      "Content-Type": "application/offset+octet-stream",
    },
    body,
  });
}

async function tusHead(url) {
  return fetch(url, {
    method: "HEAD",
    headers: { "Tus-Resumable": "1.0.0" },
  });
}

async function uploadFullMp4(ctx, videoid, size = 1024) {
  const body = makeMp4(size);
  const create = await tusCreate(ctx.baseUrl, {
    videoid,
    filename: "clip.mp4",
    size: body.length,
  });
  assert.equal(create.status, 201, "create");
  const location = create.headers.get("location");
  assert.ok(location, "location header");
  const patch = await tusPatch(location, 0, body);
  assert.equal(patch.status, 204, "patch");
  return { body, location };
}

// ---------- tests ----------

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
    assert.equal(sidecar.ext, ".mp4");
    assert.equal(sidecar.version, 1);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(get.status, 200);
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
    // Create but never PATCH — file exists at 0 bytes, sidecar is "uploading".
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 201);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
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
      videoid: ID1,
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

    // Before the final PATCH, GET must still be 404.
    const midGet = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(midGet.status, 404);

    const p2 = await tusPatch(location, half, body.subarray(half));
    assert.equal(p2.status, 204);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(get.status, 200);
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("second reserve for same videoid returns 409", async () => {
  const ctx = await startApp();
  try {
    const first = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(first.status, 201);

    const dup = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
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
      videoid: ID1,
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

    const range = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`, {
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

test("GET of an unknown videoid returns 404", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(res.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("authorize rejection blocks create, GET, and DELETE", async () => {
  const ctx = await startApp({
    pluginOptions: {
      authorize: async (_req, { phase }) => {
        throw Object.assign(new Error(`no ${phase}`), { statusCode: 403 });
      },
    },
  });
  try {
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 403);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(get.status, 403);

    const del = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`, { method: "DELETE" });
    assert.equal(del.status, 403);
  } finally {
    await ctx.teardown();
  }
});

test("DELETE removes the video; second DELETE is 404", async () => {
  const ctx = await startApp();
  try {
    await uploadFullMp4(ctx, ID1);

    const preGet = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(preGet.status, 200);

    const del = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`, { method: "DELETE" });
    assert.equal(del.status, 204);

    const sidecarStat = await fs
      .stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`))
      .catch(() => null);
    assert.equal(sidecarStat, null);

    const postGet = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(postGet.status, 404);

    const del2 = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`, { method: "DELETE" });
    assert.equal(del2.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("createMp4Sniffer rejects non-MP4 bytes and removes the video", async () => {
  const ctx = await startApp({ withSniffer: true });
  try {
    // GIF header — deliberately not ISOBMFF.
    const fake = Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.alloc(1024, 0xff),
    ]);
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
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

    const sidecarStat = await fs
      .stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`))
      .catch(() => null);
    assert.equal(sidecarStat, null, "sidecar should be removed");

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("createMp4Sniffer accepts a valid MP4 payload", async () => {
  const ctx = await startApp({ withSniffer: true });
  try {
    await uploadFullMp4(ctx, ID2, 2048);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID2}`);
    assert.equal(get.status, 200);
  } finally {
    await ctx.teardown();
  }
});

test("onUploadComplete fires exactly once with the right ctx", async () => {
  const calls = [];
  const ctx = await startApp({
    pluginOptions: {
      onUploadComplete: async (_req, info) => {
        calls.push(info);
      },
    },
  });
  try {
    const { body } = await uploadFullMp4(ctx, ID1);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].videoid, ID1);
    assert.equal(calls[0].size, body.length);
    assert.equal(typeof calls[0].uploadId, "string");
  } finally {
    await ctx.teardown();
  }
});

test("malformed sidecar is treated as absent; reserve rewrites it", async () => {
  const ctx = await startApp();
  try {
    await fs.mkdir(path.join(ctx.workspaceDir, ".pulsevault"), { recursive: true });
    await fs.writeFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), "not json");

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(get.status, 404);

    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 201);
  } finally {
    await ctx.teardown();
  }
});

test("old root-level plugin paths return 404", async () => {
  const ctx = await startApp();
  try {
    // POST /upload (root) must not exist — plugin is mounted at /pulsevault.
    const uploadRoot = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": "1024",
        "Upload-Metadata": `videoid ${Buffer.from(ID1).toString("base64")}`,
      },
    });
    assert.equal(uploadRoot.status, 404, "POST /upload should be 404");

    // GET /:videoid (root) must not exist.
    const getRoot = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(getRoot.status, 404, "GET /:videoid at root should be 404");

    // DELETE /:videoid (root) must not exist.
    const delRoot = await fetch(`${ctx.baseUrl}/${ID1}`, { method: "DELETE" });
    assert.equal(delRoot.status, 404, "DELETE /:videoid at root should be 404");
  } finally {
    await ctx.teardown();
  }
});
