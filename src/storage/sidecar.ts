import { httpError } from '../lib/errors.js';
import type { ReserveUploadParams, UploadKind } from './types.js';
import { parseUploadKind } from './types.js';

/**
 * Everything the two storage adapters share about per-artifact metadata
 * sidecars — the schema, its parsing/normalization, the in-memory cache, the
 * debris-staleness gate, and the reserve-collision error. The local adapter
 * persists a sidecar as a JSON file under `.pulsevault/`, the S3 adapter as a
 * JSON object under the `.pulsevault/` key prefix; the CONTENT and semantics
 * are identical by design, and this module is what keeps them identical —
 * before it existed, every sidecar change had to be hand-mirrored across both
 * adapters.
 */

/** Sidecar schema version. Increment for breaking changes. */
export const SIDECAR_VERSION = 1 as const;
/** Default cap on an adapter's in-memory metadata cache before evicting the oldest entry. */
export const DEFAULT_META_CACHE_LIMIT = 10_000;
/** Default minimum age before an orphaned `"uploading"` sidecar may be reclaimed. */
export const DEFAULT_RECLAIM_GRACE_MS = 60_000;

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
   * Epoch-ms timestamp of the `reserveUpload` that wrote this sidecar. Used to
   * age-gate crash-debris reclaim (see `sidecarIsStale`); carried in the JSON
   * (not derived from file mtimes) so it survives backup/restore and works
   * identically on object storage. Absent on sidecars written before this
   * field existed — those are by definition old enough to reclaim.
   */
  reservedAt?: number;
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
};

/** Fresh `"uploading"` sidecar for a reserve, stamped with the reservation time. */
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
  };
}

/**
 * Whether a sidecar is old enough to be reclaimable debris. A sidecar younger
 * than the grace window may belong to a concurrent create that hasn't written
 * its datastore state yet — those must still 409, or two simultaneous creates
 * for the same artifactId would both "win". Sidecars without a `reservedAt`
 * (written before the field existed) are old by definition.
 */
export function sidecarIsStale(sidecar: Sidecar, reclaimGraceMs: number): boolean {
  return sidecar.reservedAt === undefined || Date.now() - sidecar.reservedAt > reclaimGraceMs;
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
 * read, never correctness.
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
