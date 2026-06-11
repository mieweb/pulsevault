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

// ---------- helpers ----------

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function atom(type, payload = Buffer.alloc(0)) {
  const size = 8 + payload.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function fullBox(type, version, flags, payload = Buffer.alloc(0)) {
  const prefix = Buffer.alloc(4);
  prefix[0] = version;
  prefix[1] = (flags >> 16) & 0xff;
  prefix[2] = (flags >> 8) & 0xff;
  prefix[3] = flags & 0xff;
  return atom(type, Buffer.concat([prefix, payload]));
}

function ftyp() {
  const payload = Buffer.alloc(16);
  payload.write("isom", 0, 4, "ascii");
  payload.writeUInt32BE(0x00000200, 4);
  payload.write("isom", 8, 4, "ascii");
  payload.write("mp42", 12, 4, "ascii");
  return atom("ftyp", payload);
}

function mvhd() {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(0, 4);
  payload.writeUInt32BE(1000, 8);
  payload.writeUInt32BE(1000, 12);
  return fullBox("mvhd", 0, 0, payload);
}

function mdhd() {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(0, 4);
  payload.writeUInt32BE(1000, 8);
  payload.writeUInt32BE(1000, 12);
  return fullBox("mdhd", 0, 0, payload);
}

function hdlr() {
  const payload = Buffer.alloc(24);
  payload.writeUInt32BE(0, 0);
  payload.write("vide", 4, 4, "ascii");
  return fullBox("hdlr", 0, 0, payload);
}

function moov() {
  const mdia = atom("mdia", Buffer.concat([mdhd(), hdlr()]));
  const trak = atom("trak", mdia);
  return atom("moov", Buffer.concat([mvhd(), trak]));
}

function makeMp4(size) {
  const base = Buffer.concat([ftyp(), moov()]);
  if (size < base.length + 8) {
    throw new Error(`makeMp4: size ${size} < minimum ${base.length + 8}`);
  }
  const mdatPayloadSize = size - base.length - 8;
  const mdatPayload = Buffer.alloc(mdatPayloadSize);
  for (let i = 0; i < mdatPayload.length; i++) {
    mdatPayload[i] = i & 0xff;
  }
  return Buffer.concat([base, atom("mdat", mdatPayload)]);
}

async function startApp({ pluginOptions = {}, withSniffer = false } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-test-"));
  const storage = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: "",
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
  return fetch(`${baseUrl}/upload`, {
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
        path.join(ctx.workspaceDir, ID1, ".pulsevault.json"),
        "utf8",
      ),
    );
    assert.equal(sidecar.status, "ready");
    assert.equal(sidecar.ext, ".mp4");
    assert.equal(sidecar.version, 1);

    const get = await fetch(`${ctx.baseUrl}/${ID1}`);
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

    const get = await fetch(`${ctx.baseUrl}/${ID1}`);
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
    const midGet = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(midGet.status, 404);

    const p2 = await tusPatch(location, half, body.subarray(half));
    assert.equal(p2.status, 204);

    const get = await fetch(`${ctx.baseUrl}/${ID1}`);
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

    const range = await fetch(`${ctx.baseUrl}/${ID1}`, {
      headers: { Range: "bytes=0-99" },
    });
    assert.equal(range.status, 206);
    const slice = Buffer.from(await range.arrayBuffer());
    assert.equal(slice.length, 100);
    assert.equal(Buffer.compare(slice, body.subarray(0, 100)), 0);
    assert.equal(range.headers.get("accept-ranges"), "bytes");
    assert.ok(range.headers.get("content-range"));
  } finally {
    await ctx.teardown();
  }
});

