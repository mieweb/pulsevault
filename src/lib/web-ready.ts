import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PulseVaultLogger } from './request.js';

const execFileAsync = promisify(execFile);

/**
 * Conform uploaded videos to one web-playable format: the one the Pulse app records.
 *
 * A video reaches PulseVault from the Pulse app (already in the target format) or from a host's
 * own file picker: a screen recording, an iPhone HEVC `.mov` (often 10-bit HDR), a WebM from a
 * browser recorder, a 4K clip. Browsers streaming over progressive HTTP need the `moov` atom at
 * the front, a codec they all decode, and 8-bit SDR colour; a phone needs a sane size.
 *
 * `ensureWebReady` does the least work that gets a file there: nothing when it already
 * conforms (a Pulse upload keeps its bytes), a lossless remux when only the container or the
 * `moov` position is off, and otherwise one ffmpeg run that re-encodes only the streams that
 * are off-target. Fail-open by design: without `ffmpeg`/`ffprobe`, or when a run fails or
 * times out, the original bytes keep serving and the result says why.
 */

/**
 * The format every video is served in. "Already conforms" checks exactly these properties —
 * never the orientation: a landscape video stays landscape and a portrait one portrait, with no
 * crop, pad or stretch.
 */
export const CONFORM_TARGET = {
  /** MP4 with the `moov` atom at the front (faststart). */
  container: 'mp4',
  extension: '.mp4',
  /**
   * H.264, 8-bit 4:2:0 in limited range, even width and height, SDR, no rotation tag. HDR (PQ,
   * HLG) is tone-mapped to BT.709; an SDR source keeps its own colour tags (BT.709 or BT.601),
   * which browsers honour — so a Pulse upload from any phone keeps its bytes.
   */
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  /** Default cap on the longest edge, in pixels (`webReady.maxEdge`). */
  maxEdge: 1920,
  /** AAC; a video without audio stays silent. */
  audioCodec: 'aac',
} as const;

/** The containers the conform step turns into the target: the default video `allowedExtensions`. */
export const CONFORM_VIDEO_EXTENSIONS: readonly string[] = [
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.3gp',
  '.avi',
];

/** ffprobe demuxers that read still or animated images, not video. */
const IMAGE_FORMATS = /^(image2|[a-z0-9]+_pipe|gif|apng|webp)$/;

/** Transfer functions of HDR video (PQ and HLG): tone-mapped to SDR on the way in. */
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

/**
 * - `none`: already in the target format; the bytes are untouched.
 * - `remuxed`: only the `moov` position was off; rewritten losslessly, same file.
 * - `transcoded`: an MP4 whose video or audio was re-encoded, same file.
 * - `conformed`: a different container (WebM, MKV, MOV, …) rewritten as a new `.mp4`.
 * - `skipped`: nothing was done (no ffmpeg, a failed or timed-out run); the original serves.
 */
export type WebReadyAction = 'none' | 'remuxed' | 'transcoded' | 'conformed' | 'skipped';

export type WebReadyResult = {
  action: WebReadyAction;
  /** Human-readable explanation (what was detected and done, or why nothing was done). */
  reason: string;
};

