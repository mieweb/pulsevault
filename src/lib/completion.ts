import fs from 'node:fs/promises';
import {
  CONFORM_TARGET,
  ensureWebReady,
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
  /** With `webReady.completeAfter`, what the conversion did — the hook runs once it has finished. */
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

  const describe = (artifactId: string): Promise<PulseVaultArtifactMeta | null> =>
    storage.describeArtifact ? storage.describeArtifact(artifactId) : Promise.resolve(null);

  const record = async (artifactId: string, patch: { acknowledged: true }) => {
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
   * Resolves whether this record applied.
   */
  const recordConversion = async (
    artifactId: string,
    generation: string | null,
    result: WebReadyResult,
    outputPath: string | undefined,
  ): Promise<boolean> => {
    let applied = false;
    try {
      applied =
        (await storage.patchArtifact?.(artifactId, {
          converted: true,
          webReady: result,
          unlessConverted: true,
          generation,
          ...(outputPath ? { file: outputPath, ext: CONFORM_TARGET.extension } : {}),
        })) ?? false;
    } catch (err) {
      logger.error({ err, artifactId }, 'pulsevault could not record a web-ready conversion');
    }
    if (!applied && outputPath) await fs.rm(outputPath, { force: true });
    return applied;
  };

  /** Rule 1. Never throws: a failed conversion serves the original bytes, and says why. */
  const convert = (ctx: PulseVaultUploadCompleteContext): Promise<WebReadyResult | undefined> =>
    new Promise((resolve) => {
      void queue.run(async () => {
        try {
          // What was read before this job waited for its slot may be stale: the artifact may
          // have been removed, or converted by another instance on the same disk, meanwhile.
          const fresh = await describe(ctx.artifactId);
          if (!fresh || fresh.converted) {
            resolve(fresh?.webReady);
            return;
          }
          const localPath = await (storage as LocalPathStorage).getLocalPath?.(ctx.artifactId);
          // `install: false`: the file is installed by the record below, under the adapter's
          // lock and conditions, never renamed over the stored file from here.
          const { outputPath, ...result } =
            typeof localPath === 'string'
              ? await ensureWebReady(localPath, { ...webReady, logger, install: false })
              : { action: 'skipped' as const, reason: 'no local path for this artifact', outputPath: undefined };
          if (!(await recordConversion(ctx.artifactId, fresh.generation ?? null, result, outputPath))) {
            resolve((await describe(ctx.artifactId))?.webReady);
            return;
          }
          await onArtifactEvent?.({
            phase: 'processed',
            artifactId: ctx.artifactId,
            kind: ctx.kind,
            size: ctx.size,
            reason: result.reason,
            webReady: result,
          });
          resolve(result);
        } catch (err) {
          logger.error({ err, artifactId: ctx.artifactId }, 'pulsevault web-ready conversion failed');
          resolve(undefined);
        }
      });
    });

  /** Rule 2. Rethrows what the hook threw. */
  const hook = async (
    request: PulseVaultRequest,
    ctx: PulseVaultUploadCompleteContext,
  ): Promise<void> => {
    if (onUploadComplete) await onUploadComplete(request, ctx);
    await record(ctx.artifactId, { acknowledged: true });
  };

  /** One artifact is settled by one caller at a time; a second caller joins the first. */
  const settling = new Map<string, Promise<void>>();

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
    const running = settling.get(upload.artifactId);
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
        const result = await convert(ctx);
        if (!needsHook) return;
        try {
          await hook(request, { ...ctx, ...(result ? { webReady: result } : {}) });
        } catch (err) {
          logger.error(
            { err, artifactId: ctx.artifactId, kind: ctx.kind },
            'pulsevault onUploadComplete failed after web-ready; it will be tried again',
          );
        }
      })();
      settling.set(upload.artifactId, run);
      void run.finally(() => settling.delete(upload.artifactId));
      return Promise.resolve();
    }
    run = (async () => {
      const conversion = needsConversion ? convert(ctx) : Promise.resolve(undefined);
      try {
        if (needsHook) await hook(request, ctx);
      } finally {
        // The settle covers the conversion too, so a replay doesn't queue it again meanwhile.
        void conversion.finally(() => settling.delete(upload.artifactId));
      }
    })();
    settling.set(upload.artifactId, run);
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
        if (!record.ready || settling.has(record.artifactId)) continue;
        let meta: PulseVaultArtifactMeta | null;
        try {
          meta = await storage.describeArtifact(record.artifactId);
        } catch (err) {
          logger.error({ err, artifactId: record.artifactId }, 'pulsevault replay could not read an artifact');
          continue;
        }
        if (!meta || !meta.ready || settling.has(meta.artifactId)) continue;
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
      await Promise.allSettled([...settling.values()]);
    },
  };
}
