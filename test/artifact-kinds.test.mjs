// Tests for kind=project and kind=captions uploads through the TUS endpoint
// and the generic /artifacts/:artifactId route.
// Covers: happy paths (.pulse / .zip / .srt), extension-mismatch rejections,
// authorize ctx kind, the artifactId/videoid/projectid metadata aliases,
// unified hook dispatch (incl. the deprecated per-kind project hooks),
// relatedTo linking, getKind(), and legacy back-compat (sidecars without
// `kind`).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pulseVault, { createLocalStorage } from "../dist/app.js";
import { makeMp4 } from "./helpers.mjs";

const ID1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PREFIX = "/pulsevault";

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

/** Build a TUS Upload-Metadata header supporting kind, id key, relatedTo, and filename. */
function buildMetadata({ artifactId, idKey = "artifactId", filename, kind, relatedTo }) {
  const parts = [`${idKey} ${b64(artifactId)}`, `filename ${b64(filename)}`];
  if (kind) parts.push(`kind ${b64(kind)}`);
  if (relatedTo) parts.push(`relatedTo ${b64(relatedTo)}`);
  return parts.join(",");
}

async function startApp(pluginOptions = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-kinds-test-"));
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

async function tusCreate(baseUrl, { artifactId, idKey = "artifactId", filename, size, kind, relatedTo }) {
  return fetch(`${baseUrl}${PREFIX}/upload`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": buildMetadata({ artifactId, idKey, filename, kind, relatedTo }),
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
async function uploadFull(ctx, { artifactId, idKey = "artifactId", filename, kind, relatedTo, payload }) {
  const create = await tusCreate(ctx.baseUrl, {
    artifactId,
    idKey,
    filename,
    size: payload.length,
    kind,
    relatedTo,
  });
  assert.equal(create.status, 201, `create ${filename}`);
  const location = create.headers.get("location");
  assert.ok(location, "location header");
  const patch = await tusPatch(location, 0, payload);
  assert.equal(patch.status, 204, `patch ${filename}`);
  return { location };
}

const artifactUrl = (ctx, id) => `${ctx.baseUrl}${PREFIX}/artifacts/${id}`;

// ---------- kind=project ----------

test("kind=project .pulse happy path: file under project/ subdir, correct Content-Type", async () => {
  const ctx = await startApp();
  try {
    const payload = Buffer.from(JSON.stringify({ format: "pulse", version: 1 }));
    await uploadFull(ctx, {
      artifactId: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    const expectedPath = path.join(ctx.workspaceDir, "project", `${ID1}.pulse`);
    const stat = await fs.stat(expectedPath);
    assert.ok(stat.isFile(), "file exists at project/ subdir");

    const sidecar = JSON.parse(
      await fs.readFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), "utf8"),
    );
    assert.equal(sidecar.kind, "project");
    assert.equal(sidecar.ext, ".pulse");
    assert.equal(sidecar.status, "ready");

    const get = await fetch(artifactUrl(ctx, ID1));
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
      artifactId: ID1,
      filename: "diagnostic.zip",
      kind: "project",
      payload,
    });

    const expectedPath = path.join(ctx.workspaceDir, "project", `${ID1}.zip`);
    const stat = await fs.stat(expectedPath);
    assert.ok(stat.isFile(), "zip exists at project/ subdir");

    const get = await fetch(artifactUrl(ctx, ID1));
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
      artifactId: ID1,
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
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
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
      artifactId: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload,
    });

    assert.equal(capturedPhases["create"], "project", "kind on create");

    await fetch(artifactUrl(ctx, ID1));
    assert.equal(capturedPhases["resolve"], "project", "kind on resolve");
  } finally {
    await ctx.teardown();
  }
});

