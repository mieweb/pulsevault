import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PulseVaultLogger } from './request.js';

const execFileAsync = promisify(execFile);

/**
 * Web-playability backstop for uploaded MP4 artifacts.
 *
 * Browsers streaming an MP4 over progressive HTTP need two things the mobile
 * capture pipelines frequently don't provide:
 *
 * 1. The `moov` atom at the FRONT of the file ("faststart"). iOS/Android
 *    recorders finalize the moov at the end, so a `<video>` tag must fetch the
 *    file's tail before it can render frame one — a multi-second stall behind
 *    Range requests, or a full download in naive players.
 * 2. A codec browsers actually decode. iPhones record HEVC by default, which
 *    Firefox never plays and Chrome usually can't without hardware support.
 *
 * `ensureWebReady` fixes both in place: a lossless sub-second remux
 * (`-c copy -movflags +faststart`) when only the moov position is wrong, and a
 * one-time H.264 transcode when the codec is hostile. Fail-open by design —
 * if `ffmpeg`/`ffprobe` are not installed, or the file isn't MP4-family, the
 * artifact is left byte-for-byte as uploaded and serving continues exactly as
 * before.
 */

/** Codecs every mainstream browser decodes without hardware caveats. */
const WEB_SAFE_VIDEO_CODECS = new Set(['h264']);

export type WebReadyAction = 'none' | 'remuxed' | 'transcoded' | 'skipped';

export type WebReadyResult = {
  action: WebReadyAction;
  /** Human-readable explanation (what was detected, or why nothing was done). */
  reason: string;
};

export type WebReadyOptions = {
  /** Path to the ffmpeg binary. Default `"ffmpeg"` (resolved via PATH). */
  ffmpegPath?: string;
  /** Path to the ffprobe binary. Default `"ffprobe"` (resolved via PATH). */
  ffprobePath?: string;
  /**
   * Whether a non-web-safe codec triggers a full H.264 transcode. Default
   * `true`. Set `false` to only ever do the lossless faststart remux —
   * useful when transcode cost on the serving host is a concern.
   */
  transcode?: boolean;
  /** x264 CRF for the transcode path (lower = better/larger). Default `23`. */
  crf?: number;
  /** x264 preset for the transcode path. Default `"veryfast"`. */
  preset?: string;
  /** Optional logger; `error` fires when ffmpeg/ffprobe are missing or a rewrite fails. */
  logger?: PulseVaultLogger;
};

/** Where the moov atom sits among the file's top-level boxes. */
export type MoovPosition = 'front' | 'end' | 'unknown';

/**
 * Walk the file's top-level ISO-BMFF boxes and report whether `moov` appears
 * before or after `mdat`. Pure Node (a handful of 16-byte header reads) — no
 * ffprobe needed, so the cheap common case ("already faststart, do nothing")
 * costs microseconds regardless of file size.
 *
 * Returns `"unknown"` for non-MP4 bytes, truncated headers, or files missing
 * either box — callers should treat that as "leave the file alone".
 */
export async function scanMoovPosition(filePath: string): Promise<MoovPosition> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, 'r');
  } catch {
    return 'unknown';
  }
  try {
    const { size: fileSize } = await fd.stat();
    let offset = 0;
    let sawMdat = false;
    let first = true;
    while (offset + 8 <= fileSize) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await fd.read(header, 0, 16, offset);
      if (bytesRead < 8) return 'unknown';
      let boxSize = header.readUInt32BE(0);
      const boxType = header.toString('latin1', 4, 8);
      if (first) {
        // Anything that doesn't open with ftyp isn't MP4-family — don't touch it.
        if (boxType !== 'ftyp') return 'unknown';
        first = false;
      }
      if (boxSize === 1) {
        // 64-bit largesize in the 8 bytes after the type.
        if (bytesRead < 16) return 'unknown';
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return 'unknown';
        boxSize = Number(large);
      } else if (boxSize === 0) {
        // Box extends to end of file.
        boxSize = fileSize - offset;
      }
      if (boxSize < 8) return 'unknown';
      if (boxType === 'moov') return sawMdat ? 'end' : 'front';
      if (boxType === 'mdat') sawMdat = true;
      offset += boxSize;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    await fd.close();
  }
}

/** ffprobe the first video stream's codec name; `null` when unprobeable. */
async function probeVideoCodec(filePath: string, ffprobePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const codec = stdout.trim();
    return codec.length > 0 ? codec : null;
  } catch {
    return null;
  }
}

// One availability probe per (binary path) per process — a missing ffmpeg
// should cost one spawn and one warning, not one of each per upload.
const binaryAvailable = new Map<string, Promise<boolean>>();
const warnedMissing = new Set<string>();
function isBinaryAvailable(binPath: string): Promise<boolean> {
  let cached = binaryAvailable.get(binPath);
  if (!cached) {
    cached = execFileAsync(binPath, ['-version']).then(
      () => true,
      () => false,
    );
    binaryAvailable.set(binPath, cached);
  }
  return cached;
}

