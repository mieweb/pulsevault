#!/usr/bin/env node
// Make every already-uploaded video artifact in a local-storage workspace
// web-playable, in place. New uploads are handled by the `onUploadComplete`
// web-ready hook (see examples/fastify-demo/server.mjs); this script is the
// one-time backfill for artifacts that landed before the hook existed.
//
// For each ready `kind: "video"` sidecar in `<workspaceDir>/.pulsevault/`:
//   - moov atom at the end of the file  → lossless faststart remux (sub-second)
//   - non-H.264 video codec (e.g. HEVC) → one-time libx264 transcode
//   - already web-ready / not MP4 bytes → untouched
//
// Rewrites are atomic (tmp file + rename), so interrupting the script never
// corrupts an artifact — rerun it and it picks up where it left off (already
// fixed files report `none` and are skipped for free).
//
// Usage:
//   node scripts/web-ready-migrate.mjs <workspaceDir> [--dry-run] [--no-transcode]
//
// Requires ffmpeg + ffprobe on PATH (apt install ffmpeg / brew install ffmpeg).

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ensureWebReady, scanMoovPosition } from "../dist/core.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const transcode = !args.includes("--no-transcode");
const workspaceDir = args.find((a) => !a.startsWith("--"));

if (!workspaceDir) {
  console.error(
    "Usage: node scripts/web-ready-migrate.mjs <workspaceDir> [--dry-run] [--no-transcode]",
  );
  process.exit(1);
}

const root = path.resolve(workspaceDir);
const sidecarDir = path.join(root, ".pulsevault");

let sidecarFiles;
try {
  sidecarFiles = (await fs.readdir(sidecarDir)).filter((f) => f.endsWith(".json"));
} catch {
  console.error(`No .pulsevault directory in ${root} — is this a local-storage workspace?`);
  process.exit(1);
}

const counts = { none: 0, remuxed: 0, transcoded: 0, skipped: 0, missing: 0 };
let processed = 0;

for (const sidecarFile of sidecarFiles) {
  let sidecar;
  try {
    sidecar = JSON.parse(await fs.readFile(path.join(sidecarDir, sidecarFile), "utf8"));
  } catch {
    continue; // unreadable sidecar — not this script's problem
  }
  // Old sidecars predate `kind` and are videos by definition. Mirror the
  // storage adapter's status semantics (src/storage/local.ts): anything that
  // isn't explicitly "uploading" is ready — legacy sidecars predate `status`
  // too, and those pre-hook artifacts are exactly what this script exists for.
  const kind = sidecar.kind ?? "video";
  const status = sidecar.status === "uploading" ? "uploading" : "ready";
  if (kind !== "video" || status !== "ready") continue;

  const artifactId = path.basename(sidecarFile, ".json");
  const filePath = path.join(root, kind, `${artifactId}${sidecar.ext ?? ".mp4"}`);
  processed += 1;

  try {
    await fs.access(filePath);
  } catch {
    counts.missing += 1;
    console.warn(`missing bytes  ${artifactId}`);
    continue;
  }

  if (dryRun) {
    // Report what WOULD happen: the moov scan is free; the codec check is
    // ffprobe-cheap but we keep dry-run dependency-free and byte-only.
    const moov = await scanMoovPosition(filePath);
    console.log(`would inspect  ${artifactId}  (moov: ${moov})`);
    continue;
  }

  const result = await ensureWebReady(filePath, { transcode, logger: console });
  counts[result.action] += 1;
  if (result.action !== "none") {
    console.log(`${result.action.padEnd(11)}  ${artifactId}  (${result.reason})`);
  }
}

if (dryRun) {
  console.log(`\nDry run: inspected ${processed} ready video artifact(s); nothing was modified.`);
} else {
  console.log(
    `\nDone: ${processed} ready video artifact(s) — ` +
      `${counts.remuxed} remuxed, ${counts.transcoded} transcoded, ` +
      `${counts.none} already web-ready, ${counts.skipped} skipped, ${counts.missing} missing.`,
  );
}
