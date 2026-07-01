// Fast unit tests for `buildUploadLink`'s server-URL validation — no Fastify
// server, no filesystem. PROTOCOL.md §3 requires a client to reject any
// non-https `server` origin except the narrow localhost/private-IP dev
// exception; this validates the one place that constructs the link enforces
// the same rule server-side, instead of relying entirely on every client
// to reimplement the check correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUploadLink } from "../dist/lib/deeplinks.js";

const ARTIFACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("builds a link for an https server", () => {
  const link = buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId: ARTIFACT_ID });
  assert.ok(link.startsWith("pulsecam://?"));
  const params = new URLSearchParams(link.slice("pulsecam://?".length));
  assert.equal(params.get("server"), "https://vault.example.org/pulsevault");
  assert.equal(params.get("artifactId"), ARTIFACT_ID);
  assert.equal(params.get("v"), "1");
});

test("includes the token when provided, omits it when not", () => {
  const withToken = buildUploadLink({
    server: "https://vault.example.org/pulsevault",
    artifactId: ARTIFACT_ID,
    token: "secret",
  });
  assert.ok(new URLSearchParams(withToken.split("?")[1]).get("token") === "secret");

  const withoutToken = buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId: ARTIFACT_ID });
  assert.equal(new URLSearchParams(withoutToken.split("?")[1]).get("token"), null);
});

test("allows http://localhost for local dev", () => {
  assert.doesNotThrow(() =>
    buildUploadLink({ server: "http://localhost:3030/pulsevault", artifactId: ARTIFACT_ID }),
  );
});

test("allows a private-IP-literal http origin for local dev", () => {
  for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.20", "172.16.0.1", "100.64.0.1", "169.254.1.1"]) {
    assert.doesNotThrow(
      () => buildUploadLink({ server: `http://${host}:3030/pulsevault`, artifactId: ARTIFACT_ID }),
      `expected ${host} to be allowed over http`,
    );
  }
});

test("rejects a plaintext http server that isn't localhost/private-IP", () => {
  assert.throws(() => buildUploadLink({ server: "http://vault.example.org/pulsevault", artifactId: ARTIFACT_ID }));
});

test("rejects a public IP over http (not fooled by looking like an IP literal)", () => {
  assert.throws(() => buildUploadLink({ server: "http://8.8.8.8/pulsevault", artifactId: ARTIFACT_ID }));
});

test("rejects a hostname that merely contains 'localhost'", () => {
  assert.throws(() =>
    buildUploadLink({ server: "http://localhost.evil.example/pulsevault", artifactId: ARTIFACT_ID }),
  );
});

test("rejects a malformed server URL", () => {
  assert.throws(() => buildUploadLink({ server: "not a url", artifactId: ARTIFACT_ID }));
});

test("includes uploadUnit when provided, omits it when not", () => {
  const withUnit = buildUploadLink({
    server: "https://vault.example.org/pulsevault",
    artifactId: ARTIFACT_ID,
    uploadUnit: "merged",
  });
  assert.equal(new URLSearchParams(withUnit.split("?")[1]).get("uploadUnit"), "merged");

  const withoutUnit = buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId: ARTIFACT_ID });
  assert.equal(new URLSearchParams(withoutUnit.split("?")[1]).get("uploadUnit"), null);
});

test("accepts both uploadUnit values", () => {
  for (const uploadUnit of ["beat", "merged"]) {
    const link = buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId: ARTIFACT_ID, uploadUnit });
    assert.equal(new URLSearchParams(link.split("?")[1]).get("uploadUnit"), uploadUnit);
  }
});

test("rejects an invalid uploadUnit", () => {
  assert.throws(() =>
    buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId: ARTIFACT_ID, uploadUnit: "bogus" }),
  );
});
