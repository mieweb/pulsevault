import { FileStore } from '@tus/file-store';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isUuid } from '../lib/uuid.js';
import type {
  ArtifactMetadata,
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from './types.js';
import {
  buildSidecar,
  createMetaCache,
  DEFAULT_META_CACHE_LIMIT,
  extToContentType,
  parseSidecar,
  reserveConflictError,
  type Sidecar,
  sidecarToCachedMeta,
} from './sidecar.js';

// Sidecar schema, parsing, cache, and the reserve-collision error all live in
// `./sidecar.js`, shared verbatim with the S3 adapter — this file owns only
// the filesystem-specific I/O around them.

/** Hidden directory inside workspaceRoot that holds per-upload sidecar files. */
const PULSEVAULT_META_DIR = '.pulsevault';

export type LocalStorageOptions = {
  /** Directory where uploads are stored (flat kind-scoped subdirs). Resolved against CWD if relative. */
  workspaceDir: string;
  /**
   * Max number of entries kept in the in-memory metadata cache before the
   * oldest (by insertion order) is evicted. A cache miss falls back to
   * reading the sidecar from disk, so eviction only costs an extra read, not
   * correctness. Defaults to 10,000.
   */
  metaCacheLimit?: number;
};

/**
 * Local adapter storage. Layout contract (stable; downstream tools may rely
 * on it):
 *
 * ```text
 * <workspaceRoot>/
 *   .pulsevault/<artifactId>.json   # sidecar: { version, ext, filename, status, kind, relatedTo, checksum, name }
 *   video/<artifactId><ext>         # finalized video bytes
 *   video/<artifactId><ext>.json    # @tus/file-store offset/metadata sidecar
 *   project/<artifactId><ext>       # finalized project bytes
 *   project/<artifactId><ext>.json  # @tus/file-store offset/metadata sidecar
 *   captions/<artifactId><ext>      # finalized captions bytes
 *   captions/<artifactId><ext>.json # @tus/file-store offset/metadata sidecar
 * ```
 *
 * `workspaceRoot` is exposed so consumers can layer post-processing (e.g.
 * hydrate an ArtiPod with `video/`, `transcripts/`, `frames/` mounts) against
 * the same on-disk tree from an `onUploadComplete` hook. `getLocalPath` is
 * exposed for `validatePayload` helpers that need to sniff the bytes before
 * the upload is marked ready.
 */
export type LocalStorage = PulseVaultStorage & {
  readonly workspaceRoot: string;
  /**
   * Return the absolute path to the upload bytes for `artifactId`, regardless
   * of ready state. Falls back to reading the sidecar if the in-memory cache
   * is cold (so it works even after a server restart mid-upload). Returns
   * `null` if the artifactId is unknown.
   */
  getLocalPath(artifactId: string): Promise<string | null>;
  /**
   * Return the artifact kind for a known artifactId without a full resolve.
   * Returns `null` if the artifactId is unknown. Satisfies the optional
   * `PulseVaultStorage.getKind` contract.
   */
  getKind(artifactId: string): Promise<UploadKind | null>;
  /** Satisfies the optional `PulseVaultStorage.getRelatedTo` contract. */
  getRelatedTo(artifactId: string): Promise<string | null>;
  /** Satisfies the optional `PulseVaultStorage.getChecksum` contract. */
  getChecksum(artifactId: string): Promise<string | null>;
  /** Satisfies the optional `PulseVaultStorage.getName` contract. */
  getName(artifactId: string): Promise<string | null>;
  /** Satisfies the optional `PulseVaultStorage.getMetadata` contract (incl. `{ fresh }`). */
  getMetadata(artifactId: string, opts?: { fresh?: boolean }): Promise<ArtifactMetadata | null>;
  /**
   * All artifactIds with a readable sidecar, ready or not — one readdir of the
   * metadata directory. Complements `getMetadata` so a consumer can list
   * uploads without crawling the sidecar files by hand.
   */
  listArtifactIds(): Promise<string[]>;
};

export function createLocalStorage(opts: LocalStorageOptions): LocalStorage {
  const workspaceRoot = path.resolve(opts.workspaceDir);
  const datastore = new FileStore({ directory: workspaceRoot });
  // Metadata cache keyed by artifactId. Populated eagerly on reserve and
  // lazily from the sidecar on cache-miss — so we never do a workspace-wide
  // scan at boot and never do a per-request readdir on the GET hot path.
  const metaCache = createMetaCache(opts.metaCacheLimit ?? DEFAULT_META_CACHE_LIMIT);

  /** Absolute path to the hidden metadata directory. */
  const sidecarDir = (): string => path.join(workspaceRoot, PULSEVAULT_META_DIR);
  /**
   * Absolute path to the sidecar JSON for a given artifactId. `readSidecar`
   * already rejects non-UUID ids before any path is built; the resolve +
   * containment check here is defense in depth for any future caller that
   * bypasses that funnel — a path that escapes the metadata directory is a
   * hard error, never a read.
   */
  const sidecarPath = (artifactId: string): string => {
    // Strictly inside the metadata directory: the sidecar is always a `.json`
    // file under it, so the resolved path can never equal the directory itself.
    const base = path.resolve(sidecarDir());
    const resolved = path.resolve(base, `${artifactId}.json`);
    if (!resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error('artifactId escapes the metadata directory');
    }
    return resolved;
  };
  /** Relative path (from workspaceRoot) to the artifact bytes. */
  const artifactRelPath = (artifactId: string, kind: UploadKind, ext: string): string =>
    `${kind}/${artifactId}${ext}`;

  /**
   * Per-artifact critical sections for the multi-step mutating operations
   * (markReady's read→write, remove's read→delete→evict). Without it, a
   * markReady racing a remove could re-write a sidecar the remove just
   * deleted, resurrecting a half-deleted artifact. `reserveUpload` doesn't
   * need it — its exclusive `wx` create is already one-winner-atomic, even
   * across processes. In-process is the honest scope: multiple server
   * processes sharing one local workspace are not a supported topology (the
   * underlying @tus/file-store has no cross-process coordination either) —
   * use the S3 adapter, whose conditional writes arbitrate across instances,
   * for shared storage.
   */
  const locks = new Map<string, Promise<void>>();
  const withArtifactLock = async <T>(artifactId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(artifactId) ?? Promise.resolve();
    const run = prev.then(fn);
    // The stored tail never rejects, so a failed operation can't poison the chain.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(artifactId, tail);
    try {
      return await run;
    } finally {
      if (locks.get(artifactId) === tail) locks.delete(artifactId);
    }
  };

  const writeSidecar = async (artifactId: string, sidecar: Sidecar): Promise<void> => {
    // Atomic tmp + rename so a crash mid-write can never leave a truncated
    // JSON blob that `loadMeta` would then treat as corrupt.
    const finalPath = sidecarPath(artifactId);
    const tmpPath = `${finalPath}.tmp`;
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });
    await fs.writeFile(tmpPath, JSON.stringify(sidecar), 'utf8');
    await fs.rename(tmpPath, finalPath);
  };

  const readSidecar = async (artifactId: string): Promise<Sidecar | null> => {
    // Every sidecar/artifact path in this module is built by joining
    // `artifactId` straight into a filesystem path — reject anything that
    // isn't a real UUID before it reaches `fs`, the same way `resolve()`
    // already refuses to serve non-UUID ids, so a stray `../` (or one
    // smuggled in by a caller that skips the HTTP route layer, e.g. a
    // direct `getLocalPath`/`getKind` call) can never escape the intended
    // `.pulsevault`/`<kind>` subdirectories. This is the single funnel
    // every other method in this file goes through (`loadMeta`), so
    // gating here covers `getLocalPath`, `getKind`, `getRelatedTo`,
    // `getChecksum`, `resolve`, `remove`, and `markReady` in one place.
    if (!isUuid(artifactId)) return null;
    let raw: string;
    try {
      raw = await fs.readFile(sidecarPath(artifactId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
    // Malformed sidecars parse to null — treated as absent; `reserveUpload`
    // rewrites them on the next create.
    return parseSidecar(raw);
  };

  const loadMeta = async (artifactId: string, opts?: { fresh?: boolean }) => {
    if (!opts?.fresh) {
      const cached = metaCache.get(artifactId);
      if (cached) return cached;
    }
    // Capture the deletion epoch BEFORE the disk read: if a `remove` lands
    // while this read is in flight, the epoch moves and the stale fill below
    // is discarded instead of resurrecting a deleted artifact's metadata.
    const asOf = metaCache.epoch();
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) return null;
    const meta = sidecarToCachedMeta(sidecar, sidecar.status === 'ready');
    metaCache.set(artifactId, meta, asOf);
    return meta;
  };

  const initialize = async (): Promise<void> => {
    // Dirs PulseVault creates itself get mode 0o750 directly (mkdir's mode caps
    // the permission bits — umask only removes more — so this holds even under a
    // permissive umask; a world-readable upload tree would otherwise leak media).
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });
    // @tus/file-store creates `workspaceRoot` with mode 0777 if it doesn't already exist;
    // tighten it so the upload tree isn't world-writable under a permissive umask.
    await fs.chmod(workspaceRoot, 0o750).catch(() => {});
  };

