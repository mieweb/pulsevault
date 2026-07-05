// Regression test for the path-injection fix in src/storage/local.ts:
// every LocalStorage method that takes an artifactId now refuses anything
// that isn't a UUID before it's joined into a filesystem path, closing off
// a caller (e.g. an HTTP route param passed straight through, or a direct
// `getLocalPath`/`getKind` call from consumer code that skips the plugin's
// own route-level validation) supplying a `../`-style traversal string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage } from '../dist/app.js';

const VALID_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// A file this test plants OUTSIDE the storage workspace — if any method
// below actually reads/touches it, the traversal succeeded and the test
// must fail.
async function withOutsideSecret(fn) {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-outside-'));
  const secretPath = path.join(outsideDir, 'secret.json');
  await fs.writeFile(secretPath, JSON.stringify({ ext: '.mp4', filename: 'leaked' }), 'utf8');
  try {
    return await fn(outsideDir, secretPath);
  } finally {
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
}

test('LocalStorage rejects non-UUID artifactIds instead of joining them into a path', async () => {
  await withOutsideSecret(async (outsideDir) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-test-'));
    try {
      const storage = createLocalStorage({ workspaceDir });
      // A traversal string is crafted to land on the file planted in
      // `outsideDir` if `sidecarPath`/`artifactRelPath` joined it unchecked.
      const relativeToSidecarDir = path.relative(
        path.join(workspaceDir, '.pulsevault'),
        outsideDir,
      );
      const traversalId = `${relativeToSidecarDir}${path.sep}secret`;

      for (const maliciousId of [traversalId, '../../etc/passwd', 'not-a-uuid', '']) {
        assert.equal(await storage.getLocalPath(maliciousId), null, `getLocalPath(${maliciousId})`);
        assert.equal(await storage.getKind(maliciousId), null, `getKind(${maliciousId})`);
        assert.equal(await storage.getRelatedTo(maliciousId), null, `getRelatedTo(${maliciousId})`);
        assert.equal(await storage.getChecksum(maliciousId), null, `getChecksum(${maliciousId})`);
        assert.equal(await storage.resolve(maliciousId), null, `resolve(${maliciousId})`);
        assert.equal(await storage.remove(maliciousId), false, `remove(${maliciousId})`);
      }
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

test("LocalStorage still serves a real UUID normally (guard isn't overbroad)", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-test-'));
  try {
    const storage = createLocalStorage({ workspaceDir });
    await storage.reserveUpload({
      artifactId: VALID_ID,
      filename: 'clip.mp4',
      ext: '.mp4',
      kind: 'video',
    });
    await fs.mkdir(path.join(workspaceDir, 'video'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'video', `${VALID_ID}.mp4`), 'bytes');
    await storage.markReady(VALID_ID);

    assert.equal(await storage.getKind(VALID_ID), 'video');
    assert.equal(
      await storage.getLocalPath(VALID_ID),
      path.join(workspaceDir, 'video', `${VALID_ID}.mp4`),
    );
    const resolved = await storage.resolve(VALID_ID);
    assert.equal(resolved?.kind, 'stream');
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
