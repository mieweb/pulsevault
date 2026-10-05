import { createHash } from 'node:crypto';
import type { DataStore } from '@tus/server';
// Type-only imports: erased at compile time (verbatimModuleSyntax), so loading
// this module never pulls in the AWS SDK. The real modules are loaded lazily
// inside `createS3Storage` so a local-filesystem-only consumer never has to
// install `@aws-sdk/*` or `@tus/s3-store`.
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
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
import { isUuid } from '../lib/uuid.js';

/**
 * Per-upload metadata sidecar, stored as a small JSON object in the bucket at
 * `.pulsevault/<artifactId>.json`. This mirrors the local adapter's on-disk
 * sidecar: it lets `resolve`/`getKind` recover an upload's extension, kind and
 * completion state from the `artifactId` alone (the object key needs both
 * `kind` and `ext`, which the bare artifactId doesn't carry), and survives a
 * restart.
 */
type Sidecar = {
  /** Sidecar schema version. Increment for breaking changes. */
  version: 1;
  /** Lowercase extension including the leading dot (e.g. `".mp4"`). */
  ext: string;
  /** Original filename from `Upload-Metadata.filename`. */
  filename: string;
  /**
   * `"uploading"` between `reserveUpload` and `markReady`; `"ready"` once every
   * post-upload validation has passed. `resolve` only serves `"ready"` uploads
   * so an object that exists but failed validation is never handed out.
   */
  status: 'uploading' | 'ready';
  /** Artifact kind. Optional for back-compat; absent is read as `"video"`. */
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
  /** `false` from reserve until the core records that `onUploadComplete` finished; absent reads as `true` once finished. */
  acknowledged?: boolean;
  /** `false` from reserve until the core records that the web-ready conversion finished; absent reads as `true` once finished. */
  converted?: boolean;
  /** Whatever the host recorded with `recordOutcome`. */
  outcome?: unknown;
  /** When the upload finished (ms since the epoch), set by `markReady`, never changed after. */
  readyAt?: number;
};

const SIDECAR_VERSION = 1 as const;
/** Key prefix inside the bucket that holds the per-upload sidecar objects. */
const PULSEVAULT_META_PREFIX = '.pulsevault';
/**
 * Relation index: `.pulsevault/related/<anchorId>/<artifactId>` is an empty object for every
 * artifact that declared `relatedTo` the anchor, so a pulse's files are one prefix listing away.
 */
const RELATED_PREFIX = `${PULSEVAULT_META_PREFIX}/related`;
/** Default presigned playback URL lifetime (15 minutes). */
const DEFAULT_PRESIGN_TTL_SECONDS = 900;
/** Default cap on the in-memory metadata cache before evicting the oldest entry. */
const DEFAULT_META_CACHE_LIMIT = 10_000;

type CachedMeta = {
  ext: string;
  ready: boolean;
  kind: UploadKind;
  relatedTo?: string;
  checksum?: string;
  name?: string;
};

/** Map a file extension to the `Content-Type` the playback URL should return. */
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
    ready,
    kind: sidecar.kind ?? 'video',
    relatedTo: sidecar.relatedTo,
    checksum: sidecar.checksum,
    name: sidecar.name,
  };
}

