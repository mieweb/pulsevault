import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '@tus/file-store';

import { isUuid } from '../lib/uuid.js';
import type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from './types.js';
import { parseUploadKind } from './types.js';

/**
 * Per-artifact metadata sidecar written at
 * `<workspaceRoot>/.pulsevault/<artifactId>.json`. Lets `resolve()` recover an
 * artifact's extension and completion state without scanning the directory,
 * and keeps the on-disk layout self-describing for downstream tools
 * (ArtiPod pipelines, ffmpeg, rsync, etc.).
 */
type Sidecar = {
  /** Sidecar schema version. Increment for breaking changes. */
  version: 1;
  /** Lowercase extension including the leading dot (e.g. `".mp4"`). */
  ext: string;
  /** Original filename from `Upload-Metadata.filename`. */
  filename: string;
  /**
   * `"uploading"` between `reserveUpload` and `markReady`; `"ready"` once
   * every post-upload validation has passed. The GET route only serves
   * `"ready"` sidecars — partially-written files never leak out.
   */
  status: 'uploading' | 'ready';
  /**
   * Artifact kind. Optional for back-compat — sidecars written before
   * kind was introduced are read as `"video"` with no on-disk migration.
   */
  kind?: UploadKind;
  /** Optional id of another artifact this one belongs to. See `ReserveUploadParams.relatedTo`. */
  relatedTo?: string;
  /** Optional client-supplied checksum metadata. See `ReserveUploadParams.checksum`. */
  checksum?: string;
};

const SIDECAR_VERSION = 1 as const;
/** Hidden directory inside workspaceRoot that holds per-upload sidecar files. */
const PULSEVAULT_META_DIR = '.pulsevault';
/** Default cap on the in-memory metadata cache before evicting the oldest entry. */
const DEFAULT_META_CACHE_LIMIT = 10_000;

type CachedMeta = {
  ext: string;
  ready: boolean;
  kind: UploadKind;
  relatedTo?: string;
  checksum?: string;
};