test("no Range header returns 200 with Accept-Ranges header", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1, 2048);

    const res = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.length, body.length);
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("open-ended range (bytes=N-) returns 206 with correct headers", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1, 2048);
    const total = body.length;
    const startByte = 512;

    const res = await fetch(`${ctx.baseUrl}/${ID1}`, {
      headers: { Range: `bytes=${startByte}-` },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const contentRange = res.headers.get("content-range");
    assert.ok(
      contentRange.includes(`${startByte}-`) && contentRange.includes(`/${total}`),
      `expected Content-Range like "bytes ${startByte}-*/${total}", got "${contentRange}"`
    );
    const slice = Buffer.from(await res.arrayBuffer());
    assert.equal(slice.length, total - startByte);
    assert.equal(Buffer.compare(slice, body.subarray(startByte)), 0);
  } finally {
    await ctx.teardown();
  }
});

test("suffix range (bytes=-N) returns 206 with correct headers", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1, 2048);
    const total = body.length;
    const suffixLength = 256;

    const res = await fetch(`${ctx.baseUrl}/${ID1}`, {
      headers: { Range: `bytes=-${suffixLength}` },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const contentRange = res.headers.get("content-range");
    const expectedStart = total - suffixLength;
    assert.ok(
      contentRange.includes(`${expectedStart}-`) && contentRange.includes(`/${total}`),
      `expected Content-Range like "bytes ${expectedStart}-*/${total}", got "${contentRange}"`
    );
    const slice = Buffer.from(await res.arrayBuffer());
    assert.equal(slice.length, suffixLength);
    assert.equal(Buffer.compare(slice, body.subarray(expectedStart)), 0);
  } finally {
    await ctx.teardown();
  }
});

test("out-of-bounds range returns 416 with Content-Range", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1, 2048);
    const total = body.length;

    const res = await fetch(`${ctx.baseUrl}/${ID1}`, {
      headers: { Range: "bytes=9999-10000" },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), `bytes */${total}`);
  } finally {
    await ctx.teardown();
  }
});

test("malformed range returns 416 with Content-Range", async () => {
  const ctx = await startApp();
  try {
    const { body } = await uploadFullMp4(ctx, ID1, 2048);
    const total = body.length;

    const res = await fetch(`${ctx.baseUrl}/${ID1}`, {
      headers: { Range: "bytes=abc-def" },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), `bytes */${total}`);
  } finally {
    await ctx.teardown();
  }
});

test("GET of an unknown videoid returns 404", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.baseUrl}/${ID1}`);
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

    const get = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(get.status, 403);

    const del = await fetch(`${ctx.baseUrl}/${ID1}`, { method: "DELETE" });
    assert.equal(del.status, 403);
  } finally {
    await ctx.teardown();
  }
});

test("DELETE removes the video; second DELETE is 404", async () => {
  const ctx = await startApp();
  try {
    await uploadFullMp4(ctx, ID1);

    const preGet = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(preGet.status, 200);

    const del = await fetch(`${ctx.baseUrl}/${ID1}`, { method: "DELETE" });
    assert.equal(del.status, 204);

    const dirStat = await fs
      .stat(path.join(ctx.workspaceDir, ID1))
      .catch(() => null);
    assert.equal(dirStat, null);

    const postGet = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(postGet.status, 404);

    const del2 = await fetch(`${ctx.baseUrl}/${ID1}`, { method: "DELETE" });
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

    const dirStat = await fs
      .stat(path.join(ctx.workspaceDir, ID1))
      .catch(() => null);
    assert.equal(dirStat, null, "videoid dir should be removed");

    const get = await fetch(`${ctx.baseUrl}/${ID1}`);
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("createMp4Sniffer accepts a valid MP4 payload", async () => {
  const ctx = await startApp({ withSniffer: true });
  try {
    await uploadFullMp4(ctx, ID2, 2048);

    const get = await fetch(`${ctx.baseUrl}/${ID2}`);
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
    const dir = path.join(ctx.workspaceDir, ID1);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".pulsevault.json"), "not json");

    const get = await fetch(`${ctx.baseUrl}/${ID1}`);
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
