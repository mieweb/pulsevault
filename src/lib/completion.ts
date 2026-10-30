import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONFORM_TARGET,
  ensureWebReady,
  extractPosterFrame,
  validateWebReadyOptions,
  type WebReadyOptions,
  type WebReadyResult,
} from './web-ready.js';
import { consoleLogger, type PulseVaultLogger, type PulseVaultRequest } from './request.js';
import type { PulseVaultArtifactMeta, PulseVaultStorage, UploadKind } from '../storage/types.js';
import { uploadIdOf } from '../storage/types.js';

/**
 * What `onUploadComplete` is told about a finished upload. Everything the client sent in
 * `Upload-Metadata` and everything the token carried, so a host can map the file to its own
 * record without reading storage back.
 */
export type PulseVaultUploadCompleteContext = {
  artifactId: string;
  kind: UploadKind;
  /** Bytes stored. `0` on a replay when the adapter can't tell. */
  size: number;
  /** tus's upload id (`<kind>/<artifactId><ext>`). */
  uploadId: string;
  /** Original filename from `Upload-Metadata.filename`. */
  filename: string;
  /** Lowercase extension of `filename`, with the leading dot. */
  ext: string;
  /** The video this artifact belongs to (`Upload-Metadata.relatedTo`), for a thumbnail, beat manifest or captions. */
  relatedTo?: string;
  /** The display name from `Upload-Metadata.name` (the draft's title), when sent. */
  name?: string;
  /** The uploading app's version, when sent. */
  appVersion?: string;
  /** The host data the capability token carried (`issueCapabilityToken`'s `context`). */
  context?: unknown;
  /**
   * `true` when PulseVault is firing this completion again: the hook threw, or the process
   * stopped, before it recorded the first one. Hosts must treat completion as at-least-once —
   * check their own record before writing it again.
   */
  replay: boolean;
  /**
   * What the web-ready conversion did, once it has run: with `webReady.completeAfter` the hook
   * runs after it, and a replayed hook gets the recorded result too.
   */
  webReady?: WebReadyResult;
};

export type PulseVaultOnUploadComplete = (
  request: PulseVaultRequest,
  ctx: PulseVaultUploadCompleteContext,
) => void | Promise<void>;

/**
 * Fired at low-frequency, audit-worthy moments — never per chunk — so an
 * operator can wire one hook to get both ops metrics and a compliance audit
 * trail without hand-rolling both from the lower-level hooks. `remove` fires
 * after PulseVault removed an artifact: a `DELETE /artifacts/:id` or a TUS
 * `DELETE` (`reason: "deleted"`), the `retention` sweep (`reason: "abandoned"`),
 * or a create that reclaimed an idle, unfinished upload (`reason: "reclaimed"`)
 * — so a host keeping its own index of artifacts can drop it. `processed`
 * fires when a web-ready conversion has finished, with what it did.
 */
export type PulseVaultArtifactEvent = {
  phase: 'authorize' | 'complete' | 'reject' | 'remove' | 'processed';
  artifactId: string;
  kind: UploadKind;
  size?: number;
  reason?: string;
  /** The uploading app's version, from `Upload-Metadata.appVersion` (`complete`/`reject` only). */
  appVersion?: string;
  /** What the conversion did (`processed` only). */
  webReady?: WebReadyResult;
};
export type PulseVaultOnArtifactEvent = (event: PulseVaultArtifactEvent) => void | Promise<void>;

/**
 * Web-ready conversion of every finished video to one format (`CONFORM_TARGET`: faststart MP4,
 * H.264 8-bit SDR at most `maxEdge` on the longest edge, AAC), by `ensureWebReady`, run after
 * the final `PATCH` is answered so the client never waits on ffmpeg. Local storage only; on an
 * adapter without `getLocalPath` the option is refused at boot.
 */
