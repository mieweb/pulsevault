// Fast unit tests for checksum parsing/verification logic. The local-path
// validator is exercised against a real temp file (cheap, no Fastify
// server); the S3 validator is exercised against a hand-rolled fake storage
// object since it only needs `readAll`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseChecksumMetadata,
  createChecksumValidator,
  createS3ChecksumValidator,
} from '../dist/lib/checksum.js';

test('parseChecksumMetadata accepts well-formed values, rejects everything else', () => {
  assert.deepEqual(parseChecksumMetadata('sha256:abcd1234'), {
    algorithm: 'sha256',
    digest: 'abcd1234',
  });
  assert.deepEqual(parseChecksumMetadata('SHA1:ABCD'), { algorithm: 'sha1', digest: 'abcd' });
  assert.equal(parseChecksumMetadata(undefined), null);
  assert.equal(parseChecksumMetadata(null), null);
  assert.equal(parseChecksumMetadata(''), null);
  assert.equal(parseChecksumMetadata('nocolon'), null);
  assert.equal(parseChecksumMetadata('md7:abcd'), null, 'unsupported algorithm');
  assert.equal(parseChecksumMetadata('sha256:not-hex!'), null);
  assert.equal(parseChecksumMetadata('sha256:'), null, 'empty digest');
});

test('createChecksumValidator accepts a matching digest via localPath', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-checksum-'));
  try {
    const file = path.join(dir, 'clip.mp4');
    const bytes = Buffer.from('hello world');
    await fs.writeFile(file, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');

    const validator = createChecksumValidator();
    await assert.doesNotReject(() =>
      validator(
        {},
        {
          artifactId: 'id',
          size: bytes.length,
          uploadId: 'u1',
          localPath: file,
          checksum: `sha256:${digest}`,
        },
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createChecksumValidator rejects a mismatched digest with a 422', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-checksum-'));
  try {
    const file = path.join(dir, 'clip.mp4');
    await fs.writeFile(file, Buffer.from('hello world'));

    const validator = createChecksumValidator();
    await assert.rejects(
      () =>
        validator(
          {},
          {
            artifactId: 'id',
            size: 11,
            uploadId: 'u1',
            localPath: file,
            checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        ),
      (err) => {
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createChecksumValidator passes through (no-op) when no checksum metadata is present', async () => {
  let nextCalled = false;
  const validator = createChecksumValidator(async () => {
    nextCalled = true;
  });
  await validator({}, { artifactId: 'id', size: 0, uploadId: 'u1', localPath: null });
  assert.equal(nextCalled, true, 'chained validator still runs when checksum is absent');
});

test('createChecksumValidator throws a clear error when checksum is requested but localPath is unavailable', async () => {
  const validator = createChecksumValidator();
  await assert.rejects(() =>
    validator(
      {},
      { artifactId: 'id', size: 0, uploadId: 'u1', localPath: null, checksum: 'sha256:abcd' },
    ),
  );
});

test('createS3ChecksumValidator verifies against storage.digestAll', async () => {
  const bytes = Buffer.from('s3 object bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const fakeStorage = {
    digestAll: async (_id, algorithm) => createHash(algorithm).update(bytes).digest('hex'),
  };

  const validator = createS3ChecksumValidator(fakeStorage);
  await assert.doesNotReject(() =>
    validator(
      {},
      {
        artifactId: 'id',
        size: bytes.length,
        uploadId: 'u1',
        localPath: null,
        checksum: `sha256:${digest}`,
      },
    ),
  );

  await assert.rejects(() =>
    validator(
      {},
      {
        artifactId: 'id',
        size: bytes.length,
        uploadId: 'u1',
        localPath: null,
        checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    ),
  );
});