/** Map a file extension to the `Content-Type` the GET route should return. */
function extToContentType(ext: string): string {
  switch (ext) {
    case '.mp4':
      return 'video/mp4';
    case '.zip':
      return 'application/zip';
    case '.vtt':
      return 'text/vtt';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

/** Project a `Sidecar` into the shape kept in the in-memory cache. */
function sidecarToCachedMeta(sidecar: Sidecar, ready: boolean): CachedMeta {
  return {
    ext: sidecar.ext,
    ready,
    kind: sidecar.kind ?? 'video',
    relatedTo: sidecar.relatedTo,
    checksum: sidecar.checksum,
  };
}

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
 *   .pulsevault/<artifactId>.json   # sidecar: { version, ext, filename, status, kind, relatedTo }
 *   video/<artifactId><ext>         # finalized video bytes
 *   video/<artifactId><ext>.json    # @tus/file-store offset/metadata sidecar
 *   project/<artifactId><ext>       # finalized project bytes
 *   project/<artifactId><ext>.json  # @tus/file-store offset/metadata sidecar
 *   captions/<artifactId><ext>      # finalized captions bytes
 *   captions/<artifactId><ext>.json # @tus/file-store offset/metadata sidecar
 *   thumbnail/<artifactId><ext>     # finalized thumbnail bytes (merged-mode poster frame)
 *   thumbnail/<artifactId><ext>.json # @tus/file-store offset/metadata sidecar
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
};

export function createLocalStorage(opts: LocalStorageOptions): LocalStorage {
  const workspaceRoot = path.resolve(opts.workspaceDir);
  const datastore = new FileStore({ directory: workspaceRoot });
  const metaCacheLimit = opts.metaCacheLimit ?? DEFAULT_META_CACHE_LIMIT;
  // Metadata cache keyed by artifactId. Populated eagerly on reserve and
  // lazily from the sidecar on cache-miss — so we never do a workspace-wide
  // scan at boot and never do a per-request readdir on the GET hot path.
  // Bounded with simple insertion-order eviction (a `Map` preserves insertion
  // order, and re-setting a key moves it to the end) so a long-running server
  // doesn't grow this unboundedly; a cache miss just costs an extra disk read.
  const metaCache = new Map<string, CachedMeta>();

  const cacheSet = (artifactId: string, meta: CachedMeta): void => {
    // Re-inserting moves the key to the end of iteration order, so eviction
    // below always drops the actual least-recently-set entry.
    metaCache.delete(artifactId);
    metaCache.set(artifactId, meta);
    if (metaCache.size > metaCacheLimit) {
      const oldest = metaCache.keys().next().value;
      if (oldest !== undefined) metaCache.delete(oldest);
    }
  };

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

  const writeSidecar = async (artifactId: string, sidecar: Sidecar): Promise<void> => {
    // Atomic tmp + rename so a crash mid-write can never leave a truncated
    // JSON blob that `loadMeta` would then treat as corrupt.
    const finalPath = sidecarPath(artifactId);
    const tmpPath = `${finalPath}.tmp`;
    await fs.mkdir(sidecarDir(), { recursive: true });
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
    try {
      const parsed = JSON.parse(raw) as Partial<Sidecar>;
      if (typeof parsed.ext !== 'string') return null;
      if (typeof parsed.filename !== 'string') return null;
      // Older sidecars (pre-status) are treated as ready so an in-place
      // upgrade doesn't hide finalized uploads. New uploads always write a
      // `status` field explicitly.
      const status: Sidecar['status'] = parsed.status === 'uploading' ? 'uploading' : 'ready';
      // Older sidecars without `kind` default to `"video"` — no migration.
      const kind = parseUploadKind(parsed.kind);
      return {
        version: SIDECAR_VERSION,
        ext: parsed.ext,
        filename: parsed.filename,
        status,
        kind,
        relatedTo: typeof parsed.relatedTo === 'string' ? parsed.relatedTo : undefined,
        checksum: typeof parsed.checksum === 'string' ? parsed.checksum : undefined,
      };
    } catch {
      // Malformed sidecar — treat as absent. `reserveUpload` will rewrite
      // it on the next create.
      return null;
    }
  };

  const loadMeta = async (artifactId: string): Promise<CachedMeta | null> => {
    const cached = metaCache.get(artifactId);
    if (cached) return cached;
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) return null;
    const meta = sidecarToCachedMeta(sidecar, sidecar.status === 'ready');
    cacheSet(artifactId, meta);
    return meta;
  };

  const initialize = async (): Promise<void> => {
    // Dirs PulseVault creates itself get mode 0o750 directly (mkdir's mode caps the
    // permission bits — umask only removes more — so this holds even under a permissive umask).
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });
    // @tus/file-store creates `workspaceRoot` with mode 0777 if it doesn't already exist;
    // we don't create it, so tighten it after the fact.
    await fs.chmod(workspaceRoot, 0o750).catch(() => {});
  };

  const reserveUpload = async ({
    artifactId,
    filename,
    ext,
    kind,
    relatedTo,
    checksum,
  }: ReserveUploadParams): Promise<string> => {
    await fs.mkdir(path.join(workspaceRoot, kind), { recursive: true, mode: 0o750 });
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });

    const sidecar: Sidecar = {
      version: SIDECAR_VERSION,
      ext,
      filename,
      status: 'uploading',
      kind,
      relatedTo,
      checksum,
    };

    // Collision guard: `wx` fails atomically with EEXIST if a sidecar already exists for
    // this artifactId, rather than the previous read-then-write (`loadMeta` then
    // `writeSidecar`) which left a window for two concurrent/retried requests to both pass
    // the check before either had written — letting the second silently clobber the first's
    // sidecar and race @tus/file-store's own offset tracking. Translates to HTTP 409 via
    // @tus/server's error path, same as before.
    try {
      await fs.writeFile(sidecarPath(artifactId), JSON.stringify(sidecar), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      // A file already exists at this path, but `readSidecar` treats a malformed/corrupt
      // one as absent (e.g. debris from a crash mid-write) — re-check before deciding this
      // is a genuine collision rather than debris that's safe to overwrite.
      const existing = await readSidecar(artifactId);
      if (existing) {
        throw Object.assign(new Error(`artifactId ${artifactId} already has an upload`), {
          statusCode: 409,
          status_code: 409,
        });
      }
      await writeSidecar(artifactId, sidecar);
    }

    cacheSet(artifactId, { ext, ready: false, kind, relatedTo, checksum });
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

  const markReady = async (artifactId: string): Promise<void> => {
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
      cacheSet(artifactId, sidecarToCachedMeta(sidecar, true));
      return;
    }
    await writeSidecar(artifactId, { ...sidecar, status: 'ready' });
    cacheSet(artifactId, sidecarToCachedMeta(sidecar, true));
  };

  const remove = async (artifactId: string): Promise<boolean> => {
    const meta = await loadMeta(artifactId);
    // Drop from cache before rm so a racing `resolve` arriving after the
    // rm but before cache eviction can't hand back a stale path.
    metaCache.delete(artifactId);
    if (!meta) return false;
    const artifactPath = path.join(workspaceRoot, meta.kind, `${artifactId}${meta.ext}`);
    await Promise.all([
      fs.rm(artifactPath, { force: true }),
      fs.rm(`${artifactPath}.json`, { force: true }),
      fs.rm(sidecarPath(artifactId), { force: true }),
    ]);
    return true;
  };

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
  };
}