export type PulseVaultWebReadyOptions = WebReadyOptions & {
  /** How many conversions run at once. A transcode is CPU-bound; defaults to 1. */
  concurrency?: number;
  /**
   * Call `onUploadComplete` only once the conversion has finished, with `ctx.webReady` saying
   * what it did — so a host that publishes from the hook never publishes a video that's still
   * being rewritten. Defaults to `false`: the hook runs at once and the conversion follows.
   */
  completeAfter?: boolean;
  /**
   * Give a video that arrived without a thumbnail (a file from a host's own picker) a poster:
   * one frame, taken after the conversion and stored as a thumbnail `relatedTo` it, as a pulse
   * uploads one. A video that has a thumbnail is left alone. Before the hook with
   * `completeAfter`, so the host never publishes it without its poster. Needs a storage adapter
   * with `storeArtifact` (the local adapter). Defaults to `true`.
   */
  poster?: boolean;
};

export type PulseVaultReplayOptions = {
  /**
   * How often PulseVault settles finished artifacts it isn't done with: the host's
   * `onUploadComplete` never returned (it threw, or the process stopped first), or a conversion
   * never finished. The first pass runs shortly after start. Defaults to 300 seconds.
   */
  intervalSeconds?: number;
};

export type CompletionRunnerOptions = {
  storage: PulseVaultStorage;
  onUploadComplete?: PulseVaultOnUploadComplete;
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  webReady?: PulseVaultWebReadyOptions | boolean;
  replay?: PulseVaultReplayOptions | false;
  logger?: PulseVaultLogger;
};

export type FinishedUpload = { artifactId: string; kind: UploadKind; size: number; uploadId: string };

export type CompletionRunner = {
  /**
   * Settle an upload whose bytes are stored and marked ready. Resolves once the final request
   * may be answered: after `onUploadComplete` when it runs inline (and rejects when the hook
   * threw, so the client gets a non-2xx), or at once when the hook waits for the conversion.
   */
  complete(request: PulseVaultRequest, upload: FinishedUpload): Promise<void>;
  /**
   * One pass over storage: settle every finished artifact that still needs something — a hook
   * that never returned, a conversion that never finished. Resolves the artifactIds it settled.
   * Needs `storage.listArtifacts` and `describeArtifact`; resolves `[]` without them.
   */
  replay(): Promise<string[]>;
  /** Whether a web-ready conversion applies to an artifact of this kind: `webReady` is on and it's a video. */
  converts(kind: UploadKind): boolean;
  /**
   * Make a poster for a finished video stored before posters were made (or whose first try
   * failed), in the conversion queue: once per video per process, a no-op when it has a
   * thumbnail or `webReady.poster` is off. Never rejects. For the poster route's miss.
   */
  posterFor(artifactId: string): void;
  /** Start the periodic replay (no-op when replay is off). The timer never keeps the process alive. */
  start(): void;
  /** Stop the periodic replay and wait for conversions and hooks in progress. */
  stop(): Promise<void>;
};

const DEFAULT_REPLAY_INTERVAL_SECONDS = 300;
/** The first replay after start: late enough for the host to finish booting. */
const FIRST_REPLAY_DELAY_MS = 5_000;
/** A request-shaped stand-in for replays, whose original request is long gone. */
const REPLAY_REQUEST: PulseVaultRequest = { headers: {} };

type LocalPathStorage = PulseVaultStorage & {
  getLocalPath?: (artifactId: string) => Promise<string | null>;
};

