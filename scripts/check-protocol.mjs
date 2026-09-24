#!/usr/bin/env node
// Enforces the rules for changing the protocol (PROTOCOL.md §7.1), comparing protocol/ against a
// base git ref (default origin/main; CI passes the PR base):
//
// 1. Anything under protocol/ changed (ignoring descriptions and titles) → package.json
//    pulseProtocol.version must change.
// 2. A breaking change → the major must go up. Breaking is decided by oasdiff for
//    protocol/openapi.json, and by the conservative diff below for protocol/schemas/: removing a
//    field, making one required, removing an allowed value, or changing a type, format, pattern,
//    const or default is breaking; adding an optional field or an allowed value isn't.
// 3. The version never goes backwards.
// 4. PROTOCOL.md §7.4 has a history row for the current version.
//
//   node scripts/check-protocol.mjs [--base <ref>] [--oasdiff <path to oasdiff binary>]
//
// oasdiff (https://github.com/oasdiff/oasdiff) is looked up on PATH unless --oasdiff is given. In
// CI (CI=true) a missing oasdiff is an error; locally it's a warning.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const baseRef = arg("--base") ?? process.env.PROTOCOL_BASE ?? "origin/main";
const oasdiffBin = arg("--oasdiff") ?? process.env.OASDIFF ?? "oasdiff";

const failures = [];
const changes = [];
const note = (breaking, msg) => changes.push({ breaking, msg });

function gitShow(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return null;
  }
}
function gitLs(ref, dir) {
  try {
    return execFileSync("git", ["ls-tree", "--name-only", `${ref}`, `${dir}/`], { cwd: root })
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((f) => path.basename(f));
  } catch {
    return [];
  }
}

// ---- versions ---------------------------------------------------------------------------------

const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? { major: Number(m[1]), minor: Number(m[2]), text: v } : null;
};
const head = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).pulseProtocol;
const headVersion = parseVersion(head?.version);
if (!headVersion) failures.push(`package.json pulseProtocol.version must be "major.minor", got ${JSON.stringify(head?.version)}`);
const basePkg = gitShow(baseRef, "package.json");
const baseVersion = parseVersion(basePkg ? JSON.parse(basePkg).pulseProtocol?.version : undefined);

// ---- schema diff ------------------------------------------------------------------------------

const IGNORED = new Set(["description", "title", "$comment", "examples", "$id", "$schema"]);
const strip = (value) =>
  Array.isArray(value)
    ? value.map(strip)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => !IGNORED.has(k))
            .map(([k, v]) => [k, strip(v)]),
        )
      : value;
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

function diffSchema(a, b, where) {
  for (const key of ["type", "format", "pattern", "const", "default"]) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      note(true, `${where}: \`${key}\` changed from ${JSON.stringify(a[key])} to ${JSON.stringify(b[key])}`);
    }
  }
  for (const key of ["maxLength", "maximum"]) {
    if (a[key] !== undefined && (b[key] === undefined || b[key] < a[key])) {
      if (b[key] === undefined) note(false, `${where}: \`${key}\` limit removed`);
      else note(true, `${where}: \`${key}\` lowered from ${a[key]} to ${b[key]}`);
    } else if (a[key] === undefined && b[key] !== undefined) {
      note(true, `${where}: \`${key}\` ${b[key]} added`);
    }
  }
  if (a.enum || b.enum) {
    const before = new Set(a.enum ?? []);
    const after = new Set(b.enum ?? []);
    for (const v of before) if (!after.has(v)) note(true, `${where}: allowed value \`${v}\` removed`);
    for (const v of after) if (!before.has(v)) note(false, `${where}: allowed value \`${v}\` added`);
  }
  const reqA = new Set(a.required ?? []);
  const reqB = new Set(b.required ?? []);
  for (const k of reqB) if (!reqA.has(k)) note(true, `${where}.${k} is now required`);
  for (const k of reqA) if (!reqB.has(k)) note(true, `${where}.${k} is no longer required`);
  const propsA = a.properties ?? {};
  const propsB = b.properties ?? {};
  for (const k of Object.keys(propsA)) {
    if (!(k in propsB)) note(true, `${where}.${k} removed`);
    else diffSchema(propsA[k], propsB[k], `${where}.${k}`);
  }
  for (const k of Object.keys(propsB)) if (!(k in propsA)) note(false, `${where}.${k} added`);
  if (a.items && b.items) diffSchema(a.items, b.items, `${where}[]`);
  if (a.additionalProperties && typeof a.additionalProperties === "object") {
    if (typeof b.additionalProperties === "object") {
      diffSchema(a.additionalProperties, b.additionalProperties, `${where}.*`);
    } else note(true, `${where}: additionalProperties changed`);
  }
}

