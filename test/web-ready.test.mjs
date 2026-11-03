// Web-ready backstop tests. The moov box scan runs against hand-crafted
// ISO-BMFF byte layouts (pure Node, no ffmpeg needed); the remux/transcode
// paths run against real files generated with ffmpeg and are skipped when
// ffmpeg/ffprobe are not installed, mirroring ensureWebReady's own fail-open
// behavior on such hosts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWebReady, extractPosterFrame, readContainerRange, scanMoovPosition } from "../dist/lib/web-ready.js";

function hasCmd(cmd) {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = hasCmd("ffmpeg") && hasCmd("ffprobe");

// Every scratch directory a test makes, removed once the file's tests are done.
const scratchDirs = [];
async function scratchDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
after(() => Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function tmpFile(name, bytes) {
  const dir = await scratchDir("webready-");
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
  const dir = await scratchDir("webready-");
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
  const dir = await scratchDir("webready-");
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
  const dir = await scratchDir("webready-");
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
  assert.equal(result.action, "skipped", "left off-target on purpose: not `none`, which means it conforms");
  assert.match(result.reason, /transcode disabled/);
});

// ---------- conform to CONFORM_TARGET (#84) ----------

/** Generate a fixture with ffmpeg (lavfi sources); `null` when this ffmpeg build can't. */
async function fixture(name, args, { pipe = false } = {}) {
  const dir = await scratchDir("conform-");
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

// ---------- rotation: a phone's portrait is a rotation tag ----------

/** Four coloured quadrants (red, green / blue, white), so a turn or a flip shows in the pixels. */
const QUADRANTS = (size, duration = 1) => {
  const [w, h] = size.split("x").map((n) => Number(n) / 2);
  const q = (colour, label) => `color=${colour}:s=${w}x${h}:d=${duration}:r=30[${label}]`;
  return ["-f", "lavfi", "-i", `${q("red", "a")};${q("lime", "b")};${q("blue", "c")};${q("white", "d")};[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack,format=yuv420p`];
};

/**
 * The colours of the first frame's quadrants, top-left to bottom-right (`RGBW` is upright), as a
 * player shows it (the rotation tag applied) or, with `autorotate: false`, as the pixels are stored.
 */
function quadrants(p, { autorotate = true } = {}) {
  const rgb = execFileSync("ffmpeg", [
    "-v", "error", ...(autorotate ? [] : ["-noautorotate"]), "-i", p,
    "-frames:v", "1", "-vf", "scale=8:8:flags=neighbor", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  const at = (x, y) => {
    const [r, g, b] = rgb.subarray((y * 8 + x) * 3, (y * 8 + x) * 3 + 3);
    return r > 200 && g > 200 && b > 200 ? "W" : r > 150 ? "R" : g > 150 ? "G" : b > 150 ? "B" : "?";
  };
  return at(2, 2) + at(5, 2) + at(2, 5) + at(5, 5);
}

/** A copy of `src` tagged to show turned by `degrees`, the way a phone writes portrait: no re-encode. */
function tagged(src, degrees, name, { faststart = true } = {}) {
  const p = path.join(path.dirname(src), name);
  const flags = faststart ? ["-movflags", "+faststart"] : [];
  try {
    execFileSync("ffmpeg", ["-v", "error", "-display_rotation", String(degrees), "-i", src, "-c", "copy", "-map", "0", ...flags, "-y", p], { stdio: "ignore" });
  } catch {
    // FFmpeg before 6.0 has no -display_rotation: the stream's `rotate` tag writes the same matrix.
    execFileSync("ffmpeg", ["-v", "error", "-i", src, "-c", "copy", "-map", "0", "-metadata:s:v:0", `rotate=${(degrees + 360) % 360}`, ...flags, "-y", p], { stdio: "ignore" });
  }
  assert.equal(turn(probe(p).rotation), turn(degrees), "fixture must carry its rotation tag");
  return p;
}

/** Degrees as a turn in (-180, 180], as `ensureWebReady` reports it (270 → -90, -180 → 180). */
const turn = (degrees) => {
  const a = ((Number(degrees) % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
};

/** What the Pulse app uploads: H.264 High 8-bit BT.709, mono 48 kHz AAC, faststart MP4. */
const PULSE_ENCODE = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-ac", "1", "-ar", "48000"];

test("conform: every way the Pulse app writes a recording keeps its bytes, rotation tag and all", { skip: !FFMPEG }, async () => {
  // iOS joins keep the camera's coded 1920×1080 with its orientation tag (portrait is -90° or 90°,
  // upside-down landscape 180°); a full render, and Android, write it upright.
  const landscape = await fixture("coded.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...PULSE_ENCODE, "-movflags", "+faststart"]);
  const upright = await fixture("upright.mp4", [...QUADRANTS("1080x1920"), ...TONE(), ...PULSE_ENCODE, "-movflags", "+faststart"]);
  const shapes = [landscape, upright, ...[90, -90, 180, 270].map((d) => tagged(landscape, d, `rot${d}.mp4`))];
  for (const p of shapes) {
    const before = await fs.readFile(p);
    const shown = quadrants(p);
    const result = await ensureWebReady(p);
    assert.deepEqual([result.action, result.reason], ["none", "already web-ready"], path.basename(p));
    assert.equal(result.outputPath, undefined);
    assert.deepEqual(await fs.readFile(p), before, `${path.basename(p)}: bytes untouched`);
    assert.equal(quadrants(p), shown, `${path.basename(p)}: shown the same way`);
  }
});

test("conform: a rotated video that is re-encoded anyway comes out upright, with no tag", { skip: !FFMPEG }, async () => {
  const big = await fixture("big.mp4", [...QUADRANTS("3840x2160"), ...TONE(), ...PULSE_ENCODE, "-movflags", "+faststart"]);
  for (const degrees of [90, -90, 180]) {
    const p = tagged(big, degrees, `big${degrees}.mp4`);
    const shown = quadrants(p);
    const result = await ensureWebReady(p);
    assert.equal(result.action, "transcoded");
    assert.match(result.reason, new RegExp(`rotation ${turn(degrees)}° applied`));
    const { video, rotation } = probe(p);
    const expected = degrees === 180 ? [1920, 1080] : [1080, 1920];
    assert.deepEqual([video.width, video.height], expected, `${degrees}°: the size it was shown at, capped`);
    assert.equal(rotation, 0, `${degrees}°: no tag left to apply`);
    assert.equal(quadrants(p, { autorotate: false }), shown, `${degrees}°: the stored pixels are upright`);
  }
});

test("conform: a rotated HEVC clip is transcoded to upright H.264", { skip: !FFMPEG }, async (t) => {
  const flat = await fixture("hevc.mp4", [...QUADRANTS("640x360"), "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error", "-movflags", "+faststart"]);
  if (!flat) return t.skip("ffmpeg build lacks libx265");
  const p = tagged(flat, 90, "hevc90.mp4");
  const shown = quadrants(p);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "transcoded");
  const { video, rotation } = probe(p);
  assert.equal(video.codec_name, "h264");
  assert.deepEqual([video.width, video.height, rotation], [360, 640, 0]);
  assert.equal(quadrants(p, { autorotate: false }), shown);
});

test("conform: stream copies keep the rotation tag (moov remux, container change, audio-only re-encode)", { skip: !FFMPEG }, async () => {
  const mp4 = await fixture("src.mp4", [...QUADRANTS("640x360"), ...TONE(), ...PULSE_ENCODE]);
  const cases = [
    { p: tagged(mp4, -90, "end.mp4", { faststart: false }), action: "remuxed", file: (r, p) => p },
    { p: tagged(mp4, -90, "phone.mov"), action: "conformed", file: (r) => r.outputPath },
  ];
  const pcm = await fixture("pcm-src.mov", [...QUADRANTS("640x360"), ...TONE(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le"]);
  cases.push({ p: tagged(pcm, 90, "pcm.mov"), action: "conformed", file: (r) => r.outputPath, audio: true });
  for (const { p, action, file, audio } of cases) {
    const before = probe(p);
    const shown = quadrants(p);
    const result = await ensureWebReady(p);
    assert.equal(result.action, action, path.basename(p));
    assert.doesNotMatch(result.reason, /→ h264/, `${path.basename(p)}: the video is copied`);
    if (audio) assert.match(result.reason, /audio pcm_s16le → aac/);
    const out = file(result, p);
    const after = probe(out);
    assert.deepEqual([after.video.width, after.video.height], [before.video.width, before.video.height]);
    assert.equal(after.rotation, before.rotation, `${path.basename(p)}: the tag is kept`);
    assert.equal(quadrants(out), shown, `${path.basename(p)}: shown the same way`);
    assert.equal(await scanMoovPosition(out), "front");
    assert.equal((await ensureWebReady(out)).action, "none", `${path.basename(p)}: conforms once done`);
  }
});

/** H.264 in full range, as a Pixel's Pulse recordings are, with the MP4 `colr` box written. */
const FULL_RANGE_ENCODE = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuvj420p", "-color_range", "pc", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-ac", "1", "-ar", "48000"];

/** A stream copy of `src` tagged `degrees`, with the `colr` box (`faststart: false` leaves `moov` at the end). */
function taggedWithColr(src, degrees, name, { faststart = true } = {}) {
  const p = path.join(path.dirname(src), name);
  const flags = faststart ? "+faststart+write_colr" : "+write_colr";
  try {
    execFileSync("ffmpeg", ["-v", "error", "-display_rotation", String(degrees), "-i", src, "-c", "copy", "-map", "0", "-movflags", flags, "-y", p], { stdio: "ignore" });
  } catch {
    execFileSync("ffmpeg", ["-v", "error", "-i", src, "-c", "copy", "-map", "0", "-metadata:s:v:0", `rotate=${(degrees + 360) % 360}`, "-movflags", flags, "-y", p], { stdio: "ignore" });
  }
  return p;
}

/** Turn the file's `colr` box into a `free` one (skipped by every reader): the container then says no range. */
async function dropColr(p) {
  const bytes = await fs.readFile(p);
  const at = bytes.indexOf("colrnclx", 0, "latin1");
  assert.ok(at > 0, `${path.basename(p)} has an nclx colr box`);
  bytes.write("free", at, "latin1");
  await fs.writeFile(p, bytes);
  return p;
}

/** Rewrite the full-range bit of the file's MP4 `colr` (nclx) box, so the container says `full`. */
async function setColrFullRange(p, full) {
  const bytes = await fs.readFile(p);
  const at = bytes.indexOf("colrnclx", 0, "latin1");
  assert.ok(at > 0, `${path.basename(p)} has an nclx colr box`);
  // type + nclx + primaries, transfer, matrix (2 bytes each), then the full-range bit.
  bytes[at + 14] = (bytes[at + 14] & 0x7f) | (full ? 0x80 : 0);
  await fs.writeFile(p, bytes);
}

/** The range the container declares (`container`, `none` without a colr box) and the first decoded frame's (`frame`). */
async function ranges(p) {
  const frame = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "frame=color_range", "-of", "csv=p=0", p]).toString().trim().split("\n")[0].replace(/,+$/, "");
  return { container: await readContainerRange(p), frame };
}

test("conform: a full-range recording keeps its bytes when the container and the video agree", { skip: !FFMPEG }, async () => {
  // A Pixel's Pulse recordings are full range (`yuvj420p`, the colr box saying so too), coded
  // 1920×1080 tagged ±90° or 1080×1920 upright; the app's joins keep them as they are.
  const coded = await fixture("full.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...FULL_RANGE_ENCODE]);
  const upright = await fixture("full-upright.mp4", [...QUADRANTS("1080x1920"), ...TONE(), ...FULL_RANGE_ENCODE, "-movflags", "+faststart+write_colr"]);
  const shapes = [
    [upright, "pc"], [taggedWithColr(coded, -90, "full-90.mp4"), "pc"], [taggedWithColr(coded, 90, "full+90.mp4"), "pc"],
    [await dropColr(taggedWithColr(coded, -90, "full-nocolr.mp4")), "none"],
  ];
  for (const [p, container] of shapes) {
    assert.deepEqual(await ranges(p), { container, frame: "pc" }, `${path.basename(p)}: fixture is full range`);
    const before = await fs.readFile(p);
    const result = await ensureWebReady(p);
    assert.deepEqual([result.action, result.reason], ["none", "already web-ready"], path.basename(p));
    assert.deepEqual(await fs.readFile(p), before, `${path.basename(p)}: bytes untouched`);
  }
});

test("conform: a range tagged two ways is re-encoded, and comes out limited range", { skip: !FFMPEG }, async () => {
  // iOS Safari shows the container's range, every other browser the video's: one of them is wrong.
  const full = await fixture("full-src.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...FULL_RANGE_ENCODE]);
  const limited = await fixture("limited-src.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...PULSE_ENCODE, "-color_range", "tv"]);
  const saysLimited = taggedWithColr(full, -90, "colr-limited.mp4");
  await setColrFullRange(saysLimited, false);
  const saysFull = taggedWithColr(limited, -90, "colr-full.mp4");
  await setColrFullRange(saysFull, true);
  for (const [p, container, frame] of [[saysLimited, "tv", "pc"], [saysFull, "pc", "tv"]]) {
    assert.deepEqual(await ranges(p), { container, frame }, `${path.basename(p)}: fixture disagrees with itself`);
    const shown = quadrants(p);
    const result = await ensureWebReady(p);
    assert.equal(result.action, "transcoded", path.basename(p));
    assert.match(result.reason, new RegExp(`range tagged ${container} in the container, ${frame} in the video`));
    const after = await ranges(p);
    assert.notEqual(after.container, "pc", `${path.basename(p)}: limited range out`);
    assert.notEqual(after.frame, "pc", `${path.basename(p)}: limited range out`);
    assert.equal(quadrants(p), shown, `${path.basename(p)}: shown the same way`);
    assert.equal((await ensureWebReady(p)).action, "none", `${path.basename(p)}: conforms once done`);
  }
});

test("conform: stream copies of a full-range video keep it full range in both places", { skip: !FFMPEG }, async () => {
  const full = await fixture("full-copy-src.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...FULL_RANGE_ENCODE]);
  const cases = [
    { p: taggedWithColr(full, -90, "full-end.mp4", { faststart: false }), action: "remuxed", file: (r, p) => p },
    { p: taggedWithColr(full, -90, "full.mov"), action: "conformed", file: (r) => r.outputPath },
  ];
  for (const { p, action, file } of cases) {
    const result = await ensureWebReady(p);
    assert.equal(result.action, action, path.basename(p));
    const out = file(result, p);
    const after = await ranges(out);
    assert.equal(after.frame, "pc", `${path.basename(p)}: full range in the video`);
    assert.notEqual(after.container, "tv", `${path.basename(p)}: the container doesn't say otherwise`);
    assert.equal((await ensureWebReady(out)).action, "none", `${path.basename(p)}: conforms once done`);
  }
});

/** Insert `count` empty `free` boxes before the top-level box `before`, or at the end of the file without one. */
async function insertFreeBoxes(p, count, before = null) {
  const bytes = await fs.readFile(p);
  let at = bytes.length;
  for (let o = 0; before && o + 8 <= bytes.length; o += bytes.readUInt32BE(o)) {
    if (bytes.toString("latin1", o + 4, o + 8) === before) { at = o; break; }
  }
  const free = Buffer.alloc(8 * count);
  for (let i = 0; i < count; i++) { free.writeUInt32BE(8, i * 8); free.write("free", i * 8 + 4, "latin1"); }
  await fs.writeFile(p, Buffer.concat([bytes.subarray(0, at), free, bytes.subarray(at)]));
  return p;
}

test("readContainerRange: stops at the boxes it needs, and says unknown when it can't read far enough", { skip: !FFMPEG }, async () => {
  const full = await fixture("range-src.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...FULL_RANGE_ENCODE]);
  // 10,001 boxes after a front moov: the walk stops at moov, so they are never read.
  const trailing = await insertFreeBoxes(taggedWithColr(full, -90, "trailing.mp4"), 10_001);
  assert.equal(await readContainerRange(trailing), "pc");
  const saysLimited = await insertFreeBoxes(taggedWithColr(full, -90, "trailing-limited.mp4"), 10_001);
  await setColrFullRange(saysLimited, false);
  assert.equal(await readContainerRange(saysLimited), "tv");
  const result = await ensureWebReady(saysLimited);
  assert.equal(result.action, "transcoded");
  assert.match(result.reason, /range tagged tv in the container, pc in the video/);
  // The same boxes before a moov at the end: the budget runs out first, so the range is unknown,
  // not absent, and a full-range video is re-encoded rather than trusted.
  const leading = await insertFreeBoxes(taggedWithColr(full, -90, "leading.mp4", { faststart: false }), 10_001, "moov");
  assert.equal(await readContainerRange(leading), "unknown");
  const unknown = await ensureWebReady(leading);
  assert.equal(unknown.action, "transcoded");
  assert.match(unknown.reason, /range tagged unknown in the container, pc in the video/);
  // Cut inside moov: unknown. Not ISO-BMFF: nothing declared.
  const cut = path.join(path.dirname(full), "cut.mp4");
  const whole = await fs.readFile(taggedWithColr(full, -90, "whole.mp4"));
  await fs.writeFile(cut, whole.subarray(0, whole.indexOf("moov", 0, "latin1") + 64));
  assert.equal(await readContainerRange(cut), "unknown");
  assert.equal(await readContainerRange(await tmpFile("text.mp4", Buffer.from("not a video at all"))), "none");
});

test("conform: a frame probe past probeTimeoutSeconds keeps the original", { skip: !FFMPEG }, async () => {
  const full = await fixture("frame-hang-src.mp4", [...QUADRANTS("1920x1080"), ...TONE(), ...FULL_RANGE_ENCODE]);
  const p = taggedWithColr(full, -90, "frame-hang.mp4");
  const before = await fs.readFile(p);
  // The metadata probe answers; the one-frame range probe hangs.
  const ffprobePath = await fakeBinary("ffprobe", 'case "$*" in *frame=color_range*) sleep 10;; *) exec ffprobe "$@";; esac');
  const started = Date.now();
  const result = await ensureWebReady(p, { ffprobePath, probeTimeoutSeconds: 1 });
  assert.equal(result.action, "skipped");
  assert.match(result.reason, /ffprobe timed out/);
  assert.ok(Date.now() - started < 8000, "the probe was killed, not waited out");
  assert.deepEqual(await fs.readFile(p), before, "bytes untouched");
});

test("conform: the size cap is the size a player shows, not the coded one", { skip: !FFMPEG }, async () => {
  // Coded 1920×1080, shown 1080×1920: within the default cap, over a 1280 one.
  const coded = await fixture("cap.mp4", [...QUADRANTS("1920x1080"), ...PULSE_ENCODE, "-movflags", "+faststart"]);
  const p = tagged(coded, 90, "cap90.mp4");
  assert.equal((await ensureWebReady(p)).action, "none");
  const shown = quadrants(p);
  const result = await ensureWebReady(p, { maxEdge: 1280 });
  assert.equal(result.action, "transcoded");
  assert.match(result.reason, /size 1080×1920/);
  const { video, rotation } = probe(p);
  assert.deepEqual([video.width, video.height, rotation], [720, 1280, 0]);
  assert.equal(quadrants(p, { autorotate: false }), shown);
});

test("extractPosterFrame: a rotated video's poster is upright", { skip: !FFMPEG }, async () => {
  const flat = await fixture("poster-src.mp4", [...QUADRANTS("640x360", 2), ...PULSE_ENCODE, "-movflags", "+faststart"]);
  const p = tagged(flat, -90, "poster90.mp4");
  const jpeg = await extractPosterFrame(p);
  assert.ok(jpeg, "a poster was made");
  const out = path.join(path.dirname(p), "poster.jpg");
  await fs.writeFile(out, jpeg);
  const { video } = probe(out);
  assert.deepEqual([video.width, video.height], [360, 640]);
  assert.equal(quadrants(out), quadrants(p));
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

test("conform: an odd maxEdge stays a cap (sizes round down to even)", { skip: !FFMPEG }, async () => {
  const p = await fixture("odd-cap.mp4", [...VIDEO("640x360"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
  const result = await ensureWebReady(p, { maxEdge: 321 });
  assert.equal(result.action, "transcoded");
  const { video } = probe(p);
  assert.deepEqual([video.width, video.height], [320, 180]);
});

/**
 * A stand-in for ffmpeg/ffprobe: `-version` (and ffmpeg's `-h`/`-filters` queries unless
 * `queries` is "empty") pass through to the real binary; anything else runs `body`.
 */
async function fakeBinary(real, body, { queries = "real" } = {}) {
  const dir = await scratchDir("fakebin-");
  const p = path.join(dir, real);
  const passQueries = queries === "real" ? `exec ${real} "$@"` : "exit 0";
  await fs.writeFile(p, [
    "#!/bin/sh",
    `case "$1" in -version) exec ${real} "$@";; esac`,
    `case "$*" in *"-h filter=scale"*|*"-filters"*) ${passQueries};; esac`,
    body,
  ].join("\n"), { mode: 0o755 });
  return p;
}

test("conform: a one-frame MKV (no frame count in the container) isn't a video", { skip: !FFMPEG }, async () => {
  const p = await fixture("one.mkv", [...VIDEO("320x240"), "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "matroska"]);
  const result = await ensureWebReady(p);
  assert.equal(result.action, "skipped");
  assert.match(result.reason, /not a video/);
});

test("conform: options that can't work are refused", async () => {
  await assert.rejects(ensureWebReady("/nonexistent.mp4", { maxEdge: 1 }), /maxEdge/);
  await assert.rejects(ensureWebReady("/nonexistent.mp4", { timeoutSeconds: 0 }), /timeoutSeconds/);
  await assert.rejects(ensureWebReady("/nonexistent.mp4", { probeTimeoutSeconds: -1 }), /probeTimeoutSeconds/);
});

test("conform: a failed run records a plain reason, never ffmpeg's output with server paths", { skip: !FFMPEG }, async () => {
  const p = await fixture("fail.webm", [...VIDEO("320x240"), "-c:v", "libvpx", "-f", "webm"]);
  const ffmpegPath = await fakeBinary("ffmpeg", 'echo "Error opening output /srv/secret/workspace/video/x.mp4" >&2; exit 1');
  const result = await ensureWebReady(p, { ffmpegPath });
  assert.equal(result.action, "skipped");
  assert.equal(result.reason, "conversion failed: ffmpeg exited with code 1");
});

test("conform: a hung ffprobe is cut off at probeTimeoutSeconds", { skip: !FFMPEG }, async () => {
  const p = await fixture("hang.mp4", [...VIDEO("320x240"), "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const ffprobePath = await fakeBinary("ffprobe", "sleep 10");
  const started = Date.now();
  const result = await ensureWebReady(p, { ffprobePath, probeTimeoutSeconds: 0.3 });
  assert.equal(result.action, "skipped");
  assert.match(result.reason, /ffprobe timed out/);
  assert.ok(Date.now() - started < 5000, "the probe was killed, not waited out");
});

test("conform: HDR on an ffmpeg that can't tone-map keeps the original and says why", { skip: !FFMPEG }, async (t) => {
  const p = await fixture("hdr.mov", [...VIDEO("320x240"),
    "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p10le",
    "-x265-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error"]);
  if (!p) return t.skip("ffmpeg build lacks libx265");
  const before = await fs.readFile(p);
  const ffmpegPath = await fakeBinary("ffmpeg", 'exec ffmpeg "$@"', { queries: "empty" });
  const result = await ensureWebReady(p, { ffmpegPath });
  assert.equal(result.action, "skipped");
  assert.match(result.reason, /needs tone mapping/);
  assert.deepEqual(await fs.readFile(p), before);
});