/** Fail at boot on a setting that can't work, rather than silently doing nothing later. */
export function validateCompletionOptions(
  opts: Pick<CompletionRunnerOptions, 'storage' | 'webReady' | 'replay'>,
): void {
  if (opts.webReady) {
    if (typeof (opts.storage as LocalPathStorage).getLocalPath !== 'function') {
      throw new TypeError(
        '`webReady` needs a storage adapter with `getLocalPath` (the local adapter): ffmpeg rewrites the file in place',
      );
    }
    if (typeof opts.storage.patchArtifact !== 'function' || typeof opts.storage.describeArtifact !== 'function') {
      throw new TypeError('`webReady` needs a storage adapter with `patchArtifact` and `describeArtifact`');
    }
    if (typeof opts.webReady === 'object') {
      const { concurrency } = opts.webReady;
      if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) {
        throw new TypeError('`webReady.concurrency` must be a positive integer');
      }
      validateWebReadyOptions(opts.webReady);
    }
  }
  if (opts.replay) {
    const { intervalSeconds } = opts.replay;
    if (intervalSeconds !== undefined && !(intervalSeconds > 0 && Number.isFinite(intervalSeconds))) {
      throw new TypeError('`replayCompletions.intervalSeconds` must be a positive number of seconds');
    }
    // A replay that can find unacknowledged artifacts but can't record an acknowledgement would
    // run the hook again on every pass, forever.
    const { listArtifacts, describeArtifact, patchArtifact } = opts.storage;
    if (typeof listArtifacts === 'function' && typeof describeArtifact === 'function' && typeof patchArtifact !== 'function') {
      throw new TypeError(
        '`replayCompletions` needs a storage adapter with `patchArtifact` to record what was replayed (or set `replayCompletions: false`)',
      );
    }
  }
}

/** The hook context for an artifact, from its stored metadata. */
function contextFor(
  meta: PulseVaultArtifactMeta | null,
  upload: FinishedUpload,
  replay: boolean,
): PulseVaultUploadCompleteContext {
  return {
    artifactId: upload.artifactId,
    kind: upload.kind,
    size: upload.size,
    uploadId: upload.uploadId,
    filename: meta?.filename ?? '',
    // `filename`'s extension, as documented: the uploaded one, even once a conversion changed it.
    ext: meta ? (meta.sourceExt ?? meta.ext) : '',
    ...(meta?.relatedTo ? { relatedTo: meta.relatedTo } : {}),
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.appVersion ? { appVersion: meta.appVersion } : {}),
    ...(meta?.context !== undefined ? { context: meta.context } : {}),
    // What a conversion did, once one was recorded: a replayed hook gets it too, so a host that
    // names the file from it (an `.mp4` once a WebM was conformed) gets it right the second time.
    ...(meta?.converted && meta.webReady ? { webReady: meta.webReady } : {}),
    replay,
  };
}