// ---- compare protocol/ against the base -------------------------------------------------------

const schemaDir = path.join(root, "protocol", "schemas");
const headSchemas = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
const baseSchemas = gitLs(baseRef, "protocol/schemas").filter((f) => f.endsWith(".schema.json"));
const baseline = baseSchemas.length > 0;

if (!baseline) {
  console.log(`No protocol/ at ${baseRef}: this change introduces it, so there is nothing to compare.`);
} else {
  for (const file of baseSchemas) {
    const before = JSON.parse(gitShow(baseRef, `protocol/schemas/${file}`));
    if (!headSchemas.includes(file)) {
      note(true, `schema \`${file}\` removed`);
      continue;
    }
    const after = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
    if (!same(before, after)) diffSchema(before, after, file.replace(".schema.json", ""));
  }
  for (const file of headSchemas) if (!baseSchemas.includes(file)) note(false, `schema \`${file}\` added`);

  // The HTTP surface: any non-cosmetic change counts, and oasdiff decides what's breaking.
  const baseOpenApi = gitShow(baseRef, "protocol/openapi.json");
  const headOpenApi = fs.readFileSync(path.join(root, "protocol", "openapi.json"), "utf8");
  const withoutInfo = (text) => ({ ...JSON.parse(text), info: undefined });
  if (baseOpenApi && !same(withoutInfo(baseOpenApi), withoutInfo(headOpenApi))) {
    note(false, "protocol/openapi.json changed");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pv-protocol-base-"));
    const baseFile = path.join(tmp, "openapi.json");
    fs.writeFileSync(baseFile, baseOpenApi);
    try {
      execFileSync(oasdiffBin, ["breaking", baseFile, path.join(root, "protocol", "openapi.json"), "--fail-on", "ERR"], {
        stdio: "pipe",
      });
    } catch (err) {
      if (err.code === "ENOENT") {
        const msg = `oasdiff not found (${oasdiffBin}), so breaking HTTP changes weren't checked`;
        if (process.env.CI) failures.push(msg);
        else console.warn(`warning: ${msg}`);
      } else {
        for (const line of String(err.stdout).split("\n").filter((l) => l.includes("] at ") || l.startsWith("\t\t"))) {
          note(true, `openapi: ${line.trim().replaceAll(`${root}${path.sep}`, "")}`);
        }
        if (!changes.some((c) => c.msg.startsWith("openapi:"))) note(true, "openapi: breaking change (see oasdiff)");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---- rules ------------------------------------------------------------------------------------

const significant = changes.length > 0;
const breaking = changes.some((c) => c.breaking);
if (headVersion && baseVersion) {
  const versionChanged = headVersion.text !== baseVersion.text;
  if (
    headVersion.major < baseVersion.major ||
    (headVersion.major === baseVersion.major && headVersion.minor < baseVersion.minor)
  ) {
    failures.push(`pulseProtocol.version went backwards: ${baseVersion.text} → ${headVersion.text}`);
  }
  if (significant && !versionChanged) {
    failures.push(`protocol/ changed but pulseProtocol.version is still ${headVersion.text}: bump the ${breaking ? "major" : "minor"}`);
  }
  if (breaking && headVersion.major === baseVersion.major) {
    failures.push(`breaking protocol change without a major bump (still ${headVersion.major}.x)`);
  }
}
const protocolMd = fs.readFileSync(path.join(root, "PROTOCOL.md"), "utf8");
if (headVersion && !new RegExp(`^\\| ${headVersion.text.replace(".", "\\.")} \\|`, "m").test(protocolMd)) {
  failures.push(`PROTOCOL.md §7.4 History needs a row for ${headVersion.text}`);
}

// ---- report -----------------------------------------------------------------------------------

const lines = [
  `### Protocol check (${baseVersion?.text ?? "none"} at ${baseRef} → ${headVersion?.text ?? "?"})`,
  "",
  ...(changes.length === 0
    ? ["No protocol changes."]
    : changes.map((c) => `- ${c.breaking ? "**breaking:** " : ""}${c.msg}`)),
  "",
  ...(failures.length === 0 ? ["✓ Versioning rules pass."] : failures.map((f) => `✗ ${f}`)),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
process.exit(failures.length === 0 ? 0 : 1);