export type S3StorageOptions = {
  /** Target bucket. Must already exist (the integrator provisions it). */
  bucket: string;
  /**
   * Custom S3 endpoint. Set this for Cloudflare R2 or any S3-compatible store
   * (e.g. `https://<account-id>.r2.cloudflarestorage.com`). Omit for AWS S3.
   */
  endpoint?: string;
  /**
   * AWS region. Required for AWS S3; for R2 use `"auto"`. When omitted and an
   * `endpoint` is set this defaults to `"auto"`; otherwise the SDK resolves it
   * from the environment.
   */
  region?: string;
  /**
   * Access key id. Optional — when both `accessKeyId` and `secretAccessKey`
   * are omitted the AWS SDK default credential chain is used (env vars, IAM
   * role, etc.). Never hard-code keys; read them from env in your app.
   */
  accessKeyId?: string;
  /** Secret access key. See `accessKeyId`. */
  secretAccessKey?: string;
  /** Optional STS session token for temporary credentials. */
  sessionToken?: string;
  /**
   * Use path-style addressing (`<endpoint>/<bucket>/<key>`) instead of
   * virtual-host style. Defaults to `true` whenever a custom `endpoint` is set
   * (R2 and most S3-compatible stores need it).
   */
  forcePathStyle?: boolean;
  /** Presigned playback URL TTL in seconds. Defaults to 900 (15 minutes). */
  presignTtlSeconds?: number;
  /**
   * Preferred multipart part size in bytes, forwarded to `@tus/s3-store`. Must
   * be >= 5 MiB. When omitted, `@tus/s3-store` computes an optimal size.
   */
  partSize?: number;
  /**
   * Max number of entries kept in the in-memory metadata cache before the
   * oldest (by insertion order) is evicted. A cache miss falls back to a
   * bucket read, so eviction only costs an extra request, not correctness.
   * Defaults to 10,000.
   */
  metaCacheLimit?: number;
  /**
   * Advanced escape hatch: extra `S3ClientConfig` fields merged into the
   * client used for both playback presigning and the underlying TUS datastore
   * (e.g. checksum flags for S3-compatible stores). Values here win over the
   * fields derived from the options above.
   */
  clientConfig?: Partial<S3ClientConfig>;
};

/**
 * S3 / Cloudflare R2 storage adapter. Uploads stream into the bucket via S3
 * multipart upload (`@tus/s3-store`); playback is served by redirecting the
 * client to a short-lived presigned GET URL, so bytes never flow back through
 * the app server.
 */