test("validatePayload runs for every kind, with ctx.kind distinguishing them", async () => {
  const calls = [];
  const ctx = await startApp({
    validatePayload: async (_req, info) => {
      calls.push({ kind: info.kind, artifactId: info.artifactId });
    },
  });
  try {
    await uploadFull(ctx, { artifactId: ID1, filename: "clip.mp4", payload: makeMp4(1024) });
    await uploadFull(ctx, {
      artifactId: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse data"),
    });

    assert.equal(calls.length, 2, "both uploads ran validatePayload");
    const videoCall = calls.find((c) => c.kind === "video");
    const projectCall = calls.find((c) => c.kind === "project");
    assert.ok(videoCall && videoCall.artifactId === ID1);
    assert.ok(projectCall && projectCall.artifactId === ID2);
  } finally {
    await ctx.teardown();
  }
});

test("[deprecated] validateProjectPayload still fires for kind=project but not for kind=video", async () => {
  const calls = [];
  const ctx = await startApp({
    validateProjectPayload: async (_req, info) => {
      calls.push({ kind: "project", artifactId: info.artifactId });
    },
    validatePayload: async (_req, info) => {
      calls.push({ kind: "video", artifactId: info.artifactId });
    },
  });
  try {
    await uploadFull(ctx, { artifactId: ID1, filename: "clip.mp4", payload: makeMp4(1024) });
    await uploadFull(ctx, {
      artifactId: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse data"),
    });

    assert.equal(calls.length, 2, "both validators fired");
    const videoCall = calls.find((c) => c.kind === "video");
    const projectCall = calls.find((c) => c.kind === "project");
    assert.ok(videoCall, "validatePayload (video) fired");
    assert.equal(videoCall.artifactId, ID1);
    assert.ok(projectCall, "validateProjectPayload (project) fired");
    assert.equal(projectCall.artifactId, ID2);
  } finally {
    await ctx.teardown();
  }
});

test("[deprecated] onProjectUploadComplete still fires for kind=project but not for kind=video", async () => {
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
    await uploadFull(ctx, { artifactId: ID1, filename: "clip.mp4", payload: makeMp4(1024) });
    await uploadFull(ctx, {
      artifactId: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse data"),
    });

    assert.equal(calls.length, 2);
    const videoCall = calls.find((c) => c.hook === "video");
    const projectCall = calls.find((c) => c.hook === "project");
    assert.ok(videoCall, "onUploadComplete fired for video");
    assert.equal(videoCall.artifactId, ID1);
    assert.ok(projectCall, "onProjectUploadComplete fired for project");
    assert.equal(projectCall.artifactId, ID2);
  } finally {
    await ctx.teardown();
  }
});

test("artifactId/videoid/projectid metadata keys are all accepted as the id alias", async () => {
  const ctx = await startApp();
  try {
    await uploadFull(ctx, {
      artifactId: ID1,
      idKey: "videoid",
      filename: "clip.mp4",
      payload: makeMp4(1024),
    });
    const get1 = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get1.status, 200, "videoid alias works");

    await uploadFull(ctx, {
      artifactId: ID2,
      idKey: "projectid",
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse project data"),
    });
    const get2 = await fetch(artifactUrl(ctx, ID2));
    assert.equal(get2.status, 200, "projectid alias works");
  } finally {
    await ctx.teardown();
  }
});

