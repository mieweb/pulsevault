// Web-ready backstop tests. The moov box scan runs against hand-crafted
// ISO-BMFF byte layouts (pure Node, no ffmpeg needed); the remux/transcode
// paths run against real files generated with ffmpeg and are skipped when
// ffmpeg/ffprobe are not installed, mirroring ensureWebReady's own fail-open
// behavior on such hosts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWebReady, scanMoovPosition } from '../dist/lib/web-ready.js';

function hasCmd(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = hasCmd('ffmpeg') && hasCmd('ffprobe');

async function tmpFile(name, bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webready-'));
  const p = path.join(dir, name);
  await fs.writeFile(p, bytes);
  return p;
}

/** Minimal top-level box: 4-byte big-endian size + 4-char type + payload. */
function box(type, payloadLength = 0) {
  const b = Buffer.alloc(8 + payloadLength);
  b.writeUInt32BE(8 + payloadLength, 0);
  b.write(type, 4, 'latin1');
  return b;
}

test("scanMoovPosition: moov before mdat is 'front'", async () => {
  const p = await tmpFile(
    'front.mp4',
    Buffer.concat([box('ftyp', 8), box('moov', 16), box('mdat', 32)]),
  );
  assert.equal(await scanMoovPosition(p), 'front');
});

test("scanMoovPosition: moov after mdat is 'end'", async () => {
  const p = await tmpFile(
    'end.mp4',
    Buffer.concat([box('ftyp', 8), box('mdat', 32), box('moov', 16)]),
  );
  assert.equal(await scanMoovPosition(p), 'end');
});

test("scanMoovPosition: non-MP4 bytes, truncation, missing moov are 'unknown'", async () => {
  assert.equal(
    await scanMoovPosition(
      await tmpFile('junk.bin', Buffer.from('this is not an mp4 file at all')),
    ),
    'unknown',
  );
  assert.equal(await scanMoovPosition(await tmpFile('empty.mp4', Buffer.alloc(0))), 'unknown');
  // ftyp present but the file ends before any moov shows up.
  assert.equal(
    await scanMoovPosition(
      await tmpFile('nomoov.mp4', Buffer.concat([box('ftyp', 8), box('mdat', 32)])),
    ),
    'unknown',
  );
  // A box header claiming a size smaller than 8 is corrupt — bail, don't loop.
  const corrupt = Buffer.concat([box('ftyp', 8), box('mdat', 8)]);
  corrupt.writeUInt32BE(3, 16);
  assert.equal(await scanMoovPosition(await tmpFile('corrupt.mp4', corrupt)), 'unknown');
  assert.equal(await scanMoovPosition('/nonexistent/definitely-not-here.mp4'), 'unknown');
});

test('scanMoovPosition: 64-bit largesize boxes are stepped over', async () => {
  // mdat with size==1 and the real size in the 8-byte largesize field.
  const payload = 24;
  const mdat = Buffer.alloc(16 + payload);
  mdat.writeUInt32BE(1, 0);
  mdat.write('mdat', 4, 'latin1');
  mdat.writeBigUInt64BE(BigInt(16 + payload), 8);
  const p = await tmpFile('large.mp4', Buffer.concat([box('ftyp', 8), mdat, box('moov', 16)]));
  assert.equal(await scanMoovPosition(p), 'end');
});

test('ensureWebReady: non-MP4 file is skipped untouched', async () => {
  const p = await tmpFile('junk.bin', Buffer.from('not a video'));
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p);
  assert.equal(result.action, 'skipped');
  assert.deepEqual(await fs.readFile(p), before, 'bytes must be untouched');
});

test("ensureWebReady: missing ffmpeg fails open as 'skipped'", async () => {
  const p = await tmpFile(
    'end.mp4',
    Buffer.concat([box('ftyp', 8), box('mdat', 32), box('moov', 16)]),
  );
  const before = await fs.readFile(p);
  const result = await ensureWebReady(p, {
    ffmpegPath: '/nonexistent/ffmpeg',
    ffprobePath: '/nonexistent/ffprobe',
  });
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /not available/);
  assert.deepEqual(await fs.readFile(p), before, 'bytes must be untouched');
});

test(
  'ensureWebReady: moov-at-end H.264 gets a lossless faststart remux',
  { skip: !FFMPEG },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webready-'));
    const p = path.join(dir, 'recorded.mp4');
    // No -movflags +faststart: like a mobile recorder, ffmpeg writes moov last.
    execFileSync(
      'ffmpeg',
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        p,
      ],
      { stdio: 'ignore' },
    );
    assert.equal(await scanMoovPosition(p), 'end', 'fixture must start moov-at-end');

    const result = await ensureWebReady(p);
    assert.equal(result.action, 'remuxed');
    assert.equal(await scanMoovPosition(p), 'front');

    // Idempotent: a second pass finds nothing to do.
    const again = await ensureWebReady(p);
    assert.equal(again.action, 'none');
  },
);

test('ensureWebReady: HEVC is transcoded to H.264 (+faststart)', { skip: !FFMPEG }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webready-'));
  const p = path.join(dir, 'hevc.mp4');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30:duration=1',
        '-c:v',
        'libx265',
        '-tag:v',
        'hvc1',
        '-pix_fmt',
        'yuv420p',
        '-y',
        p,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    t.skip('ffmpeg build lacks libx265');
    return;
  }

  const result = await ensureWebReady(p);
  assert.equal(result.action, 'transcoded');
  const codec = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    p,
  ])
    .toString()
    .trim();
  assert.equal(codec, 'h264');
  assert.equal(await scanMoovPosition(p), 'front');
});

test(
  'ensureWebReady: transcode:false leaves hostile codecs alone after the remux',
  { skip: !FFMPEG },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webready-'));
    const p = path.join(dir, 'hevc-noconvert.mp4');
    try {
      execFileSync(
        'ffmpeg',
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x240:rate=30:duration=1',
          '-c:v',
          'libx265',
          '-tag:v',
          'hvc1',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-y',
          p,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      t.skip('ffmpeg build lacks libx265');
      return;
    }

    const result = await ensureWebReady(p, { transcode: false });
    assert.equal(result.action, 'none');
    assert.match(result.reason, /transcode disabled/);
  },
);
