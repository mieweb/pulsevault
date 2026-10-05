import { ensureWebReady, type WebReadyOptions, type WebReadyResult } from './web-ready.js';
import { consoleLogger, type PulseVaultLogger, type PulseVaultRequest } from './request.js';
import type { PulseVaultArtifactMeta, PulseVaultStorage, UploadKind } from '../storage/types.js';

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
 * fires when a background web-ready conversion has finished, with what it did.
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
 * Background web-ready conversion of every finished video: a lossless faststart remux, or an
 * H.264 transcode for a codec browsers can't play (`ensureWebReady`), run after the final
 * `PATCH` is answered so the client never waits on ffmpeg. Local storage only; on an adapter
 * without `getLocalPath` the option is refused at boot.
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
   * How often PulseVault looks for finished artifacts whose `onUploadComplete` never finished
   * (it threw, or the process stopped first) and fires it again, and resumes a conversion a
   * restart interrupted. The first pass runs shortly after start. Defaults to 300 seconds.
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

export type CompletionRunner = {
  /**
   * Run the completion of an upload whose bytes are stored and marked ready. Resolves once the
   * final request may be answered: after `onUploadComplete` when it runs inline (and rejects
   * when the hook threw, so the client gets a non-2xx), or at once with `webReady.completeAfter`.
   */
  complete(request: PulseVaultRequest, upload: FinishedUpload): Promise<void>;
  /**
   * One pass over storage: fire `onUploadComplete` for every finished artifact the host hasn't
   * acknowledged, and resume a conversion a restart interrupted. Resolves the artifactIds it
   * replayed. Needs `storage.listArtifacts` and `describeArtifact`; resolves `[]` without them.
   */
  replay(): Promise<string[]>;
  /** Start the periodic replay (no-op when replay is off). The timer never keeps the process alive. */
  start(): void;
  /** Stop the periodic replay and wait for conversions and replays in progress. */
  stop(): Promise<void>;
};

