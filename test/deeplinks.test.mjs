// Fast unit tests for `buildUploadLink`'s server-URL validation — no Fastify
// server, no filesystem. PROTOCOL.md §3 requires a client to reject any
// non-https `server` origin except the narrow localhost/private-IP dev
// exception; this validates the one place that constructs the link enforces
// the same rule server-side, instead of relying entirely on every client
// to reimplement the check correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUploadLink, PULSE_OPEN_URL } from "../dist/lib/deeplinks.js";
import { issueCapabilityToken } from "../dist/lib/capability-token.js";

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

test("never carries an uploadUnit param, even if one is passed", () => {
  const params = (link) => new URLSearchParams(link.split("?")[1]);
  const plain = buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId: ARTIFACT_ID });
  assert.equal(params(plain).get("uploadUnit"), null);

  // A stale caller still passing the removed field gets a link without it.
  const stale = buildUploadLink({
    server: "https://vault.example.org/pulsevault",
    artifactId: ARTIFACT_ID,
    uploadUnit: "merged",
  });
  assert.equal(params(stale).get("uploadUnit"), null);
  assert.deepEqual([...params(stale).keys()].sort(), ["artifactId", "server", "v"]);
});

// The https form (PROTOCOL.md §3): the same parameters as `pulsecam://`, in the fragment of a
// link on the host the Pulse app claims.
const HTTPS_OPTS = {
  server: "https://vault.example.org/pulsevault",
  artifactId: ARTIFACT_ID,
  token: "a.b+c/d=", // the characters that break a hand-rolled query string
};

test("form 'https' builds the link on the fixed link host, parameters in the fragment", () => {
  assert.equal(PULSE_OPEN_URL, "https://mieweb.github.io/pulse/open");
  const link = new URL(buildUploadLink({ ...HTTPS_OPTS, form: "https" }));
  assert.equal(link.origin + link.pathname, PULSE_OPEN_URL);
  assert.equal(link.search, "", "nothing in the query string, which the link host would receive");
  const params = new URLSearchParams(link.hash.slice(1));
  assert.equal(params.get("v"), "1");
  assert.equal(params.get("artifactId"), ARTIFACT_ID);
  assert.equal(params.get("server"), HTTPS_OPTS.server);
  assert.equal(params.get("token"), HTTPS_OPTS.token);
});

test("form 'https' carries exactly the parameters of the pulsecam form", () => {
  const https = buildUploadLink({ ...HTTPS_OPTS, form: "https" });
  const pulsecam = buildUploadLink(HTTPS_OPTS);
  assert.equal(https.slice(https.indexOf("#") + 1), pulsecam.slice(pulsecam.indexOf("?") + 1));
});

test("no form and form 'pulsecam' build the same link", () => {
  assert.equal(buildUploadLink(HTTPS_OPTS), buildUploadLink({ ...HTTPS_OPTS, form: "pulsecam" }));
});

test("form 'https' validates the server like the pulsecam form", () => {
  assert.throws(() =>
    buildUploadLink({ server: "http://vault.example.org/pulsevault", artifactId: ARTIFACT_ID, form: "https" }),
  );
});

test("rejects an unknown form", () => {
  for (const form of ["http", "HTTPS", "", null]) {
    assert.throws(() => buildUploadLink({ ...HTTPS_OPTS, form }), /`form` must be/, `expected ${form} to throw`);
  }
});

// ---------- link hints (protocol 2.7, PROTOCOL.md §3.1) ----------

