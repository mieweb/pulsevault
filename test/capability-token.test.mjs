// Fast unit tests for the pure capability-token crypto/parsing logic — no
// Fastify server, no filesystem. Complements the integration-level coverage
// in plugin.test.mjs (which exercises `createCapabilityAuthorize` wired into
// real HTTP requests); this file is about the cryptographic/parsing
// correctness in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  issueCapabilityToken,
  verifyCapabilityToken,
  issueViewToken,
  verifyViewToken,
  createCapabilityAuthorize,
} from "../dist/lib/capability-token.js";
import { createViewLinkIssuer } from "../dist/lib/view-links.js";

const ARTIFACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "shh";
const ISSUER = "https://vault.example.test";
const lookupSecret = (kid) => (kid === "k1" ? SECRET : null);

test("issue + verify round-trips the artifactId", () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER });
  const result = verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER });
  assert.deepEqual(result, { artifactId: ARTIFACT_ID });
});

test("rejects a token with a tampered signature", () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER });
  const [payload] = token.split(".");
  const tampered = `${payload}.not-the-real-signature`;
  assert.equal(verifyCapabilityToken(tampered, lookupSecret, { issuer: ISSUER }), null);
});

test("rejects a token with a tampered payload (signature no longer matches)", () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER });
  const [, signature] = token.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({
      artifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1800,
      kid: "k1",
      issuer: ISSUER,
    }),
  ).toString("base64url");
  assert.equal(
    verifyCapabilityToken(`${forgedPayload}.${signature}`, lookupSecret, { issuer: ISSUER }),
    null,
  );
});

test("rejects malformed tokens (no dot, truncated, non-JSON payload, missing claims)", () => {
  const opts = { issuer: ISSUER };
  assert.equal(verifyCapabilityToken("not-a-token", lookupSecret, opts), null);
  assert.equal(verifyCapabilityToken("", lookupSecret, opts), null);
  assert.equal(verifyCapabilityToken(".", lookupSecret, opts), null);
  const notJson = Buffer.from("not json").toString("base64url");
  assert.equal(verifyCapabilityToken(`${notJson}.sig`, lookupSecret, opts), null);
  const missingClaims = Buffer.from(JSON.stringify({ artifactId: ARTIFACT_ID })).toString("base64url");
  assert.equal(verifyCapabilityToken(`${missingClaims}.sig`, lookupSecret, opts), null);
  // Valid JSON that isn't an object (the literal `null`) must return null like
  // every other malformed token — not throw on the claims property access.
  const nullPayload = Buffer.from(JSON.stringify(null)).toString("base64url");
  assert.equal(verifyCapabilityToken(`${nullPayload}.sig`, lookupSecret, opts), null);
});

test("createCapabilityAuthorize accepts the Bearer scheme case-insensitively (RFC 7235)", async () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER });
  const authorize = createCapabilityAuthorize(lookupSecret, { issuer: ISSUER });
  for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
    await assert.doesNotReject(
      () =>
        authorize(
          { headers: { authorization: `${scheme} ${token}` } },
          { phase: "resolve", artifactId: ARTIFACT_ID },
        ),
      `scheme "${scheme}" should be accepted`,
    );
  }
});

test("rejects an unknown kid", () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "unknown-key", issuer: ISSUER });
  assert.equal(verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER }), null);
});

test("rejects an expired token, accepts one within the clock-tolerance window", () => {
  const expired = issueCapabilityToken(ARTIFACT_ID, SECRET, {
    keyId: "k1",
    issuer: ISSUER,
    expirySeconds: -120,
  });
  assert.equal(verifyCapabilityToken(expired, lookupSecret, { issuer: ISSUER }), null);

  // Expired 10s ago, but within a 30s tolerance — should still verify.
  const barelyExpired = issueCapabilityToken(ARTIFACT_ID, SECRET, {
    keyId: "k1",
    issuer: ISSUER,
    expirySeconds: -10,
  });
  assert.deepEqual(
    verifyCapabilityToken(barelyExpired, lookupSecret, { issuer: ISSUER, clockToleranceSeconds: 30 }),
    { artifactId: ARTIFACT_ID },
  );
});

test("rejects a token issued too far in the future (clock-skew guard)", () => {
  // Simulate by hand-crafting claims with iat far in the future — issueCapabilityToken
  // always uses Date.now(), so we sign the payload ourselves to test the boundary.
  const claims = {
    artifactId: ARTIFACT_ID,
    iat: Math.floor(Date.now() / 1000) + 600,
    exp: Math.floor(Date.now() / 1000) + 2400,
    kid: "k1",
    issuer: ISSUER,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
  assert.equal(verifyCapabilityToken(`${payload}.${signature}`, lookupSecret, { issuer: ISSUER }), null);
});

test("rejects a token issued under a different issuer", () => {
  const token = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: "https://other.example" });
  assert.equal(verifyCapabilityToken(token, lookupSecret, { issuer: ISSUER }), null);
});

test("key rotation: old and new kid both verify when lookupSecret recognizes both", () => {
  const lookup = (kid) => ({ old: "old-secret", new: "new-secret" })[kid] ?? null;
  const oldToken = issueCapabilityToken(ARTIFACT_ID, "old-secret", { keyId: "old", issuer: ISSUER });
  const newToken = issueCapabilityToken(ARTIFACT_ID, "new-secret", { keyId: "new", issuer: ISSUER });
  assert.deepEqual(verifyCapabilityToken(oldToken, lookup, { issuer: ISSUER }), { artifactId: ARTIFACT_ID });
  assert.deepEqual(verifyCapabilityToken(newToken, lookup, { issuer: ISSUER }), { artifactId: ARTIFACT_ID });
});

