import { createHash } from 'node:crypto';
import type { DataStore } from '@tus/server';
// Type-only imports: erased at compile time (verbatimModuleSyntax), so loading
// this module never pulls in the AWS SDK. The real modules are loaded lazily
// inside `createS3Storage` so a local-filesystem-only consumer never has to
// install `@aws-sdk/*` or `@tus/s3-store`.
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type {
  ArtifactMetadata,
  DirectUploadGrant,
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from './types.js';
import { isUuid } from '../lib/uuid.js';
import {
  buildSidecar,
  createMetaCache,
  createSidecarReader,
  DEFAULT_META_CACHE_LIMIT,
  extToContentType,
  parseSidecar,
  reserveConflictError,
  type Sidecar,
  sidecarToCachedMeta,
} from './sidecar.js';

// Sidecar schema, parsing, cache, and the reserve-collision error all live in
// `./sidecar.js`, shared verbatim with the local adapter — this file owns only
// the bucket-specific I/O around them. The sidecar for an artifact is a small
// JSON object at `.pulsevault/<artifactId>.json`.

/** Key prefix inside the bucket that holds the per-upload sidecar objects. */
const PULSEVAULT_META_PREFIX = '.pulsevault';
/** Default presigned playback URL lifetime (15 minutes). */
const DEFAULT_PRESIGN_TTL_SECONDS = 900;

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
   * be >= 5 MiB. When omitted, `@tus/s3-store` computes an optimal size —
   * except on Cloudflare R2 (auto-detected from `endpoint`), where it defaults
   * to 8 MiB because R2 requires all non-trailing parts to be the same size.
   */
  partSize?: number;
  /**
   * Minimum multipart part size in bytes, forwarded to `@tus/s3-store`.
   * Setting `minPartSize === partSize` makes every non-trailing part exactly
   * that size — REQUIRED by Cloudflare R2. Auto-defaulted to `partSize` when
   * the endpoint is R2; leave unset for AWS S3.
   */
  minPartSize?: number;
  /**
   * Maximum number of parts per multipart upload, forwarded to
   * `@tus/s3-store`. Defaults to 10,000 (the AWS limit); some S3-compatible
   * stores allow fewer (e.g. Scaleway: 1,000).
   */
  maxMultipartParts?: number;
  /**
   * Whether `@tus/s3-store` may tag objects (its `Tus-Completed` tag powers
   * lifecycle-based cleanup of unfinished uploads). Cloudflare R2 does not
   * implement object tagging, so this is auto-defaulted to `false` when the
   * endpoint is R2; leave unset for AWS S3.
   */
  useTags?: boolean;
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

/** Default multipart part size on backends that require equal-size parts (Cloudflare R2). */
const R2_DEFAULT_PART_SIZE = 8 * 1024 * 1024;

/** Whether an endpoint URL points at Cloudflare R2. Tolerant of unparseable input (returns false). */
function isR2Endpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return /(^|\.)r2\.cloudflarestorage\.com$/i.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the `@tus/s3-store` construction options from the adapter options,
 * applying Cloudflare R2's documented requirements automatically when the
 * endpoint is R2 (unless explicitly overridden):
 *
 * - R2 requires all non-trailing multipart parts to be the SAME size →
 *   `partSize`/`minPartSize` both default to 8 MiB.
 * - R2 does not implement `PutObjectTagging` → `useTags` defaults to `false`
 *   (with tags on, `@tus/s3-store` tries to tag every upload's objects).
 *
 * Exported for direct unit testing; not part of the documented public surface.
 */
export function deriveDatastoreOptions(
  opts: Pick<
    S3StorageOptions,
    'endpoint' | 'partSize' | 'minPartSize' | 'maxMultipartParts' | 'useTags'
  >,
): {
  partSize?: number;
  minPartSize?: number;
  maxMultipartParts?: number;
  useTags?: boolean;
} {
  const r2 = isR2Endpoint(opts.endpoint);
  const partSize = opts.partSize ?? (r2 ? R2_DEFAULT_PART_SIZE : undefined);
  const minPartSize = opts.minPartSize ?? (r2 ? partSize : undefined);
  const useTags = opts.useTags ?? (r2 ? false : undefined);
  return {
    ...(partSize !== undefined ? { partSize } : {}),
    ...(minPartSize !== undefined ? { minPartSize } : {}),
    ...(opts.maxMultipartParts !== undefined ? { maxMultipartParts: opts.maxMultipartParts } : {}),
    ...(useTags !== undefined ? { useTags } : {}),
  };
}

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
  /** Satisfies the optional `PulseVaultStorage.getMetadata` contract (incl. `{ fresh }`). */
  getMetadata(artifactId: string, opts?: { fresh?: boolean }): Promise<ArtifactMetadata | null>;
  /**
   * Reserve an artifact and mint a presigned PUT URL the client uploads the
   * bytes to directly (PROTOCOL.md §9 direct-upload profile). Runs the same
   * `reserveUpload` bookkeeping as a TUS create (sidecar, single-use collision
   * rule), so the artifactId space is shared with TUS uploads. `Content-Type`
   * and `Content-Length` are signed into the URL, so it can only upload the
   * declared payload shape.
   */
  createDirectUpload(params: ReserveUploadParams & { size: number }): Promise<DirectUploadGrant>;
  /**
   * Fresh presigned PUT for an EXISTING reservation — the §9 re-grant path.
   * Storage truth is read once, at mint time, and every identity field of the
   * reservation compared against `expected`; a ready artifact, a TUS
   * reservation, or any mismatch is the same 409 as a create collision.
   */
  presignPut(
    artifactId: string,
    expected: { size: number; kind: UploadKind; ext: string; relatedTo?: string },
    ttlSeconds?: number,
  ): Promise<DirectUploadGrant>;
  /** Size in bytes of the stored object for an artifactId, or `null` when absent. */
  headObjectSize(artifactId: string): Promise<number | null>;
  /** Every artifactId with a sidecar under the metadata prefix — the input to the OPERATIONS.md retention sweep. */
  listArtifactIds(): Promise<string[]>;
  /** Probes conditional-write support once (see `createS3Storage`). Also run lazily by the first reserve. */
  initialize(): Promise<void>;
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
  } = s3;
  const { getSignedUrl } = presigner;
  const { S3Store } = s3store;

  const bucket = opts.bucket;
  const presignTtl = opts.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;

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
    ...deriveDatastoreOptions(opts),
    s3ClientConfig: { ...clientConfig, bucket },
  }) as unknown as DataStore;

  // Metadata cache keyed by artifactId, mirroring the local adapter: populated
  // eagerly on reserve and lazily from the sidecar on a cache-miss, so the GET
  // hot path avoids a per-request round-trip to the bucket.
  const metaCache = createMetaCache(opts.metaCacheLimit ?? DEFAULT_META_CACHE_LIMIT);

  const sidecarKey = (artifactId: string): string => `${PULSEVAULT_META_PREFIX}/${artifactId}.json`;
  /** Object key for the artifact bytes — also the TUS file id / multipart key. */
  const artifactKey = (artifactId: string, kind: UploadKind, ext: string): string =>
    `${kind}/${artifactId}${ext}`;
  /**
   * The key the artifact's bytes actually live at. TUS uploads (and pre-suffix
   * sidecars) use the deterministic `artifactKey`; direct uploads carry a
   * per-reservation `objectSuffix` so a superseded reservation's still-valid
   * presigned PUT targets a key no newer reservation — and no ready artifact —
   * reads from (deleting a reservation cannot revoke its presigned URLs; fencing
   * the KEY is what actually retires them). See `Sidecar.objectSuffix`.
   */
  const dataKey = (
    artifactId: string,
    meta: { kind?: UploadKind; ext: string; objectSuffix?: string },
  ): string =>
    meta.objectSuffix
      ? `${meta.kind ?? 'video'}/${artifactId}.${meta.objectSuffix}${meta.ext}`
      : artifactKey(artifactId, meta.kind ?? 'video', meta.ext);

  const writeSidecar = async (artifactId: string, sidecar: Sidecar): Promise<void> => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: sidecarKey(artifactId),
        Body: JSON.stringify(sidecar),
        ContentType: 'application/json',
      }),
    );
  };

  const readSidecar = async (artifactId: string): Promise<Sidecar | null> => {
    let raw: string;
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }),
      );
      raw = (await bodyToBuffer(res.Body)).toString('utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // Malformed sidecars parse to null — absent for readers, but the object
    // still burns the id for `reserveUpload` (the conditional create still
    // conflicts) until `remove` clears it.
    return parseSidecar(raw);
  };

  const { loadMeta, getKind, getRelatedTo, getChecksum, getName, getMetadata } =
    createSidecarReader({ cache: metaCache, readSidecar });

  /** Whether a sidecar object exists for the id — existence, not parsed content (debris still burns the id). */
  const sidecarExists = (artifactId: string): Promise<boolean> =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) })).then(
      () => true,
      (err) => {
        if (isNotFound(err)) return false;
        throw err;
      },
    );

  /**
   * Whether the backend honors `IfNoneMatch: "*"` — decided ONCE per adapter by
   * writing a probe key twice, never inferred per request from an error. That
   * is what catches backends which accept the header and silently ignore it
   * (older MinIO, some gateways): they answer the second PUT with 200 instead
   * of 412, and would otherwise overwrite a finished artifact's sidecar on
   * every collision with no signal at all. Backends that reject the header
   * (501) land in the same degraded mode. `initialize()` runs it eagerly; the
   * first reserve runs it lazily for hosts that skip initialize.
   *
   * Degraded mode is check-then-write, which reopens a genuine TOCTOU window
   * (two concurrent/retried creates for one artifactId can both pass the check
   * before either writes). There is no closing it without a distributed lock,
   * so the best this adapter can do is decide once and say so loudly.
   */
  let conditionalWrites: Promise<boolean> | null = null;
  const supportsConditionalWrites = (): Promise<boolean> =>
    (conditionalWrites ??= probeConditionalWrites().catch((err) => {
      conditionalWrites = null;
      throw err;
    }));
  const probeConditionalWrites = async (): Promise<boolean> => {
    const key = `${PULSEVAULT_META_PREFIX}/.probe-${crypto.randomUUID()}`;
    const put = (conditional: boolean) =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: '',
          ...(conditional ? { IfNoneMatch: '*' } : {}),
        }),
      );
    try {
      await put(false);
      const honored = await put(true).then(
        () => false,
        (err) => {
          if (isPreconditionFailed(err)) return true;
          if (isConditionalWriteUnsupported(err)) return false;
          throw err;
        },
      );
      if (!honored) {
        console.warn(
          '[pulsevault] S3-compatible backend does not honor conditional writes (IfNoneMatch); ' +
            'falling back to check-then-write for reserveUpload. This reopens a collision race ' +
            'between concurrent/retried creates for the same artifactId. If this matters for your ' +
            'deployment, use a backend that supports IfNoneMatch, or serialize artifactId creation ' +
            'in front of pulsevault (e.g. in your own /reserve endpoint).',
        );
      }
      return honored;
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    }
  };
  const initialize = async (): Promise<void> => {
    await supportsConditionalWrites();
  };

  /**
   * Write the reservation sidecar. ArtifactIds are single-use: the create is
   * atomic (`IfNoneMatch: "*"` fails with 412/409 if a sidecar object already
   * exists for this artifactId — whether the previous upload finished, is
   * still in flight, or died halfway), so every collision is a plain 409;
   * clients mint a fresh id per attempt, and abandoned reservations age out
   * via operator retention (see OPERATIONS.md), not an in-band reclaim.
   */
  const reserveSidecar = async (params: ReserveUploadParams): Promise<Sidecar> => {
    const { artifactId } = params;
    const sidecar = buildSidecar(params);
    const asOf = metaCache.epoch();
    const put = {
      Bucket: bucket,
      Key: sidecarKey(artifactId),
      Body: JSON.stringify(sidecar),
      ContentType: 'application/json',
    };
    if (await supportsConditionalWrites()) {
      try {
        await client.send(new PutObjectCommand({ ...put, IfNoneMatch: '*' }));
      } catch (err) {
        if (isPreconditionFailed(err)) throw reserveConflictError(artifactId);
        throw err;
      }
    } else {
      // Degraded backend (see `probeConditionalWrites`): check-then-write.
      if (await sidecarExists(artifactId)) throw reserveConflictError(artifactId);
      await client.send(new PutObjectCommand(put));
    }
    metaCache.set(artifactId, sidecarToCachedMeta(sidecar, false), asOf);
    return sidecar;
  };

  const reserveUpload = async (params: ReserveUploadParams): Promise<string> => {
    await reserveSidecar(params);
    // @tus/s3-store uses this as the object key for the multipart upload, so
    // the finished object lands at `<kind>/<artifactId><ext>`. (Direct uploads
    // ignore this return and PUT to their suffixed key — see `dataKey`.)
    return artifactKey(params.artifactId, params.kind, params.ext);
  };

  const resolve = async (artifactId: string): Promise<PulseVaultResolution | null> => {
    const meta = await loadMeta(artifactId);
    // Only serve ready uploads — an object that exists but is mid-upload or
    // failed validation stays hidden.
    if (!meta || !meta.ready) return null;
    const key = dataKey(artifactId, meta);
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

  const markReady = async (artifactId: string): Promise<void> => {
    const asOf = metaCache.epoch();
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) {
      throw new Error(
        `markReady: no sidecar for artifactId ${artifactId} (was reserveUpload called?)`,
      );
    }
    const next = sidecarToCachedMeta(sidecar, true);
    if (sidecar.status === 'ready') {
      // Idempotent: already ready, just keep the cache consistent.
      metaCache.set(artifactId, next, asOf);
      return;
    }
    await writeSidecar(artifactId, { ...sidecar, status: 'ready' });
    metaCache.set(artifactId, next, asOf);
  };

  const remove = async (artifactId: string): Promise<boolean> => {
    // Disk truth, not the cache — the current objectSuffix decides which key
    // the deletes below target, and a cached entry could be stale.
    const meta = await loadMeta(artifactId, { fresh: true });
    if (!meta) {
      // An existing-but-unparseable sidecar (crash mid-write, a foreign schema)
      // still burns the id — clear it here rather than leave an id no API can
      // free. Its bytes, if any, are unknowable without kind/ext; retention
      // covers those.
      if (!(await sidecarExists(artifactId))) return false;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }));
      metaCache.delete(artifactId);
      return true;
    }
    const key = dataKey(artifactId, meta);
    // Abort any still-in-progress multipart upload (no-op / best-effort once
    // the upload has completed) so we never orphan an open multipart session.
    // TUS is the only multipart writer and always writes the base key.
    await Promise.allSettled([
      (datastore as { remove?: (id: string) => Promise<void> }).remove?.(
        artifactKey(artifactId, meta.kind, meta.ext),
      ),
    ]);
    // Delete the artifact bytes and the @tus/s3-store `.info` sidecar FIRST,
    // and only then our metadata sidecar: the sidecar is the reservation lock
    // (while it exists, `reserveUpload` conflicts), so deleting it last
    // guarantees no new reservation can re-create the same deterministic keys
    // while these deletes are still in flight. TUS never suffixes, so the
    // `.info` lives at the base key. DeleteObject is idempotent — safe whether
    // or not the multipart abort removed some.
    await Promise.all([
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: `${artifactKey(artifactId, meta.kind, meta.ext)}.info`,
        }),
      ),
    ]);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }));
    // Evict AFTER the sidecar is gone — and bump the deletion epoch — so an
    // in-flight `loadMeta` fill that read the sidecar before the delete can't
    // resurrect it (fills capture the epoch before reading and are discarded
    // on mismatch). Evicting earlier would buy nothing: the sidecar is still in
    // the bucket until this point, so a racing read just refills from it.
    metaCache.delete(artifactId);
    return true;
  };

  // The three byte readers feed `validatePayload` during finalize. They read the
  // sidecar fresh: a direct upload's bytes live at a per-reservation key, and a
  // rival instance may have removed + re-reserved this id since this process
  // cached it — validating (and on failure, wiping) the wrong object would turn a
  // good upload into a 500. Playback (`resolve`) stays on the cache.
  const readHeader = async (artifactId: string, n: number): Promise<Buffer | null> => {
    const meta = await loadMeta(artifactId, { fresh: true });
    if (!meta) return null;
    const key = dataKey(artifactId, meta);
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
    const meta = await loadMeta(artifactId, { fresh: true });
    if (!meta) return null;
    const key = dataKey(artifactId, meta);
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
    const meta = await loadMeta(artifactId, { fresh: true });
    if (!meta) return null;
    const key = dataKey(artifactId, meta);
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await digestBody(res.Body, algorithm);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };


  /** Sign a PUT for exactly this reservation's key and declared payload shape. */
  const signPut = async (
    artifactId: string,
    meta: { kind?: UploadKind; ext: string; objectSuffix?: string },
    size: number,
    ttlSeconds: number,
  ): Promise<DirectUploadGrant> => {
    const contentType = extToContentType(meta.ext);
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: dataKey(artifactId, meta),
        ContentType: contentType,
        ContentLength: size,
      }),
      // The presigner leaves `content-type` UNSIGNED by default — name it, or the
      // grant pins only the byte count and any type could be stored under it.
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type']) },
    );
    return {
      uploadUrl,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
    };
  };

  const createDirectUpload = async (
    params: ReserveUploadParams & { size: number },
  ): Promise<DirectUploadGrant> => {
    // Same reservation as a TUS create — sidecar written, single-use collision
    // rule applied identically — so a direct upload and a TUS upload can never
    // silently share an artifactId. The sidecar just written IS the
    // reservation; sign from it rather than reading it back.
    const sidecar = await reserveSidecar(params);
    return signPut(params.artifactId, sidecar, params.size, presignTtl);
  };

  const presignPut = async (
    artifactId: string,
    expected: { size: number; kind: UploadKind; ext: string; relatedTo?: string },
    ttlSeconds = presignTtl,
  ): Promise<DirectUploadGrant> => {
    // Storage truth, read once at mint time and compared on EVERY identity
    // field: between the caller's decision and this signature the reservation
    // can complete (another instance's `complete`) or be removed and
    // re-reserved with a different shape or session anchor. A ready artifact,
    // a TUS reservation (no `expectedSize`), a different size/kind/ext, or a
    // different `relatedTo` all lose as a 409 — a grant is never re-armed for
    // a reservation the caller was not authorized against.
    const meta = await loadMeta(artifactId, { fresh: true });
    if (
      !meta ||
      meta.ready ||
      meta.expectedSize !== expected.size ||
      meta.kind !== expected.kind ||
      meta.ext !== expected.ext ||
      meta.relatedTo !== expected.relatedTo
    ) {
      throw reserveConflictError(artifactId);
    }
    return signPut(artifactId, meta, expected.size, ttlSeconds);
  };

  const headObjectSize = async (artifactId: string): Promise<number | null> => {
    const meta = await loadMeta(artifactId, { fresh: true });
    if (!meta) return null;
    try {
      const res = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: dataKey(artifactId, meta),
        }),
      );
      return typeof res.ContentLength === 'number' ? res.ContentLength : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  /** Every artifactId with a sidecar — reserved, ready, or debris — so the OPERATIONS.md retention sweep can run on S3/R2. */
  const listArtifactIds = async (): Promise<string[]> => {
    const prefix = `${PULSEVAULT_META_PREFIX}/`;
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) {
        const name = obj.Key?.slice(prefix.length) ?? '';
        const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
        if (isUuid(id)) ids.push(id);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return ids;
  };

  const shutdown = async (): Promise<void> => {
    client.destroy();
  };

  return {
    datastore,
    bucket,
    initialize,
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
    getMetadata,
    createDirectUpload,
    presignPut,
    headObjectSize,
    listArtifactIds,
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

/**
 * Whether a conditional `PutObjectCommand` (`IfNoneMatch`) lost: 412 when the
 * object already exists, and — AWS's documented answer when two conditional
 * writes to the same key race — 409 `ConditionalRequestConflict`. Both mean
 * "someone else holds this id", i.e. the reserve collision.
 */
function isPreconditionFailed(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'PreconditionFailed' ||
    e?.Code === 'PreconditionFailed' ||
    e?.name === 'ConditionalRequestConflict' ||
    e?.Code === 'ConditionalRequestConflict' ||
    e?.$metadata?.httpStatusCode === 412 ||
    e?.$metadata?.httpStatusCode === 409
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