export type WebReadyOptions = {
  /** Path to the ffmpeg binary. Default `"ffmpeg"` (resolved via PATH). */
  ffmpegPath?: string;
  /** Path to the ffprobe binary. Default `"ffprobe"` (resolved via PATH). */
  ffprobePath?: string;
  /**
   * Whether an off-target stream is re-encoded. Default `true`. Set `false` to never re-encode:
   * only lossless remuxes still run (a `moov` moved to the front, or another container whose
   * streams already conform copied into an `.mp4`) — useful when transcode cost on the serving
   * host is a concern.
   */
  transcode?: boolean;
  /** Longest edge of the served video, in pixels; larger videos are scaled down. Default `1920`. */
  maxEdge?: number;
  /** x264 CRF for the transcode path (lower = better/larger). Default `23`. */
  crf?: number;
  /** x264 preset for the transcode path. Default `"veryfast"`. */
  preset?: string;
  /**
   * Wall-clock limit for one ffmpeg run, in seconds; the run is killed and the original kept.
   * Default `60 + 10 × the video's duration`, or an hour when the duration is unknown.
   */
  timeoutSeconds?: number;
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
 * either box.
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
        // Anything that doesn't open with ftyp isn't MP4-family.
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

/** What ffprobe says about a video: the streams the conform step maps, and its length. */
export type VideoProbe = {
  video: {
    index: number;
    codec: string;
    pixelFormat: string;
    width: number;
    height: number;
    /** The colour transfer (`bt709`, `arib-std-b67`, …), when tagged. */
    transfer?: string;
    /** Display rotation in degrees from the stream's matrix (`0`, `90`, `-90`, `180`). */
    rotation: number;
  };
  /** The first audio stream, or `null` for a silent video. */
  audio: { index: number; codec: string } | null;
  /** Seconds, or `null` when neither the header nor the packets say. */
  durationSeconds: number | null;
};

type ProbeStream = {
  index?: number;
  nb_frames?: string;
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  color_transfer?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ rotation?: number | string }>;
  tags?: { rotate?: string };
};

/** Degrees to the nearest quarter turn in (-180, 180]: 270 → -90, -180 → 180, 360 → 0. */
const quarterTurn = (degrees: number): number =>
  [0, 90, 180, -90][(((Math.round(degrees / 90) % 4) + 4) % 4)] ?? 0;

const positive = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The end of the last video packet, for a file whose header carries no duration (a WebM from
 * a browser's MediaRecorder is written without one). Demuxes the file without decoding it.
 */
async function packetDuration(filePath: string, ffprobePath: string, index: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-select_streams', String(index),
        '-show_entries', 'packet=pts_time,duration_time',
        '-of', 'csv=p=0',
        filePath,
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    let end = 0;
    for (const line of stdout.split('\n')) {
      const [pts, duration] = line.split(',');
      const start = positive(pts) ?? 0;
      end = Math.max(end, start + (positive(duration) ?? 0));
    }
    return end > 0 ? end : null;
  } catch {
    return null;
  }
}

/**
 * ffprobe a file: its first real video stream (not cover art), its first audio stream and its
 * duration. `null` when it isn't a video: ffprobe can't read it, it has no video stream, or it
 * is a picture (an image file, or a stream of one frame).
 */
export async function probeVideo(filePath: string, ffprobePath = 'ffprobe'): Promise<VideoProbe | null> {
  let parsed: { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-show_entries',
        'stream=index,codec_type,codec_name,pix_fmt,width,height,color_transfer,nb_frames' +
          ':stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate' +
          ':format=duration,format_name',
        '-of', 'json',
        filePath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const streams = parsed.streams ?? [];
  const video = streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.width && s.height,
  );
  if (!video || typeof video.index !== 'number') return null;
  // A picture isn't a video: an image file (PNG, JPEG, GIF, WebP) read by an image demuxer, or
  // a single-frame stream (an iPhone HEIC photo is an ISO-BMFF file with one HEVC frame).
  if (IMAGE_FORMATS.test(parsed.format?.format_name ?? '') || Number(video.nb_frames) === 1) return null;
  const audio = streams.find((s) => s.codec_type === 'audio');
  const sideRotation = video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  const rotation = Number(sideRotation ?? video.tags?.rotate ?? 0) || 0;
  const durationSeconds =
    positive(parsed.format?.duration) ?? (await packetDuration(filePath, ffprobePath, video.index));
  return {
    video: {
      index: video.index,
      codec: video.codec_name ?? '',
      pixelFormat: video.pix_fmt ?? '',
      width: video.width ?? 0,
      height: video.height ?? 0,
      ...(video.color_transfer ? { transfer: video.color_transfer } : {}),
      rotation: quarterTurn(rotation),
    },
    audio: audio && typeof audio.index === 'number' ? { index: audio.index, codec: audio.codec_name ?? '' } : null,
    durationSeconds,
  };
}

