import { FileStore } from '@tus/file-store';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../lib/uuid.js';
import type { WebReadyResult } from '../lib/web-ready.js';
import type {
  PulseVaultArtifactMeta,
  PulseVaultArtifactPatch,
  PulseVaultArtifactRecord,
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
  /** Lowercase extension of the stored file, including the leading dot (e.g. `".mp4"`). */
  ext: string;
  /**
   * The uploaded file's extension, kept once a web-ready conversion switched `ext` (a `.webm`
   * conformed to `.mp4`), so `remove` also deletes the original if a crash left it behind.
   */
  sourceExt?: string;
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
  /** Optional human-facing display name. See `ReserveUploadParams.name`. */
  name?: string;
  /** Optional uploading app version. See `ReserveUploadParams.appVersion`. */
  appVersion?: string;
  /** Optional host data from the capability token. See `ReserveUploadParams.context`. */
  context?: unknown;
  /**
   * `false` from reserve until the core records that `onUploadComplete` finished. Absent on
   * sidecars written before the flag existed: read as `true` when finished, `false` otherwise.
   */
  acknowledged?: boolean;
  /** `false` from reserve until the core records that the web-ready conversion finished; absent reads as `true` once finished. */
  converted?: boolean;
  /** What the web-ready conversion did, once it ran. */
  webReady?: WebReadyResult;
  /** New at every reservation of the id. See `PulseVaultArtifactMeta.generation`. */
  generation?: string;
  /** Whatever the host recorded with `recordOutcome`. */
  outcome?: unknown;
  /** When the upload finished (ms since the epoch), set by `markReady`, never changed after. */
  readyAt?: number;
};

const SIDECAR_VERSION = 1 as const;
/** Hidden directory inside workspaceRoot that holds per-upload sidecar files. */
const PULSEVAULT_META_DIR = '.pulsevault';
/**
 * Relation index under the metadata directory: `related/<anchorId>/<artifactId>` is an empty
 * marker for every artifact that declared `relatedTo` the anchor, so a pulse's files are one
 * `readdir` away instead of a scan of every sidecar.
 */
const RELATED_DIR = 'related';
/** A stored file's extension: lowercase, one dot, nothing that could leave the kind directory. */
const STORED_EXT = /^\.[a-z0-9]+$/;
/** A sidecar lock held longer than this was left by a process that died holding it. */
const LOCK_STALE_MS = 30_000;
/** How long a sidecar write waits for another instance's lock before failing. */
const LOCK_WAIT_MS = 60_000;
/** Default cap on the in-memory metadata cache before evicting the oldest entry. */
const DEFAULT_META_CACHE_LIMIT = 10_000;

type CachedMeta = {
  ext: string;
  sourceExt?: string;
  ready: boolean;
  kind: UploadKind;
  relatedTo?: string;
  checksum?: string;
  name?: string;
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
    case '.mov':
      return 'video/quicktime';
    case '.m4v':
      return 'video/x-m4v';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.3gp':
      return 'video/3gpp';
    case '.avi':
      return 'video/x-msvideo';
    case '.srt':
      return 'application/x-subrip';
    case '.pulse':
      // The beat manifest (PROTOCOL.md §8) is JSON.
      return 'application/json';
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
    ...(sidecar.sourceExt ? { sourceExt: sidecar.sourceExt } : {}),
    ready,
    kind: sidecar.kind ?? 'video',
    relatedTo: sidecar.relatedTo,
    checksum: sidecar.checksum,
    name: sidecar.name,
  };
}

