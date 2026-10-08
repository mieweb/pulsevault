// Web-ready backstop tests. The moov box scan runs against hand-crafted
// ISO-BMFF byte layouts (pure Node, no ffmpeg needed); the remux/transcode
// paths run against real files generated with ffmpeg and are skipped when
// ffmpeg/ffprobe are not installed, mirroring ensureWebReady's own fail-open
// behavior on such hosts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWebReady, scanMoovPosition } from "../dist/lib/web-ready.js";

function hasCmd(cmd) {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = hasCmd("ffmpeg") && hasCmd("ffprobe");

async function tmpFile(name, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webready-"));
  const p = path.join(dir, name);
  await fs.writeFile(p, bytes);
  return p;
}

/** Minimal top-level box: 4-byte big-endian size + 4-char type + payload. */
function box(type, payloadLength = 0) {
  const b = Buffer.alloc(8 + payloadLength);
  b.writeUInt32BE(8 + payloadLength, 0);
  b.write(type, 4, "latin1");
  return b;
}

test("scanMoovPosition: moov before mdat is 'front'", async () => {
  const p = await tmpFile("front.mp4", Buffer.concat([box("ftyp", 8), box("moov", 16), box("mdat", 32)]));
  assert.equal(await scanMoovPosition(p), "front");
});

test("scanMoovPosition: moov after mdat is 'end'", async () => {
  const p = await tmpFile("end.mp4", Buffer.concat([box("ftyp", 8), box("mdat", 32), box("moov", 16)]));
  assert.equal(await scanMoovPosition(p), "end");
});

test("scanMoovPosition: non-MP4 bytes, truncation, missing moov are 'unknown'", async () => {
  assert.equal(await scanMoovPosition(await tmpFile("junk.bin", Buffer.from("this is not an mp4 file at all"))), "unknown");
  assert.equal(await scanMoovPosition(await tmpFile("empty.mp4", Buffer.alloc(0))), "unknown");
  // ftyp present but the file ends before any moov shows up.
  assert.equal(await scanMoovPosition(await tmpFile("nomoov.mp4", Buffer.concat([box("ftyp", 8), box("mdat", 32)]))), "unknown");
  // A box header claiming a size smaller than 8 is corrupt — bail, don't loop.
  const corrupt = Buffer.concat([box("ftyp", 8), box("mdat", 8)]);
  corrupt.writeUInt32BE(3, 16);
  assert.equal(await scanMoovPosition(await tmpFile("corrupt.mp4", corrupt)), "unknown");
  assert.equal(await scanMoovPosition("/nonexistent/definitely-not-here.mp4"), "unknown");
});

test("scanMoovPosition: 64-bit largesize boxes are stepped over", async () => {
  // mdat with size==1 and the real size in the 8-byte largesize field.
  const payload = 24;
  const mdat = Buffer.alloc(16 + payload);
  mdat.writeUInt32BE(1, 0);
  mdat.write("mdat", 4, "latin1");
  mdat.writeBigUInt64BE(BigInt(16 + payload), 8);
  const p = await tmpFile("large.mp4", Buffer.concat([box("ftyp", 8), mdat, box("moov", 16)]));
  assert.equal(await scanMoovPosition(p), "end");
});

test("ensureWebReady: non-MP4 file is skipped untouched", async () => {
  const p = await tmpFile("junk.bin", Buffer.from("not a video"));
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "skipped");
  assert.deepEqual(await fs.readFile(p), before, "bytes must be untouched");
});

test("ensureWebReady: missing ffmpeg fails open as 'skipped'", async () => {
  const p = await tmpFile("end.mp4", Buffer.concat([box("ftyp", 8), box("mdat", 32), box("moov", 16)]));
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p, {
    ffmpegPath: "/nonexistent/ffmpeg",
    ffprobePath: "/nonexistent/ffprobe",
  });
  assert.equal(result.action, "skipped");
  assert.match(result.reason, /not available/);
  assert.deepEqual(await fs.readFile(p), before, "bytes must be untouched");
});

test("ensureWebReady: moov-at-end H.264 gets a lossless faststart remux", { skip: !FFMPEG }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webready-"));
  const p = path.join(dir, "recorded.mp4");
  // No -movflags +faststart: like a mobile recorder, ffmpeg writes moov last.
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", p,
  ], { stdio: "ignore" });
  assert.equal(await scanMoovPosition(p), "end", "fixture must start moov-at-end");

  const result = await ensureWebReady(p);
  assert.equal(result.action, "remuxed");
  assert.equal(await scanMoovPosition(p), "front");

  // Idempotent: a second pass finds nothing to do.
  const again = await ensureWebReady(p);
  assert.equal(again.action, "none");
});

test("ensureWebReady: HEVC is transcoded to H.264 (+faststart)", { skip: !FFMPEG }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webready-"));
  const p = path.join(dir, "hevc.mp4");
  try {
    execFileSync("ffmpeg", [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
      "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-y", p,
    ], { stdio: "ignore" });
  } catch {
    t.skip("ffmpeg build lacks libx265");
    return;
  }

  const result = await ensureWebReady(p);
  assert.equal(result.action, "transcoded");
  const codec = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name",
    "-of", "default=noprint_wrappers=1:nokey=1", p,
  ]).toString().trim();
  assert.equal(codec, "h264");
  assert.equal(await scanMoovPosition(p), "front");
});

test("ensureWebReady: transcode:false leaves hostile codecs alone after the remux", { skip: !FFMPEG }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webready-"));
  const p = path.join(dir, "hevc-noconvert.mp4");
  try {
    execFileSync("ffmpeg", [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
      "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-y", p,
    ], { stdio: "ignore" });
  } catch {
    t.skip("ffmpeg build lacks libx265");
    return;
  }

  const result = await ensureWebReady(p, { transcode: false });
  assert.equal(result.action, "none");
  assert.match(result.reason, /transcode disabled/);
});

