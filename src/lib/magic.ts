import fs from 'node:fs/promises';
import type { PulseVaultLogger, PulseVaultRequest } from './request.js';
import { isBinaryAvailable, probeVideo } from './web-ready.js';
import type { LocalStorage } from '../storage/local.js';
import type { S3Storage } from '../storage/s3.js';
import type { UploadKind } from '../storage/types.js';

/**
 * Optional plugin-level hook: after TUS writes the final byte but before the
 * upload is marked ready (or the consumer's `onUploadComplete` runs),
 * validate the payload bytes. Throw to reject — the plugin translates the
 * throw into a 422 response, calls `storage.remove?.(artifactId)` to free the
 * disk, and never flips the sidecar to `"ready"`.
 *
 * The `localPath` field is populated for adapters that expose
 * `getLocalPath` (the built-in local adapter does). For adapters whose
 * bytes don't live on local disk (S3, etc.), `localPath` is `null` and the
 * validator has to fetch bytes through whatever API the adapter provides.
 */
export type PulseVaultValidatePayload = (
  request: PulseVaultRequest,
  ctx: {
    artifactId: string;
    size: number;
    uploadId: string;
    /** Which artifact kind this upload is. Runs for every kind — branch on this if you only want a check applied to one. */
    kind: UploadKind;
    /** Absolute local path to the finalized bytes, or `null` if unavailable. */
    localPath: string | null;
    /** Client-supplied `<algorithm>:<hex>` digest, if `Upload-Metadata.checksum` was sent. */
    checksum?: string;
  },
) => void | Promise<void>;

/**
 * Check whether a file's first bytes match the ISO base media file format
 * (`ftyp` box at offset 4), which covers MP4, MOV, M4V, 3GP, and related
 * containers. This is the same check tools like `file(1)` and ffprobe use
 * to identify MP4-family videos.
 *
 * Not a full MP4 parse — just a ~12-byte sniff. Enough to reject uploads
 * that are obviously not video (PDFs, HTML, random bytes) before the
 * server ever serves them back as `video/mp4`.
 */
export async function sniffMp4(filePath: string): Promise<boolean> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fd.read(buf, 0, 12, 0);
    if (bytesRead < 12) return false;
    return hasFtypBox(buf);
  } finally {
    await fd.close();
  }
}

/**
 * Whether a buffer's first 12 bytes carry an ISO base media `ftyp` box.
 * Bytes 4..7 must spell "ftyp" (ASCII 0x66 0x74 0x79 0x70). The first four
 * bytes are the box size and the four after "ftyp" are the brand (e.g.
 * "isom", "mp42", "qt  ") — brand validation is left to downstream tools.
 */
function hasFtypBox(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

/**
 * Build a `validatePayload` hook that enforces every uploaded file is a
 * valid MP4-family container. Only works with `LocalStorage` (or any
 * adapter that exposes `getLocalPath`) — pulls the path from the storage
 * and runs `sniffMp4` against it.
 *
 * Usage:
 * ```ts
 * const storage = createLocalStorage({ workspaceDir: "./data" });
 * await app.register(pulseVault, {
 *   storage,
 *   validatePayload: createMp4Sniffer(storage),
 *   // ...
 * });
 * ```
 */
export function createMp4Sniffer(storage: LocalStorage): PulseVaultValidatePayload {
  return async (_request, { artifactId }) => {
    const localPath = await storage.getLocalPath(artifactId);
    if (!localPath) {
      throw Object.assign(
        new Error(`Cannot validate upload ${artifactId}: no local path available`),
        { statusCode: 500 },
      );
    }
    const ok = await sniffMp4(localPath);
    if (!ok) {
      throw Object.assign(new Error('Uploaded bytes are not a valid MP4 (missing ftyp header)'), {
        statusCode: 422,
      });
    }
  };
}

/**
 * `createMp4Sniffer` for the S3 / R2 backend. Instead of opening a local file,
 * it asks the adapter for the first 12 bytes of the finalized object via a
 * small ranged GET (`S3Storage.readHeader`) and applies the same `ftyp` check.
 * Runs in the same lifecycle slot — after `@tus/s3-store` completes the
 * multipart upload (so the object is readable) but before `markReady` — so a
 * non-MP4 upload is removed and never served.
 *
 * Usage:
 * ```ts
 * const storage = await createS3Storage({ ... });
 * await app.register(pulseVault, {
 *   storage,
 *   validatePayload: createS3Mp4Sniffer(storage),
 *   // ...
 * });
 * ```
 */
export function createS3Mp4Sniffer(storage: S3Storage): PulseVaultValidatePayload {
  return async (_request, { artifactId }) => {
    const header = await storage.readHeader(artifactId, 12);
    if (!header) {
      throw Object.assign(
        new Error(`Cannot validate upload ${artifactId}: no object bytes available`),
        { statusCode: 500 },
      );
    }
    if (!hasFtypBox(header)) {
      throw Object.assign(new Error('Uploaded bytes are not a valid MP4 (missing ftyp header)'), {
        statusCode: 422,
      });
    }
  };
}

/**
 * Whether a file's first bytes open one of the video containers PulseVault accepts: ISO base
 * media (`ftyp`: MP4, MOV, M4V, 3GP), EBML (WebM, MKV) or RIFF `AVI `. A ~12-byte sniff, for
 * when ffprobe isn't installed: it tells a video container from a renamed document, not a
 * playable video from a broken one.
 */
export async function sniffVideo(filePath: string): Promise<boolean> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fd.read(buf, 0, 12, 0);
    if (bytesRead < 12) return false;
    const ebml = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    const avi = buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'AVI ';
    return hasFtypBox(buf) || ebml || avi;
  } finally {
    await fd.close();
  }
}