export type S3Storage = PulseVaultStorage & {
  /** The bucket this adapter writes to. */
  readonly bucket: string;
  /**
   * Ranged GET of the first `n` bytes of a finalized upload, or `null` if the
   * artifactId is unknown. Used by `createS3Mp4Sniffer` to validate the
   * payload without downloading the whole object.
   */
  readHeader(artifactId: string, n: number): Promise<Buffer | null>;
  /**
   * Full GET of a finalized upload's bytes, or `null` if the artifactId is
   * unknown. Used by `createS3ChecksumValidator` — unlike `readHeader`, this
   * downloads the whole object, so it's only worth using for an explicit,
   * opt-in integrity check, not on every upload by default.
   */
  readAll(artifactId: string): Promise<Buffer | null>;
  /**
   * Streams a finalized upload's bytes through a hash digest, returning the
   * hex digest, or `null` if the artifactId is unknown. The streaming
   * counterpart to `readAll` — used by `createS3ChecksumValidator` so
   * checksum verification never has to hold an entire (potentially
   * multi-gigabyte) object in memory as one `Buffer`.
   */
  digestAll(artifactId: string, algorithm: 'sha256' | 'sha1' | 'md5'): Promise<string | null>;
  /** Artifact kind for a known artifactId, or `null`. Satisfies `getKind`. */
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

/**
 * Build an S3/R2-backed storage adapter.
 *
 * Async because it lazily imports the optional `@aws-sdk/*` and
 * `@tus/s3-store` packages — `await` it before registering the plugin:
 *
 * ```ts
 * const storage = await createS3Storage({
 *   bucket: "pulse-videos",
 *   endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
 *   accessKeyId: process.env.R2_ACCESS_KEY,
 *   secretAccessKey: process.env.R2_SECRET_KEY,
 * });
 * await app.register(pulseVault, { storage, prefix: "/pulsevault", maxUploadSize: Infinity });
 * ```
 */
export async function createS3Storage(opts: S3StorageOptions): Promise<S3Storage> {
  let s3: typeof import('@aws-sdk/client-s3');
  let presigner: typeof import('@aws-sdk/s3-request-presigner');
  let s3store: typeof import('@tus/s3-store');
  try {
    [s3, presigner, s3store] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
      import('@tus/s3-store'),
    ]);
  } catch (err) {
    throw new Error(
      'createS3Storage requires the optional packages `@aws-sdk/client-s3`, ' +
        '`@aws-sdk/s3-request-presigner`, and `@tus/s3-store`. Install them with:\n' +
        '  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @tus/s3-store\n' +
        `(original error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListPartsCommand,
  } = s3;
  const { getSignedUrl } = presigner;
  const { S3Store } = s3store;

  const bucket = opts.bucket;
  const presignTtl = opts.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
  const metaCacheLimit = opts.metaCacheLimit ?? DEFAULT_META_CACHE_LIMIT;

  const credentials =
    opts.accessKeyId && opts.secretAccessKey
      ? {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
          ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
        }
      : undefined;

  const clientConfig: S3ClientConfig = {
    region: opts.region ?? (opts.endpoint ? 'auto' : undefined),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
    ...(credentials ? { credentials } : {}),
    ...opts.clientConfig,
  };

  // Our own client, used for sidecar I/O, ranged header reads, deletes, and
  // presigning. The TUS datastore creates its own client from the same config.
  const client: S3Client = new S3Client(clientConfig);
  const datastore = new S3Store({
    ...(opts.partSize ? { partSize: opts.partSize } : {}),
    s3ClientConfig: { ...clientConfig, bucket },
  }) as unknown as DataStore;

  // Metadata cache keyed by artifactId, mirroring the local adapter: populated
  // eagerly on reserve and lazily from the sidecar on a cache-miss, so the GET
  // hot path avoids a per-request round-trip to the bucket. Bounded with
  // simple insertion-order eviction, same rationale as the local adapter.
  const metaCache = new Map<string, CachedMeta>();

  const cacheSet = (artifactId: string, meta: CachedMeta): void => {
    metaCache.delete(artifactId);
    metaCache.set(artifactId, meta);
    if (metaCache.size > metaCacheLimit) {
      const oldest = metaCache.keys().next().value;
      if (oldest !== undefined) metaCache.delete(oldest);
    }
  };

  const sidecarKey = (artifactId: string): string => `${PULSEVAULT_META_PREFIX}/${artifactId}.json`;
  /** Object key for the artifact bytes — also the TUS file id / multipart key. */
  const artifactKey = (artifactId: string, kind: UploadKind, ext: string): string =>
    `${kind}/${artifactId}${ext}`;

  const writeSidecar = async (
    artifactId: string,
    sidecar: Sidecar,
    /** Only replace the version with this ETag (a read-modify-write that must not lose a concurrent one). */
    ifMatch?: string,
  ): Promise<void> => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: sidecarKey(artifactId),
        Body: JSON.stringify(sidecar),
        ContentType: 'application/json',
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
      }),
    );
  };

  /** The sidecar and the ETag of the version read, for a conditional rewrite. */
  const readSidecarVersioned = async (
    artifactId: string,
  ): Promise<{ sidecar: Sidecar; etag?: string } | null> => {
    let raw: string;
    let etag: string | undefined;
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }),
      );
      raw = (await bodyToBuffer(res.Body)).toString('utf8');
      etag = res.ETag;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const sidecar = parseSidecar(raw);
    return sidecar ? { sidecar, ...(etag ? { etag } : {}) } : null;
  };

  const readSidecar = async (artifactId: string): Promise<Sidecar | null> =>
    (await readSidecarVersioned(artifactId))?.sidecar ?? null;

  const parseSidecar = (raw: string): Sidecar | null => {
    try {
      const parsed = JSON.parse(raw) as Partial<Sidecar>;
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
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : undefined,
        ...(parsed.context !== undefined ? { context: parsed.context } : {}),
        // A sidecar from before the flag existed: finished means nothing to replay; still
        // uploading means its completion hasn't happened yet.
        acknowledged: parsed.acknowledged ?? status === 'ready',
        converted: parsed.converted ?? status === 'ready',
        ...(parsed.outcome !== undefined ? { outcome: parsed.outcome } : {}),
        ...(typeof parsed.readyAt === 'number' ? { readyAt: parsed.readyAt } : {}),
      };
    } catch {
      // Malformed sidecar — treat as absent; `reserveUpload` rewrites it.
      return null;
    }
  };

  /** `LastModified` of one object, 0 when absent or unknown. */
  const objectModifiedAt = async (key: string): Promise<number> => {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return head.LastModified?.getTime() ?? 0;
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
  };

  /**
   * When an unfinished upload last received bytes, as far as the bucket can tell: the newest of
   * its multipart parts (listed through the upload id @tus/s3-store keeps on its `.info` object)
   * and the incomplete part it parks between PATCHes. 0 when nothing has arrived yet. A PATCH
   * leaves a trace here as soon as it lands, unlike the sidecar, which is written at reserve.
   */
  const lastUploadActivity = async (key: string): Promise<number> => {
    let latest = await objectModifiedAt(`${key}.part`);
    try {
      const info = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${key}.info` }));
      latest = Math.max(latest, info.LastModified?.getTime() ?? 0);
      const uploadId = info.Metadata?.['upload-id'];
      if (uploadId) {
        // Pages of at most 1,000 parts: a long upload's newest parts are on the last page.
        let marker: string | undefined;
        do {
          const page = await client.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              ...(marker ? { PartNumberMarker: marker } : {}),
            }),
          );
          for (const part of page.Parts ?? []) {
            latest = Math.max(latest, part.LastModified?.getTime() ?? 0);
          }
          marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
        } while (marker);
      }
    } catch (err) {
      // No `.info` yet, or the multipart upload is gone: nothing more to learn. Anything else
      // (permissions, a transient failure) must not read as "idle".
      if (!isNotFound(err) && !isNoSuchUpload(err)) throw err;
    }
    return latest;
  };

  /** Relation index key for one related artifact under its anchor. */
  const relatedKey = (anchorId: string, artifactId: string): string =>
    `${RELATED_PREFIX}/${anchorId}/${artifactId}`;

  /** When the sidecar was last written — when the upload started, or when it finished. */
  const sidecarModifiedAt = async (artifactId: string): Promise<number> => {
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }),
      );
      return head.LastModified?.getTime() ?? 0;
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
  };

  const sidecarToMeta = (
    artifactId: string,
    sidecar: Sidecar,
    updatedAt: number,
  ): PulseVaultArtifactMeta => ({
    artifactId,
    kind: sidecar.kind ?? 'video',
    ext: sidecar.ext,
    filename: sidecar.filename,
    ...(sidecar.relatedTo ? { relatedTo: sidecar.relatedTo } : {}),
    ...(sidecar.checksum ? { checksum: sidecar.checksum } : {}),
    ...(sidecar.name ? { name: sidecar.name } : {}),
    ...(sidecar.appVersion ? { appVersion: sidecar.appVersion } : {}),
    ...(sidecar.context !== undefined ? { context: sidecar.context } : {}),
    ready: sidecar.status === 'ready',
    acknowledged: sidecar.acknowledged !== false,
    converted: sidecar.converted !== false,
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
    };

    // Fast-path rejection for the common case. Not atomic by itself (two concurrent
    // requests can both observe no existing meta before either writes) — the conditional
    // write below closes that race on backends that support it — but it's also the only
    // enforcement on S3-compatible backends that silently ignore `IfNoneMatch` instead of
    // erroring.
    const existing = await loadMeta(artifactId);
    if (existing) {
      throw Object.assign(new Error(`artifactId ${artifactId} already has an upload`), {
        statusCode: 409,
        status_code: 409,
      });
    }

    // Collision guard: `IfNoneMatch: "*"` makes the write itself atomically fail
    // (PreconditionFailed) if a sidecar object already exists for this artifactId, closing
    // the race the check above can't close by itself. Surfaces as HTTP 409 via @tus/server's
    // error path, same as before.
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: sidecarKey(artifactId),
          Body: JSON.stringify(sidecar),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw Object.assign(new Error(`artifactId ${artifactId} already has an upload`), {
          statusCode: 409,
          status_code: 409,
        });
      }
      if (!isConditionalWriteUnsupported(err)) throw err;
      // Some S3-compatible backends don't support conditional writes — fall back to the
      // previous check-then-write. Weaker (the original TOCTOU window reopens) but keeps
      // reserve working on those backends instead of hard-failing every upload. Surface
      // this degraded mode once per process so operators know their backend can't fully
      // guarantee collision safety under concurrent/retried creates for the same artifactId.
      warnAboutConditionalWriteFallbackOnce();
      const meta = await loadMeta(artifactId);
      if (meta) {
        throw Object.assign(new Error(`artifactId ${artifactId} already has an upload`), {
          statusCode: 409,
          status_code: 409,
        });
      }
      await writeSidecar(artifactId, sidecar);
    }

    if (relatedTo) {
      // The relation index entry, written after the sidecar so a failure between the two
      // leaves an unlisted artifact, never an entry without one.
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: relatedKey(relatedTo, artifactId), Body: '' }),
      );
    }

    cacheSet(artifactId, { ext, ready: false, kind, relatedTo, checksum, name });
    // @tus/s3-store uses this as the object key for the multipart upload, so
    // the finished object lands at `<kind>/<artifactId><ext>`.
    return artifactKey(artifactId, kind, ext);
  };

  const resolve = async (artifactId: string): Promise<PulseVaultResolution | null> => {
    const meta = await loadMeta(artifactId);
    // Only serve ready uploads — an object that exists but is mid-upload or
    // failed validation stays hidden.
    if (!meta || !meta.ready) return null;
    const key = artifactKey(artifactId, meta.kind, meta.ext);
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        // Force the right Content-Type on the redirected download regardless
        // of what was stored on the object.
        ResponseContentType: extToContentType(meta.ext),
      }),
      { expiresIn: presignTtl },
    );
    return { kind: 'redirect', url, statusCode: 302 };
  };

  /**
   * A read-modify-write of the sidecar that must not lose a concurrent one (an instance
   * acknowledging a completion while another records its outcome, or finishes the upload): the
   * rewrite is conditional on the ETag that was read, and retried from a fresh read when the
   * object changed meanwhile. On a backend that doesn't support `IfMatch`, the write is
   * unconditional — the same degraded mode as reserve. Resolves `null` for an unknown id.
   */
  const rewriteSidecar = async (
    artifactId: string,
    mutate: (current: Sidecar) => Sidecar | null,
  ): Promise<Sidecar | null> => {
    for (let attempt = 0; ; attempt++) {
      const current = await readSidecarVersioned(artifactId);
      if (!current) return null;
      const next = mutate(current.sidecar);
      if (next === null) return current.sidecar; // nothing to change
      try {
        await writeSidecar(artifactId, next, current.etag);
      } catch (err) {
        if (isPreconditionFailed(err) && attempt < 5) continue; // changed under us: re-read, retry
        if (!isConditionalWriteUnsupported(err)) throw err;
        warnAboutConditionalWriteFallbackOnce();
        await writeSidecar(artifactId, next);
      }
      cacheSet(artifactId, sidecarToCachedMeta(next, next.status === 'ready'));
      return next;
    }
  };

  const markReady = async (artifactId: string): Promise<void> => {
    const result = await rewriteSidecar(artifactId, (sidecar) =>
      // Idempotent: already ready leaves the sidecar alone.
      sidecar.status === 'ready' ? null : { ...sidecar, status: 'ready', readyAt: Date.now() },
    );
    if (!result) {
      throw new Error(
        `markReady: no sidecar for artifactId ${artifactId} (was reserveUpload called?)`,
      );
    }
    cacheSet(artifactId, sidecarToCachedMeta(result, true));
  };

  const remove = async (artifactId: string): Promise<boolean> => {
    const meta = await loadMeta(artifactId);
    // Evict before deleting so a racing `resolve` can't hand back a stale key.
    metaCache.delete(artifactId);
    if (!meta) return false;
    const key = artifactKey(artifactId, meta.kind, meta.ext);
    // Abort any still-in-progress multipart upload (no-op / best-effort once
    // the upload has completed) so we never orphan an open multipart session.
    await Promise.allSettled([
      (datastore as { remove?: (id: string) => Promise<void> }).remove?.(key),
    ]);
    // @tus/s3-store caches an upload's metadata, and its own removal of a finished upload fails
    // (NoSuchUpload) before clearing it — a HEAD would then still report the deleted upload as
    // complete.
    await (datastore as { clearCache?: (id: string) => Promise<void> }).clearCache?.(key);
    // Delete the finalized object, the @tus/s3-store `.info` sidecar, the incomplete part it
    // parks between PATCHes (`.part`, left behind by its own removal), and our metadata
    // sidecar. DeleteObject is idempotent, so this is safe whether or not the multipart abort
    // above already removed some of them.
    await Promise.all([
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${key}.info` })),
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${key}.part` })),
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) })),
      ...(meta.relatedTo
        ? [
            client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: relatedKey(meta.relatedTo, artifactId) }),
            ),
          ]
        : []),
    ]);
    return true;
  };

  const readHeader = async (artifactId: string, n: number): Promise<Buffer | null> => {
    const meta = await loadMeta(artifactId);
    if (!meta) return null;
    const key = artifactKey(artifactId, meta.kind, meta.ext);
    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          Range: `bytes=0-${Math.max(0, n - 1)}`,
        }),
      );
      return await bodyToBuffer(res.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  const readAll = async (artifactId: string): Promise<Buffer | null> => {
    const meta = await loadMeta(artifactId);
    if (!meta) return null;
    const key = artifactKey(artifactId, meta.kind, meta.ext);
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await bodyToBuffer(res.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  const digestAll = async (
    artifactId: string,
    algorithm: 'sha256' | 'sha1' | 'md5',
  ): Promise<string | null> => {
    const meta = await loadMeta(artifactId);
    if (!meta) return null;
    const key = artifactKey(artifactId, meta.kind, meta.ext);
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await digestBody(res.Body, algorithm);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
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

  /** Straight from the bucket, never the cache: the flags change after the cache was filled. */
  const describeArtifact = async (artifactId: string): Promise<PulseVaultArtifactMeta | null> => {
    if (!isUuid(artifactId)) return null;
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) return null;
    let updatedAt = await sidecarModifiedAt(artifactId);
    if (sidecar.status === 'uploading') {
      // An upload in flight counts from its last byte, not from when it was reserved — so a
      // long upload that's still moving is never taken for an idle one.
      const key = artifactKey(artifactId, sidecar.kind ?? 'video', sidecar.ext);
      updatedAt = Math.max(updatedAt, await lastUploadActivity(key));
    }
    return sidecarToMeta(artifactId, sidecar, updatedAt);
  };

  const patchArtifact = async (
    artifactId: string,
    patch: PulseVaultArtifactPatch,
  ): Promise<boolean> => {
    if (!isUuid(artifactId)) return false;
    const result = await rewriteSidecar(artifactId, (sidecar) => {
      const next: Sidecar = { ...sidecar };
      if (patch.acknowledged !== undefined) next.acknowledged = patch.acknowledged;
      if (patch.converted !== undefined) next.converted = patch.converted;
      if (patch.outcome !== undefined) {
        if (patch.outcome === null) delete next.outcome;
        else next.outcome = patch.outcome;
      }
      return next;
    });
    return result !== null;
  };

  async function* listRelated(artifactId: string): AsyncIterable<PulseVaultArtifactRecord> {
    if (!isUuid(artifactId)) return;
    const prefix = `${RELATED_PREFIX}/${artifactId}/`;
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        const relatedId = object.Key?.slice(prefix.length) ?? '';
        if (!isUuid(relatedId)) continue;
        const sidecar = await readSidecar(relatedId);
        if (!sidecar || sidecar.relatedTo !== artifactId) continue; // An entry whose artifact is gone.
        yield {
          artifactId: relatedId,
          kind: sidecar.kind ?? 'video',
          relatedTo: artifactId,
          ready: sidecar.status === 'ready',
          updatedAt: await sidecarModifiedAt(relatedId),
        };
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /**
   * Walk the sidecar objects. A sidecar is rewritten only when its upload finishes, so its
   * `LastModified` is when the upload started (still uploading) or when it finished (ready).
   * Sidecars changed at or after `changedBefore` are skipped without being read.
   */
  async function* listArtifacts(
    opts: { changedBefore?: number } = {},
  ): AsyncIterable<PulseVaultArtifactRecord> {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${PULSEVAULT_META_PREFIX}/`,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(PULSEVAULT_META_PREFIX.length + 1) ?? '';
        if (!name.endsWith('.json')) continue;
        const artifactId = name.slice(0, -'.json'.length);
        if (!isUuid(artifactId)) continue;
        const updatedAt = object.LastModified?.getTime() ?? 0;
        if (opts.changedBefore !== undefined && updatedAt >= opts.changedBefore) continue;
        const sidecar = await readSidecar(artifactId);
        if (!sidecar) continue;
        yield {
          artifactId,
          kind: sidecar.kind ?? 'video',
          ...(sidecar.relatedTo ? { relatedTo: sidecar.relatedTo } : {}),
          ready: sidecar.status === 'ready',
          updatedAt,
        };
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  const shutdown = async (): Promise<void> => {
    client.destroy();
  };

  return {
    datastore,
    bucket,
    reserveUpload,
    resolve,
    markReady,
    remove,
    readHeader,
    readAll,
    digestAll,
    getKind,
    getRelatedTo,
    getChecksum,
    getName,
    listArtifacts,
    describeArtifact,
    patchArtifact,
    listRelated,
    shutdown,
  };
}

/**
 * The two shapes `GetObjectCommandOutput.Body` can take depending on runtime:
 * a web-stream-backed blob with `transformToByteArray` (Node 18+ AWS SDK v3),
 * or a plain Node.js `Readable` async iterable.
 */
type SdkResponseBody = { transformToByteArray(): Promise<Uint8Array> } | AsyncIterable<Uint8Array>;

function hasTransformToByteArray(
  body: unknown,
): body is { transformToByteArray(): Promise<Uint8Array> } {
  return (
    !!body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function'
  );
}

/** Collect an AWS SDK response body into a Buffer. */
async function bodyToBuffer(body: SdkResponseBody | undefined): Promise<Buffer> {
  if (hasTransformToByteArray(body)) {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Stream an AWS SDK response body through a hash digest without buffering the
 * whole thing into memory first — the streaming counterpart to
 * `bodyToBuffer`, used by `digestAll`.
 */
async function digestBody(
  body: SdkResponseBody | undefined,
  algorithm: 'sha256' | 'sha1' | 'md5',
): Promise<string> {
  const hash = createHash(algorithm);
  if (hasTransformToByteArray(body)) {
    hash.update(await body.transformToByteArray());
    return hash.digest('hex');
  }
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Whether an AWS SDK error represents a missing key/object (404-ish). */
/** Whether `ListParts` answered that the multipart upload no longer exists (completed or aborted). */
function isNoSuchUpload(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchUpload' || e?.Code === 'NoSuchUpload';
}

function isNotFound(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.Code === 'NoSuchKey' ||
    e?.Code === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/** Whether a conditional `PutObjectCommand` (`IfNoneMatch`) failed because the object already exists. */
function isPreconditionFailed(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'PreconditionFailed' ||
    e?.Code === 'PreconditionFailed' ||
    e?.$metadata?.httpStatusCode === 412
  );
}

/** Whether the backend rejected `IfNoneMatch` itself as unsupported, rather than the condition failing. */
function isConditionalWriteUnsupported(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'NotImplemented' ||
    e?.Code === 'NotImplemented' ||
    e?.$metadata?.httpStatusCode === 501
  );
}

let warnedAboutConditionalWriteFallback = false;
/**
 * One-time-per-process warning when `reserveUpload` falls back to
 * check-then-write because the configured S3-compatible backend doesn't
 * support `IfNoneMatch`. That fallback reopens a genuine TOCTOU window
 * (two concurrent/retried `reserveUpload` calls for the same artifactId can
 * both pass the check before either writes, silently clobbering one
 * another's sidecar) — there's no way to close it without a real distributed
 * lock, so the best this library can do is make the degraded mode visible.
 */
function warnAboutConditionalWriteFallbackOnce(): void {
  if (warnedAboutConditionalWriteFallback) return;
  warnedAboutConditionalWriteFallback = true;
  console.warn(
    '[pulsevault] S3-compatible backend does not support conditional writes (IfNoneMatch); ' +
      'falling back to check-then-write for reserveUpload. This reopens a collision race ' +
      'between concurrent/retried creates for the same artifactId. If this matters for your ' +
      'deployment, use a backend that supports IfNoneMatch, or serialize artifactId creation ' +
      'in front of pulsevault (e.g. in your own /reserve endpoint).',
  );
}
