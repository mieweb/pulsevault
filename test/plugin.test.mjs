// Smoke suite for @mieweb/pulsevault. Runs against the built `dist/` so a
// consumer exercising the public exports would see the same surface. Each
// test spins up a fresh Fastify instance on a random port with a tmpdir
// workspace and tears it all down in `finally` — no shared state.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
  createChecksumValidator,
  issueCapabilityToken,
  createCapabilityAuthorize,
} from "../dist/app.js";
import {
  makeMp4,
  tusCreate as tusCreateRaw,
  tusPatch,
  tusHead,
  uploadFull,
} from "./helpers.mjs";

// Reusable UUIDs. Each test uses its own workspace, so collisions across
// tests are impossible — these just need to be valid UUIDs.
const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// All plugin-owned routes are mounted under this prefix.
const PREFIX = "/pulsevault";

// ---------- helpers ----------

// Prefix-bound wrappers so the test bodies below read the same as before the
// shared helpers were extracted.
const tusCreate = (baseUrl, opts) => tusCreateRaw(baseUrl, PREFIX, opts);
const uploadFullMp4 = (ctx, artifactId, size = 1024) =>
  uploadFull(ctx.baseUrl, PREFIX, { artifactId, size });
const artifactUrl = (ctx, id) => `${ctx.baseUrl}${PREFIX}/artifacts/${id}`;

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
    // Create but never PATCH — file exists at 0 bytes, sidecar is "uploading".
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
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    const half = body.length / 2;

    const p1 = await tusPatch(location, 0, body.subarray(0, half));
    assert.equal(p1.status, 204);

    const head = await tusHead(location);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("upload-offset"), String(half));

    // Before the final PATCH, GET must still be 404.
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