// One availability probe per (binary path) per process — a missing ffmpeg
// should cost one spawn and one warning, not one of each per upload.
const binaryAvailable = new Map<string, Promise<boolean>>();
const warnedMissing = new Set<string>();
export function isBinaryAvailable(binPath: string): Promise<boolean> {
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

/** Whether this host can conform videos: both `ffmpeg` and `ffprobe` run. */
export async function webReadyAvailable(
  options: Pick<WebReadyOptions, 'ffmpegPath' | 'ffprobePath'> = {},
): Promise<boolean> {
  const [ffmpeg, ffprobe] = await Promise.all([
    isBinaryAvailable(options.ffmpegPath ?? 'ffmpeg'),
    isBinaryAvailable(options.ffprobePath ?? 'ffprobe'),
  ]);
  return ffmpeg && ffprobe;
}

/**
 * How this ffmpeg can tone-map HDR to SDR: FFmpeg 8+'s `scale` converts transfer and primaries
 * itself; older builds need the `zscale` filter (libzimg, in the Debian/Ubuntu packages); a
 * build with neither converts the pixels without tone mapping.
 */
type ToneMapper = 'scale' | 'zscale' | null;
const toneMappers = new Map<string, Promise<ToneMapper>>();
function toneMapperOf(ffmpegPath: string): Promise<ToneMapper> {
  let cached = toneMappers.get(ffmpegPath);
  if (!cached) {
    cached = (async (): Promise<ToneMapper> => {
      try {
        const { stdout: scaleHelp } = await execFileAsync(ffmpegPath, ['-hide_banner', '-h', 'filter=scale']);
        if (scaleHelp.includes('out_transfer')) return 'scale';
        const { stdout: filters } = await execFileAsync(ffmpegPath, ['-hide_banner', '-filters']);
        return /\szscale\s/.test(filters) ? 'zscale' : null;
      } catch {
        return null;
      }
    })();
    toneMappers.set(ffmpegPath, cached);
  }
  return cached;
}

/**
 * Rounded to whole pixels, then down to even (at least 2): never above the limit it was scaled
 * to (an odd `maxEdge` stays a cap), and an odd source edge loses a pixel rather than gaining one.
 */
const even = (n: number): number => Math.max(2, 2 * Math.floor(Math.round(n) / 2));

/** The displayed size (after rotation) scaled so the longest edge is at most `maxEdge`. */
function targetSize(video: VideoProbe['video'], maxEdge: number): { width: number; height: number } {
  const sideways = Math.abs(video.rotation) === 90;
  const width = sideways ? video.height : video.width;
  const height = sideways ? video.width : video.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

/** The `-vf` chain for a re-encode: tone map (HDR), scale to the target size, 8-bit 4:2:0. */
function videoFilter(
  size: { width: number; height: number },
  hdr: boolean,
  toneMapper: ToneMapper,
): string {
  const { width, height } = size;
  if (hdr && toneMapper === 'scale') {
    return (
      `scale=w=${width}:h=${height}:out_transfer=bt709:out_primaries=bt709` +
      ':out_color_matrix=bt709:out_range=tv:intent=perceptual,format=yuv420p'
    );
  }
  if (hdr && toneMapper === 'zscale') {
    return (
      'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,' +
      `zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=${width}:${height}`
    );
  }
  // `out_range=tv`: a full-range source (`yuvj420p`, as iPhone screen recordings are) is
  // converted to the limited range of `yuv420p`; `format` alone keeps the source's range.
  return `scale=${width}:${height}:out_range=tv,format=yuv420p`;
}

class TimeoutError extends Error {}

/**
 * Run ffmpeg into a sibling tmp file, then rename it onto `outputPath` (the input itself, or a
 * new `.mp4` beside it). The rename is atomic, so a crash never leaves a half-written artifact.
 */
async function rewrite(
  inputPath: string,
  outputPath: string,
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  // randomUUID in the name: every video artifact shares one kind directory, so
  // a pid+timestamp tmp name collides when two uploads finish in the same
  // millisecond — both ffmpegs would interleave writes into one file and the
  // winner's rename would install garbage bytes over a real artifact.
  const tmp = path.join(path.dirname(inputPath), `.webready-${randomUUID()}${CONFORM_TARGET.extension}`);
  try {
    try {
      await execFileAsync(ffmpegPath, ['-y', '-v', 'error', '-i', inputPath, ...args, tmp], {
        // Cap the buffered stderr; the wall clock is capped by the timeout.
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      if ((err as { killed?: boolean }).killed) {
        throw new TimeoutError(`timed out after ${Math.round(timeoutMs / 100) / 10} s`);
      }
      throw err;
    }
    // ffmpeg exiting 0 with an empty/absent output would still be a corrupt
    // swap — verify there are real bytes before replacing the original.
    const stat = await fs.stat(tmp);
    if (stat.size === 0) throw new Error('ffmpeg produced an empty output');
    await fs.rename(tmp, outputPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** The first line of an ffmpeg failure, for a reason a person can read. */
function failureOf(err: unknown): string {
  if (err instanceof TimeoutError) return err.message;
  const stderr = (err as { stderr?: string }).stderr?.trim().split('\n').pop();
  return stderr || (err as Error).message || String(err);
}

/**
 * Bring the video at `filePath` to `CONFORM_TARGET`:
 *
 * - already conforming → `none`, bytes untouched;
 * - an MP4 with conforming streams but the `moov` at the end → lossless faststart remux in
 *   place (`remuxed`);
 * - any other container with conforming streams → lossless remux into a new `.mp4` beside it
 *   (`conformed`);
 * - otherwise one ffmpeg run: the video re-encoded to H.264 when its codec, pixel format, bit
 *   depth, size, rotation or dynamic range is off (scaled by the longest edge, rotation
 *   applied, HDR tone-mapped), the audio re-encoded to AAC unless it already is — in place for
 *   an MP4 (`transcoded`), into a new `.mp4` otherwise (`conformed`);
 * - no ffmpeg/ffprobe, a file ffprobe can't read, a failed or timed-out run → `skipped` with
 *   the reason; the original is untouched.
 *
 * When the result carries `outputPath`, the conformed file was written there (`<name>.mp4`)
 * and the original is left in place: the caller switches the artifact over, then removes it.
 * Never throws for pipeline reasons.
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
): Promise<WebReadyResult & { outputPath?: string }> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const transcode = options.transcode ?? true;
  const maxEdge = options.maxEdge ?? CONFORM_TARGET.maxEdge;
  const crf = options.crf ?? 23;
  const preset = options.preset ?? 'veryfast';

  if (!(await webReadyAvailable({ ffmpegPath, ffprobePath }))) {
    const key = `${ffmpegPath}|${ffprobePath}`;
    if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      options.logger?.error(
        { filePath },
        'pulsevault web-ready: ffmpeg/ffprobe not found — uploads are served as-is. ' +
          'Install ffmpeg (apt install ffmpeg / brew install ffmpeg) to conform videos for the web.',
      );
    }
    return { action: 'skipped', reason: 'ffmpeg/ffprobe not available' };
  }

  const probe = await probeVideo(filePath, ffprobePath);
  if (!probe) return { action: 'skipped', reason: 'not a video ffprobe can read' };
  const { video, audio } = probe;
  const moov = await scanMoovPosition(filePath);
  const isMp4 = path.extname(filePath).toLowerCase() === CONFORM_TARGET.extension && moov !== 'unknown';

  // What's off-target, stream by stream.
  const hdr = video.transfer !== undefined && HDR_TRANSFERS.has(video.transfer);
  const size = targetSize(video, maxEdge);
  const videoOff: string[] = [];
  if (video.codec !== CONFORM_TARGET.videoCodec) videoOff.push(`codec ${video.codec}`);
  if (video.pixelFormat !== CONFORM_TARGET.pixelFormat) videoOff.push(`pixel format ${video.pixelFormat}`);
  if (hdr) videoOff.push(`HDR (${video.transfer})`);
  if (video.rotation !== 0) videoOff.push(`rotation ${video.rotation}°`);
  if (video.rotation === 0 && (size.width !== video.width || size.height !== video.height)) {
    videoOff.push(`size ${video.width}×${video.height}`);
  }
  const audioOff = audio !== null && audio.codec !== CONFORM_TARGET.audioCodec;

  if (videoOff.length === 0 && !audioOff && isMp4 && moov === 'front') {
    return { action: 'none', reason: 'already web-ready' };
  }

  if ((videoOff.length > 0 || audioOff) && !transcode) {
    const off = [...videoOff, ...(audioOff ? [`audio ${audio?.codec}`] : [])].join(', ');
    if (isMp4 && moov === 'end') {
      try {
        await rewrite(filePath, filePath, ffmpegPath, ['-c', 'copy', '-map', '0', '-movflags', '+faststart'], timeoutOf(options, probe));
        return { action: 'remuxed', reason: `moov was at end of file; remuxed to faststart (${off} left as-is: transcode disabled)` };
      } catch (err) {
        options.logger?.error({ err, filePath }, 'pulsevault web-ready: faststart remux failed; serving original bytes');
        return { action: 'skipped', reason: `remux failed: ${failureOf(err)}` };
      }
    }
    return { action: 'none', reason: `${off} left as-is (transcode disabled)` };
  }

  const args = ['-map', `0:${video.index}`, ...(audio ? ['-map', `0:${audio.index}`] : []), '-sn', '-dn'];
  const done: string[] = [];
  if (videoOff.length > 0) {
    const toneMapper = hdr ? await toneMapperOf(ffmpegPath) : null;
    args.push(
      '-vf', videoFilter(size, hdr, toneMapper),
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    );
    // An 8-bit SDR output must not keep the source's HDR colour tags.
    if (hdr) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    const toneMapped = !hdr ? '' : toneMapper ? ', tone-mapped' : ', not tone-mapped (this ffmpeg can\'t)';
    done.push(`video ${videoOff.join(', ')} → h264 ${size.width}×${size.height}${toneMapped}`);
  } else {
    args.push('-c:v', 'copy');
  }
  if (audioOff) {
    args.push('-c:a', 'aac', '-b:a', '160k');
    done.push(`audio ${audio?.codec} → aac`);
  } else if (audio) {
    args.push('-c:a', 'copy');
  }
  args.push('-movflags', '+faststart');

  const outputPath = isMp4
    ? filePath
    : path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${CONFORM_TARGET.extension}`);
  const action: WebReadyAction = !isMp4 ? 'conformed' : done.length > 0 ? 'transcoded' : 'remuxed';
  if (!isMp4) {
    const ext = path.extname(filePath).toLowerCase();
    done.unshift(`container ${ext && ext !== CONFORM_TARGET.extension ? ext : 'not MP4'} → mp4`);
  }
  if (isMp4 && moov === 'end') done.push('moov moved to the front');
  try {
    await rewrite(filePath, outputPath, ffmpegPath, args, timeoutOf(options, probe));
  } catch (err) {
    options.logger?.error({ err, filePath }, `pulsevault web-ready: ${action === 'remuxed' ? 'remux' : 'conversion'} failed; serving original bytes`);
    return { action: 'skipped', reason: `${action === 'remuxed' ? 'remux' : 'conversion'} failed: ${failureOf(err)}` };
  }
  const reason = action === 'remuxed' ? 'moov was at end of file; remuxed to faststart' : `${done.join('; ')} (+faststart)`;
  return { action, reason, ...(outputPath !== filePath ? { outputPath } : {}) };
}

/** The wall-clock limit for one run over this video, in ms. */
function timeoutOf(options: WebReadyOptions, probe: VideoProbe): number {
  const seconds =
    options.timeoutSeconds ?? (probe.durationSeconds !== null ? 60 + 10 * probe.durationSeconds : 3600);
  return Math.max(1, Math.round(seconds * 1000));
}
