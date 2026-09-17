import { httpError } from '../lib/errors.js';
import type { ArtifactMetadata, ReserveUploadParams, UploadKind } from './types.js';
import { parseUploadKind } from './types.js';

/**
 * Everything the two storage adapters share about per-artifact metadata
 * sidecars — the schema, its parsing/normalization, the in-memory cache, and
 * the reserve-collision error. The local adapter persists a sidecar as a JSON
 * file under `.pulsevault/`, the S3 adapter as a JSON object under the
 * `.pulsevault/` key prefix; the CONTENT and semantics are identical by
 * design, and this module is what keeps them identical.
 *
 * The sidecar is the reservation: while one exists under an artifactId, no
 * create for that id can succeed. `remove` never deletes it — it rewrites it
 * as a `"deleted"` tombstone, so an id stays spent forever. That one rule is
 * what makes every stale handle harmless: a stale presigned PUT lands on a key
 * nothing will ever serve, a stale cache entry describes an id whose identity
 * can never change, and a cancel that races a finish can only ever un-serve.
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
  /** Lowercase extension including the leading dot (e.g. `".mp4"`). Empty on a tombstone left over unparseable debris. */
  ext: string;
  /** Original filename from `Upload-Metadata.filename`. Empty on a tombstone left over unparseable debris. */
  filename: string;
  /**
   * `"uploading"` between `reserveUpload` and `markReady`; `"ready"` once
   * every post-upload validation has passed; `"deleted"` once `remove` ran.
   * Only `"ready"` sidecars are served. `"deleted"` is a tombstone: readers
   * treat it as absent, but the file/object still occupies the id, so
   * `reserveUpload` keeps conflicting.
   */
  status: 'uploading' | 'ready' | 'deleted';
  /** Artifact kind. Optional for back-compat — pre-kind sidecars read as `"video"`. */
  kind?: UploadKind;
  /** Optional id of another artifact this one belongs to. See `ReserveUploadParams.relatedTo`. */
  relatedTo?: string;
  /** Optional client-supplied checksum metadata. See `ReserveUploadParams.checksum`. */
  checksum?: string;
  /** Optional human-facing display name. See `ReserveUploadParams.name`. */
  name?: string;
  /**
   * Epoch-ms timestamp of the `reserveUpload` that wrote this sidecar. Exists
   * for retention tooling: an operator sweep (or object-storage lifecycle
   * rule) ages out abandoned `"uploading"` sidecars by it. Carried in the JSON
   * (not derived from file mtimes) so it survives backup/restore and works
   * identically on object storage.
   */
  reservedAt?: number;
  /** Expected total size in bytes (direct uploads only). See `ReserveUploadParams.size`. */
  expectedSize?: number;
  /** Epoch-ms timestamp of the `remove` that tombstoned this sidecar. */
  deletedAt?: number;
};

/** The subset of a sidecar the adapters keep in their in-memory cache. Never a tombstone. */
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
};

/** Fresh `"uploading"` sidecar for a reserve, stamped with the reservation time. A declared
 * size marks a direct upload (see `ReserveUploadParams.size`). */
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
    ...(params.size !== undefined ? { expectedSize: params.size } : {}),
  };
}

/**
 * The tombstone `remove` leaves behind. Keeps what identity it can (an
 * unparseable sidecar has none) so listings stay informative; the status is
 * what matters — it is what keeps the id spent.
 */
export function tombstoneSidecar(prev: Sidecar | null): Sidecar {
  return {
    version: SIDECAR_VERSION,
    ext: prev?.ext ?? '',
    filename: prev?.filename ?? '',
    status: 'deleted',
    kind: prev?.kind,
    relatedTo: prev?.relatedTo,
    reservedAt: prev?.reservedAt,
    deletedAt: Date.now(),
  };
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
  const status = parsed.status ?? 'ready';
  if (status !== 'uploading' && status !== 'ready' && status !== 'deleted') return null;
  return {
    version: SIDECAR_VERSION,
    ext: parsed.ext,
    filename: parsed.filename,
    status,
    kind: parseUploadKind(parsed.kind),
    relatedTo: typeof parsed.relatedTo === 'string' ? parsed.relatedTo : undefined,
    checksum: typeof parsed.checksum === 'string' ? parsed.checksum : undefined,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    reservedAt: typeof parsed.reservedAt === 'number' ? parsed.reservedAt : undefined,
    expectedSize: typeof parsed.expectedSize === 'number' ? parsed.expectedSize : undefined,
    deletedAt: typeof parsed.deletedAt === 'number' ? parsed.deletedAt : undefined,
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
 * projection of the storage contract. A tombstone reads as absent.
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
    const sidecar = await readSidecar(artifactId);
    if (!sidecar || sidecar.status === 'deleted') {
      cache.delete(artifactId);
      return null;
    }
    const meta = sidecarToCachedMeta(sidecar, sidecar.status === 'ready');
    cache.set(artifactId, meta);
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
  set(artifactId: string, meta: CachedMeta): void;
  delete(artifactId: string): void;
};

/**
 * Bounded metadata cache keyed by artifactId, with insertion-order eviction
 * (a `Map` preserves insertion order; re-setting a key moves it to the end,
 * so eviction always drops the least-recently-set entry). A cache miss falls
 * back to reading the sidecar from storage, so eviction only costs an extra
 * read, never correctness. A stale entry is harmless too: an id's identity
 * never changes (ids are single-use), and the only state that can go stale is
 * `ready` — a stale "ready" for a tombstoned id resolves to bytes that are
 * gone, which the serving path reports as 404.
 */
export function createMetaCache(limit: number): MetaCache {
  const cache = new Map<string, CachedMeta>();
  return {
    get: (artifactId) => cache.get(artifactId),
    set: (artifactId, meta) => {
      cache.delete(artifactId);
      cache.set(artifactId, meta);
      if (cache.size > limit) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    },
    delete: (artifactId) => {
      cache.delete(artifactId);
    },
  };
}
