// Protocol versioning and the client ↔ server version exchange (PROTOCOL.md §7): where the
// protocol version comes from, the `Pulse-Client` header, `426 Upgrade Required` for clients
// that are too old, and `Upload-Metadata.appVersion` being stored and reported.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Fastify from "fastify";
import pulseVault from "../dist/app.js";
import { createLocalStorage, createPulseVaultCore } from "../dist/core.js";
import {
  outdatedClientRejection,
  parsePulseClient,
  PROTOCOL_REVISION,
  PROTOCOL_VERSION,
} from "../dist/lib/protocol.js";
import { tusCreate, uploadFull } from "./helpers.mjs";
import pkg from "../package.json" with { type: "json" };

const PREFIX = "/pulsevault";
const { min: MIN, max: MAX } = pkg.pulseProtocol;
const tooOld = `Pulse/0.9.0 (1; ios); protocol=1-${MIN - 1}`;
const current = `Pulse/9.9.9 (99; ios); protocol=${MIN}-${MAX}`;

async function startCore(coreOptions = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-protocol-test-"));
  const storage = createLocalStorage({ workspaceDir });
  const core = createPulseVaultCore({
    basePath: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    ...coreOptions,
  });
  const server = http.createServer((req, res) => void core.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    workspaceDir,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve));
      await core.shutdown();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

test("the protocol version comes from package.json pulseProtocol", () => {
  assert.equal(PROTOCOL_REVISION, pkg.pulseProtocol.version);
  assert.match(PROTOCOL_REVISION, /^\d+\.\d+$/);
  assert.equal(PROTOCOL_VERSION, Number(PROTOCOL_REVISION.split(".")[0]));
  assert.ok(MIN <= PROTOCOL_VERSION && PROTOCOL_VERSION <= MAX);
});

test("parsePulseClient reads the protocol range, and tolerates anything else", () => {
  assert.deepEqual(parsePulseClient("Pulse/2.1.0 (45; ios); protocol=1-2"), {
    raw: "Pulse/2.1.0 (45; ios); protocol=1-2",
    protocolMin: 1,
    protocolMax: 2,
  });
  assert.deepEqual(parsePulseClient("Pulse/2.1.0; protocol=2"), {
    raw: "Pulse/2.1.0; protocol=2",
    protocolMin: 2,
    protocolMax: 2,
  });
  assert.deepEqual(parsePulseClient("SomeClient/1.0"), { raw: "SomeClient/1.0" });
  assert.deepEqual(parsePulseClient("X; protocol=3-1"), { raw: "X; protocol=3-1" });
  assert.equal(parsePulseClient(undefined), null);
  assert.equal(parsePulseClient("   "), null);
});

test("only a client that says it's too old is rejected", () => {
  const req = (value) => ({ headers: value === undefined ? {} : { "pulse-client": value } });
  assert.equal(outdatedClientRejection(req(undefined)), null);
  assert.equal(outdatedClientRejection(req("SomeClient/1.0")), null);
  assert.equal(outdatedClientRejection(req(current)), null);
  assert.deepEqual(outdatedClientRejection(req(tooOld)), {
    error: outdatedClientRejection(req(tooOld)).error,
    minSupportedVersion: MIN,
    maxSupportedVersion: MAX,
  });
});

test("426 for a too-old client on uploads and artifacts; /capabilities still answers", async () => {
  const ctx = await startCore();
  try {
    const create = await tusCreate(ctx.baseUrl, PREFIX, {
      artifactId: randomUUID(),
      filename: "clip.mp4",
      size: 16,
      headers: { "Pulse-Client": tooOld },
    });
    assert.equal(create.status, 426);
    assert.equal(create.headers.get("protocol-version"), String(PROTOCOL_VERSION));
    const body = await create.json();
    assert.equal(body.minSupportedVersion, MIN);
    assert.equal(body.maxSupportedVersion, MAX);
    assert.match(body.error, /Update the app/);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${randomUUID()}`, {
      headers: { "Pulse-Client": tooOld },
    });
    assert.equal(get.status, 426);

    const caps = await fetch(`${ctx.baseUrl}${PREFIX}/capabilities`, {
      headers: { "Pulse-Client": tooOld },
    });
    assert.equal(caps.status, 200);
    assert.equal((await caps.json()).protocolRevision, PROTOCOL_REVISION);
  } finally {
    await ctx.teardown();
  }
});

test("a current client, or one without the header, uploads normally", async () => {
  const ctx = await startCore();
  try {
    for (const headers of [{ "Pulse-Client": current }, {}]) {
      const artifactId = randomUUID();
      await uploadFull(ctx.baseUrl, PREFIX, { artifactId, headers });
      const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${artifactId}`, { headers });
      assert.equal(get.status, 200);
    }
  } finally {
    await ctx.teardown();
  }
});

test("the Fastify plugin applies the same 426", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-protocol-plugin-"));
  const app = Fastify({ logger: false });
  try {
    await app.register(pulseVault, {
      prefix: PREFIX,
      storage: createLocalStorage({ workspaceDir }),
      maxUploadSize: 10 * 1024 * 1024,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const create = await tusCreate(baseUrl, PREFIX, {
      artifactId: randomUUID(),
      filename: "clip.mp4",
      size: 16,
      headers: { "Pulse-Client": tooOld },
    });
    assert.equal(create.status, 426);
  } finally {
    await app.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("appVersion is stored with the artifact and reported on the complete event", async () => {
  const events = [];
  const ctx = await startCore({ onArtifactEvent: (event) => events.push(event) });
  try {
    const artifactId = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId, appVersion: "  2.1.0 (45)  " });
    const sidecar = JSON.parse(
      await fs.readFile(path.join(ctx.workspaceDir, ".pulsevault", `${artifactId}.json`), "utf8"),
    );
    assert.equal(sidecar.appVersion, "2.1.0 (45)");
    assert.equal(sidecar.status, "ready", "appVersion survives markReady");
    const complete = events.find((e) => e.phase === "complete" && e.artifactId === artifactId);
    assert.equal(complete?.appVersion, "2.1.0 (45)");

    const capped = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: capped, appVersion: "9".repeat(500) });
    const cappedSidecar = JSON.parse(
      await fs.readFile(path.join(ctx.workspaceDir, ".pulsevault", `${capped}.json`), "utf8"),
    );
    assert.equal(cappedSidecar.appVersion.length, 64);

    const without = randomUUID();
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: without });
    const plainEvent = events.find((e) => e.phase === "complete" && e.artifactId === without);
    assert.equal("appVersion" in plainEvent, false);
  } finally {
    await ctx.teardown();
  }
});