/** A bounded set of concurrent jobs: `run` waits for a slot, `drain` waits for every job. */
function createQueue(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const running = new Set<Promise<void>>();
  const run = (job: () => Promise<void>): Promise<void> => {
    const task = (async () => {
      if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        await job();
      } finally {
        active--;
        waiting.shift()?.();
      }
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return task;
  };
  const drain = async (): Promise<void> => {
    while (running.size > 0) await Promise.allSettled([...running]);
  };
  return { run, drain };
}

/**
 * The completion pipeline shared by the core and the Fastify plugin. Everything it knows is on
 * the artifact's sidecar: `converted` (the web-ready pass finished; written `false` at reserve)
 * and `acknowledged` (the host's `onUploadComplete` returned). One rule settles a finished
 * artifact, whether its final chunk just landed, a retried request finished it a second time,
 * or a replay found it after a throw or a restart:
 *
 *   1. if a conversion applies and it isn't converted, convert (idempotent), then record it;
 *   2. if it isn't acknowledged, run the hook — after 1 with `completeAfter`, otherwise at
 *      once — then record it.
 *
 * The only thing kept in memory is which artifacts are being settled right now, so the same
 * artifact isn't settled twice at once.
 */
export function createCompletionRunner(opts: CompletionRunnerOptions): CompletionRunner {
  const { storage, onUploadComplete, onArtifactEvent } = opts;
  const logger = opts.logger ?? consoleLogger;
  const webReady: PulseVaultWebReadyOptions | undefined = opts.webReady
    ? typeof opts.webReady === 'object'
      ? opts.webReady
      : {}
    : undefined;
  const completeAfter = webReady?.completeAfter === true;
  const queue = createQueue(webReady?.concurrency ?? 1);
  const replayEvery =
    opts.replay === false ? null : (opts.replay?.intervalSeconds ?? DEFAULT_REPLAY_INTERVAL_SECONDS) * 1000;

  const converts = (kind: UploadKind): boolean => webReady !== undefined && kind === 'video';

  const postersOn =
    webReady !== undefined &&
    webReady.poster !== false &&
    typeof storage.storeArtifact === 'function' &&
    typeof storage.listRelated === 'function';

  /**
   * `videoId`'s thumbnail: `'ready'` once one is stored (its pulse sent one, or one was made),
   * `'pending'` while one is still uploading — it may yet arrive, or be abandoned — else `'none'`.
   */
  const thumbnailState = async (videoId: string): Promise<'ready' | 'pending' | 'none'> => {
    let state: 'pending' | 'none' = 'none';
    for await (const record of storage.listRelated!(videoId)) {
      if (record.kind !== 'thumbnail') continue;
      if (record.ready) return 'ready';
      state = 'pending';
    }
    return state;
  };

  /**
   * A poster for `videoId` when it has no thumbnail: a frame of the stored (conformed) file,
   * stored as a thumbnail `relatedTo` it. One at a time per video as it is now (its id and
   * `generation`), whichever path asked: a new upload of the id never joins a run on the old one.
   * Never throws: a video without a poster still plays. Resolves `'retry'` when it should be
   * tried again later (a thumbnail still uploading, the frame or the store failed, or the video
   * changed meanwhile), else `'done'`.
   */
  const posterRuns = new Map<string, Promise<'done' | 'retry'>>();
  const makePoster = async (videoId: string): Promise<'done' | 'retry'> => {
    if (!postersOn) return 'done';
    let video: PulseVaultArtifactMeta | null;
    try {
      video = await describe(videoId);
    } catch (err) {
      logger.error({ err, artifactId: videoId }, 'pulsevault could not make a poster');
      return 'retry';
    }
    if (!video?.ready) return 'done';
    // A video stored before generations were kept has none; any new upload of its id gets one.
    const generation = video.generation ?? null;
    const key = `${videoId}:${generation ?? ''}`;
    const running = posterRuns.get(key);
    if (running) return running;
    const run = (async (): Promise<'done' | 'retry'> => {
      try {
        const before = await thumbnailState(videoId);
        if (before !== 'none') return before === 'ready' ? 'done' : 'retry';
        const localPath = await (storage as LocalPathStorage).getLocalPath?.(videoId);
        if (typeof localPath !== 'string') return 'done';
        const bytes = await extractPosterFrame(localPath, { ...webReady, logger });
        if (!bytes) return 'retry';
        // A client thumbnail that arrived while the frame was made: no poster needed. One that
        // lands after this check still wins, in `getPulse`, over the `generated` poster.
        const after = await thumbnailState(videoId);
        if (after !== 'none') return after === 'ready' ? 'done' : 'retry';
        // Refused when the video was deleted or uploaded again meanwhile: not done, so the next
        // ask for its poster tries the video as it is then.
        const stored = await storage.storeArtifact!({
          artifactId: randomUUID(),
          kind: 'thumbnail',
          ext: '.jpg',
          filename: 'poster.jpg',
          relatedTo: videoId,
          relatedGeneration: generation,
          bytes,
        });
        return stored ? 'done' : 'retry';
      } catch (err) {
        logger.error({ err, artifactId: videoId }, 'pulsevault could not make a poster');
        return 'retry';
      }
    })().finally(() => posterRuns.delete(key));
    posterRuns.set(key, run);
    return run;
  };

  /**
   * Videos `posterFor` settled in this process, so a feed of old videos asks once each. A video
   * that should be tried again (a thumbnail still uploading, a failed frame, a conversion not
   * done yet) leaves the set, and its next poster request tries again. Cleared past the cap,
   * which only means a retry.
   */
  const POSTER_TRIED_LIMIT = 10_000;
  const posterTried = new Set<string>();
  const posterFor = (artifactId: string): void => {
    if (!postersOn || posterTried.has(artifactId)) return;
    if (posterTried.size >= POSTER_TRIED_LIMIT) posterTried.clear();
    posterTried.add(artifactId);
    void queue.run(async () => {
      let outcome: 'done' | 'retry' = 'retry';
      try {
        const meta = await describe(artifactId);
        if (!meta || meta.kind !== 'video') outcome = 'done';
        // A video still waiting on its conversion gets its poster there.
        else if (meta.ready && meta.converted) outcome = await makePoster(artifactId);
      } catch (err) {
        logger.error({ err, artifactId }, 'pulsevault could not make a poster');
      }
      if (outcome === 'retry') posterTried.delete(artifactId);
    });
  };

  const describe = (artifactId: string): Promise<PulseVaultArtifactMeta | null> =>
    storage.describeArtifact ? storage.describeArtifact(artifactId) : Promise.resolve(null);

  const record = async (artifactId: string, patch: { acknowledged: true; generation?: string | null }) => {
    try {
      await storage.patchArtifact?.(artifactId, patch);
    } catch (err) {
      // The work was done; a failed record means one extra pass over it, not a lost completion.
      logger.error({ err, artifactId, patch }, 'pulsevault could not record a completion step');
    }
  };

  /**
   * Record a conversion's result, and install the file it wrote (`outputPath`, a temporary
   * `.mp4` beside the stored file), in one patch under the adapter's lock: only for the upload
   * the conversion began on (`generation`) and only while no other pass has recorded one
   * (`unlessConverted`). Another container's original is deleted by the patch once the sidecar
   * names the `.mp4`. When the patch doesn't apply — the artifact was removed, or reserved again,
   * or converted elsewhere meanwhile — or fails, the file it wrote goes and nothing else
   * changes. Until a record is written the original serves and the next pass converts again.
   * `storedExt`: the extension of the file the conversion ran on, when it isn't the one the
   * sidecar names (the local adapter found the converted `.mp4` under a sidecar written from a
   * copy older than the conversion): the record names that file again. Resolves whether this
   * record applied.
   */
  const recordConversion = async (
    artifactId: string,
    generation: string | null,
    result: WebReadyResult,
    outputPath: string | undefined,
    storedExt?: string,
  ): Promise<boolean> => {
    let applied = false;
    try {
      applied =
        (await storage.patchArtifact?.(artifactId, {
          converted: true,
          webReady: result,
          unlessConverted: true,
          generation,
          ...(outputPath
            ? { file: outputPath, ext: CONFORM_TARGET.extension }
            : storedExt
              ? { ext: storedExt }
              : {}),
        })) ?? false;
    } catch (err) {
      logger.error({ err, artifactId }, 'pulsevault could not record a web-ready conversion');
    }
    if (!applied && outputPath) await fs.rm(outputPath, { force: true });
    return applied;
  };

  /**
   * Rule 1, for the reservation the work was scheduled for (`generation`; `undefined` when the
   * adapter can't say). Never throws: a failed conversion serves the original bytes, and says why.
   */
  const convert = (
    ctx: PulseVaultUploadCompleteContext,
    generation: string | null | undefined,
  ): Promise<WebReadyResult | undefined> =>
    new Promise((resolve) => {
      void queue.run(async () => {
        try {
          // What was read before this job waited for its slot may be stale: the artifact may
          // have been removed — and its id reserved again by another upload, which isn't this
          // job's — or converted by another instance on the same disk, meanwhile.
          const fresh = await describe(ctx.artifactId);
          if (!fresh || !fresh.ready || (generation !== undefined && (fresh.generation ?? null) !== generation)) {
            resolve(undefined);
            return;
          }
          if (fresh.converted) {
            resolve(fresh.webReady);
            return;
          }
          const localPath = await (storage as LocalPathStorage).getLocalPath?.(ctx.artifactId);
          // `install: false`: the file is installed by the record below, under the adapter's
          // lock and conditions, never renamed over the stored file from here. Only with a
          // generation: a conversion takes long enough for the id to be removed and uploaded
          // again, and without one the record couldn't tell this upload from that one.
          const { outputPath, ...result } =
            typeof localPath !== 'string'
              ? { action: 'skipped' as const, reason: 'no local path for this artifact', outputPath: undefined }
              : !fresh.generation
                ? { action: 'skipped' as const, reason: 'the storage adapter keeps no generation for this upload', outputPath: undefined }
                : await ensureWebReady(localPath, { ...webReady, logger, install: false });
          const expected = generation !== undefined ? generation : (fresh.generation ?? null);
          const localExt = typeof localPath === 'string' ? path.extname(localPath).toLowerCase() : '';
          const storedExt = localExt && localExt !== fresh.ext ? localExt : undefined;
          if (!(await recordConversion(ctx.artifactId, expected, result, outputPath, storedExt))) {
            // Lost to another pass: its result, but only while the id is still this reservation's
            // (a removal and a new upload of the id would hand back the new upload's result).
            const now = await describe(ctx.artifactId);
            resolve(now && (now.generation ?? null) === expected ? now.webReady : undefined);
            return;
          }
          // The result is recorded: an observer that throws is the observer's failure, not the
          // conversion's, and doesn't hide the result from the hook that follows it.
          try {
            await onArtifactEvent?.({
              phase: 'processed',
              artifactId: ctx.artifactId,
              kind: ctx.kind,
              size: ctx.size,
              reason: result.reason,
              webReady: result,
            });
          } catch (err) {
            logger.error({ err, artifactId: ctx.artifactId }, 'pulsevault onArtifactEvent (processed) failed');
          }
          // In the same slot. With `completeAfter` the hook waits for it, so the host is told of
          // the video with its poster; otherwise the conversion settles first, as it always has.
          // A new upload of the id starts fresh for the poster route's make-on-miss, too.
          posterTried.delete(ctx.artifactId);
          if (completeAfter) await makePoster(ctx.artifactId);
          resolve(result);
          if (!completeAfter) await makePoster(ctx.artifactId);
        } catch (err) {
          logger.error({ err, artifactId: ctx.artifactId }, 'pulsevault web-ready conversion failed');
          resolve(undefined);
        }
      });
    });

  /** Rule 2, recorded only on the reservation it ran for. Rethrows what the hook threw. */
  const hook = async (
    request: PulseVaultRequest,
    ctx: PulseVaultUploadCompleteContext,
    generation: string | null | undefined,
  ): Promise<void> => {
    if (onUploadComplete) await onUploadComplete(request, ctx);
    await record(ctx.artifactId, { acknowledged: true, ...(generation !== undefined ? { generation } : {}) });
  };

  /**
   * One upload is settled by one caller at a time; a second caller joins the first. Keyed by the
   * reservation too: a new upload of an id that was removed is never joined to the old one's.
   */
  const settling = new Map<string, Promise<void>>();
  const settlingKey = (artifactId: string, generation: string | null | undefined): string =>
    `${artifactId}/${generation ?? ''}`;

  /**
   * Apply the rule to one finished artifact. The request that finished the upload waits on the
   * result: it rejects when the hook threw, so the client gets a non-2xx — except with
   * `completeAfter`, where the hook follows the conversion in the background and the request
   * is answered at once. In the background (a replay, a hook after a conversion) a throw is
   * logged and left for the next pass.
   */
  const settle = (
    request: PulseVaultRequest,
    meta: PulseVaultArtifactMeta | null,
    upload: FinishedUpload,
    replay: boolean,
  ): Promise<void> => {
    const generation = meta ? (meta.generation ?? null) : undefined;
    const key = settlingKey(upload.artifactId, generation);
    const running = settling.get(key);
    if (running) return running;
    const ctx = contextFor(meta, upload, replay);
    // An adapter without `describeArtifact` can't say what was done: run everything (the hook
    // is at-least-once anyway, and the conversion is idempotent).
    const needsConversion = converts(upload.kind) && !(meta ? meta.converted : false);
    const needsHook = meta ? !meta.acknowledged : true;
    if (!needsConversion && !needsHook) return Promise.resolve();

    let run: Promise<void>;
    if (needsConversion && completeAfter) {
      // Nothing for the request to wait on: the hook follows the conversion.
      run = (async () => {
        const result = await convert(ctx, generation);
        if (!needsHook) return;
        try {
          await hook(request, { ...ctx, ...(result ? { webReady: result } : {}) }, generation);
        } catch (err) {
          logger.error(
            { err, artifactId: ctx.artifactId, kind: ctx.kind },
            'pulsevault onUploadComplete failed after web-ready; it will be tried again',
          );
        }
      })();
      settling.set(key, run);
      void run.finally(() => settling.delete(key));
      return Promise.resolve();
    }
    run = (async () => {
      const conversion = needsConversion ? convert(ctx, generation) : Promise.resolve(undefined);
      try {
        if (needsHook) await hook(request, ctx, generation);
      } finally {
        // The settle covers the conversion too, so a replay doesn't queue it again meanwhile.
        void conversion.finally(() => settling.delete(key));
      }
    })();
    settling.set(key, run);
    return run;
  };

  const complete = async (request: PulseVaultRequest, upload: FinishedUpload): Promise<void> =>
    settle(request, await describe(upload.artifactId), upload, false);

  /** The stored size of a finished upload, from tus's own record; `0` when it can't be read. */
  const storedSize = async (uploadId: string): Promise<number> => {
    try {
      const upload = await storage.datastore.getUpload(uploadId);
      return upload.size ?? upload.offset ?? 0;
    } catch {
      return 0;
    }
  };

  let replaying: Promise<string[]> | null = null;
  const replay = (): Promise<string[]> => {
    if (replaying) return replaying;
    replaying = (async () => {
      const replayed: string[] = [];
      if (typeof storage.listArtifacts !== 'function' || typeof storage.describeArtifact !== 'function') {
        return replayed;
      }
      const pending: Promise<void>[] = [];
      for await (const record of storage.listArtifacts()) {
        if (!record.ready) continue;
        let meta: PulseVaultArtifactMeta | null;
        try {
          meta = await storage.describeArtifact(record.artifactId);
        } catch (err) {
          logger.error({ err, artifactId: record.artifactId }, 'pulsevault replay could not read an artifact');
          continue;
        }
        if (!meta || !meta.ready || settling.has(settlingKey(meta.artifactId, meta.generation ?? null))) continue;
        if (meta.acknowledged && !(converts(meta.kind) && !meta.converted)) continue;
        const uploadId = uploadIdOf(meta);
        const upload: FinishedUpload = {
          artifactId: meta.artifactId,
          kind: meta.kind,
          size: await storedSize(uploadId),
          uploadId,
        };
        replayed.push(meta.artifactId);
        pending.push(
          settle(REPLAY_REQUEST, meta, upload, true).catch((err) => {
            logger.error(
              { err, artifactId: meta.artifactId, kind: meta.kind },
              'pulsevault onUploadComplete failed on replay; it will be tried again',
            );
          }),
        );
      }
      await Promise.all(pending);
      return replayed;
    })().finally(() => {
      replaying = null;
    });
    return replaying;
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = (delayMs: number): void => {
    if (stopped || replayEvery === null) return;
    timer = setTimeout(() => {
      timer = null;
      void replay()
        .catch((err) => logger.error({ err }, 'pulsevault completion replay failed'))
        .finally(() => schedule(replayEvery));
    }, delayMs);
    timer.unref();
  };

  return {
    complete,
    replay,
    converts,
    posterFor,
    start: () => {
      if (timer || stopped) return;
      schedule(Math.min(FIRST_REPLAY_DELAY_MS, replayEvery ?? FIRST_REPLAY_DELAY_MS));
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await replaying?.catch(() => []);
      await queue.drain();
      await Promise.allSettled([...settling.values(), ...posterRuns.values()]);
    },
  };
}