test("two truly concurrent reserves for the same artifactId: exactly one 201, one 409", async () => {
  const ctx = await startApp();
  try {
    const [a, b] = await Promise.all([
      tusCreate(ctx.baseUrl, { artifactId: ID1, filename: "clip.mp4", size: 1024 }),
      tusCreate(ctx.baseUrl, { artifactId: ID1, filename: "clip.mp4", size: 1024 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
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

test("authorize rejection blocks PATCH and HEAD on an existing upload, and sees the real artifactId", async () => {
  // Regression test: `authorize` must actually run (with the correct
  // artifactId) for the patch/head phase, not be silently skipped because the
  // artifactId couldn't be recovered from the tus URL.
  const authorizedPhases = [];
  const ctx = await startApp({
    pluginOptions: {
      authorize: async (_req, { phase, artifactId }) => {
        authorizedPhases.push({ phase, artifactId });
        if (phase === "patch") {
          throw Object.assign(new Error("no patch"), { statusCode: 403 });
        }
      },
    },
  });
  try {
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;

    const patch = await tusPatch(location, 0, makeMp4(1024));
    assert.equal(patch.status, 403, "authorize must reject the PATCH, not silently allow it");

    const head = await tusHead(location);
    assert.equal(head.status, 403, "authorize must reject the HEAD too");

    const patchCalls = authorizedPhases.filter((c) => c.phase === "patch");
    assert.ok(patchCalls.length > 0, "authorize must actually run for the patch phase");
    for (const call of patchCalls) {
      assert.equal(call.artifactId, ID1, "authorize must see the real artifactId, not the kind prefix or undefined");
    }
  } finally {
    await ctx.teardown();
  }
});

test("PATCH/HEAD with an unresolvable upload id is a hard 403 when authorize is configured (PROTOCOL.md §5.2)", async () => {
  // Regression test: when the artifactId cannot be recovered from the tus
  // URL, authorization-context resolution failure must be treated as an
  // authorization failure — never "no artifactId to check, so allow".
  const authorizedIds = [];
  const ctx = await startApp({
    pluginOptions: {
      authorize: async (_req, { artifactId }) => {
        authorizedIds.push(artifactId);
      },
    },
  });
  try {
    // Valid base64url characters, but decodes to garbage with no UUID inside,
    // so `artifactIdFromTusUrl` cannot resolve an artifactId for it.
    const bogus = `${ctx.baseUrl}${PREFIX}/upload/not-a-real-upload-id`;

    const patch = await tusPatch(bogus, 0, makeMp4(1024));
    assert.equal(patch.status, 403, "unresolvable PATCH target must be rejected, not silently allowed");

    const head = await tusHead(bogus);
    assert.equal(head.status, 403, "unresolvable HEAD target must be rejected too");

    assert.ok(
      authorizedIds.every((id) => id !== undefined),
      "authorize must never be invoked with an undefined artifactId",
    );
  } finally {
    await ctx.teardown();
  }
});

test("a crafted multi-segment PATCH URL cannot smuggle bytes into a different artifact than authorize() checked", async () => {
  // Regression test for a URL-parsing divergence: `authorize()`'s artifactId
  // must always be resolved the same way `@tus/server` itself resolves the
  // file it will actually read/write — the *last* `/`-delimited URL segment,
  // not the first one after `/upload/`. Fastify's `/upload/*` route accepts
  // extra trailing segments, so without this, an attacker holding a valid
  // token for their OWN artifact could append a victim's real (but
  // ordinarily unguessable-without-the-pairing-link) tus id as a second path
  // segment: authorize() would see and approve the attacker's own id (first
  // segment), while the PATCH body actually landed on the victim's file
  // (the true last segment, per `@tus/server`'s own resolution).
  const authorizeCalls = [];
  const ctx = await startApp({
    pluginOptions: {
      authorize: async (_req, ctx) => {
        authorizeCalls.push(ctx);
        if (ctx.phase === "create") return; // simulate two independently-authorized sessions
        if (ctx.artifactId !== ID1) {
          throw Object.assign(new Error("forbidden"), { statusCode: 403 });
        }
      },
    },
  });
  try {
    // ID1 = "attacker's own artifact" (authorize approves it); ID2 = "victim's artifact"
    // (authorize would reject it) — both created via a legitimate POST first.
    const victimCreate = await tusCreate(ctx.baseUrl, { artifactId: ID2, filename: "clip.mp4", size: 1024 });
    const attackerCreate = await tusCreate(ctx.baseUrl, { artifactId: ID1, filename: "clip.mp4", size: 1024 });
    assert.equal(victimCreate.status, 201);
    assert.equal(attackerCreate.status, 201);

    const attackerSegment = attackerCreate.headers.get("location").split("/upload/")[1];
    const victimSegment = victimCreate.headers.get("location").split("/upload/")[1];
    const craftedUrl = `${ctx.baseUrl}${PREFIX}/upload/${attackerSegment}/${victimSegment}`;

    const patch = await tusPatch(craftedUrl, 0, makeMp4(1024));
    assert.equal(patch.status, 403, "must be rejected, not silently write to the victim's artifact");

    const patchCall = authorizeCalls.find((c) => c.phase === "patch");
    assert.equal(patchCall.artifactId, ID2, "authorize must see the artifactId @tus/server will actually operate on");

    const victimBytes = await fs.readFile(path.join(ctx.workspaceDir, "video", `${ID2}.mp4`)).catch(() => null);
    assert.equal(victimBytes.length, 0, "victim's file must be untouched (still 0 bytes from create)");
  } finally {
    await ctx.teardown();
  }
});

test("createCapabilityAuthorize: PATCH without a valid token is rejected, not silently accepted", async () => {
  // The artifactId is not secret (it's embedded in the pairing link/QR code
  // by design) — the token is what's supposed to gate writing bytes into an
  // upload. This exercises the exact bypass scenario the fix above closes.
  const secret = "test-secret";
  const issuer = "https://vault.example.test";
  const lookupSecret = (kid) => (kid === "k1" ? secret : null);
  const ctx = await startApp({
    pluginOptions: {
      authorize: createCapabilityAuthorize(lookupSecret, { issuer }),
    },
  });
  try {
    const token = issueCapabilityToken(ID1, secret, { keyId: "k1", issuer });
    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;

    // No credential presented at all -> 401 (PROTOCOL.md §5.2), not a silent pass-through.
    const noToken = await tusPatch(location, 0, makeMp4(1024));
    assert.equal(noToken.status, 401, "PATCH with no token must be rejected");

    const unrelatedToken = issueCapabilityToken("cccccccc-cccc-4ccc-8ccc-cccccccccccc", secret, {
      keyId: "k1",
      issuer,
    });
    const wrongToken = await tusPatch(location, 0, makeMp4(1024), {
      Authorization: `Bearer ${unrelatedToken}`,
    });
    assert.equal(wrongToken.status, 403, "PATCH with a token for a different artifact must be rejected");

    const ok = await tusPatch(location, 0, makeMp4(1024), { Authorization: `Bearer ${token}` });
    assert.equal(ok.status, 204, "PATCH with the legitimate token must still succeed");
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

    const sidecarStat = await fs
      .stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`))
      .catch(() => null);
    assert.equal(sidecarStat, null);

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
    // GIF header — deliberately not ISOBMFF.
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
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;

    const patch = await tusPatch(location, 0, fake);
    assert.ok(
      patch.status >= 400 && patch.status < 500,
      `expected 4xx, got ${patch.status}`,
    );

    const sidecarStat = await fs
      .stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`))
      .catch(() => null);
    assert.equal(sidecarStat, null, "sidecar should be removed");

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
});

test("createMp4Sniffer accepts a valid MP4 payload", async () => {
  const ctx = await startApp({ withSniffer: true });
  try {
    await uploadFullMp4(ctx, ID2, 2048);

    const get = await fetch(artifactUrl(ctx, ID2));
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
    assert.equal(calls[0].artifactId, ID1);
    assert.equal(calls[0].kind, "video");
    assert.equal(calls[0].size, body.length);
    assert.equal(typeof calls[0].uploadId, "string");
  } finally {
    await ctx.teardown();
  }
});

test("onUploadComplete failure returns a generic 500 without leaking the internal error", async () => {
  // A consumer hook error often carries infra detail (DB schema, table names,
  // paths). It must be logged server-side, never echoed in the client's 5xx body.
  const secret = "SECRET_pulses_table_password_h4 x0r";
  const ctx = await startApp({
    pluginOptions: {
      onUploadComplete: async () => {
        throw new Error(secret);
      },
    },
  });
  try {
    const body = makeMp4(1024);
    const create = await tusCreate(ctx.baseUrl, { artifactId: ID1, filename: "clip.mp4", size: body.length });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    const patch = await tusPatch(location, 0, body);

    assert.equal(patch.status, 500);
    const text = await patch.text();
    assert.ok(!text.includes(secret), "internal error text must not reach the client");
    assert.match(text, /Upload completion hook failed/);
  } finally {
    await ctx.teardown();
  }
});

test(
  "storage subdirectories are created without world access (mode 0o750)",
  { skip: process.platform === "win32" ? "posix mode bits only" : false },
  async () => {
    const ctx = await startApp();
    try {
      await uploadFullMp4(ctx, ID1); // creates the `video/` kind dir and `.pulsevault/`
      for (const dir of [".pulsevault", "video"]) {
        const st = await fs.stat(path.join(ctx.workspaceDir, dir));
        assert.equal(st.mode & 0o007, 0, `${dir} must not be world-accessible`);
      }
    } finally {
      await ctx.teardown();
    }
  },
);

test("malformed sidecar is treated as absent; reserve rewrites it", async () => {
  const ctx = await startApp();
  try {
    await fs.mkdir(path.join(ctx.workspaceDir, ".pulsevault"), { recursive: true });
    await fs.writeFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), "not json");

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 404);

    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: 1024,
    });
    assert.equal(create.status, 201);
  } finally {
    await ctx.teardown();
  }
});

test("a pre-artifactId-rename sidecar (legacy fields only, no kind) still resolves through the new generic route", async () => {
  // Simulates a workspace left behind by a pre-this-release deployment: the
  // sidecar predates `kind` entirely (it was already optional for back-compat)
  // and was written before this release renamed `videoid` to `artifactId`
  // everywhere — but since the on-disk sidecar never stored the id as a field
  // (the id is the filename), nothing on disk actually needs migrating. This
  // is the real "does an existing deployment survive the upgrade" check.
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
      // `kind` intentionally absent, matching every pre-this-release sidecar.
    });
    await fs.writeFile(path.join(ctx.workspaceDir, ".pulsevault", `${ID1}.json`), legacySidecar);

    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 200, "legacy sidecar resolves through the new /artifacts/ route");
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(bytes, mp4), 0);

    const kind = await ctx.storage.getKind(ID1);
    assert.equal(kind, "video", "legacy upload reports kind=video");
  } finally {
    await ctx.teardown();
  }
});

