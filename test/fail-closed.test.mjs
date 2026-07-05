// Regression suite for the artifact handlers' fail-closed behavior. These
// handlers run on a *hijacked* socket (Fastify's `reply.hijack()`), so a thrown
// storage error is never turned into a response by Fastify — before the fix it
// left the socket hung until timeout. Each test forces a fault, then asserts the
// client gets a prompt, well-formed status (a bounded fetch timeout turns a
// regression into a failure instead of a hung suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

import pulseVault, { createLocalStorage } from "../dist/app.js";

const PREFIX = "/pulsevault";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function startApp({ wrapStorage = (s) => s, ...pluginOptions } = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-failclosed-"));
  const base = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage: wrapStorage(base),
    maxUploadSize: 10 * 1024 * 1024,
    ...pluginOptions,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    baseUrl,
    teardown: async () => {
      await app.close();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

// Fetch with a hard timeout so a hung socket (the bug this guards against)
// surfaces as a rejected fetch rather than stalling the whole test run.
async function fetchWithTimeout(url, options = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

test("GET returns 500 (not a hung socket) when storage.resolve throws", async () => {
  const ctx = await startApp({
    wrapStorage: (base) => ({
      ...base,
      resolve: async () => {
        throw new Error("storage boom");
      },
    }),
  });
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`);
    assert.equal(res.status, 500);
  } finally {
    await ctx.teardown();
  }
});

test("DELETE returns 500 (not a hung socket) when storage.remove throws", async () => {
  const ctx = await startApp({
    wrapStorage: (base) => ({
      ...base,
      remove: async () => {
        throw new Error("storage boom");
      },
    }),
  });
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 500);
  } finally {
    await ctx.teardown();
  }
});

test("an authorize error with an out-of-range statusCode degrades to 403, not a writeHead crash", async () => {
  const ctx = await startApp({
    authorize: async () => {
      // A consumer hook throwing a bogus status (42 is not a valid HTTP status)
      // must degrade to the fallback, not crash res.writeHead with a RangeError.
      throw Object.assign(new Error("bogus status"), { statusCode: 42 });
    },
  });
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`);
    assert.equal(res.status, 403);
  } finally {
    await ctx.teardown();
  }
});

test("GET still 404s for an unknown artifact when storage behaves normally", async () => {
  const ctx = await startApp();
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`);
    assert.equal(res.status, 404);
  } finally {
    await ctx.teardown();
  }
});
