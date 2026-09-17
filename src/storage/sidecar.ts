import { httpError } from '../lib/errors.js';
import type { ArtifactMetadata, ReserveUploadParams, UploadKind } from './types.js';
import { parseUploadKind } from './types.js';

/**
 * Everything the two storage adapters share about per-artifact metadata
 * sidecars — the schema, its parsing/normalization, the in-memory cache, and
 * the reserve-collision error. The local adapter persists a sidecar as a JSON
 * file under `.pulsevault/`, the S3 adapter as a JSON object under the
 * `.pulsevault/` key prefix; the CONTENT and semantics are identical by
 * design, and this module is what keeps them identical — before it existed,
 * every sidecar change had to be hand-mirrored across both adapters.
 */

/** Sidecar schema version. Increment for breaking changes. */
const SIDECAR_VERSION = 1 as const;
/** Default cap on an adapter's in-memory metadata cache before evicting the oldest entry. */
export const DEFAULT_META_CACHE_LIMIT = 10_000;

/**
 * Per-artifact metadata sidecar. Lets `resolve()` recover an artifact's
 * extension and completion state without scanning storage, and keeps the
 * layout self-describing for downstream tools.
 */
export type Sidecar = {
  /** Sidecar schema version. */
  version: typeof SIDECAR_VERSION;
  /** Lowercase extension including the leading dot (e.g. `".mp4"`). */
  ext: string;
  /** Original filename from `Upload-Metadata.filename`. */
  filename: string;
  /**
   * `"uploading"` between `reserveUpload` and `markReady`; `"ready"` once
   * every post-upload validation has passed. Only `"ready"` sidecars are
   * served — partially-written uploads never leak out.
   */
  status: 'uploading' | 'ready';
  /** Artifact kind. Optional for back-compat — pre-kind sidecars read as `"video"`. */
  kind?: UploadKind;
  /** Optional id of another artifact this one belongs to. See `ReserveUploadParams.relatedTo`. */
  relatedTo?: string;
  /** Optional client-supplied checksum metadata. See `ReserveUploadParams.checksum`. */
  checksum?: string;
  /** Optional human-facing display name. See `ReserveUploadParams.name`. */
  name?: string;
  /**
   * Epoch-ms timestamp of the `reserveUpload` that wrote this sidecar.
   * ArtifactIds are single-use — a reservation that never reaches `"ready"`
   * is abandoned, not reused — so this exists for retention tooling: an
   * operator sweep (or object-storage lifecycle rule) can age out abandoned
   * `"uploading"` sidecars by this timestamp. Carried in the JSON (not
   * derived from file mtimes) so it survives backup/restore and works
   * identically on object storage.
   */
  reservedAt?: number;
  /** Expected total size in bytes (direct uploads only). See `ReserveUploadParams.size`. */
  expectedSize?: number;
  /**
   * Per-reservation object-key suffix (direct uploads only). A presigned PUT
   * outlives the reservation that minted it — deleting the reservation cannot
   * revoke the URL — so each direct reservation writes its bytes to its own
   * key (`<kind>/<id>.<suffix><ext>`). A superseded grant then targets a key
   * no other reservation (and no ready artifact) reads from, instead of
   * silently overwriting the deterministic final key. Absent on TUS uploads
   * (the server writes those itself) and on pre-suffix sidecars — both read
   * the base `<kind>/<id><ext>` key.
   */
  objectSuffix?: string;
};

/** The subset of a sidecar the adapters keep in their in-memory cache. */
export type CachedMeta = {
  ext: string;
  ready: boolean;
  kind: UploadKind;
  filename?: string;
  relatedTo?: string;
  checksum?: string;
  name?: string;
  reservedAt?: number;
  expectedSize?: number;
  objectSuffix?: string;
};

/** Fresh `"uploading"` sidecar for a reserve, stamped with the reservation time. A declared
 * size marks a direct upload (see `ReserveUploadParams.size`), which also gets its
 * per-reservation `objectSuffix` — see that field's doc for why. */
export function buildSidecar(params: ReserveUploadParams): Sidecar {
  return {
    version: SIDECAR_VERSION,
    ext: params.ext,
    filename: params.filename,
    status: 'uploading',
    kind: params.kind,
    relatedTo: params.relatedTo,
    checksum: params.checksum,
    name: params.name,
    reservedAt: Date.now(),
    ...(params.size !== undefined
      ? { expectedSize: params.size, objectSuffix: newObjectSuffix() }
      : {}),
  };
}