export type FinishedUpload = { artifactId: string; kind: UploadKind; size: number; uploadId: string };

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
    if (typeof opts.storage.patchArtifact !== 'function') {
      throw new TypeError('`webReady` needs a storage adapter with `patchArtifact`');
    }
    if (typeof opts.webReady === 'object') {
      const { concurrency } = opts.webReady;
      if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) {
        throw new TypeError('`webReady.concurrency` must be a positive integer');
      }
    }
  }
  if (opts.replay) {
    const { intervalSeconds } = opts.replay;
    if (intervalSeconds !== undefined && !(intervalSeconds > 0 && Number.isFinite(intervalSeconds))) {
      throw new TypeError('`replayCompletions.intervalSeconds` must be a positive number of seconds');
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
    ext: meta?.ext ?? '',
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
 * The completion pipeline shared by the core and the Fastify plugin: the host's
 * `onUploadComplete`, acknowledged in storage once it returns so a completion that never
 * finished can be fired again; the background web-ready queue; and the periodic replay.
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

  /**
   * Artifacts this process is working on, which the replay leaves alone: `completing` while the
   * host's hook runs, `converting` from the moment a conversion is queued (not only once it has
   * a slot — a video waiting behind a long transcode must not be queued twice) until it ends.
   */
  const completing = new Set<string>();
  const converting = new Set<string>();
  const inFlight = (artifactId: string): boolean =>
    completing.has(artifactId) || converting.has(artifactId);

  const describe = (artifactId: string): Promise<PulseVaultArtifactMeta | null> =>
    storage.describeArtifact ? storage.describeArtifact(artifactId) : Promise.resolve(null);

  const acknowledge = async (artifactId: string): Promise<void> => {
    try {
      await storage.patchArtifact?.(artifactId, { acknowledged: true });
    } catch (err) {
      // The hook ran; a failed acknowledgement means one extra replay, not a lost completion.
      logger.error({ err, artifactId }, 'pulsevault could not acknowledge a completion');
    }
  };

  /** Fire the host's hook once and record that it finished. Rethrows what the hook threw. */
  const runHook = async (
    request: PulseVaultRequest,
    ctx: PulseVaultUploadCompleteContext,
  ): Promise<void> => {
    if (onUploadComplete) await onUploadComplete(request, ctx);
    await acknowledge(ctx.artifactId);
  };

  /** Whether a video's bytes need the conversion, and where they are. */
  const localPathFor = async (artifactId: string): Promise<string | null> => {
    const adapter = storage as LocalPathStorage;
    const localPath = await adapter.getLocalPath?.(artifactId);
    return typeof localPath === 'string' ? localPath : null;
  };

  /**
   * Convert in the background, then (with `completeAfter`) run the hook. Never throws: a failed
   * conversion serves the original bytes, and a hook that throws is replayed later.
   */
  const convert = (
    request: PulseVaultRequest,
    ctx: PulseVaultUploadCompleteContext,
    runHookAfter: boolean,
  ): Promise<void> => {
    if (converting.has(ctx.artifactId)) return Promise.resolve(); // already queued or running
    converting.add(ctx.artifactId);
    return queue.run(async () => {
      try {
        const localPath = await localPathFor(ctx.artifactId);
        const result: WebReadyResult = localPath
          ? await ensureWebReady(localPath, { ...webReady, logger })
          : { action: 'skipped', reason: 'no local path for this artifact' };
        await storage.patchArtifact?.(ctx.artifactId, { processing: false });
        await onArtifactEvent?.({
          phase: 'processed',
          artifactId: ctx.artifactId,
          kind: ctx.kind,
          size: ctx.size,
          reason: result.reason,
          webReady: result,
        });
        if (runHookAfter) {
          try {
            await runHook(request, { ...ctx, webReady: result });
          } catch (err) {
            logger.error(
              { err, artifactId: ctx.artifactId, kind: ctx.kind },
              'pulsevault onUploadComplete failed after web-ready; it will be replayed',
            );
          }
        }
      } catch (err) {
        logger.error({ err, artifactId: ctx.artifactId }, 'pulsevault web-ready conversion failed');
        await storage.patchArtifact?.(ctx.artifactId, { processing: false }).catch(() => {});
      } finally {
        converting.delete(ctx.artifactId);
      }
    });
  };

  const complete = async (request: PulseVaultRequest, upload: FinishedUpload): Promise<void> => {
    const meta = await describe(upload.artifactId);
    // A final PATCH the client retried after losing the 204 finishes the upload a second time.
    // The hook already ran and was recorded: don't run it again (a conversion still going on is
    // the queue's business). And a conversion already queued — with `completeAfter`, the hook
    // follows it — must not be queued twice.
    if (meta?.acknowledged || meta?.processing || inFlight(upload.artifactId)) return;
    const ctx = contextFor(meta, upload, false);
    const converts = webReady !== undefined && upload.kind === 'video';
    if (converts) {
      await storage.patchArtifact?.(upload.artifactId, { processing: true });
      void convert(request, ctx, completeAfter);
      if (completeAfter) return;
    }
    completing.add(upload.artifactId);
    try {
      await runHook(request, ctx);
    } finally {
      completing.delete(upload.artifactId);
    }
  };

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
      for await (const record of storage.listArtifacts()) {
        if (!record.ready || inFlight(record.artifactId)) continue;
        let meta: PulseVaultArtifactMeta | null;
        try {
          meta = await storage.describeArtifact(record.artifactId);
        } catch (err) {
          logger.error({ err, artifactId: record.artifactId }, 'pulsevault replay could not read an artifact');
          continue;
        }
        if (!meta || inFlight(meta.artifactId)) continue;
        if (meta.acknowledged && !meta.processing) continue;
        const uploadId = `${meta.kind}/${meta.artifactId}${meta.ext}`;
        const upload: FinishedUpload = {
          artifactId: meta.artifactId,
          kind: meta.kind,
          size: await storedSize(uploadId),
          uploadId,
        };
        const ctx = contextFor(meta, upload, true);
        const convertible = webReady !== undefined && meta.kind === 'video';
        if (meta.processing) {
          // A conversion a restart interrupted. `ensureWebReady` is idempotent, so a rewrite
          // that did finish before the flag was cleared is a no-op here.
          if (convertible) {
            void convert(REPLAY_REQUEST, ctx, !meta.acknowledged && completeAfter);
            if (meta.acknowledged || completeAfter) {
              replayed.push(meta.artifactId);
              continue;
            }
          } else {
            await storage.patchArtifact?.(meta.artifactId, { processing: false }).catch(() => {});
          }
          if (meta.acknowledged) continue;
        } else if (convertible) {
          // Unacknowledged and never marked as converting: the process may have stopped between
          // `markReady` and recording that a conversion was due. Converting again costs a probe
          // when the bytes are already web-ready, so convert in both modes; `completeAfter` only
          // decides whether the hook waits for it.
          await storage.patchArtifact?.(meta.artifactId, { processing: true }).catch(() => {});
          void convert(REPLAY_REQUEST, ctx, completeAfter);
          if (completeAfter) {
            replayed.push(meta.artifactId);
            continue;
          }
        }
        completing.add(meta.artifactId);
        try {
          await runHook(REPLAY_REQUEST, ctx);
          replayed.push(meta.artifactId);
        } catch (err) {
          logger.error(
            { err, artifactId: meta.artifactId, kind: meta.kind },
            'pulsevault onUploadComplete failed on replay; it will be tried again',
          );
        } finally {
          completing.delete(meta.artifactId);
        }
      }
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
    },
  };
}
