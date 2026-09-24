#!/usr/bin/env node
// Regenerates everything derived from the protocol's source files (PROTOCOL.md §7):
//
// - protocol/openapi.json — the HTTP surface, from the plugin's route schemas (which themselves
//   use protocol/schemas/ where they overlap). Built by booting the plugin with @fastify/swagger.
// - The tables between `<!-- BEGIN GENERATED: … -->` markers in PROTOCOL.md, from the
//   descriptions in protocol/schemas/*.schema.json.
//
//   npm run protocol          regenerate (after editing a schema or a route)
//   npm run protocol:check    fail if anything is out of date (CI)
//
// Needs `npm run build` first (it boots the built plugin).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifySwagger from "@fastify/swagger";
import Fastify from "fastify";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const schemaDir = path.join(root, "protocol", "schemas");
const readSchema = async (name) =>
  JSON.parse(await fs.readFile(path.join(schemaDir, `${name}.schema.json`), "utf8"));

// ---- protocol/openapi.json ----------------------------------------------------------------

async function buildOpenApi() {
  const { default: pulseVault, createLocalStorage } = await import(
    new URL("../dist/app.js", import.meta.url).href
  );
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-gen-protocol-"));
  const app = Fastify({ logger: false });
  try {
    await app.register(fastifySwagger, {
      openapi: {
        openapi: "3.0.3",
        info: {
          title: "Pulse upload protocol",
          description:
            "The HTTP surface of the Pulse upload protocol, as implemented by @mieweb/pulsevault. " +
            "Generated from the plugin's route schemas — see PROTOCOL.md for the full contract.",
          version: pkg.pulseProtocol.version,
        },
        tags: [{ name: "pulsevault", description: "Routes mounted by the plugin" }],
      },
    });
    await app.register(pulseVault, {
      prefix: "/pulsevault",
      storage: createLocalStorage({ workspaceDir }),
      maxUploadSize: 1,
    });
    await app.ready();
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

// ---- generated tables in PROTOCOL.md ------------------------------------------------------

// Markdown table cell: escape backslashes first, then pipes, so a `\` before a `|` can't unescape it.
const cell = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

function typeOf(prop) {
  if (prop.const !== undefined) return `\`${JSON.stringify(prop.const)}\``;
  if (prop.enum) return prop.enum.map((v) => `\`${v}\``).join(", ");
  const base = prop.type === "array" && prop.items?.type ? `${prop.items.type}[]` : prop.type;
  return prop.format ? `${base} (${prop.format})` : base;
}

function fieldTable(schema, keyHeader) {
  const required = new Set(schema.required ?? []);
  const rows = Object.entries(schema.properties).map(
    ([key, prop]) =>
      `| \`${key}\` | ${cell(typeOf(prop))} | ${required.has(key) ? "Yes" : "No"} | ${cell(prop.description ?? "")} |`,
  );
  return [`| ${keyHeader} | Type | Required | Description |`, "|---|---|---|---|", ...rows].join("\n");
}

async function schemaList() {
  const files = (await fs.readdir(schemaDir)).filter((f) => f.endsWith(".schema.json")).sort();
  const rows = [];
  for (const file of files) {
    const schema = JSON.parse(await fs.readFile(path.join(schemaDir, file), "utf8"));
    rows.push(`| [\`${file}\`](protocol/schemas/${file}) | ${cell(schema.title)} |`);
  }
  return [
    "| File | Defines |",
    "|---|---|",
    "| [`openapi.json`](protocol/openapi.json) | Every HTTP route, generated from the plugin |",
    ...rows,
  ].join("\n");
}

async function generatedSections() {
  return {
    capabilities: fieldTable(await readSchema("capabilities"), "Field"),
    "upload-metadata": fieldTable(await readSchema("upload-metadata"), "Key"),
    schemas: await schemaList(),
    "protocol-version": [
      "| | |",
      "|---|---|",
      `| Spec revision | \`${pkg.pulseProtocol.version}\` |`,
      `| Protocol majors accepted | ${pkg.pulseProtocol.min === pkg.pulseProtocol.max ? pkg.pulseProtocol.min : `${pkg.pulseProtocol.min}–${pkg.pulseProtocol.max}`} |`,
    ].join("\n"),
  };
}

function fillSections(markdown, sections) {
  let out = markdown;
  for (const [name, body] of Object.entries(sections)) {
    const re = new RegExp(
      `(<!-- BEGIN GENERATED: ${name} [^\\n]*-->\\n)[\\s\\S]*?(<!-- END GENERATED: ${name} -->)`,
    );
    if (!re.test(out)) throw new Error(`PROTOCOL.md has no generated section "${name}"`);
    out = out.replace(re, (_m, begin, end) => `${begin}${body}\n${end}`);
  }
  return out;
}

// ---- write or check -----------------------------------------------------------------------

const targets = [
  { file: path.join(root, "protocol", "openapi.json"), content: await buildOpenApi() },
  {
    file: path.join(root, "PROTOCOL.md"),
    content: fillSections(
      await fs.readFile(path.join(root, "PROTOCOL.md"), "utf8"),
      await generatedSections(),
    ),
  },
];

let stale = 0;
for (const { file, content } of targets) {
  const current = await fs.readFile(file, "utf8").catch(() => null);
  const rel = path.relative(root, file);
  if (current === content) continue;
  if (check) {
    console.error(`✗ ${rel} is out of date — run \`npm run protocol\` and commit the result.`);
    stale++;
  } else {
    await fs.writeFile(file, content);
    console.log(`wrote ${rel}`);
  }
}
if (check && stale > 0) process.exit(1);
if (check) console.log("✓ protocol/openapi.json and PROTOCOL.md are up to date");