/** Run ffmpeg writing to a sibling tmp file, then atomically replace the original. */
async function rewriteInPlace(filePath: string, ffmpegPath: string, args: string[]): Promise<void> {
  const dir = path.dirname(filePath);
  // randomUUID in the name: every video artifact shares one kind directory, so
  // a pid+timestamp tmp name collides when two uploads finish in the same
  // millisecond — both ffmpegs would interleave writes into one file and the
  // winner's rename would install garbage bytes over a real artifact.
  const tmp = path.join(dir, `.webready-${randomUUID()}${path.extname(filePath) || '.mp4'}`);
  try {
    await execFileAsync(ffmpegPath, ['-y', '-i', filePath, ...args, tmp], {
      // A transcode of a long upload legitimately takes minutes; cap the
      // buffered stderr instead of the wall clock.
      maxBuffer: 16 * 1024 * 1024,
    });
    // ffmpeg exiting 0 with an empty/absent output would still be a corrupt
    // swap — verify there are real bytes before replacing the original.
    const stat = await fs.stat(tmp);
    if (stat.size === 0) throw new Error('ffmpeg produced an empty output');
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Make the MP4 at `filePath` web-playable, in place:
 *
 * - moov at the end + web-safe codec → lossless `-c copy -movflags +faststart`
 *   remux (sub-second, no quality change);
 * - non-web-safe codec (HEVC etc.) → one-time `libx264` transcode (audio
 *   stream-copied) with faststart;
 * - already faststart H.264, non-MP4 bytes, unprobeable files, or missing
 *   ffmpeg/ffprobe → untouched (`skipped`/`none`).
 *
 * The rewrite is atomic (tmp file + rename in the same directory), so a crash
 * mid-way never corrupts the served artifact. Never throws for pipeline
 * reasons — a failed ffmpeg run resolves to `skipped` with the reason, and the
 * original bytes keep serving.
 *
 * NOTE: a rewrite changes the artifact's bytes, so any upload-time checksum
 * recorded for it (e.g. the local adapter's sidecar `checksum` from
 * `Upload-Metadata`) describes the ORIGINAL bytes, not the rewritten file.
 * Consumers verifying bytes against `getChecksum` must treat it as
 * upload-time provenance, not current-file integrity.
 */
export async function ensureWebReady(
  filePath: string,
  options: WebReadyOptions = {},
): Promise<WebReadyResult> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const transcode = options.transcode ?? true;
  const crf = options.crf ?? 23;
  const preset = options.preset ?? 'veryfast';

  const moov = await scanMoovPosition(filePath);
  if (moov === 'unknown') {
    return { action: 'skipped', reason: 'not an MP4-family file (or no moov/mdat found)' };
  }

  if (!(await isBinaryAvailable(ffprobePath)) || !(await isBinaryAvailable(ffmpegPath))) {
    const key = `${ffmpegPath}|${ffprobePath}`;
    if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      options.logger?.error(
        { filePath },
        'pulsevault web-ready: ffmpeg/ffprobe not found — uploads are served as-is. ' +
          'Install ffmpeg (apt install ffmpeg / brew install ffmpeg) to enable faststart remux and H.264 transcode.',
      );
    }
    return { action: 'skipped', reason: 'ffmpeg/ffprobe not available' };
  }

  const codec = await probeVideoCodec(filePath, ffprobePath);
  const codecHostile = codec !== null && !WEB_SAFE_VIDEO_CODECS.has(codec);

  if (codecHostile && transcode) {
    try {
      await rewriteInPlace(filePath, ffmpegPath, [
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-crf',
        String(crf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
      ]);
      return { action: 'transcoded', reason: `video codec ${codec} → h264 (+faststart)` };
    } catch (err) {
      options.logger?.error(
        { err, filePath },
        'pulsevault web-ready: transcode failed; serving original bytes',
      );
      return { action: 'skipped', reason: `transcode failed: ${(err as Error).message}` };
    }
  }

  if (moov === 'end') {
    try {
      await rewriteInPlace(filePath, ffmpegPath, ['-c', 'copy', '-movflags', '+faststart']);
      return { action: 'remuxed', reason: 'moov was at end of file; remuxed to faststart' };
    } catch (err) {
      options.logger?.error(
        { err, filePath },
        'pulsevault web-ready: faststart remux failed; serving original bytes',
      );
      return { action: 'skipped', reason: `remux failed: ${(err as Error).message}` };
    }
  }

  return {
    action: 'none',
    reason: codecHostile
      ? `already faststart; codec ${codec} left as-is (transcode disabled)`
      : 'already web-ready',
  };
}
