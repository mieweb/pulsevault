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
const ENCODED_SERVER = "https%3A%2F%2Fvault.example.org%2Fpulsevault";
const rawParams = (link) => link.slice(link.search(/[?#]/) + 1);
const paramsOf = (link) => Object.fromEntries(new URLSearchParams(rawParams(link)));
// The place's key rides in the token's signed `ref` claim, never as a link param.
const T = issueCapabilityToken(ARTIFACT_ID, "secret", { keyId: "k1", issuer: "vault", ref: "u1:ticket:t1" });
const BASE = { server: SERVER, artifactId: ARTIFACT_ID, token: T };
const hint = (opts, key) => paramsOf(buildUploadLink({ ...BASE, ...opts }))[key];

test("a link without hints is byte for byte the link it always was", () => {
  const plain = `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${ENCODED_SERVER}&token=t`;
  assert.equal(buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t" }), plain);
  assert.equal(
    buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, form: "https" }),
    `${PULSE_OPEN_URL}#v=1&artifactId=${ARTIFACT_ID}&server=${ENCODED_SERVER}`,
  );
  // Hints that are undefined, null, blank, invisible or not text add nothing either, so a
  // nullable title is safe to pass.
  for (const none of [undefined, null, "", "  ", "\t\n", "\u200B\u200E\u202E", "\uFEFF", 42, { a: 1 }, ["x"]]) {
    assert.equal(
      buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t", label: none, name: none, app: none }),
      plain,
      JSON.stringify(none),
    );
  }
  // The same for a return URL that is absent, blank or not text; one that is wrong still throws.
  for (const none of [undefined, null, "", "  ", "\t\n", 42, { a: 1 }]) {
    assert.equal(
      buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t", returnUrl: none }),
      plain,
      JSON.stringify(none),
    );
  }
});

test("hints follow the v1 params in a fixed order, in both forms", () => {
  const opts = {
    ...BASE,
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
    ["label", "Fix the login page"],
    ["name", "Login fix walkthrough"],
    ["app", "TimeHuddle"],
    ["return", "https://app.example.org/tickets/t1?tab=video"],
  ];
  assert.deepEqual(Object.entries(paramsOf(buildUploadLink(opts))), expected);
  assert.deepEqual(Object.entries(paramsOf(buildUploadLink({ ...opts, form: "https" }))), expected);
});

test("hints are form-urlencoded UTF-8 on the wire, the same in both forms", () => {
  const opts = {
    server: SERVER,
    artifactId: ARTIFACT_ID,
    token: "t",
    label: "Q&A = 100% #1 + more",
    name: "Café ☕",
    app: "T&H",
    returnUrl: "https://app.example.org/t?a=1&b=2#f",
  };
  const wire =
    `v=1&artifactId=${ARTIFACT_ID}&server=${ENCODED_SERVER}&token=t` +
    "&label=Q%26A+%3D+100%25+%231+%2B+more&name=Caf%C3%A9+%E2%98%95&app=T%26H" +
    "&return=https%3A%2F%2Fapp.example.org%2Ft%3Fa%3D1%26b%3D2%23f";
  assert.equal(buildUploadLink(opts), `pulsecam://?${wire}`);
  // In the https form the hints, and a `#` inside one, stay inside the one fragment.
  const https = buildUploadLink({ ...opts, form: "https" });
  assert.equal(https, `${PULSE_OPEN_URL}#${wire}`);
  assert.equal(new URL(https).hash, `#${wire}`);
  assert.equal(paramsOf(https).label, opts.label);
  assert.equal(paramsOf(https).return, opts.returnUrl);
});

test("the place's key is only in the token: a link never carries a ref param", () => {
  const params = paramsOf(buildUploadLink({ ...BASE, label: "Fix the login page", ref: "u1:ticket:t1" }));
  assert.equal("ref" in params, false);
  const claims = JSON.parse(Buffer.from(params.token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(claims.ref, "u1:ticket:t1", "where a client reads it");
});

test("label, name and app are trimmed and cut at 60, 80 and 30 characters", () => {
  const params = paramsOf(
    buildUploadLink({ ...BASE, label: ` ${"L".repeat(80)} `, name: ` ${"N".repeat(100)} `, app: "A".repeat(40) }),
  );
  assert.equal(params.label, "L".repeat(60));
  assert.equal(params.name, "N".repeat(80));
  assert.equal(params.app, "A".repeat(30));
  // A character is a code point: 30 emoji fit, though they are 60 UTF-16 units.
  assert.equal(hint({ app: "😀".repeat(31) }, "app"), "😀".repeat(30));
  assert.equal(hint({ app: `${"A".repeat(29)}😀😀` }, "app"), `${"A".repeat(29)}😀`);
  // A space the cut would leave at the end is trimmed too.
  assert.equal(hint({ app: `${"A".repeat(29)} B` }, "app"), "A".repeat(29));
});

test("a hint is cut at a whole character: never through an emoji sequence, a flag or an accent", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // one character on screen, five code points
  assert.equal(hint({ app: `${"A".repeat(25)}${family}` }, "app"), `${"A".repeat(25)}${family}`);
  assert.equal(hint({ app: `${"A".repeat(27)}${family}` }, "app"), "A".repeat(27));
  assert.equal(hint({ app: `${"A".repeat(29)}\u{1F1FA}\u{1F1F8}` }, "app"), "A".repeat(29));
  assert.equal(hint({ app: `${"A".repeat(29)}e\u0301` }, "app"), "A".repeat(29));
  assert.equal(hint({ app: `${"A".repeat(28)}e\u0301` }, "app"), `${"A".repeat(28)}e\u0301`);
  // One character that is longer than the cap by itself can't be cut: no hint.
  const stacked = `e${"\u0301".repeat(40)}`;
  assert.equal(hint({ app: stacked }, "app"), undefined);
  assert.equal(hint({ app: `Hi ${stacked}` }, "app"), "Hi");
});

test("a hint that is blank once cut is left out, like one that is blank as given", () => {
  // Sixty zero-width characters take the whole cap; the visible text after them is cut away.
  for (const invisible of ["\u200B", "\u2060"]) {
    const params = paramsOf(buildUploadLink({ ...BASE, label: `${invisible.repeat(60)}Fix the login page` }));
    assert.deepEqual(Object.keys(params), ["v", "artifactId", "server", "token"]);
  }
  assert.equal(hint({ label: `${"\u200B".repeat(59)}Fix the login page` }, "label"), `${"\u200B".repeat(59)}F`);
});

test("an unpaired surrogate in a hint goes out as U+FFFD, the way every URL encoder writes it", () => {
  const link = buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "t", label: "a\uD83Db" });
  assert.equal(rawParams(link).split("&").at(-1), "label=a%EF%BF%BDb");
  assert.equal(paramsOf(link).label, "a\uFFFDb");
});

test("a hint is one line of plain text: control and bidi-formatting characters don't reach the link", () => {
  // Line breaks, tabs and other controls (C0, DEL, C1, U+2028/9) become one space.
  assert.equal(hint({ label: "Fix\r\nthe\tlogin\u0000page\u0085now\u2028ok\u007F" }, "label"), "Fix the login page now ok");
  // Bidi overrides, isolates and marks are dropped, so a name can't be shown reversed.
  assert.equal(hint({ label: "invoice\u202Egnp.exe" }, "label"), "invoicegnp.exe");
  assert.equal(hint({ app: "\u2066Time\u200FHuddle\u2069\u061C" }, "app"), "TimeHuddle");
  // What scripts and emoji need stays: joiners, variation selectors, right-to-left text itself.
  for (const kept of ["می\u200Cخواهم", "❤\uFE0F", "שלום", "مرحبا"]) assert.equal(hint({ label: kept }, "label"), kept);
  // Nothing left to show: no param.
  const blank = paramsOf(buildUploadLink({ ...BASE, label: "\u202E\u200B", name: "\u0000\u0007", app: " \u2067 " }));
  assert.deepEqual(Object.keys(blank), ["v", "artifactId", "server", "token"]);
});

test("the builder writes each hint it is given, though a client acts on them only with a ref", () => {
  const named = paramsOf(buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, token: "opaque", name: "Huddle update" }));
  assert.deepEqual(Object.keys(named), ["v", "artifactId", "server", "token", "name"]);
  const labelled = paramsOf(buildUploadLink({ server: SERVER, artifactId: ARTIFACT_ID, label: "Team · Huddle" }));
  assert.deepEqual(Object.keys(labelled), ["v", "artifactId", "server", "label"]);
});

