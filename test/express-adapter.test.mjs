// Smoke test proving `core.handler` composes cleanly as real Express
// middleware (`app.use(prefix, handler)`) — not a full protocol re-run (see
// http-adapter.test.mjs for that), just confirmation that Express's own
// request pipeline (its router, body handling, etc.) doesn't interfere.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createPulseVaultCore, createLocalStorage } from "../dist/core.js";
import { makeMp4, tusCreate as tusCreateRaw, tusPatch } from "./helpers.mjs";

const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "/pulsevault";

async function startApp() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-express-test-"));
  const storage = createLocalStorage({ workspaceDir });
  // `basePath` must still be the full external prefix — the core uses it to
  // build the tus `Location` header clients PATCH against. But Express's
  // `app.use(prefix, ...)` already strips that prefix from `req.url` before
  // the middleware runs (same for Connect/Meteor's `connectHandlers.use`),
  // so tell the core not to also try to strip/match it itself.
  const core = createPulseVaultCore({
    basePath: PREFIX,
    stripBasePath: false,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
  });

  const app = express();
  // No body-parser middleware ahead of pulsevault — it must own the raw
  // request stream itself for the tus PATCH bodies.
  app.use(PREFIX, (req, res, next) => {
    core.handler(req, res, next).catch(next);
  });
  app.get("/healthz", (_req, res) => res.send("ok"));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    workspaceDir,
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve));
      await core.shutdown();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

test("express: full TUS upload + GET round-trips through app.use(prefix, core.handler)", async () => {
  const ctx = await startApp();
  try {
    const body = makeMp4(2048);
    const create = await tusCreateRaw(ctx.baseUrl, PREFIX, {
      artifactId: ID1,
      filename: "clip.mp4",
      size: body.length,
    });
    assert.equal(create.status, 201);
    const location = new URL(create.headers.get("location"), ctx.baseUrl).href;

    const patch = await tusPatch(location, 0, body);
    assert.equal(patch.status, 204);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/artifacts/${ID1}`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("protocol-version"), "1");
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(bytes, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("express: routes outside the mounted prefix still reach Express's own handlers", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    await ctx.teardown();
  }
});

test("express: GET /capabilities is reachable through the mounted router", async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.baseUrl}${PREFIX}/capabilities`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocolVersion, 1);
  } finally {
    await ctx.teardown();
  }
});
