import type { PulseVaultLogger } from './request.js';
import type { PulseVaultStorage } from '../storage/types.js';

/**
 * Opt-in cleanup of what abandoned uploads leave behind. A client that dies mid-upload (an app
 * killed, a phone that never comes back) leaves an unfinished upload, and the related artifacts
 * it finished before its video — captions, a beat manifest, a thumbnail — belong to a video that
 * will never arrive. Nothing else removes them.
 */
export type PulseVaultRetentionOptions = {
  /**
   * Remove an upload still unfinished this long after it started, and a finished artifact whose
   * `relatedTo` artifact isn't finished (or is gone) this long after it finished. Finished
   * artifacts with a finished (or no) `relatedTo` are never removed. Keep it well above how long
   * an upload may take — at least your capability tokens' lifetime, past which no upload can
   * continue anyway.
   */
  abandonedAfterSeconds: number;
  /** How often to sweep. Defaults to 3600 (an hour). */
  sweepIntervalSeconds?: number;
};

const DEFAULT_SWEEP_INTERVAL_SECONDS = 3600;

/** Fail at boot on a retention setting that can't work, rather than sweeping wrongly later. */
export function validateRetentionOptions(
  retention: PulseVaultRetentionOptions | undefined,
  storage: PulseVaultStorage,
): void {
  if (retention === undefined) return;
  const { abandonedAfterSeconds, sweepIntervalSeconds } = retention;
  if (!Number.isFinite(abandonedAfterSeconds) || abandonedAfterSeconds <= 0) {
    throw new TypeError('`retention.abandonedAfterSeconds` must be a positive number of seconds');
  }
  if (
    sweepIntervalSeconds !== undefined &&
    (!Number.isFinite(sweepIntervalSeconds) || sweepIntervalSeconds <= 0)
  ) {
    throw new TypeError('`retention.sweepIntervalSeconds` must be a positive number of seconds');
  }
  if (typeof storage.listArtifacts !== 'function' || typeof storage.remove !== 'function') {
    throw new TypeError(
      '`retention` needs a storage adapter with `listArtifacts` and `remove` (both built-in adapters have them)',
    );
  }
}

/**
 * One sweep (see `PulseVaultRetentionOptions`): removes, through `storage.remove`, every upload
 * unfinished for longer than `abandonedAfterSeconds`, and every finished artifact whose
 * `relatedTo` artifact still isn't finished that long after it finished. Resolves the removed
 * artifactIds. Safe to run from several instances at once (a removal that finds nothing is a
 * no-op), and usable on its own from a cron job instead of the `retention` option.
 */
export async function sweepAbandonedUploads(
  storage: PulseVaultStorage,
  opts: { abandonedAfterSeconds: number; now?: number },
): Promise<string[]> {
  const { listArtifacts, remove } = storage;
  if (typeof listArtifacts !== 'function' || typeof remove !== 'function') {
    throw new TypeError('sweepAbandonedUploads needs `storage.listArtifacts` and `storage.remove`');
  }
  const cutoff = (opts.now ?? Date.now()) - opts.abandonedAfterSeconds * 1000;
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
    if (record.updatedAt >= cutoff) continue;
    const abandoned =
      !record.ready ||
      (record.relatedTo !== undefined && !(await isFinished(record.relatedTo)));
    if (abandoned && (await remove.call(storage, record.artifactId))) {
      removed.push(record.artifactId);
    }
  }
  return removed;
}

/**
 * Run `sweepAbandonedUploads` every `sweepIntervalSeconds` (first sweep one interval after start).
 * The timer doesn't keep the process alive; `stop` ends it. A failed sweep is logged and the next
 * one tries again.
 */
export function startRetentionSweep(
  storage: PulseVaultStorage,
  retention: PulseVaultRetentionOptions,
  logger: PulseVaultLogger,
): { stop: () => void } {
  const intervalMs =
    (retention.sweepIntervalSeconds ?? DEFAULT_SWEEP_INTERVAL_SECONDS) * 1000;
  let sweeping = false;
  const timer = setInterval(() => {
    // One sweep at a time: a slow one (a large bucket) isn't overlapped by the next.
    if (sweeping) return;
    sweeping = true;
    sweepAbandonedUploads(storage, retention)
      .then((removed) => {
        if (removed.length > 0) {
          logger.info({ removed }, 'pulsevault removed abandoned uploads');
        }
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'pulsevault retention sweep failed');
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
