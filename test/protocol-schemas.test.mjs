// The schemas in protocol/schemas/ are the protocol's single source (PROTOCOL.md §7). These tests
// check that what the code actually produces matches them, so the code and the spec can't drift.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createLocalStorage, createPulseVaultCore } from "../dist/core.js";
import { issueCapabilityToken, issueViewToken } from "../dist/lib/capability-token.js";
import { createViewLinkIssuer } from "../dist/lib/view-links.js";
import { buildUploadLink } from "../dist/lib/deeplinks.js";
import { parsePulseClient } from "../dist/lib/protocol.js";

const schemaDir = new URL("../protocol/schemas/", import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaFiles = (await fs.readdir(schemaDir)).filter((f) => f.endsWith(".schema.json"));
const schemas = Object.fromEntries(
  await Promise.all(
    schemaFiles.map(async (file) => [
      file.replace(".schema.json", ""),
      JSON.parse(await fs.readFile(new URL(file, schemaDir), "utf8")),
    ]),
  ),
);

const validatorOf = (name) => ajv.getSchema(schemas[name].$id) ?? ajv.compile(schemas[name]);

function assertValid(name, value) {
  const validate = validatorOf(name);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

test("every protocol schema compiles under strict JSON Schema 2020-12", () => {
  assert.ok(schemaFiles.length >= 6);
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.ok(schema.title && schema.description, `${name} needs a title and description`);
    ajv.compile(schema);
  }
});

test("GET /capabilities matches capabilities.schema.json", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-schema-test-"));
  const core = createPulseVaultCore({
    basePath: "/pulsevault",
    storage: createLocalStorage({ workspaceDir }),
    maxUploadSize: 1024,
  });
  const server = http.createServer((req, res) => void core.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/pulsevault/capabilities`);
    assertValid("capabilities", await res.json());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await core.shutdown();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("buildUploadLink's params match deep-link.schema.json", () => {
  for (const token of [undefined, "abc.def"]) {
    const link = buildUploadLink({
      server: "https://vault.example.org/pulsevault",
      artifactId: randomUUID(),
      ...(token ? { token } : {}),
    });
    const params = Object.fromEntries(new URL(link.replace("pulsecam://", "http://x/")).searchParams);
    assertValid("deep-link", params);
  }
});

test("a link with hints matches deep-link.schema.json, and its token's ref claim the token schema", () => {
  const artifactId = randomUUID();
  const token = issueCapabilityToken(artifactId, "secret", { keyId: "k1", issuer: "vault", ref: "u1:ticket:42" });
  const link = buildUploadLink({
    server: "https://vault.example.org/pulsevault",
    artifactId,
    token,
    label: "Fix the login page",
    name: "Login fix",
    app: "TimeHuddle",
    returnUrl: "https://app.example.org/tickets/42",
  });
  const params = Object.fromEntries(new URL(link.replace("pulsecam://", "http://x/")).searchParams);
  assert.equal(Object.keys(params).length, 8);
  assertValid("deep-link", params);
  const claims = JSON.parse(Buffer.from(params.token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(claims.ref, "u1:ticket:42");
  assertValid("capability-token", claims);
});

test("the hints buildUploadLink writes match deep-link.schema.json: cut and cleaned text, a normalized return URL", () => {
  const artifactId = randomUUID();
  // The same parameters in both forms: after `?` in one, after `#` in the other.
  const paramsOf = (opts) => {
    const [pulsecam, https] = [undefined, "https"].map((form) => {
      const link = buildUploadLink({ server: "https://vault.example.org/pulsevault", artifactId, token: "t", ...opts, form });
      return Object.fromEntries(new URLSearchParams(link.slice(link.search(/[?#]/) + 1)));
    });
    assert.deepEqual(https, pulsecam);
    return pulsecam;
  };
  // Over-long, astral, padded and control-laden text is cut and cleaned to what the schema allows.
  for (const text of ["L".repeat(500), "😀".repeat(500), `  ${"é".repeat(90)}  `, "a\nb\tc", "x"]) {
    const params = paramsOf({ label: text, name: text, app: text });
    assert.deepEqual(Object.keys(params), ["v", "artifactId", "server", "token", "label", "name", "app"]);
    assertValid("deep-link", params);
  }
  // A return URL goes out as the URL parser writes it, at most 512 characters of http(s).
  const longest = `https://app.example.org/${"a".repeat(488)}`;
  for (const returnUrl of [" https://app.example.org/x ", "https://exämple.org/a b", "https:\\\\app.example.org\\x", "http://localhost:3000/x", longest]) {
    assertValid("deep-link", paramsOf({ returnUrl }));
  }
  // That writing leaves `[ ] { } |` as they are in a query, which a strict URI grammar refuses and
  // every browser accepts: the schema holds `return` to its scheme and length, not to that grammar.
  for (const [returnUrl, sent] of [
    ["https://app.example.org/tickets?filter[status]=open", "https://app.example.org/tickets?filter[status]=open"],
    ["https://app.example.org/search?q=a|b", "https://app.example.org/search?q=a|b"],
    ['https://app.example.org/search?json={"a":1}', "https://app.example.org/search?json={%22a%22:1}"],
  ]) {
    const params = paramsOf({ returnUrl });
    assert.equal(params.return, sent);
    assertValid("deep-link", params);
  }
});

test("deep-link.schema.json holds the hints to their caps, counted as code points, and `return` to http(s)", () => {
  const validate = validatorOf("deep-link");
  const base = { v: "1", artifactId: randomUUID(), server: "https://vault.example.org/pulsevault" };
  for (const [key, max] of [["label", 60], ["name", 80], ["app", 30]]) {
    assert.equal(validate({ ...base, [key]: "😀".repeat(max) }), true, `${key} at its cap`);
    assert.equal(validate({ ...base, [key]: "x".repeat(max + 1) }), false, `${key} past its cap`);
  }
  assert.equal(validate({ ...base, return: `https://app.example.org/${"a".repeat(488)}` }), true);
  assert.equal(validate({ ...base, return: `https://app.example.org/${"a".repeat(489)}` }), false);
  for (const bad of ["javascript:alert(1)", "pulsecam://?v=1", "ftp://app.example.org/x", " https://app.example.org/"]) {
    assert.equal(validate({ ...base, return: bad }), false, bad);
  }
  // Unknown parameters stay valid: a client ignores them.
  assert.equal(validate({ ...base, zzz: "1" }), true);
});

test("capability-token.schema.json and issueCapabilityToken agree on a ref: 1 to 200 code points, no unpaired surrogate", () => {
  const validate = validatorOf("capability-token");
  const claims = JSON.parse(
    Buffer.from(issueCapabilityToken(randomUUID(), "secret", { keyId: "k1", issuer: "vault" }).split(".")[0], "base64url").toString("utf8"),
  );
  for (const ref of ["x", "x".repeat(200), "😀".repeat(200), "", "x".repeat(201), "😀".repeat(201), 42, "\ud800", "a\udc00b", "😀\ud83d"]) {
    let issued = true;
    try {
      issueCapabilityToken(randomUUID(), "secret", { keyId: "k1", issuer: "vault", ref });
    } catch {
      issued = false;
    }
    assert.equal(validate({ ...claims, ref }), issued, JSON.stringify(ref).slice(0, 20));
  }
});

test("issued capability tokens carry claims matching capability-token.schema.json", () => {
  const token = issueCapabilityToken(randomUUID(), "secret", { keyId: "k1", issuer: "vault" });
  const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assertValid("capability-token", claims);
});

test("view tokens carry claims matching capability-token.schema.json", () => {
  const token = issueViewToken(randomUUID(), "secret", {
    keyId: "k1",
    issuer: "vault",
    expirySeconds: 60,
  });
  const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assertValid("capability-token", claims);
  assert.equal(claims.use, "view");
});

test("a minted view link matches view-link.schema.json, and /capabilities reports viewLinks", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-schema-test-"));
  const core = createPulseVaultCore({
    basePath: "/pulsevault",
    storage: createLocalStorage({ workspaceDir }),
    maxUploadSize: 1 << 20,
    issueViewLink: createViewLinkIssuer({
      keyId: "k1",
      secret: "secret",
      issuer: "vault",
      expirySeconds: 60,
    }),
  });
  const server = http.createServer((req, res) => void core.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/pulsevault`;
  try {
    const caps = await (await fetch(`${base}/capabilities`)).json();
    assertValid("capabilities", caps);
    assert.equal(caps.viewLinks, true);

    // A finished artifact: create + one PATCH of a minimal MP4.
    const artifactId = randomUUID();
    const body = Buffer.alloc(64);
    Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(body);
    const create = await fetch(`${base}/upload`, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(body.length),
        "Upload-Metadata": `artifactId ${Buffer.from(artifactId).toString("base64")},filename ${Buffer.from("a.mp4").toString("base64")}`,
      },
    });
    const location = new URL(create.headers.get("location"), base).href;
    const patch = await fetch(location, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      body,
    });
    assert.equal(patch.status, 204);

    const res = await fetch(`${base}/artifacts/${artifactId}/view-link`, { method: "POST" });
    assert.equal(res.status, 200);
    assertValid("view-link", await res.json());
  } finally {
    server.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("the metadata a Pulse upload sends matches upload-metadata.schema.json", () => {
  const video = randomUUID();
  assertValid("upload-metadata", {
    artifactId: video,
    filename: "draft.mp4",
    kind: "video",
    checksum: "md5:0123456789abcdef0123456789abcdef",
    name: "Morning walkthrough",
    appVersion: "2.1.0 (45)",
  });
  assertValid("upload-metadata", {
    artifactId: randomUUID(),
    filename: "draft.vtt",
    kind: "captions",
    relatedTo: video,
  });
});

test("a beat manifest matches beat-manifest.schema.json", () => {
  assertValid("beat-manifest", {
    version: 1,
    type: "beat-manifest",
    durationMs: 9000,
    beats: [
      { segmentId: "s0", order: 0, startMs: 0, endMs: 2500 },
      { segmentId: "s1", order: 1, startMs: 2500, endMs: 9000 },
    ],
  });
});

test("Pulse-Client values the schema accepts are ones the server can read", () => {
  for (const value of [
    "Pulse/2.1.0 (45; ios); protocol=1-2",
    "Pulse/2.1.0; protocol=2",
    "SomeServer-Test/0.1 (ci); protocol=2-3",
  ]) {
    assertValid("pulse-client", value);
    assert.ok(parsePulseClient(value).protocolMax !== undefined, value);
  }
});