test("old per-kind routes (pre-generic-route) are gone, not kept as a parallel API", async () => {
  const ctx = await startApp();
  try {
    await uploadFullMp4(ctx, ID1);
    const oldVideoRoute = await fetch(`${ctx.baseUrl}${PREFIX}/${ID1}`);
    assert.equal(oldVideoRoute.status, 404, "old GET /:videoid is gone");
    const oldProjectRoute = await fetch(`${ctx.baseUrl}${PREFIX}/project/${ID1}`);
    assert.equal(oldProjectRoute.status, 404, "old GET /project/:projectid is gone");
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
        "Upload-Metadata": `artifactId ${Buffer.from(ID1).toString("base64")}`,
      },
    });
    assert.equal(uploadRoot.status, 404, "POST /upload should be 404");

    // GET /artifacts/:artifactId (root) must not exist.
    const getRoot = await fetch(`${ctx.baseUrl}/artifacts/${ID1}`);
    assert.equal(getRoot.status, 404, "GET /artifacts/:artifactId at root should be 404");

    // DELETE /artifacts/:artifactId (root) must not exist.
    const delRoot = await fetch(`${ctx.baseUrl}/artifacts/${ID1}`, { method: "DELETE" });
    assert.equal(delRoot.status, 404, "DELETE /artifacts/:artifactId at root should be 404");
  } finally {
    await ctx.teardown();
  }
});