const SERVER = "https://vault.example.org/pulsevault";
const paramsOf = (link) => Object.fromEntries(new URLSearchParams(link.slice(link.search(/[?#]/) + 1)));
const tokenFor = (ref) => issueCapabilityToken(ARTIFACT_ID, "secret", { keyId: "k1", issuer: "vault", ...(ref ? { ref } : {}) });
const T = tokenFor("u1:ticket:t1");
const HINTED = { server: SERVER, artifactId: ARTIFACT_ID, token: T, ref: "u1:ticket:t1" };

test("a link without hints is byte for byte the link it always was", () => {
  assert.equal(
    buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t" }),
    `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=https%3A%2F%2Fvault.example.org%2Fpulsevault&token=t`,
  );
  assert.equal(
    buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, form: "https" }),
    `${PULSE_OPEN_URL}#v=1&artifactId=${ARTIFACT_ID}&server=https%3A%2F%2Fvault.example.org%2Fpulsevault`,
  );
  // Hints that are undefined or blank add nothing either.
  assert.equal(
    buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t", ref: undefined, label: "  ", name: "", app: undefined, returnUrl: undefined }),
    buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t" }),
  );
});

test("hints follow the v1 params in a fixed order, in both forms", () => {
  const opts = {
    ...HINTED,
    label: "Fix the login page",
    name: "Login fix walkthrough",
    app: "TimeHuddle",
    returnUrl: "https://app.example.org/tickets/t1?tab=video",
  };
  const expected = [
    ["v", "1"],
    ["artifactId", ARTIFACT_ID],
    ["server", SERVER],
    ["token", T],
    ["ref", "u1:ticket:t1"],
    ["label", "Fix the login page"],
    ["name", "Login fix walkthrough"],
    ["app", "TimeHuddle"],
    ["return", "https://app.example.org/tickets/t1?tab=video"],
  ];
  assert.deepEqual(Object.entries(paramsOf(buildUploadLink(opts))), expected);
  assert.deepEqual(Object.entries(paramsOf(buildUploadLink({ ...opts, form: "https" }))), expected);
});

test("label, name and app are trimmed and capped at 60, 80 and 30 characters; blank ones are dropped", () => {
  const params = paramsOf(
    buildUploadLink({ ...HINTED, label: ` ${"L".repeat(80)} `, name: ` ${"N".repeat(100)} `, app: "A".repeat(40) }),
  );
  assert.equal(params.label, "L".repeat(60));
  assert.equal(params.name, "N".repeat(80));
  assert.equal(params.app, "A".repeat(30));
  // Capped by code point: an emoji at the boundary is kept whole or not at all.
  assert.equal(paramsOf(buildUploadLink({ ...HINTED, app: `${"A".repeat(29)}😀😀` })).app, `${"A".repeat(29)}😀`);
  const blank = paramsOf(buildUploadLink({ ...HINTED, label: "   ", name: "", app: " " }));
  assert.deepEqual(Object.keys(blank), ["v", "artifactId", "server", "token", "ref"]);
});

test("the display hints need no ref: they are unsigned and stand alone", () => {
  const params = paramsOf(buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "opaque", name: "Huddle update", app: "TimeHuddle" }));
  assert.equal(params.name, "Huddle update");
  assert.equal(params.app, "TimeHuddle");
  assert.equal("ref" in params, false);
});

test("the link's ref must be the ref signed into its token", () => {
  const bound = /`ref` must be the `ref` signed into `token`/;
  assert.ok(buildUploadLink(HINTED));
  // Another place's token, a token with no ref, an opaque token, no token at all.
  assert.throws(() => buildUploadLink({ ...HINTED, token: tokenFor("u2:ticket:t1") }), bound);
  assert.throws(() => buildUploadLink({ ...HINTED, token: tokenFor() }), bound);
  assert.throws(() => buildUploadLink({ ...HINTED, token: "opaque" }), bound);
  assert.throws(() => buildUploadLink({ ...HINTED, token: "bnVsbA.sig" }), bound);
  assert.throws(() => buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, ref: "u1:ticket:t1" }), bound);
  // A token may carry a ref the link doesn't mention.
  assert.equal("ref" in paramsOf(buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: T })), false);
});

test("ref is 1 to 200 characters", () => {
  assert.throws(() => buildUploadLink({ ...HINTED, ref: "" }), /`ref` must be 1 to 200 characters/);
  assert.throws(() => buildUploadLink({ ...HINTED, ref: "x".repeat(201) }), /`ref` must be 1 to 200 characters/);
  const long = "x".repeat(200);
  assert.equal(paramsOf(buildUploadLink({ ...HINTED, token: tokenFor(long), ref: long })).ref, long);
});

test("returnUrl is held to the server's rule: https, or http to localhost or a private IP", () => {
  assert.throws(() => buildUploadLink({ ...HINTED, returnUrl: "http://evil.example.com/" }), /`returnUrl` must be https/);
  assert.throws(() => buildUploadLink({ ...HINTED, returnUrl: "javascript:alert(1)" }), /`returnUrl` must be https/);
  assert.throws(() => buildUploadLink({ ...HINTED, returnUrl: "not a url" }), /`returnUrl` is not a valid URL/);
  assert.equal(paramsOf(buildUploadLink({ ...HINTED, returnUrl: "http://localhost:3000/x" })).return, "http://localhost:3000/x");
});
