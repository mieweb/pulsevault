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
import { issueCapabilityToken } from "../dist/lib/capability-token.js";
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

function assertValid(name, value) {
  const validate = ajv.getSchema(schemas[name].$id) ?? ajv.compile(schemas[name]);
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

test("issued capability tokens carry claims matching capability-token.schema.json", () => {
  const token = issueCapabilityToken(randomUUID(), "secret", { keyId: "k1", issuer: "vault" });
  const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assertValid("capability-token", claims);
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