/** Short random token for `Sidecar.objectSuffix` — uniqueness per reservation, not secrecy. */
function newObjectSuffix(): string {
  return `g${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Parse + normalize raw sidecar JSON. Returns `null` for malformed content
 * (crash-mid-write debris) — callers treat that as absent. Back-compat rules
 * live here once: pre-`status` sidecars read as `"ready"` (an in-place upgrade
 * must not hide finalized uploads), pre-`kind` as `"video"`.
 */
export function parseSidecar(raw: string): Sidecar | null {
  let parsed: Partial<Sidecar>;
  try {
    parsed = JSON.parse(raw) as Partial<Sidecar>;
  } catch {
    return null;
  }
  if (typeof parsed.ext !== 'string') return null;
  if (typeof parsed.filename !== 'string') return null;
  // Fail closed on an unknown explicit status — only a MISSING status reads as
  // "ready" (pre-status sidecars), never a corrupted value.
  if (parsed.status !== undefined && parsed.status !== 'uploading' && parsed.status !== 'ready') {
    return null;
  }
  const status: Sidecar['status'] = parsed.status === 'uploading' ? 'uploading' : 'ready';
  const kind = parseUploadKind(parsed.kind);
  return {
    version: SIDECAR_VERSION,
    ext: parsed.ext,
    filename: parsed.filename,
    status,
    kind,
    relatedTo: typeof parsed.relatedTo === 'string' ? parsed.relatedTo : undefined,
    checksum: typeof parsed.checksum === 'string' ? parsed.checksum : undefined,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    reservedAt: typeof parsed.reservedAt === 'number' ? parsed.reservedAt : undefined,
    expectedSize: typeof parsed.expectedSize === 'number' ? parsed.expectedSize : undefined,
    objectSuffix: typeof parsed.objectSuffix === 'string' ? parsed.objectSuffix : undefined,
  };
}

/** Project a `Sidecar` into the shape kept in the in-memory cache. */
export function sidecarToCachedMeta(sidecar: Sidecar, ready: boolean): CachedMeta {
  return {
    ext: sidecar.ext,
    ready,
    kind: sidecar.kind ?? 'video',
    filename: sidecar.filename,
    relatedTo: sidecar.relatedTo,
    checksum: sidecar.checksum,
    name: sidecar.name,
    reservedAt: sidecar.reservedAt,
    expectedSize: sidecar.expectedSize,
    objectSuffix: sidecar.objectSuffix,
  };
}

/** Project a cached entry into the public `ArtifactMetadata` shape the storage contract exposes. */
export function cachedMetaToArtifactMetadata(artifactId: string, meta: CachedMeta): ArtifactMetadata {
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
}

/**
 * The read side every adapter shares: a cached `loadMeta` over the adapter's
 * own `readSidecar`, plus the per-field getters and the `ArtifactMetadata`
 * projection of the storage contract. Adapters spread this into their storage
 * object, so the cache's epoch protocol (capture BEFORE the read, hand it to
 * `set`) and the projection exist exactly once instead of once per adapter.
 */
export function createSidecarReader(deps: {
  cache: MetaCache;
  readSidecar: (artifactId: string) => Promise<Sidecar | null>;
}) {
  const { cache, readSidecar } = deps;
  const loadMeta = async (
    artifactId: string,
    opts?: { fresh?: boolean },
  ): Promise<CachedMeta | null> => {
    if (!opts?.fresh) {
      const cached = cache.get(artifactId);
      if (cached) return cached;
    }
    // Capture the deletion epoch BEFORE the storage read: if a `remove` lands
    // while this read is in flight, the epoch moves and the stale fill below
    // is discarded instead of resurrecting a deleted artifact's metadata.
    const asOf = cache.epoch();
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) return null;
    const meta = sidecarToCachedMeta(sidecar, sidecar.status === 'ready');
    cache.set(artifactId, meta, asOf);
    return meta;
  };
  return {
    loadMeta,
    getKind: async (artifactId: string): Promise<UploadKind | null> =>
      (await loadMeta(artifactId))?.kind ?? null,
    getRelatedTo: async (artifactId: string): Promise<string | null> =>
      (await loadMeta(artifactId))?.relatedTo ?? null,
    getChecksum: async (artifactId: string): Promise<string | null> =>
      (await loadMeta(artifactId))?.checksum ?? null,
    getName: async (artifactId: string): Promise<string | null> =>
      (await loadMeta(artifactId))?.name ?? null,
    getMetadata: async (
      artifactId: string,
      opts?: { fresh?: boolean },
    ): Promise<ArtifactMetadata | null> => {
      const meta = await loadMeta(artifactId, opts);
      return meta ? cachedMetaToArtifactMetadata(artifactId, meta) : null;
    },
  };
}

/** The reserve-collision error both adapters throw — surfaces as HTTP 409 via @tus/server. */
export function reserveConflictError(artifactId: string): Error {
  return httpError(409, `artifactId ${artifactId} already has an upload`);
}

/** Map a file extension to the `Content-Type` a playback response should carry. */
export function extToContentType(ext: string): string {
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

export type MetaCache = {
  get(artifactId: string): CachedMeta | undefined;
  /**
   * Deletion epoch — capture it BEFORE starting an async storage read, then
   * pass it to `set`: a fill whose read straddled any deletion is discarded
   * instead of cached, so a slow read can never resurrect a just-deleted
   * artifact's metadata (the point-in-time double-eviction the adapters used
   * before could still lose to a fill that began before the delete and
   * finished after the second eviction).
   */
  epoch(): number;
  set(artifactId: string, meta: CachedMeta, asOfEpoch?: number): void;
  delete(artifactId: string): void;
};

/**
 * Bounded metadata cache keyed by artifactId, with insertion-order eviction
 * (a `Map` preserves insertion order; re-setting a key moves it to the end,
 * so eviction always drops the least-recently-set entry). A cache miss falls
 * back to reading the sidecar from storage, so eviction only costs an extra
 * read, never correctness — and a `set` carrying a stale `asOfEpoch` is
 * skipped for the same reason (see `MetaCache.epoch`).
 */
export function createMetaCache(limit: number): MetaCache {
  const cache = new Map<string, CachedMeta>();
  // One counter for the whole cache, not per key: deletions are rare, a
  // skipped fill only costs one extra read, and this keeps the guard O(1)
  // in memory with no per-key bookkeeping to leak.
  let deletionEpoch = 0;
  return {
    get: (artifactId) => cache.get(artifactId),
    epoch: () => deletionEpoch,
    set: (artifactId, meta, asOfEpoch) => {
      if (asOfEpoch !== undefined && asOfEpoch !== deletionEpoch) return;
      cache.delete(artifactId);
      cache.set(artifactId, meta);
      if (cache.size > limit) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    },
    delete: (artifactId) => {
      deletionEpoch += 1;
      cache.delete(artifactId);
    },
  };
}