test("returnUrl is held to the server's rule: https, or http to localhost or a private IP", () => {
  for (const bad of ["http://evil.example.com/", "javascript:alert(1)", "data:text/html,x", "intent://x#Intent;end", "pulsecam://?v=1", "http://localhost.evil.example/", "http://8.8.8.8/"]) {
    assert.throws(() => buildUploadLink({ ...BASE, returnUrl: bad }), /`returnUrl` must be https/, bad);
  }
  for (const bad of ["not a url", "//app.example.org/x", "https://"]) {
    assert.throws(() => buildUploadLink({ ...BASE, returnUrl: bad }), /`returnUrl` is not a valid URL/, bad);
  }
  for (const dev of ["http://localhost:3000/x", "http://127.0.0.1:3000/x", "http://192.168.1.20:3000/x", "http://10.0.0.5/x"]) {
    assert.equal(hint({ returnUrl: dev }, "return"), dev);
  }
  // The dev exception is the server's, no wider: not IPv6 loopback, not the rest of 127/8.
  for (const bad of ["http://[::1]:3000/x", "http://127.0.0.2/x", "http://localhost./x"]) {
    assert.throws(() => buildUploadLink({ ...BASE, returnUrl: bad }), /`returnUrl` must be https/, bad);
  }
  // An IPv4 address written as a number is judged, and sent, as the address it is.
  assert.equal(hint({ returnUrl: "http://2130706433/x" }, "return"), "http://127.0.0.1/x");
  assert.equal(hint({ returnUrl: "http://0x7f.1/x" }, "return"), "http://127.0.0.1/x");
  assert.equal(hint({ returnUrl: "http://3232235796:3000/x" }, "return"), "http://192.168.1.20:3000/x");
  assert.throws(() => buildUploadLink({ ...BASE, returnUrl: "http://134744072/x" }), /`returnUrl` must be https/, "8.8.8.8");
});