test("GET /capabilities is unauthenticated and reports the configured uploadUnit", async () => {
  const authorizeCalls = [];
  const ctx = await startApp({
    pluginOptions: {
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
    assert.equal(body.minSupportedVersion, 1);
    assert.equal(body.maxSupportedVersion, 1);
    assert.equal(body.uploadUnit, "merged");
    assert.deepEqual(body.kinds.sort(), ["captions", "project", "thumbnail", "video"]);
    assert.equal(body.maxUploadSize, 10 * 1024 * 1024);
    assert.ok(Array.isArray(body.checksum.algorithms));
    assert.equal(authorizeCalls.length, 0, "capabilities must not run authorize");
  } finally {
    await ctx.teardown();
  }
});

test("checksum validator accepts a matching digest and rejects a mismatched one", async () => {
  const ctx = await startApp({
    pluginOptions: { validatePayload: createChecksumValidator() },
  });
  try {
    const body = makeMp4(1024);
    const digest = createHash("sha256").update(body).digest("hex");

    const good = await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: ID1,
      body,
      checksum: `sha256:${digest}`,
    });
    const get = await fetch(artifactUrl(ctx, ID1));
    assert.equal(get.status, 200, "matching checksum is accepted");
    void good;

    const create = await tusCreate(ctx.baseUrl, {
      artifactId: ID2,
      filename: "clip.mp4",
      size: body.length,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;
    const patch = await tusPatch(location, 0, body);
    assert.equal(patch.status, 422, "mismatched checksum is rejected");

    const sidecarStat = await fs
      .stat(path.join(ctx.workspaceDir, ".pulsevault", `${ID2}.json`))
      .catch(() => null);
    assert.equal(sidecarStat, null, "rejected upload's sidecar is cleaned up");
  } finally {
    await ctx.teardown();
  }
});

test("createCapabilityAuthorize: valid token authorizes its own artifact and a related one, rejects others", async () => {
  const secret = "test-secret";
  const issuer = "https://vault.example.test";
  const lookupSecret = (kid) => (kid === "k1" ? secret : null);
  const ctx = await startApp({
    pluginOptions: {
      authorize: createCapabilityAuthorize(lookupSecret, { issuer }),
    },
  });
  try {
    const token = issueCapabilityToken(ID1, secret, { keyId: "k1", issuer });

    // Authorizes its own artifactId.
    await uploadFull(ctx.baseUrl, PREFIX, {
      artifactId: ID1,
      headers: { Authorization: `Bearer ${token}` },
    });
    const get1 = await fetch(artifactUrl(ctx, ID1), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(get1.status, 200);

    // Authorizes a related artifact (e.g. ID1's captions) via relatedTo.
    const captionsCreate = await tusCreateRaw(ctx.baseUrl, PREFIX, {
      artifactId: ID2,
      filename: "clip.vtt",
      size: 10,
      kind: "captions",
      relatedTo: ID1,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(captionsCreate.status, 201, "related artifact authorized by the session token");

    // An unrelated artifactId is rejected even with a structurally valid token.
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

    // Expired token is rejected. -120s is well past the default 30s clock-skew
    // tolerance (see capability-token.test.mjs for the boundary case itself).
    const expired = issueCapabilityToken(ID1, secret, { keyId: "k1", issuer, expirySeconds: -120 });
    const expiredGet = await fetch(artifactUrl(ctx, ID1), {
      headers: { Authorization: `Bearer ${expired}` },
    });
    assert.equal(expiredGet.status, 403);

    // Unknown kid is rejected.
    const unknownKid = issueCapabilityToken(ID1, secret, { keyId: "nope", issuer });
    const unknownKidGet = await fetch(artifactUrl(ctx, ID1), {
      headers: { Authorization: `Bearer ${unknownKid}` },
    });
    assert.equal(unknownKidGet.status, 403);
  } finally {
    await ctx.teardown();
  }
});

test("createCapabilityAuthorize: key rotation overlap — old and new kid both verify", async () => {
  const oldSecret = "old-secret";
  const newSecret = "new-secret";
  const issuer = "https://vault.example.test";
  const lookupSecret = (kid) => ({ "2026-03": oldSecret, "2026-06": newSecret })[kid] ?? null;
  const ctx = await startApp({
    pluginOptions: { authorize: createCapabilityAuthorize(lookupSecret, { issuer }) },
  });
  try {
    const oldToken = issueCapabilityToken(ID1, oldSecret, { keyId: "2026-03", issuer });
    const newToken = issueCapabilityToken(ID2, newSecret, { keyId: "2026-06", issuer });

    const r1 = await tusCreateRaw(ctx.baseUrl, PREFIX, {
      artifactId: ID1,
      filename: "a.mp4",
      size: 1024,
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    assert.equal(r1.status, 201, "old key still verifies during rotation overlap");

    const r2 = await tusCreateRaw(ctx.baseUrl, PREFIX, {
      artifactId: ID2,
      filename: "b.mp4",
      size: 1024,
      headers: { Authorization: `Bearer ${newToken}` },
    });
    assert.equal(r2.status, 201, "new key verifies");
  } finally {
    await ctx.teardown();
  }
});
