import { consoleLogger, type PulseVaultLogger } from './request.js';
import type { PulseVaultArtifactRecord, PulseVaultStorage } from '../storage/types.js';

/**
 * Opt-in cleanup of what abandoned uploads leave behind. A client that dies mid-upload (an app
 * killed, a phone that never comes back) leaves an unfinished upload, and the related artifacts
 * it finished before its video — captions, a beat manifest, a thumbnail — belong to a video that
 * will never arrive. Nothing else removes them.
 */
export type PulseVaultRetentionOptions = {
  /**
   * Remove an upload still unfinished this long after its last activity (the local adapter) or
   * after it started (S3), and a finished related artifact — anything but a video — whose
   * `relatedTo` artifact isn't finished (or is gone) this long after it finished. Finished videos
   * are never removed. Keep it well above how long an upload may take — at least your capability
   * tokens' lifetime, past which no upload can continue anyway.
   */
  abandonedAfterSeconds: number;
  /** How often to sweep. Defaults to 3600 (an hour); at most 24 days. */
  sweepIntervalSeconds?: number;
};

export type SweepAbandonedUploadsOptions = {
  /** See `PulseVaultRetentionOptions.abandonedAfterSeconds`. */
  abandonedAfterSeconds: number;
  /** The time to measure from, in ms since the epoch. Defaults to now. */
  now?: number;
  /** Called after each removal — e.g. to update the host's own index of artifacts. */
  onRemoved?: (record: PulseVaultArtifactRecord) => void | Promise<void>;
  /** Stops the sweep between artifacts (shutdown). */
  signal?: AbortSignal;
  /** Where a failure to check or remove one artifact is logged. Defaults to `console`. */
  logger?: PulseVaultLogger;
};

const DEFAULT_SWEEP_INTERVAL_SECONDS = 3600;
/** The longest delay a Node timer takes; anything above fires after 1 ms instead. */
const MAX_SWEEP_INTERVAL_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

const isPositiveSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Fail at boot on a retention setting that can't work, rather than sweeping wrongly later. */
export function validateRetentionOptions(
  retention: PulseVaultRetentionOptions | undefined,
  storage: PulseVaultStorage,
): void {
  if (retention === undefined) return;
  const { abandonedAfterSeconds, sweepIntervalSeconds } = retention;
  if (!isPositiveSeconds(abandonedAfterSeconds)) {
    throw new TypeError('`retention.abandonedAfterSeconds` must be a positive number of seconds');
  }
  if (
    sweepIntervalSeconds !== undefined &&
    (!isPositiveSeconds(sweepIntervalSeconds) || sweepIntervalSeconds > MAX_SWEEP_INTERVAL_SECONDS)
  ) {
    throw new TypeError(
      `\`retention.sweepIntervalSeconds\` must be a positive number of seconds, at most ${MAX_SWEEP_INTERVAL_SECONDS} (24 days)`,
    );
  }
  if (typeof storage.listArtifacts !== 'function' || typeof storage.remove !== 'function') {
    throw new TypeError(
      '`retention` needs a storage adapter with `listArtifacts` and `remove` (both built-in adapters have them)',
    );
  }
}

/**
 * One sweep (see `PulseVaultRetentionOptions`): removes, through `storage.remove`, every upload
 * unfinished for longer than `abandonedAfterSeconds`, and every finished related artifact (not a
 * video) whose `relatedTo` artifact still isn't finished that long after it finished. Resolves
 * the removed artifactIds. An artifact that can't be checked or removed is logged and skipped;
 * the rest of the sweep carries on. Safe to run from several instances at once (a removal that
 * finds nothing is a no-op), and usable on its own from a cron job instead of the `retention`
 * option.
 */
export async function sweepAbandonedUploads(
  storage: PulseVaultStorage,
  opts: SweepAbandonedUploadsOptions,
): Promise<string[]> {
  const { listArtifacts, remove } = storage;
  if (typeof listArtifacts !== 'function' || typeof remove !== 'function') {
    throw new TypeError('sweepAbandonedUploads needs `storage.listArtifacts` and `storage.remove`');
  }
  // A cutoff that isn't a number would make every artifact look old enough to remove.
  if (!isPositiveSeconds(opts.abandonedAfterSeconds)) {
    throw new TypeError('sweepAbandonedUploads: `abandonedAfterSeconds` must be a positive number');
  }
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(now)) throw new TypeError('sweepAbandonedUploads: `now` must be a number');
  const cutoff = now - opts.abandonedAfterSeconds * 1000;
  const logger = opts.logger ?? consoleLogger;

  // Whether an artifact is finished, looked up once per sweep.
  const finished = new Map<string, Promise<boolean>>();
  const isFinished = (artifactId: string): Promise<boolean> => {
    let known = finished.get(artifactId);
    if (!known) {
      known = storage.resolve(artifactId).then((resolved) => resolved !== null);
      finished.set(artifactId, known);
    }
    return known;
  };

  const removed: string[] = [];
  for await (const record of listArtifacts.call(storage, { changedBefore: cutoff })) {
    if (opts.signal?.aborted) break;
    // Only a record known to be older than the cutoff: an adapter's bad timestamp keeps it.
    if (!(Number.isFinite(record.updatedAt) && record.updatedAt < cutoff)) continue;
    try {
      const abandoned =
        !record.ready ||
        (record.kind !== 'video' &&
          record.relatedTo !== undefined &&
          !(await isFinished(record.relatedTo)));
      if (abandoned && (await remove.call(storage, record.artifactId))) {
        removed.push(record.artifactId);
        await opts.onRemoved?.(record);
      }
    } catch (err) {
      logger.error(
        { err, artifactId: record.artifactId },
        'pulsevault retention could not remove an artifact',
      );
    }
  }
  return removed;
}

/**
 * Run `sweepAbandonedUploads` every `sweepIntervalSeconds` (first sweep one interval after start).
 * The timer doesn't keep the process alive. `stop` ends it and resolves once a sweep in progress
 * has stopped, so storage can be shut down safely after it. A failed sweep is logged and the next
 * one tries again.
 */
export function startRetentionSweep(
  storage: PulseVaultStorage,
  retention: PulseVaultRetentionOptions,
  logger: PulseVaultLogger,
  onRemoved?: (record: PulseVaultArtifactRecord) => void | Promise<void>,
): { stop: () => Promise<void> } {
  const intervalMs = (retention.sweepIntervalSeconds ?? DEFAULT_SWEEP_INTERVAL_SECONDS) * 1000;
  const stopping = new AbortController();
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    // One sweep at a time: a slow one (a large bucket) isn't overlapped by the next.
    if (inFlight) return;
    inFlight = sweepAbandonedUploads(storage, {
      abandonedAfterSeconds: retention.abandonedAfterSeconds,
      onRemoved,
      signal: stopping.signal,
      logger,
    })
      .then((removed) => {
        if (removed.length > 0) {
          logger.info({ removed }, 'pulsevault removed abandoned uploads');
        }
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'pulsevault retention sweep failed');
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      stopping.abort();
      await inFlight;
    },
  };
}
