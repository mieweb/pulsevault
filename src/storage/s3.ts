import type { DataStore } from "@tus/server";
// Type-only imports: erased at compile time (verbatimModuleSyntax), so loading
// this module never pulls in the AWS SDK. The real modules are loaded lazily
// inside `createS3Storage` so a local-filesystem-only consumer never has to
// install `@aws-sdk/*` or `@tus/s3-store`.
import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from "./types.js";

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
  status: "uploading" | "ready";
  /** Artifact kind. Optional for back-compat; absent is read as `"video"`. */
  kind?: UploadKind;
  /** Optional id of another artifact this one belongs to. See `ReserveUploadParams.relatedTo`. */
  relatedTo?: string;
  /** Optional client-supplied checksum metadata. See `ReserveUploadParams.checksum`. */
  checksum?: string;
};

const SIDECAR_VERSION = 1 as const;
/** Key prefix inside the bucket that holds the per-upload sidecar objects. */
const PULSEVAULT_META_PREFIX = ".pulsevault";
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
};

/** Map a file extension to the `Content-Type` the playback URL should return. */
function extToContentType(ext: string): string {
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".zip": return "application/zip";
    case ".srt": return "application/x-subrip";
    default: return "application/octet-stream";
  }
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
  /** Artifact kind for a known artifactId, or `null`. Satisfies `getKind`. */
  getKind(artifactId: string): Promise<UploadKind | null>;
  /** Satisfies the optional `PulseVaultStorage.getRelatedTo` contract. */
  getRelatedTo(artifactId: string): Promise<string | null>;
  /** Satisfies the optional `PulseVaultStorage.getChecksum` contract. */
  getChecksum(artifactId: string): Promise<string | null>;
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
export async function createS3Storage(
  opts: S3StorageOptions,
): Promise<S3Storage> {
  let s3: typeof import("@aws-sdk/client-s3");
  let presigner: typeof import("@aws-sdk/s3-request-presigner");
  let s3store: typeof import("@tus/s3-store");
  try {
    [s3, presigner, s3store] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/s3-request-presigner"),
      import("@tus/s3-store"),
    ]);
  } catch (err) {
    throw new Error(
      "createS3Storage requires the optional packages `@aws-sdk/client-s3`, " +
        "`@aws-sdk/s3-request-presigner`, and `@tus/s3-store`. Install them with:\n" +
        "  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @tus/s3-store\n" +
        `(original error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = s3;
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
    region: opts.region ?? (opts.endpoint ? "auto" : undefined),
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

  const sidecarKey = (artifactId: string): string =>
    `${PULSEVAULT_META_PREFIX}/${artifactId}.json`;
  /** Object key for the artifact bytes — also the TUS file id / multipart key. */
  const artifactKey = (artifactId: string, kind: UploadKind, ext: string): string =>
    `${kind}/${artifactId}${ext}`;

  const writeSidecar = async (
    artifactId: string,
    sidecar: Sidecar,
  ): Promise<void> => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: sidecarKey(artifactId),
        Body: JSON.stringify(sidecar),
        ContentType: "application/json",
      }),
    );
  };

  const readSidecar = async (artifactId: string): Promise<Sidecar | null> => {
    let raw: string;
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }),
      );
      raw = (await bodyToBuffer(res.Body)).toString("utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Sidecar>;
      if (typeof parsed.ext !== "string") return null;
      if (typeof parsed.filename !== "string") return null;
      const status: Sidecar["status"] =
        parsed.status === "uploading" ? "uploading" : "ready";
      const kind: UploadKind =
        parsed.kind === "project" ? "project" : parsed.kind === "captions" ? "captions" : "video";
      return {
        version: SIDECAR_VERSION,
        ext: parsed.ext,
        filename: parsed.filename,
        status,
        kind,
        relatedTo: typeof parsed.relatedTo === "string" ? parsed.relatedTo : undefined,
        checksum: typeof parsed.checksum === "string" ? parsed.checksum : undefined,
      };
    } catch {
      // Malformed sidecar — treat as absent; `reserveUpload` rewrites it.
      return null;
    }
  };

  const loadMeta = async (artifactId: string): Promise<CachedMeta | null> => {
    const cached = metaCache.get(artifactId);
    if (cached) return cached;
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) return null;
    const meta: CachedMeta = {
      ext: sidecar.ext,
      ready: sidecar.status === "ready",
      kind: sidecar.kind ?? "video",
      relatedTo: sidecar.relatedTo,
      checksum: sidecar.checksum,
    };
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
  }: ReserveUploadParams): Promise<string> => {
    // Collision guard, same contract as the local adapter: refuse a second
    // upload for an artifactId that already has one (in-progress or ready)
    // rather than letting the datastore silently reset the multipart upload.
    // Surfaces as HTTP 409 via @tus/server's error path.
    const meta = await loadMeta(artifactId);
    if (meta) {
      throw Object.assign(new Error(`artifactId ${artifactId} already has an upload`), {
        statusCode: 409,
        status_code: 409,
      });
    }

    await writeSidecar(artifactId, {
      version: SIDECAR_VERSION,
      ext,
      filename,
      status: "uploading",
      kind,
      relatedTo,
      checksum,
    });
    cacheSet(artifactId, { ext, ready: false, kind, relatedTo, checksum });
    // @tus/s3-store uses this as the object key for the multipart upload, so
    // the finished object lands at `<kind>/<artifactId><ext>`.
    return artifactKey(artifactId, kind, ext);
  };

  const resolve = async (
    artifactId: string,
  ): Promise<PulseVaultResolution | null> => {
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
    return { kind: "redirect", url, statusCode: 302 };
  };

  const markReady = async (artifactId: string): Promise<void> => {
    const sidecar = await readSidecar(artifactId);
    if (!sidecar) {
      throw new Error(
        `markReady: no sidecar for artifactId ${artifactId} (was reserveUpload called?)`,
      );
    }
    const next: CachedMeta = {
      ext: sidecar.ext,
      ready: true,
      kind: sidecar.kind ?? "video",
      relatedTo: sidecar.relatedTo,
      checksum: sidecar.checksum,
    };
    if (sidecar.status === "ready") {
      // Idempotent: already ready, just keep the cache consistent.
      cacheSet(artifactId, next);
      return;
    }
    await writeSidecar(artifactId, { ...sidecar, status: "ready" });
    cacheSet(artifactId, next);
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
    // Delete the finalized object, the @tus/s3-store `.info` sidecar, and our
    // metadata sidecar. DeleteObject is idempotent, so this is safe whether or
    // not the multipart abort above already removed some of them.
    await Promise.all([
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: `${key}.info` }),
      ),
      client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: sidecarKey(artifactId) }),
      ),
    ]);
    return true;
  };

  const readHeader = async (
    artifactId: string,
    n: number,
  ): Promise<Buffer | null> => {
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
    getKind,
    getRelatedTo,
    getChecksum,
    shutdown,
  };
}

/** Collect an AWS SDK response body into a Buffer. */
async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (
    body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray ===
      "function"
  ) {
    const arr = await (
      body as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(arr);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Whether an AWS SDK error represents a missing key/object (404-ish). */
function isNotFound(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.Code === "NoSuchKey" ||
    e?.Code === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}