// ---------- view tokens (protocol 2.2) ----------

const RELATED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const viewOpts = { keyId: "k1", issuer: ISSUER, expirySeconds: 60 };
const nowSeconds = () => Math.floor(Date.now() / 1000);

test("a view token verifies as a view token, and is never an upload capability", () => {
  const view = issueViewToken(ARTIFACT_ID, SECRET, viewOpts);
  const verified = verifyViewToken(view, lookupSecret, { issuer: ISSUER });
  assert.equal(verified.artifactId, ARTIFACT_ID);
  assert.ok(Math.abs(verified.exp - (nowSeconds() + 60)) <= 1);
  assert.equal(verifyCapabilityToken(view, lookupSecret, { issuer: ISSUER }), null);

  const upload = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER });
  assert.equal(verifyViewToken(upload, lookupSecret, { issuer: ISSUER }), null);
});

test("a verifier that predates view tokens rejects one: it isn't signed with the secret itself", () => {
  const [payload, signature] = issueViewToken(ARTIFACT_ID, SECRET, viewOpts).split(".");
  // What a pre-2.2 `verifyCapabilityToken` compares the signature against.
  const legacySignature = createHmac("sha256", SECRET).update(payload).digest("base64url");
  assert.notEqual(signature, legacySignature);
});

test("a token claiming `use: view` but signed with the secret itself is neither kind", () => {
  const payload = Buffer.from(
    JSON.stringify({
      artifactId: ARTIFACT_ID,
      iat: nowSeconds(),
      exp: nowSeconds() + 60,
      kid: "k1",
      issuer: ISSUER,
      use: "view",
    }),
  ).toString("base64url");
  const forged = `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
  assert.equal(verifyCapabilityToken(forged, lookupSecret, { issuer: ISSUER }), null);
  assert.equal(verifyViewToken(forged, lookupSecret, { issuer: ISSUER }), null);
});

test("issueViewToken needs a lifetime of at least a second — PulseVault sets none of its own", () => {
  for (const expirySeconds of [0, 0.5, -1, Number.NaN, Infinity, undefined]) {
    assert.throws(
      () => issueViewToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER, expirySeconds }),
      TypeError,
    );
  }
});

test("createCapabilityAuthorize: a view token opens its artifact and related ones, and does nothing else", async () => {
  const authorize = createCapabilityAuthorize(lookupSecret, { issuer: ISSUER });
  const view = issueViewToken(ARTIFACT_ID, SECRET, viewOpts);
  const asView = { headers: { authorization: `Bearer ${view}` } };

  // As a watch link's `?token=`, and as a header.
  await authorize({ headers: {} }, { phase: "resolve", artifactId: ARTIFACT_ID, token: view });
  await authorize(asView, { phase: "resolve", artifactId: RELATED_ID, relatedTo: ARTIFACT_ID });

  for (const phase of ["create", "patch", "delete", "share"]) {
    await assert.rejects(
      () => authorize(asView, { phase, artifactId: ARTIFACT_ID }),
      { statusCode: 403 },
      `a view token must not authorize "${phase}"`,
    );
  }

  // Minting a view link takes the upload capability itself.
  const upload = issueCapabilityToken(ARTIFACT_ID, SECRET, { keyId: "k1", issuer: ISSUER });
  await authorize(
    { headers: { authorization: `Bearer ${upload}` } },
    { phase: "share", artifactId: ARTIFACT_ID },
  );
});

test("createViewLinkIssuer: the host decides each link's lifetime, or refuses the link", async () => {
  const seen = [];
  const issue = createViewLinkIssuer({
    keyId: "k1",
    secret: SECRET,
    issuer: ISSUER,
    expirySeconds: async (_request, ctx) => {
      seen.push(ctx);
      return ctx.kind === "video" ? 3600 : null;
    },
  });

  const link = await issue({ headers: {} }, { artifactId: ARTIFACT_ID, kind: "video" });
  const verified = verifyViewToken(link.token, lookupSecret, { issuer: ISSUER });
  assert.equal(verified.artifactId, ARTIFACT_ID);
  assert.equal(link.expiresAt, verified.exp, "expiresAt is the token's own exp");
  assert.ok(Math.abs(link.expiresAt - (nowSeconds() + 3600)) <= 1);

  const refused = await issue(
    { headers: {} },
    { artifactId: RELATED_ID, kind: "captions", relatedTo: ARTIFACT_ID },
  );
  assert.equal(refused, null);
  assert.deepEqual(seen, [
    { artifactId: ARTIFACT_ID, kind: "video" },
    { artifactId: RELATED_ID, kind: "captions", relatedTo: ARTIFACT_ID },
  ]);

  const fixed = createViewLinkIssuer({ keyId: "k1", secret: SECRET, issuer: ISSUER, expirySeconds: 90 });
  const fixedLink = await fixed({ headers: {} }, { artifactId: ARTIFACT_ID, kind: "video" });
  assert.ok(Math.abs(fixedLink.expiresAt - (nowSeconds() + 90)) <= 1);
});

test("createViewLinkIssuer refuses a fixed lifetime that can't work, when it's set up", () => {
  for (const expirySeconds of [Number.NaN, 0, 0.5, -60, Infinity, "3600", undefined]) {
    assert.throws(
      () => createViewLinkIssuer({ keyId: "k1", secret: SECRET, issuer: ISSUER, expirySeconds }),
      TypeError,
    );
  }
  assert.doesNotThrow(() =>
    createViewLinkIssuer({ keyId: "k1", secret: SECRET, issuer: ISSUER, expirySeconds: () => 60 }),
  );
});
