// Tests for the optional `name` Upload-Metadata key: a free-form, human-facing
// display title (e.g. the draft name typed on the capture device) that rides
// the create request, is persisted to the sidecar, and is exposed via
// `storage.getName`. Covers: happy-path round-trip, UTF-8 fidelity, absent and
// whitespace-only values dropping to no-name, and the server-side length cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pulseVault, { createLocalStorage } from "../dist/fastify.js";
import { uploadFull } from "./helpers.mjs";

const PREFIX = "/pulsevault";
const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNKNOWN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// Mirrors the server-side MAX_ARTIFACT_NAME_LENGTH in lib/pulsevaultTus.ts.
const MAX_NAME = 512;

async function startApp() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-name-test-"));
  const storage = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    storage,
    baseUrl,
    workspaceDir,
    readSidecar: async (id) =>
      JSON.parse(await fs.readFile(path.join(workspaceDir, ".pulsevault", `${id}.json`), "utf8")),
    teardown: async () => {
      await app.close();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

test("name metadata round-trips to the sidecar and getName", async () => {
  const ctx = await startApp();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: ID1, name: "Morning rounds" });
    const sidecar = await ctx.readSidecar(ID1);
    assert.equal(sidecar.name, "Morning rounds");
    assert.equal(await ctx.storage.getName(ID1), "Morning rounds");
  } finally {
    await ctx.teardown();
  }
});

test("UTF-8 names (accents, emoji) survive the base64 metadata round-trip", async () => {
  const ctx = await startApp();
  try {
    const title = "Café ☕ — visite du matin 🎥";
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: ID1, name: title });
    assert.equal(await ctx.storage.getName(ID1), title);
  } finally {
    await ctx.teardown();
  }
});

test("no name metadata leaves the sidecar without a name and getName null", async () => {
  const ctx = await startApp();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: ID1 });
    const sidecar = await ctx.readSidecar(ID1);
    assert.equal("name" in sidecar, false);
    assert.equal(await ctx.storage.getName(ID1), null);
  } finally {
    await ctx.teardown();
  }
});

test("whitespace-only name is dropped (treated as no name)", async () => {
  const ctx = await startApp();
  try {
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: ID1, name: "   \t  " });
    assert.equal(await ctx.storage.getName(ID1), null);
  } finally {
    await ctx.teardown();
  }
});

test("name is trimmed and hard-capped at the server-side limit", async () => {
  const ctx = await startApp();
  try {
    const padded = `  ${"x".repeat(MAX_NAME + 88)}  `;
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: ID2, name: padded });
    const stored = await ctx.storage.getName(ID2);
    assert.equal(stored, "x".repeat(MAX_NAME));
  } finally {
    await ctx.teardown();
  }
});

test("caps by code point so a boundary emoji is never split into a lone surrogate", async () => {
  const ctx = await startApp();
  try {
    // The emoji lands exactly on the MAX_NAME boundary; a UTF-16 `.slice()`
    // would keep only its leading surrogate and drop a lone half.
    const title = "x".repeat(MAX_NAME - 1) + "😀" + "tail";
    await uploadFull(ctx.baseUrl, PREFIX, { artifactId: ID2, name: title });
    const stored = await ctx.storage.getName(ID2);
    assert.equal(stored, "x".repeat(MAX_NAME - 1) + "😀");
    // Emoji intact: MAX_NAME code points, and the string is well-formed UTF-16.
    assert.equal(Array.from(stored).length, MAX_NAME);
    assert.equal(stored.toWellFormed(), stored);
  } finally {
    await ctx.teardown();
  }
});

test("getName returns null for an unknown artifactId", async () => {
  const ctx = await startApp();
  try {
    assert.equal(await ctx.storage.getName(UNKNOWN), null);
  } finally {
    await ctx.teardown();
  }
});
