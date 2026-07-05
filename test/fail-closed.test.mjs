// Regression suite for the artifact handlers' fail-closed behavior. These
// handlers run on a *hijacked* socket (Fastify's `reply.hijack()`), so a thrown
// storage error is never turned into a response by Fastify — before the fix it
// left the socket hung until timeout. Each test wraps the local adapter so a
// storage method throws, then asserts the client gets a 500 promptly (a bounded
// fetch timeout turns a regression into a failure instead of a hung suite).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';

import pulseVault, { createLocalStorage } from '../dist/app.js';

const PREFIX = '/pulsevault';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function startApp(wrapStorage) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-failclosed-'));
  const base = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage: wrapStorage(base),
    maxUploadSize: 10 * 1024 * 1024,
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
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

test('GET returns 500 (not a hung socket) when storage.resolve throws', async () => {
  const ctx = await startApp((base) => ({
    ...base,
    resolve: async () => {
      throw new Error('storage boom');
    },
  }));
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`);
    assert.equal(res.status, 500);
  } finally {
    await ctx.teardown();
  }
});

test('DELETE returns 500 (not a hung socket) when storage.remove throws', async () => {
  const ctx = await startApp((base) => ({
    ...base,
    remove: async () => {
      throw new Error('storage boom');
    },
  }));
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 500);
  } finally {
    await ctx.teardown();
  }
});

test('GET still 404s for an unknown artifact when storage behaves normally', async () => {
  const ctx = await startApp((base) => base);
  try {
    const res = await fetchWithTimeout(`${ctx.baseUrl}${PREFIX}/artifacts/${ID}`);
    assert.equal(res.status, 404);
  } finally {
    await ctx.teardown();
  }
});