/** A recorded web-ready result read back from a sidecar. */
function isWebReadyResult(value: unknown): value is WebReadyResult {
  const result = value as Partial<WebReadyResult> | null;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof result.action === 'string' &&
    typeof result.reason === 'string'
  );
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
  /** Satisfies the optional `PulseVaultStorage.listArtifacts` contract. */
  listArtifacts(opts?: { changedBefore?: number }): AsyncIterable<PulseVaultArtifactRecord>;
  /** Satisfies the optional `PulseVaultStorage.describeArtifact` contract. */
  describeArtifact(artifactId: string): Promise<PulseVaultArtifactMeta | null>;
  /** Satisfies the optional `PulseVaultStorage.patchArtifact` contract. */
  patchArtifact(artifactId: string, patch: PulseVaultArtifactPatch): Promise<boolean>;
  /** Satisfies the optional `PulseVaultStorage.listRelated` contract. */
  listRelated(artifactId: string): AsyncIterable<PulseVaultArtifactRecord>;
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
    // JSON blob that `loadMeta` would then treat as corrupt. The tmp name is
    // unique, so two writers (two instances on a shared filesystem) never
    // write into, or rename away, each other's tmp file.
    const finalPath = sidecarPath(artifactId);
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });
    try {
      await fs.writeFile(tmpPath, JSON.stringify(sidecar), 'utf8');
      await fs.rename(tmpPath, finalPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
  };

  /**
   * Read-modify-write of a sidecar runs one at a time per artifact: in this process through a
   * promise chain, and across instances sharing the workspace (OPERATIONS.md, "Horizontal
   * scaling") through a lock file, `.pulsevault/<artifactId>.json.lock`, created exclusively
   * (`wx`: atomic on a local disk and on NFS). So an acknowledgement, a conversion switching
   * the stored file and a removal each act on the sidecar as the last of them left it, never on
   * a stale copy. Each critical section is a read and a rename; a lock older than
   * `LOCK_STALE_MS` was left by a process that died holding it, and is taken over.
   */
  const sidecarWrites = new Map<string, Promise<unknown>>();
  const withLockFile = async <T>(artifactId: string, work: () => Promise<T>): Promise<T> => {
    const lockPath = `${sidecarPath(artifactId)}.lock`;
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });
    const giveUpAt = Date.now() + LOCK_WAIT_MS;
    for (let pause = 2; ; pause = Math.min(pause * 2, 50)) {
      try {
        await (await fs.open(lockPath, 'wx')).close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        const heldFor = await fs.stat(lockPath).then((stats) => Date.now() - stats.mtimeMs, () => 0);
        if (heldFor > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() > giveUpAt) throw new Error(`timed out waiting for the sidecar lock of ${artifactId}`);
        await new Promise((resolve) => setTimeout(resolve, pause + Math.random() * pause));
      }
    }
    try {
      return await work();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  };
  const withSidecarLock = async <T>(artifactId: string, work: () => Promise<T>): Promise<T> => {
    const previous = sidecarWrites.get(artifactId) ?? Promise.resolve();
    // A non-UUID id names no sidecar (`readSidecar` refuses it): nothing to lock, no path built.
    const run = previous.catch(() => {}).then(() => (isUuid(artifactId) ? withLockFile(artifactId, work) : work()));
    sidecarWrites.set(artifactId, run);
    try {
      return await run;
    } finally {
      if (sidecarWrites.get(artifactId) === run) sidecarWrites.delete(artifactId);
    }
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
        ...(typeof parsed.sourceExt === 'string' && STORED_EXT.test(parsed.sourceExt)
          ? { sourceExt: parsed.sourceExt }
          : {}),
        filename: parsed.filename,
        status,
        kind,
        relatedTo: typeof parsed.relatedTo === 'string' ? parsed.relatedTo : undefined,
        checksum: typeof parsed.checksum === 'string' ? parsed.checksum : undefined,
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : undefined,
        ...(parsed.context !== undefined ? { context: parsed.context } : {}),
        // A sidecar from before the flag existed: finished means nothing to replay; still
        // uploading means its completion hasn't happened yet.
        acknowledged: parsed.acknowledged ?? status === 'ready',
        converted: parsed.converted ?? status === 'ready',
        ...(isWebReadyResult(parsed.webReady) ? { webReady: parsed.webReady } : {}),
        ...(typeof parsed.generation === 'string' ? { generation: parsed.generation } : {}),
        ...(parsed.outcome !== undefined ? { outcome: parsed.outcome } : {}),
        ...(typeof parsed.readyAt === 'number' ? { readyAt: parsed.readyAt } : {}),
      };
    } catch {
      // Malformed sidecar — treat as absent. `reserveUpload` will rewrite
      // it on the next create.
      return null;
    }
  };

  /** Directory of relation markers for one anchor artifact. */
  const relatedDir = (anchorId: string): string => {
    const base = path.resolve(sidecarDir(), RELATED_DIR);
    const resolved = path.resolve(base, anchorId);
    if (!resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error('artifactId escapes the metadata directory');
    }
    return resolved;
  };

  /** When the upload last moved: the sidecar's mtime, or the bytes file's while still uploading. */
  const lastActivity = async (artifactId: string, sidecar: Sidecar): Promise<number> => {
    let updatedAt: number;
    try {
      updatedAt = (await fs.stat(sidecarPath(artifactId))).mtimeMs;
    } catch {
      return 0;
    }
    if (sidecar.status === 'uploading') {
      const kind = sidecar.kind ?? 'video';
      const bytes = path.join(workspaceRoot, kind, `${artifactId}${sidecar.ext}`);
      const written = await fs.stat(bytes).then(
        (stats) => stats.mtimeMs,
        () => 0,
      );
      updatedAt = Math.max(updatedAt, written);
    }
    return updatedAt;
  };

  const sidecarToMeta = (
    artifactId: string,
    sidecar: Sidecar,
    updatedAt: number,
  ): PulseVaultArtifactMeta => ({
    artifactId,
    kind: sidecar.kind ?? 'video',
    ext: sidecar.ext,
    ...(sidecar.sourceExt ? { sourceExt: sidecar.sourceExt } : {}),
    filename: sidecar.filename,
    ...(sidecar.relatedTo ? { relatedTo: sidecar.relatedTo } : {}),
    ...(sidecar.checksum ? { checksum: sidecar.checksum } : {}),
    ...(sidecar.name ? { name: sidecar.name } : {}),
    ...(sidecar.appVersion ? { appVersion: sidecar.appVersion } : {}),
    ...(sidecar.context !== undefined ? { context: sidecar.context } : {}),
    ready: sidecar.status === 'ready',
    acknowledged: sidecar.acknowledged !== false,
    converted: sidecar.converted !== false,
    ...(sidecar.webReady ? { webReady: sidecar.webReady } : {}),
    ...(sidecar.generation ? { generation: sidecar.generation } : {}),
    ...(sidecar.outcome !== undefined ? { outcome: sidecar.outcome } : {}),
    updatedAt,
    ...(sidecar.readyAt !== undefined ? { readyAt: sidecar.readyAt } : {}),
  });

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
    // Dirs PulseVault creates itself get mode 0o750 directly (mkdir's mode caps
    // the permission bits — umask only removes more — so this holds even under a
    // permissive umask; a world-readable upload tree would otherwise leak media).
    await fs.mkdir(sidecarDir(), { recursive: true, mode: 0o750 });
    // @tus/file-store creates `workspaceRoot` with mode 0777 if it doesn't already exist;
    // tighten it so the upload tree isn't world-writable under a permissive umask.
    await fs.chmod(workspaceRoot, 0o750).catch(() => {});
  };

  const reserveUpload = async ({
    artifactId,
    filename,
    ext,
    kind,
    relatedTo,
    checksum,
    name,
    appVersion,
    context,
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
      name,
      appVersion,
      ...(context !== undefined ? { context } : {}),
      acknowledged: false,
      converted: false,
      generation: randomUUID(),
    };

    // Under the sidecar lock, so a removal of the same id on any instance either finished
    // (its sidecar went last) or hasn't started.
    await withSidecarLock(artifactId, async () => {
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
    });

    if (relatedTo) {
      // The relation index entry. Written after the sidecar so a crash between the two leaves
      // an artifact without an index entry (it still works, it's just not listed under its
      // anchor), never an index entry without an artifact.
      const dir = relatedDir(relatedTo);
      await fs.mkdir(dir, { recursive: true, mode: 0o750 });
      await fs.writeFile(path.join(dir, artifactId), '', { flag: 'w' });
    }

    cacheSet(artifactId, { ext, ready: false, kind, relatedTo, checksum, name });
    // @tus/file-store joins this onto its configured `directory`, so the
    // actual file lands at `<workspaceRoot>/<kind>/<artifactId><ext>`.
    return artifactRelPath(artifactId, kind, ext);
  };

  const resolve = async (artifactId: string, reread = false): Promise<PulseVaultResolution | null> => {
    const meta = await loadMeta(artifactId);
    // Only serve ready uploads. In-progress uploads stay hidden — a client
    // GETting mid-upload would otherwise receive a truncated file.
    if (!meta || !meta.ready) return null;
    const relFile = artifactRelPath(artifactId, meta.kind, meta.ext);
    try {
      const stat = await fs.stat(path.join(workspaceRoot, relFile));
      if (!stat.isFile()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      // Another instance on the same disk may have switched the artifact to a new file (a
      // conversion changed its extension) since this one cached it: read the sidecar once more.
      if (reread) return null;
      metaCache.delete(artifactId);
      return resolve(artifactId, true);
    }
    return {
      kind: 'stream',
      root: workspaceRoot,
      filename: relFile,
      contentType: extToContentType(meta.ext),
    };
  };

  const markReady = (artifactId: string): Promise<void> =>
    withSidecarLock(artifactId, async () => {
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
      await writeSidecar(artifactId, { ...sidecar, status: 'ready', readyAt: Date.now() });
      cacheSet(artifactId, sidecarToCachedMeta(sidecar, true));
    });

  // Under the sidecar lock, from the sidecar itself: a conversion switching the artifact to a new
  // file (`patchArtifact` with `ext`) either finishes first — and this removes the new file — or
  // finds the sidecar gone and drops what it wrote; it can never write the sidecar back.
  const remove = (artifactId: string): Promise<boolean> =>
    withSidecarLock(artifactId, async () => {
      const sidecar = await readSidecar(artifactId);
      const meta = sidecar
        ? sidecarToCachedMeta(sidecar, sidecar.status === 'ready')
        : (metaCache.get(artifactId) ?? null);
      // Drop from cache before rm so a racing `resolve` arriving after the
      // rm but before cache eviction can't hand back a stale path.
      metaCache.delete(artifactId);
      if (!meta) return false;
      const artifactPath = path.join(workspaceRoot, meta.kind, `${artifactId}${meta.ext}`);
      // The uploaded file and tus's record of it, when a conversion stored the bytes under a new
      // extension (normally already gone; left behind by a crash during the switch).
      const sourcePath = meta.sourceExt
        ? path.join(workspaceRoot, meta.kind, `${artifactId}${meta.sourceExt}`)
        : null;
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(`${artifactPath}.json`, { force: true }),
        ...(sourcePath
          ? [fs.rm(sourcePath, { force: true }), fs.rm(`${sourcePath}.json`, { force: true })]
          : []),
        ...(meta.relatedTo
          ? [fs.rm(path.join(relatedDir(meta.relatedTo), artifactId), { force: true })]
          : []),
      ]);
      // Last: until the sidecar is gone the id can't be reserved again, so a new upload of it
      // never has its bytes removed by this one's removal.
      await fs.rm(sidecarPath(artifactId), { force: true });
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

  /** Straight from the sidecar, never the cache: its flags change after the cache was filled. */
  const describeArtifact = async (artifactId: string): Promise<PulseVaultArtifactMeta | null> => {
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) return null;
    return sidecarToMeta(artifactId, sidecar, await lastActivity(artifactId, sidecar));
  };

  const patchArtifact = (artifactId: string, patch: PulseVaultArtifactPatch): Promise<boolean> =>
    withSidecarLock(artifactId, async () => {
      if (patch.ext !== undefined && !STORED_EXT.test(patch.ext)) {
        throw new TypeError(`patchArtifact: invalid ext ${JSON.stringify(patch.ext)}`);
      }
      const sidecar = await readSidecar(artifactId);
      if (!sidecar) return false;
      // Another pass already recorded its conversion, or the id was removed and reserved again:
      // this patch belongs to neither.
      if (patch.unlessConverted && sidecar.converted !== false) return false;
      if (patch.generation !== undefined && (sidecar.generation ?? null) !== patch.generation) return false;
      const kind = sidecar.kind ?? 'video';
      const stored = (ext: string) => path.join(workspaceRoot, kind, `${artifactId}${ext}`);
      const ext = patch.ext ?? sidecar.ext;
      if (patch.file !== undefined) {
        if (path.dirname(path.resolve(patch.file)) !== path.join(workspaceRoot, kind)) {
          throw new TypeError('patchArtifact: `file` must be in the artifact\'s kind directory');
        }
        await fs.rename(patch.file, stored(ext));
      }
      const next: Sidecar = { ...sidecar };
      if (patch.acknowledged !== undefined) next.acknowledged = patch.acknowledged;
      if (patch.converted !== undefined) next.converted = patch.converted;
      if (patch.webReady !== undefined) next.webReady = patch.webReady;
      if (patch.ext !== undefined && patch.ext !== sidecar.ext) {
        next.sourceExt = sidecar.sourceExt ?? sidecar.ext;
        next.ext = patch.ext;
      }
      if (patch.outcome !== undefined) {
        if (patch.outcome === null) delete next.outcome;
        else next.outcome = patch.outcome;
      }
      await writeSidecar(artifactId, next);
      // The cache holds nothing a patch changes, but a `ready` flip elsewhere must not be undone
      // by a stale entry either — keep it consistent with what was just written.
      cacheSet(artifactId, sidecarToCachedMeta(next, next.status === 'ready'));
      // The sidecar names the new file: the one under the old extension goes. (A crash before
      // this leaves it for `remove`, which deletes `sourceExt` too.)
      if (ext !== sidecar.ext) await fs.rm(stored(sidecar.ext), { force: true });
      return true;
    });

  async function* listRelated(artifactId: string): AsyncIterable<PulseVaultArtifactRecord> {
    if (!isUuid(artifactId)) return;
    let names: string[];
    try {
      names = await fs.readdir(relatedDir(artifactId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
    for (const relatedId of names) {
      if (!isUuid(relatedId)) continue;
      const sidecar = await readSidecar(relatedId);
      if (!sidecar || sidecar.relatedTo !== artifactId) continue; // A marker whose artifact is gone.
      yield {
        artifactId: relatedId,
        kind: sidecar.kind ?? 'video',
        relatedTo: artifactId,
        ready: sidecar.status === 'ready',
        updatedAt: await lastActivity(relatedId, sidecar),
      };
    }
  }

  /**
   * Walk the sidecars. A sidecar is rewritten only when its upload finishes, so its mtime is
   * when the upload started (still uploading) or when it finished (ready). An upload in flight
   * counts from its last write instead — the bytes file's mtime — so a long upload that's still
   * moving is never taken for an abandoned one.
   */
  async function* listArtifacts(
    opts: { changedBefore?: number } = {},
  ): AsyncIterable<PulseVaultArtifactRecord> {
    let names: string[];
    try {
      names = await fs.readdir(sidecarDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const artifactId = name.slice(0, -'.json'.length);
      if (!isUuid(artifactId)) continue;
      let updatedAt: number;
      try {
        updatedAt = (await fs.stat(sidecarPath(artifactId))).mtimeMs;
      } catch {
        continue; // Removed since the readdir.
      }
      if (opts.changedBefore !== undefined && updatedAt >= opts.changedBefore) continue;
      const sidecar = await readSidecar(artifactId);
      if (!sidecar) continue;
      const kind = sidecar.kind ?? 'video';
      if (sidecar.status === 'uploading') {
        const bytes = path.join(workspaceRoot, kind, `${artifactId}${sidecar.ext}`);
        const written = await fs.stat(bytes).then(
          (stats) => stats.mtimeMs,
          () => 0,
        );
        updatedAt = Math.max(updatedAt, written);
        if (opts.changedBefore !== undefined && updatedAt >= opts.changedBefore) continue;
      }
      yield {
        artifactId,
        kind,
        ...(sidecar.relatedTo ? { relatedTo: sidecar.relatedTo } : {}),
        ready: sidecar.status === 'ready',
        updatedAt,
      };
    }
  }

  return {
    datastore,
    workspaceRoot,
    initialize,
    reserveUpload,
    resolve: (artifactId: string) => resolve(artifactId),
    markReady,
    remove,
    getLocalPath,
    getKind,
    getRelatedTo,
    getChecksum,
    getName,
    listArtifacts,
    describeArtifact,
    patchArtifact,
    listRelated,
  };
}
