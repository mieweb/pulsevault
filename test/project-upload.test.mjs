// Tests for kind=project uploads through the TUS endpoint.
// Covers: happy paths (.pulse / .zip), extension-mismatch rejections,
// authorize ctx kind, projectid alias, hook dispatch, getKind(), legacy
// back-compat (sidecars without `kind`).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pulseVault, { createLocalStorage } from "../dist/app.js";

const ID1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PREFIX = "/pulsevault";

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

/**
 * Build a TUS Upload-Metadata header supporting kind, id key (videoid or
 * projectid), and filename.
 */
function buildMetadata({ videoid, idKey = "videoid", filename, kind }) {
  const parts = [`${idKey} ${b64(videoid)}`, `filename ${b64(filename)}`];
  if (kind) parts.push(`kind ${b64(kind)}`);
  return parts.join(",");
}

async function startApp(pluginOptions = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-proj-test-"));
  const storage = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
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

async function tusCreate(baseUrl, { videoid, idKey = "videoid", filename, size, kind }) {
  return fetch(`${baseUrl}${PREFIX}/upload`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": buildMetadata({ videoid, idKey, filename, kind }),
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

/** Do a complete TUS upload in one go. Returns the response bodies. */
async function uploadFull(ctx, { videoid, idKey = "videoid", filename, kind, payload }) {
  const create = await tusCreate(ctx.baseUrl, {
    videoid,
    idKey,
    filename,
    size: payload.length,
    kind,
  });
  assert.equal(create.status, 201, `create ${filename}`);
  const location = create.headers.get("location");
  assert.ok(location, "location header");
  const patch = await tusPatch(location, 0, payload);
  assert.equal(patch.status, 204, `patch ${filename}`);
  return { location };
}

// ---------- tests ----------

test("kind=project .pulse happy path: file under project/ subdir, correct Content-Type", async () => {
  const ctx = await startApp();
  try {
    const payload = Buffer.from(JSON.stringify({ format: "pulse", version: 1 }));
    await uploadFull(ctx, {
      videoid: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    // File must land at <uuid>/project/<uuid>.pulse
    const expectedPath = path.join(ctx.workspaceDir, "project", `${ID1}.pulse`);
    const stat = await fs.stat(expectedPath);
    assert.ok(stat.isFile(), "file exists at project/ subdir");

    // Sidecar must record kind
    const sidecar = JSON.parse(
      await fs.readFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), "utf8"),
    );
    assert.equal(sidecar.kind, "project");
    assert.equal(sidecar.ext, ".pulse");
    assert.equal(sidecar.status, "ready");

    // GET must return 200 with application/octet-stream
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(get.status, 200);
    const ct = get.headers.get("content-type");
    assert.ok(ct?.includes("application/octet-stream"), `content-type was: ${ct}`);
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(bytes, payload), 0);
  } finally {
    await ctx.teardown();
  }
});

test("kind=project .zip happy path: file under project/ subdir, Content-Type: application/zip", async () => {
  const ctx = await startApp();
  try {
    const payload = Buffer.alloc(512, 0x50); // fake zip bytes
    await uploadFull(ctx, {
      videoid: ID1,
      filename: "diagnostic.zip",
      kind: "project",
      payload,
    });

    const expectedPath = path.join(ctx.workspaceDir, "project", `${ID1}.zip`);
    const stat = await fs.stat(expectedPath);
    assert.ok(stat.isFile(), "zip exists at project/ subdir");

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(get.status, 200);
    const ct = get.headers.get("content-type");
    assert.ok(ct?.includes("application/zip"), `content-type was: ${ct}`);
  } finally {
    await ctx.teardown();
  }
});

test("kind=project with .mp4 extension is rejected at create", async () => {
  const ctx = await startApp();
  try {
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "sneaky.mp4",
      size: 1024,
      kind: "project",
    });
    assert.ok(
      create.status >= 400 && create.status < 500,
      `expected 4xx for wrong extension, got ${create.status}`,
    );
  } finally {
    await ctx.teardown();
  }
});

test("kind=video (default) with .pulse extension is rejected at create", async () => {
  const ctx = await startApp();
  try {
    // No `kind` in metadata defaults to video; .pulse is not in the video list.
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "draft.pulse",
      size: 1024,
      // kind omitted → defaults to "video"
    });
    assert.ok(
      create.status >= 400 && create.status < 500,
      `expected 4xx for .pulse under video kind, got ${create.status}`,
    );
  } finally {
    await ctx.teardown();
  }
});