const reserveUpload = async (params: ReserveUploadParams): Promise<string> => {
    const { artifactId, kind, ext } = params;
    await fs.mkdir(path.join(workspaceRoot, kind), { recursive: true, mode: 0o750 });
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });

    const sidecar = buildSidecar(params);
    const asOf = metaCache.epoch();

    // ArtifactIds are single-use: the exclusive `wx` create fails atomically
    // with EEXIST if a sidecar already exists for this artifactId — whether
    // the previous upload finished, is still in flight, or died halfway.
    // Every collision is a plain 409 (via @tus/server's error path); clients
    // mint a fresh id per attempt, and abandoned reservations age out via
    // operator retention (see OPERATIONS.md), not an in-band reclaim.
    try {
      await fs.writeFile(sidecarPath(artifactId), JSON.stringify(sidecar), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      throw reserveConflictError(artifactId);
    }

    metaCache.set(artifactId, sidecarToCachedMeta(sidecar, false), asOf);
    // @tus/file-store joins this onto its configured `directory`, so the
    // actual file lands at `<workspaceRoot>/<kind>/<artifactId><ext>`.
    return artifactRelPath(artifactId, kind, ext);
  };

  const resolve = async (artifactId: string): Promise<PulseVaultResolution | null> => {
    const meta = await loadMeta(artifactId);
    // Only serve ready uploads. In-progress uploads stay hidden — a client
    // GETting mid-upload would otherwise receive a truncated file.
    if (!meta || !meta.ready) return null;
    const relFile = artifactRelPath(artifactId, meta.kind, meta.ext);
    try {
      const stat = await fs.stat(path.join(workspaceRoot, relFile));
      if (!stat.isFile()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
    return {
      kind: 'stream',
      root: workspaceRoot,
      filename: relFile,
      contentType: extToContentType(meta.ext),
    };
  };

  const markReady = async (artifactId: string): Promise<void> =>
    withArtifactLock(artifactId, async () => {
      const asOf = metaCache.epoch();
      const sidecar = await readSidecar(artifactId);
      if (!sidecar) {
        // No sidecar means no `reserveUpload` happened for this artifactId —
        // this is a contract violation by the caller, not a recoverable state.
        throw new Error(
          `markReady: no sidecar for artifactId ${artifactId} (was reserveUpload called?)`,
        );
      }
      if (sidecar.status === 'ready') {
        // Idempotent: already ready is fine, keep the cache consistent.
        metaCache.set(artifactId, sidecarToCachedMeta(sidecar, true), asOf);
        return;
      }
      await writeSidecar(artifactId, { ...sidecar, status: 'ready' });
      metaCache.set(artifactId, sidecarToCachedMeta(sidecar, true), asOf);
    });

  const remove = async (artifactId: string): Promise<boolean> =>
    withArtifactLock(artifactId, async () => {
      // Read disk truth under the lock — the current kind/ext decide which
      // files the deletes below target, and a cached entry could be stale.
      const meta = await loadMeta(artifactId, { fresh: true });
      // Drop from cache before rm so a racing `resolve` arriving after the
      // rm but before cache eviction can't hand back a stale path.
      metaCache.delete(artifactId);
      if (!meta) return false;
      const artifactPath = path.join(workspaceRoot, meta.kind, `${artifactId}${meta.ext}`);
      // Bytes and datastore state first, sidecar LAST (mirroring the S3
      // adapter): the sidecar is the reservation lock — while it exists,
      // `reserveUpload` still conflicts — so a new reservation can't be created
      // (and then clobbered) while these deletes are in flight.
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(`${artifactPath}.json`, { force: true }),
      ]);
      await fs.rm(sidecarPath(artifactId), { force: true });
      // Evict again AFTER the deletes — and bump the deletion epoch — so neither a
      // read that landed between the first eviction and the deletes nor an
      // in-flight `loadMeta` fill can resurrect the deleted artifact's metadata
      // (fills capture the epoch before reading and are discarded on mismatch).
      metaCache.delete(artifactId);
      return true;
    });

  const getLocalPath = async (artifactId: string): Promise<string | null> => {
    const meta = await loadMeta(artifactId);
    if (!meta) return null;
    return path.join(workspaceRoot, meta.kind, `${artifactId}${meta.ext}`);
  };

  const getKind = async (artifactId: string): Promise<UploadKind | null> => {
    const meta = await loadMeta(artifactId);
    return meta ? meta.kind : null;
  };

  const getRelatedTo = async (artifactId: string): Promise<string | null> => {
    const meta = await loadMeta(artifactId);
    return meta?.relatedTo ?? null;
  };

  const getChecksum = async (artifactId: string): Promise<string | null> => {
    const meta = await loadMeta(artifactId);
    return meta?.checksum ?? null;
  };

  const getName = async (artifactId: string): Promise<string | null> => {
    const meta = await loadMeta(artifactId);
    return meta?.name ?? null;
  };

  const getMetadata = async (
    artifactId: string,
    opts?: { fresh?: boolean },
  ): Promise<ArtifactMetadata | null> => {
    const meta = await loadMeta(artifactId, opts);
    if (!meta) return null;
    return {
      artifactId,
      kind: meta.kind,
      ext: meta.ext,
      filename: meta.filename ?? `${artifactId}${meta.ext}`,
      ready: meta.ready,
      relatedTo: meta.relatedTo,
      checksum: meta.checksum,
      name: meta.name,
      reservedAt: meta.reservedAt,
      expectedSize: meta.expectedSize,
    };
  };

  const listArtifactIds = async (): Promise<string[]> => {
    let entries: string[];
    try {
      entries = await fs.readdir(sidecarDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isUuid);
  };

  return {
    datastore,
    workspaceRoot,
    initialize,
    reserveUpload,
    resolve,
    markReady,
    remove,
    getLocalPath,
    getKind,
    getRelatedTo,
    getChecksum,
    getName,
    getMetadata,
    listArtifactIds,
  };
}