// ---------- conform to CONFORM_TARGET (#84) ----------

/** Generate a fixture with ffmpeg (lavfi sources); `null` when this ffmpeg build can't. */
async function fixture(name, args, { pipe = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conform-"));
  const p = path.join(dir, name);
  try {
    if (pipe) {
      // Written to a pipe, a WebM has no duration in its header — like a browser's MediaRecorder.
      await fs.writeFile(p, execFileSync("ffmpeg", ["-v", "error", ...args, "pipe:1"], { maxBuffer: 64 * 1024 * 1024 }));
    } else {
      execFileSync("ffmpeg", ["-v", "error", ...args, "-y", p], { stdio: "ignore" });
    }
    return p;
  } catch {
    return null;
  }
}

const VIDEO = (size, duration = 1) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${duration}`];
const TONE = (duration = 1) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`];

/** The first video and audio streams of a file, as ffprobe reports them. */
function probe(p) {
  const out = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries",
    "stream=codec_type,codec_name,pix_fmt,width,height,color_transfer:stream_side_data=rotation",
    "-of", "json", p,
  ]).toString());
  const video = out.streams.find((s) => s.codec_type === "video");
  const audio = out.streams.find((s) => s.codec_type === "audio");
  return { video, audio, rotation: video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0 };
}

test("conform: a Pulse-like portrait 1080×1920 H.264/AAC faststart MP4 is left byte-for-byte", { skip: !FFMPEG }, async () => {
  const p = await fixture("pulse.mp4", [...VIDEO("1080x1920"), ...TONE(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]);
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "none");
  assert.equal(result.outputPath, undefined);
  assert.deepEqual(await fs.readFile(p), before);
});

test("conform: a browser-recorded WebM (VP9/Opus, no duration) becomes a new MP4 beside it", { skip: !FFMPEG }, async (t) => {
  const p = await fixture("rec.webm", [...VIDEO("640x360", 2), ...TONE(2), "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-f", "webm"], { pipe: true });
  if (!p) return t.skip("ffmpeg build lacks libvpx/libopus");
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "conformed");
  assert.equal(result.outputPath, p.replace(/\.webm$/, ".mp4"));
  assert.deepEqual(await fs.readFile(p), before, "the original is left for the caller to remove");
  const { video, audio } = probe(result.outputPath);
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(audio.codec_name, "aac");
  assert.equal(await scanMoovPosition(result.outputPath), "front");
});

test("conform: an MKV with H.264/AAC is remuxed into an MP4 without re-encoding", { skip: !FFMPEG }, async () => {
  const p = await fixture("clip.mkv", [...VIDEO("320x240"), ...TONE(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "conformed");
  assert.match(result.reason, /container \.mkv → mp4/);
  assert.doesNotMatch(result.reason, /→ h264/);
  assert.equal(probe(result.outputPath).video.codec_name, "h264");
});

test("conform: landscape 4K is scaled to 1920×1080 and stays landscape", { skip: !FFMPEG }, async () => {
  const p = await fixture("land4k.mp4", [...VIDEO("3840x2160"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "transcoded");
  const { video, audio } = probe(p);
  assert.deepEqual([video.width, video.height], [1920, 1080]);
  assert.equal(audio, undefined, "no audio stays silent");
});

test("conform: a rotation tag is applied, so the file plays upright without it", { skip: !FFMPEG }, async () => {
  const flat = await fixture("flat.mp4", [...VIDEO("640x360"), "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const p = path.join(path.dirname(flat), "rot.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-display_rotation", "90", "-i", flat, "-c", "copy", "-movflags", "+faststart", "-y", p]);
  assert.equal(Math.abs(probe(p).rotation), 90, "fixture must carry a rotation tag");
  const result = await ensureWebReady(p);
  assert.equal(result.action, "transcoded");
  const { video, rotation } = probe(p);
  assert.deepEqual([video.width, video.height], [360, 640], "portrait, as it was held");
  assert.equal(rotation, 0);
});

test("conform: 10-bit HLG HEVC is tone-mapped to 8-bit BT.709 H.264", { skip: !FFMPEG }, async (t) => {
  const p = await fixture("hlg.mov", [...VIDEO("640x360"), ...TONE(),
    "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p10le",
    // x265 writes the colour tags into the stream only from its own params.
    "-x265-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error", "-c:a", "aac"]);
  if (!p) return t.skip("ffmpeg build lacks libx265");
  const result = await ensureWebReady(p);
  assert.equal(result.action, "conformed");
  assert.match(result.reason, /HDR \(arib-std-b67\)/);
  const { video } = probe(result.outputPath);
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.color_transfer, "bt709");
});

test("conform: non-AAC audio in an MP4-family file is converted to AAC", { skip: !FFMPEG }, async () => {
  const p = await fixture("pcm.mov", [...VIDEO("320x240"), ...TONE(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le"]);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "conformed");
  assert.match(result.reason, /audio pcm_s16le → aac/);
  assert.equal(probe(result.outputPath).audio.codec_name, "aac");
});

test("conform: a run past timeoutSeconds is killed, the original kept and the reason given", { skip: !FFMPEG }, async () => {
  const p = await fixture("slow.mp4", [...VIDEO("3840x2160", 3), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p, { timeoutSeconds: 0.05 });
  assert.equal(result.action, "skipped");
  assert.match(result.reason, /timed out/);
  assert.deepEqual(await fs.readFile(p), before);
  assert.deepEqual((await fs.readdir(path.dirname(p))).filter((f) => f.startsWith(".webready-")), [], "no tmp file left");
});