test("returnUrl goes into the link as the URL parser reads it, so every client reads the same URL", () => {
  for (const [given, sent] of [
    ["https://app.example.org", "https://app.example.org/"],
    ["  https://app.example.org/x \n", "https://app.example.org/x"],
    ["HTTPS://App.Example.ORG/Tickets/42", "https://app.example.org/Tickets/42"],
    ["https://app.exa\nmple.org/x", "https://app.example.org/x"],
    ["https:\\\\app.example.org\\x", "https://app.example.org/x"],
    ["https:app.example.org", "https://app.example.org/"],
    ["https://exämple.org/a b?q=ü", "https://xn--exmple-cua.org/a%20b?q=%C3%BC"],
    ["https://app.example.org:443/x#top", "https://app.example.org/x#top"],
  ]) {
    assert.equal(hint({ returnUrl: given }, "return"), sent, given);
  }
});

test("returnUrl carries no username or password, and is at most 512 characters", () => {
  for (const bad of ["https://app.example.org@evil.example/x", "https://user:pass@app.example.org/", "https://:pass@app.example.org/"]) {
    assert.throws(() => buildUploadLink({ ...BASE, returnUrl: bad }), /`returnUrl` must not carry a username or password/, bad);
  }
  const prefix = "https://app.example.org/";
  const longest = prefix + "a".repeat(512 - prefix.length);
  assert.equal(hint({ returnUrl: longest }, "return"), longest);
  assert.throws(() => buildUploadLink({ ...BASE, returnUrl: `${longest}a` }), /`returnUrl` must be at most 512 characters \(got 513\)/);
  // Measured as sent: a short URL that grows past the cap when it is percent-encoded.
  assert.throws(() => buildUploadLink({ ...BASE, returnUrl: prefix + "é".repeat(100) }), /at most 512 characters/);
});
