// Fast unit tests for the pure capability-token crypto/parsing logic — no
// Fastify server, no filesystem. Complements the integration-level coverage
// in plugin.test.mjs (which exercises `createCapabilityAuthorize` wired into
// real HTTP requests); this file is about the cryptographic/parsing
// correctness in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { issueCapabilityToken, verifyCapabilityToken } from '../dist/lib/capability-token.js';

const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'shh';
const ISSUER = 'https://vault.example.test';
const lookupSecret = (kid) => (kid === 'k1' ? SECRET : null);

test('issue + verify round-trips the artifactId (unscoped token → scope null)', () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: 'k1', issuer: ISSUER });
  const result = verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER });
  assert.deepEqual(result, { artifactId: ARTIFACT_ID, scope: null });
});

test('scope claim round-trips; malformed scope is rejected outright', () => {
  const scoped = issueCapabilityToken(ARTIFACT_ID, SECRET, {
    keyId: 'k1',
    issuer: ISSUER,
    scope: ['resolve'],
  });
  assert.deepEqual(verifyCapabilityToken(scoped, lookupSecret, { issuer: ISSUER }), {
    artifactId: ARTIFACT_ID,
    scope: ['resolve'],
  });

  // A present-but-malformed scope must fail closed, not be treated as unrestricted.
  const now = Math.floor(Date.now() / 1000);
  for (const badScope of ['resolve', ['resolve', 'launch-missiles'], 42, {}]) {
    const payload = Buffer.from(
      JSON.stringify({
        artifactId: ARTIFACT_ID,
        iat: now,
        exp: now + 1800,
        kid: 'k1',
        issuer: ISSUER,
        scope: badScope,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(payload).digest('base64url');
    assert.equal(
      verifyCapabilityToken(`${payload}.${signature}`, lookupSecret, { issuer: ISSUER }),
      null,
      `scope ${JSON.stringify(badScope)} must be rejected`,
    );
  }
});

test('rejects a token with a tampered signature', () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: 'k1', issuer: ISSUER });
  const [payload] = token.split('.');
  const tampered = `${payload}.not-the-real-signature`;
  assert.equal(verifyCapabilityToken(tampered, lookupSecret, { issuer: ISSUER }), null);
});

test('rejects a token with a tampered payload (signature no longer matches)', () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: 'k1', issuer: ISSUER });
  const [, signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({
      artifactId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1800,
      kid: 'k1',
      issuer: ISSUER,
    }),
  ).toString('base64url');
  assert.equal(
    verifyCapabilityToken(`${forgedPayload}.${signature}`, lookupSecret, { issuer: ISSUER }),
    null,
  );
});

test('rejects malformed tokens (no dot, truncated, non-JSON payload, missing claims)', () => {
  const opts = { issuer: ISSUER };
  assert.equal(verifyCapabilityToken('not-a-token', lookupSecret, opts), null);
  assert.equal(verifyCapabilityToken('', lookupSecret, opts), null);
  assert.equal(verifyCapabilityToken('.', lookupSecret, opts), null);
  const notJson = Buffer.from('not json').toString('base64url');
  assert.equal(verifyCapabilityToken(`${notJson}.sig`, lookupSecret, opts), null);
  const missingClaims = Buffer.from(JSON.stringify({ artifactId: ARTIFACT_ID })).toString(
    'base64url',
  );
  assert.equal(verifyCapabilityToken(`${missingClaims}.sig`, lookupSecret, opts), null);
});

test('rejects an unknown kid', () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: 'unknown-key', issuer: ISSUER });
  assert.equal(verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER }), null);
});

test('rejects an expired token, accepts one within the clock-tolerance window', () => {
  const expired = issueCapabilityToken(ARTIFACT_ID, SECRET, {
    keyId: 'k1',
    issuer: ISSUER,
    expirySeconds: -120,
  });
  assert.equal(verifyCapabilityToken(expired, lookupSecret, { issuer: ISSUER }), null);

  // Expired 10s ago, but within a 30s tolerance — should still verify.
  const barelyExpired = issueCapabilityToken(ARTIFACT_ID, SECRET, {
    keyId: 'k1',
    issuer: ISSUER,
    expirySeconds: -10,
  });
  assert.deepEqual(
    verifyCapabilityToken(barelyExpired, lookupSecret, {
      issuer: ISSUER,
      clockToleranceSeconds: 30,
    }),
    { artifactId: ARTIFACT_ID, scope: null },
  );
});

test('rejects a token issued too far in the future (clock-skew guard)', () => {
  // Simulate by hand-crafting claims with iat far in the future — issueCapabilityToken
  // always uses Date.now(), so we sign the payload ourselves to test the boundary.
  const claims = {
    artifactId: ARTIFACT_ID,
    iat: Math.floor(Date.now() / 1000) + 600,
    exp: Math.floor(Date.now() / 1000) + 2400,
    kid: 'k1',
    issuer: ISSUER,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(payload).digest('base64url');
  assert.equal(
    verifyCapabilityToken(`${payload}.${signature}`, lookupSecret, { issuer: ISSUER }),
    null,
  );
});

test('rejects a token issued under a different issuer', () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, {
    keyId: 'k1',
    issuer: 'https://other.example',
  });
  assert.equal(verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER }), null);
});

test('key rotation: old and new kid both verify when lookupSecret recognizes both', () => {
  const lookup = (kid) => ({ old: 'old-secret', new: 'new-secret' })[kid] ?? null;
  const oldToken = issueCapabilityToken(ARTIFACT_ID, 'old-secret', {
    keyId: 'old',
    issuer: ISSUER,
  });
  const newToken = issueCapabilityToken(ARTIFACT_ID, 'new-secret', {
    keyId: 'new',
    issuer: ISSUER,
  });
  assert.deepEqual(verifyCapabilityToken(oldToken, lookup, { issuer: ISSUER }), {
    artifactId: ARTIFACT_ID,
    scope: null,
  });
  assert.deepEqual(verifyCapabilityToken(newToken, lookup, { issuer: ISSUER }), {
    artifactId: ARTIFACT_ID,
    scope: null,
  });
});