export type VideoValidatorOptions = {
  /** Refuse a video longer than this many seconds. Default: no limit. */
  maxDurationSeconds?: number;
  /** Path to the ffprobe binary. Default `"ffprobe"` (resolved via PATH). */
  ffprobePath?: string;
  /** Optional logger; `error` fires once when ffprobe is missing. */
  logger?: PulseVaultLogger;
};

/** `90` → "1.5 minutes", `600` → "10 minutes", `45` → "45 seconds". */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const warnedNoProbe = new Set<string>();

/**
 * Build a `validatePayload` hook that checks a video by what it is, not its file name: ffprobe
 * must find a video stream with a duration above zero (and, with `maxDurationSeconds`, not
 * longer than that). Without ffprobe on the host it falls back to `sniffVideo` and logs once.
 * Other kinds pass untouched. Needs the bytes on local disk (the local adapter).
 *
 * A refusal is a `422` whose message a host can show as it is: "That file isn't a video." or
 * "That video is longer than the limit of 10 minutes."
 *
 * Usage:
 * ```ts
 * await app.register(pulseVault, {
 *   storage: createLocalStorage({ workspaceDir: "./data" }),
 *   validatePayload: createVideoValidator({ maxDurationSeconds: 600 }),
 *   // ...
 * });
 * ```
 */
export function createVideoValidator(options: VideoValidatorOptions = {}): PulseVaultValidatePayload {
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const { maxDurationSeconds } = options;
  if (maxDurationSeconds !== undefined && !(maxDurationSeconds > 0 && Number.isFinite(maxDurationSeconds))) {
    throw new TypeError('`maxDurationSeconds` must be a positive number of seconds');
  }
  const refuse = (message: string): never => {
    throw Object.assign(new Error(message), { statusCode: 422 });
  };
  return async (_request, { artifactId, kind, localPath }) => {
    if (kind !== 'video') return;
    if (!localPath) {
      throw Object.assign(
        new Error(`Cannot validate upload ${artifactId}: no local path available`),
        { statusCode: 500 },
      );
    }
    if (!(await isBinaryAvailable(ffprobePath))) {
      if (!warnedNoProbe.has(ffprobePath)) {
        warnedNoProbe.add(ffprobePath);
        options.logger?.error(
          { ffprobePath },
          'pulsevault video check: ffprobe not found — only the container bytes are checked. ' +
            'Install ffmpeg (apt install ffmpeg / brew install ffmpeg) to check videos fully.',
        );
      }
      if (!(await sniffVideo(localPath))) refuse("That file isn't a video.");
      return;
    }
    const probe = await probeVideo(localPath, ffprobePath);
    if (!probe || probe.durationSeconds === null) refuse("That file isn't a video.");
    if (maxDurationSeconds !== undefined && (probe?.durationSeconds ?? 0) > maxDurationSeconds) {
      refuse(`That video is longer than the limit of ${formatDuration(maxDurationSeconds)}.`);
    }
  };
}
