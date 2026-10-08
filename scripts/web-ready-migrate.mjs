#!/usr/bin/env node
// Conform every already-uploaded video artifact in a local-storage workspace
// to the format PulseVault serves (`CONFORM_TARGET`). New uploads are handled
// by the `webReady` option; this script is the one-time backfill for
// artifacts that landed before it was on. Stop the server first: it caches
// each artifact's extension, which a container change rewrites.
//
// For each ready `kind: "video"` sidecar in `<workspaceDir>/.pulsevault/`:
//   - already in the target format          → untouched
//   - moov atom at the end of an MP4        → lossless faststart remux
//   - off-target video or audio             → one ffmpeg run (H.264/AAC, scaled, tone-mapped)
//   - another container (WebM, MKV, MOV, …) → a new `<id>.mp4`; the sidecar
//     switches to it and the original is deleted
//
// Rewrites are atomic (tmp file + rename), so interrupting the script never
// corrupts an artifact — rerun it and it picks up where it left off (already
// fixed files report `none`).
//
// Usage:
//   node scripts/web-ready-migrate.mjs <workspaceDir> [--dry-run] [--no-transcode]
//
// Requires ffmpeg + ffprobe on PATH (apt install ffmpeg / brew install ffmpeg).

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ensureWebReady, scanMoovPosition } from "../dist/app.js";

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

const counts = { none: 0, remuxed: 0, transcoded: 0, conformed: 0, skipped: 0, missing: 0 };
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

  const { outputPath, ...result } = await ensureWebReady(filePath, { transcode, logger: console });
  counts[result.action] += 1;
  // Record what was done on the sidecar, as the server does; a new container also switches the
  // artifact to its `.mp4` (keeping the uploaded extension as `sourceExt`), then the original
  // goes. Atomic tmp + rename, like the adapter's own sidecar writes.
  // A rerun finds a converted file already in the format: keep what the conversion recorded,
  // and finish what an interrupted run left: the original, once the sidecar names the `.mp4`.
  if (result.action === "none" && sidecar.webReady) {
    if (sidecar.sourceExt && sidecar.sourceExt !== sidecar.ext) {
      await fs.rm(path.join(root, kind, `${artifactId}${sidecar.sourceExt}`), { force: true });
    }
    continue;
  }
  const next = { ...sidecar, converted: true, webReady: result };
  if (outputPath) {
    next.sourceExt = sidecar.sourceExt ?? sidecar.ext;
    next.ext = path.extname(outputPath);
  }
  const sidecarPath = path.join(sidecarDir, sidecarFile);
  const tmpPath = `${sidecarPath}.migrate.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(next), "utf8");
  await fs.rename(tmpPath, sidecarPath);
  if (outputPath) await fs.rm(filePath, { force: true });
  if (result.action !== "none") {
    console.log(`${result.action.padEnd(11)}  ${artifactId}  (${result.reason})`);
  }
}

if (dryRun) {
  console.log(`\nDry run: inspected ${processed} ready video artifact(s); nothing was modified.`);
} else {
  console.log(
    `\nDone: ${processed} ready video artifact(s) — ` +
      `${counts.remuxed} remuxed, ${counts.transcoded} transcoded, ${counts.conformed} conformed, ` +
      `${counts.none} already web-ready, ${counts.skipped} skipped, ${counts.missing} missing.`,
  );
}