test("authorize receives kind='project' on create and resolve", async () => {
  const capturedPhases = {};
  const ctx = await startApp({
    authorize: async (_req, ctx) => {
      capturedPhases[ctx.phase] = ctx.kind;
    },
  });
  try {
    const payload = Buffer.from("pulse data");
    await uploadFull(ctx, {
      videoid: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    assert.equal(capturedPhases["create"], "project", "kind on create");

    // GET /project/:projectid triggers resolve phase
    await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(capturedPhases["resolve"], "project", "kind on resolve");
  } finally {
    await ctx.teardown();
  }
});

test("validateProjectPayload fires for kind=project but not for kind=video", async () => {
  const calls = [];
  const ctx = await startApp({
    validateProjectPayload: async (_req, info) => {
      calls.push({ kind: "project", videoid: info.videoid });
    },
    validatePayload: async (_req, info) => {
      calls.push({ kind: "video", videoid: info.videoid });
    },
  });
  try {
    const payload = Buffer.from("pulse data");

    // Upload a video first (no kind in metadata → defaults to video)
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const mp4 = Buffer.alloc(1024);
    mp4Header.copy(mp4, 0);
    await uploadFull(ctx, {
      videoid: ID1,
      filename: "clip.mp4",
      // kind omitted → video
      payload: mp4,
    });

    // Upload a project
    await uploadFull(ctx, {
      videoid: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    assert.equal(calls.length, 2, "both validators fired");
    const videoCall = calls.find((c) => c.kind === "video");
    const projectCall = calls.find((c) => c.kind === "project");
    assert.ok(videoCall, "validatePayload (video) fired");
    assert.equal(videoCall.videoid, ID1);
    assert.ok(projectCall, "validateProjectPayload (project) fired");
    assert.equal(projectCall.videoid, ID2);
  } finally {
    await ctx.teardown();
  }
});

test("onProjectUploadComplete fires for kind=project but not for kind=video", async () => {
  const calls = [];
  const ctx = await startApp({
    onProjectUploadComplete: async (_req, info) => {
      calls.push({ hook: "project", ...info });
    },
    onUploadComplete: async (_req, info) => {
      calls.push({ hook: "video", ...info });
    },
  });
  try {
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const mp4 = Buffer.alloc(1024);
    mp4Header.copy(mp4, 0);
    await uploadFull(ctx, { videoid: ID1, filename: "clip.mp4", payload: mp4 });

    const pulse = Buffer.from("pulse data");
    await uploadFull(ctx, {
      videoid: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload: pulse,
    });

    assert.equal(calls.length, 2);
    const videoCall = calls.find((c) => c.hook === "video");
    const projectCall = calls.find((c) => c.hook === "project");
    assert.ok(videoCall, "onUploadComplete fired for video");
    assert.equal(videoCall.videoid, ID1);
    assert.ok(projectCall, "onProjectUploadComplete fired for project");
    assert.equal(projectCall.videoid, ID2);
  } finally {
    await ctx.teardown();
  }
});

test("projectid metadata alias works identically to videoid", async () => {
  const ctx = await startApp();
  try {
    const payload = Buffer.from("pulse project data");
    await uploadFull(ctx, {
      videoid: ID1,
      idKey: "projectid", // use the alias
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(get.status, 200, "GET succeeds with projectid alias");
    const ct = get.headers.get("content-type");
    assert.ok(ct?.includes("application/octet-stream"), `content-type was: ${ct}`);
  } finally {
    await ctx.teardown();
  }
});

test("getKind returns 'project' for project uploads and 'video' for video uploads", async () => {
  const ctx = await startApp();
  try {
    // Project upload
    const pulse = Buffer.from("pulse data");
    await uploadFull(ctx, {
      videoid: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload: pulse,
    });

    // Video upload (no kind → defaults to video)
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const mp4 = Buffer.alloc(1024);
    mp4Header.copy(mp4, 0);
    await uploadFull(ctx, { videoid: ID2, filename: "clip.mp4", payload: mp4 });

    const projectKind = await ctx.storage.getKind(ID1);
    assert.equal(projectKind, "project");

    const videoKind = await ctx.storage.getKind(ID2);
    assert.equal(videoKind, "video");

    const unknownKind = await ctx.storage.getKind("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    assert.equal(unknownKind, null);
  } finally {
    await ctx.teardown();
  }
});

test("legacy sidecar without kind field resolves as video and streams correctly", async () => {
  const ctx = await startApp();
  try {
    // Manually write a pre-kind sidecar (as if written by the old plugin version)
    await fs.mkdir(path.join(ctx.workspaceDir, "video"), { recursive: true });
    await fs.mkdir(path.join(ctx.workspaceDir, ".pulsevault"), { recursive: true });

    // Write a minimal valid MP4 as the upload bytes
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const mp4 = Buffer.alloc(1024);
    mp4Header.copy(mp4, 0);
    await fs.writeFile(path.join(ctx.workspaceDir, "video", `${ID1}.mp4`), mp4);

    // Old sidecar format: no `kind` field
    const legacySidecar = JSON.stringify({
      version: 1,
      ext: ".mp4",
      filename: "clip.mp4",
      status: "ready",
      // `kind` intentionally absent
    });
    await fs.writeFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), legacySidecar);

    // GET must succeed as a video
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(get.status, 200, "legacy sidecar resolves as 200");
    const ct = get.headers.get("content-type");
    assert.ok(ct?.includes("video/mp4"), `expected video/mp4, got ${ct}`);

    // getKind must default to "video"
    const kind = await ctx.storage.getKind(ID1);
    assert.equal(kind, "video", "legacy upload reports kind=video");
  } finally {
    await ctx.teardown();
  }
});

test("DELETE works for kind=project", async () => {
  const ctx = await startApp();
  try {
    const payload = Buffer.from("pulse data");
    await uploadFull(ctx, {
      videoid: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    const preGet = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(preGet.status, 200);

    const del = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`, { method: "DELETE" });
    assert.equal(del.status, 204);

    const sidecarStat = await fs.stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`)).catch(() => null);
    assert.equal(sidecarStat, null, "sidecar removed");

    const postGet = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(postGet.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("allowedExtensions object form: custom video and project extensions", async () => {
  const ctx = await startApp({
    allowedExtensions: { video: [".mp4"], project: [".pulse"] },
  });
  try {
    // .zip should be rejected (not in the custom project list)
    const zipCreate = await tusCreate(ctx.baseUrl, {
      videoid: ID1,
      filename: "archive.zip",
      size: 512,
      kind: "project",
    });
    assert.ok(
      zipCreate.status >= 400 && zipCreate.status < 500,
      `expected 4xx for .zip, got ${zipCreate.status}`,
    );

    // .pulse should still be allowed
    const payload = Buffer.from("pulse data");
    await uploadFull(ctx, {
      videoid: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });
    const get = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID2}`);
    assert.equal(get.status, 200);
  } finally {
    await ctx.teardown();
  }
});