test("getKind returns the right kind for video/project/captions, null for unknown", async () => {
  const ctx = await startApp();
  try {
    await uploadFull(ctx, {
      artifactId: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse data"),
    });
    await uploadFull(ctx, { artifactId: ID2, filename: "clip.mp4", payload: makeMp4(1024) });

    assert.equal(await ctx.storage.getKind(ID1), "project");
    assert.equal(await ctx.storage.getKind(ID2), "video");
    assert.equal(await ctx.storage.getKind("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), null);
  } finally {
    await ctx.teardown();
  }
});

test("DELETE works for kind=project, through the generic route", async () => {
  const ctx = await startApp();
  try {
    await uploadFull(ctx, {
      artifactId: ID1,
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse data"),
    });

    const preGet = await fetch(artifactUrl(ctx, ID1));
    assert.equal(preGet.status, 200);

    const del = await fetch(artifactUrl(ctx, ID1), { method: "DELETE" });
    assert.equal(del.status, 204);

    const sidecarStat = await fs.stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`)).catch(() => null);
    assert.equal(sidecarStat, null, "sidecar removed");

    const postGet = await fetch(artifactUrl(ctx, ID1));
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
    const zipCreate = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "archive.zip",
      size: 512,
      kind: "project",
    });
    assert.ok(
      zipCreate.status >= 400 && zipCreate.status < 500,
      `expected 4xx for .zip, got ${zipCreate.status}`,
    );

    await uploadFull(ctx, {
      artifactId: ID2,
      filename: "draft.pulse",
      kind: "project",
      payload: Buffer.from("pulse data"),
    });
    const get = await fetch(artifactUrl(ctx, ID2));
    assert.equal(get.status, 200);
  } finally {
    await ctx.teardown();
  }
});

// ---------- kind=captions ----------

test("kind=captions happy path: .srt under captions/ subdir, sharing a session via relatedTo", async () => {
  const ctx = await startApp();
  try {
    // The video this captions artifact belongs to.
    await uploadFull(ctx, { artifactId: ID1, filename: "clip.mp4", payload: makeMp4(1024) });

    const srt = Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    await uploadFull(ctx, {
      artifactId: ID2,
      filename: "clip.srt",
      kind: "captions",
      relatedTo: ID1,
      payload: srt,
    });

    const expectedPath = path.join(ctx.workspaceDir, "captions", `${ID2}.srt`);
    const stat = await fs.stat(expectedPath);
    assert.ok(stat.isFile(), "srt exists at captions/ subdir");

    const get = await fetch(artifactUrl(ctx, ID2));
    assert.equal(get.status, 200);
    const ct = get.headers.get("content-type");
    assert.ok(ct?.includes("application/x-subrip"), `content-type was: ${ct}`);

    assert.equal(await ctx.storage.getKind(ID2), "captions");
    assert.equal(await ctx.storage.getRelatedTo(ID2), ID1, "relatedTo recorded for the session link");
    assert.equal(await ctx.storage.getRelatedTo(ID1), null, "the video itself has no relatedTo");
  } finally {
    await ctx.teardown();
  }
});

test("kind=captions accepts .vtt under default captions extensions", async () => {
  const ctx = await startApp();
  try {
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.vtt",
      size: 64,
      kind: "captions",
    });
    assert.equal(
      create.status,
      201,
      `expected 201 for .vtt under default captions extensions (['.srt', '.vtt']), got ${create.status}`,
    );
  } finally {
    await ctx.teardown();
  }
});

test("kind=captions with an unlisted extension is rejected at create", async () => {
  const ctx = await startApp();
  try {
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.txt",
      size: 64,
      kind: "captions",
    });
    assert.ok(
      create.status >= 400 && create.status < 500,
      `expected 4xx for .txt under default captions extensions, got ${create.status}`,
    );
  } finally {
    await ctx.teardown();
  }
});

// ---------- legacy back-compat ----------

test("legacy sidecar without a kind field resolves as video and streams correctly", async () => {
  const ctx = await startApp();
  try {
    await fs.mkdir(path.join(ctx.workspaceDir, "video"), { recursive: true });
    await fs.mkdir(path.join(ctx.workspaceDir, ".pulsevault"), { recursive: true });
    const mp4 = makeMp4(1024);
    await fs.writeFile(path.join(ctx.workspaceDir, "video", `${ID1}.mp4`), mp4);

    const legacySidecar = JSON.stringify({
      version: 1,
      ext: ".mp4",
      filename: "clip.mp4",
      status: "ready",
      // `kind` intentionally absent.
    });
    await fs.writeFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), legacySidecar);

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 200, "legacy sidecar resolves as 200");
    const ct = get.headers.get("content-type");
    assert.ok(ct?.includes("video/mp4"), `expected video/mp4, got ${ct}`);

    const kind = await ctx.storage.getKind(ID1);
    assert.equal(kind, "video", "legacy upload reports kind=video");
  } finally {
    await ctx.teardown();
  }
});
