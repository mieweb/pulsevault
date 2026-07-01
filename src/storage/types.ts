import type { DataStore } from "@tus/server";

/**
 * How the GET route should serve a resolved artifact. Stream means
 * `@fastify/send` reads directly from a local path; Redirect issues an HTTP
 * 3xx to a URL the adapter produced (e.g. a pre-signed object storage URL).
 */
export type PulseVaultResolution =
  | {
      kind: "stream";
      /** Root directory `@fastify/send` should jail to. */
      root: string;
      /** Filename relative to `root`. */
      filename: string;
      /**
       * Explicit `Content-Type` to set on the response. When present the GET
       * route overrides whatever `@fastify/send` infers from the extension.
       * Populated by adapters for non-standard extensions (e.g. `.pulse`).
       */
      contentType?: string;
    }
  | {
      kind: "redirect";
      url: string;
      /** Defaults to 302. */
      statusCode?: number;
    };

export type UploadKind = "video" | "project" | "captions";

export type ReserveUploadParams = {
  /** UUID from `Upload-Metadata.artifactId` (or the `videoid`/`projectid` legacy aliases). */
  artifactId: string;
  /** Raw filename from `Upload-Metadata.filename`. */
  filename: string;
  /** Lowercase extension including the leading dot, validated upstream. */
  ext: string;
  /** Artifact kind derived from `Upload-Metadata.kind`. Defaults to `"video"`. */
  kind: UploadKind;
  /**
   * Optional UUID of another artifact this one belongs to, from
   * `Upload-Metadata.relatedTo`. Lets a single capability token scoped to one
   * "session" artifact (e.g. a video) authorize related artifacts uploaded in
   * the same session (its captions, or — under `uploadUnit: "beat"` — each
   * beat plus the pulse manifest) without minting a token per artifact.
   * Purely bookkeeping for the storage layer; `pulsevault` does not enforce
   * any relationship semantics beyond storing and returning it.
   */
  relatedTo?: string;
  /**
   * Optional client-supplied integrity digest from `Upload-Metadata.checksum`
   * (`<algorithm>:<hex>`), persisted so `createChecksumValidator` can read it
   * at completion time even when completion happens on a different request
   * than creation (chunked uploads, or even a single-PATCH upload sent as
   * two separate HTTP requests).
   */
  checksum?: string;
};

/**
 * Storage backend contract. Keep the surface small: one write hook, one read
 * hook, plus optional one-time init. Adapters own their own configuration.
 */
export interface PulseVaultStorage {
  /** TUS datastore used for resumable uploads. */
  readonly datastore: DataStore;

  /** One-time setup. Called once during plugin boot. */
  initialize?(): Promise<void>;

  /**
   * One-time teardown. Called from Fastify's `onClose` hook so adapters can
   * flush state, close connections, etc. The local adapter has nothing to
   * release, so it omits this method.
   */
  shutdown?(): Promise<void>;

  /**
   * Called by TUS's `namingFunction` after core validation. Returns the file
   * id (the string the datastore will use as its key/path). Adapters may also
   * perform per-upload bookkeeping here (e.g. creating local mount dirs).
   */
  reserveUpload(params: ReserveUploadParams): Promise<string>;

  /**
   * Called by the GET route. Returns how to serve the artifact, or `null` if
   * the artifactId is unknown *or* the upload is still in progress — adapters
   * that implement `markReady` should only return non-null once the bytes
   * have been promoted to "ready."
   */
  resolve(artifactId: string): Promise<PulseVaultResolution | null>;

  /**
   * Mark an upload as fully written and safe to serve. Called by the plugin
   * after the final byte lands and any `validatePayload` + `onUploadComplete`
   * hooks succeed. Adapters that do not distinguish uploading from ready
   * (e.g. S3 multipart, which only materializes on CompleteMultipartUpload)
   * may omit this method — `resolve` will be trusted to only return finished
   * uploads in that case.
   */
  markReady?(artifactId: string): Promise<void>;

  /**
   * Delete all storage associated with an artifactId. Returns `true` if
   * something was removed, `false` if the artifactId was already absent.
   * Called both from the `DELETE /artifacts/:artifactId` route and from the
   * plugin's cleanup path when `validatePayload` rejects a completed upload.
   */
  remove?(artifactId: string): Promise<boolean>;

  /**
   * Return the artifact kind for a known artifactId, or `null` if the
   * artifactId is not found. Used by the generic artifact route to resolve
   * which kind to serve without it being encoded in the URL.
   */
  getKind?(artifactId: string): Promise<UploadKind | null>;

  /**
   * Return the `relatedTo` artifact id stored at `reserveUpload` time, or
   * `null` if the artifactId is unknown or has no relation recorded. Used by
   * `createCapabilityAuthorize` to authorize an artifact against a token
   * scoped to the session it belongs to, not just its own id.
   */
  getRelatedTo?(artifactId: string): Promise<string | null>;

  /**
   * Return the `checksum` metadata stored at `reserveUpload` time, or `null`
   * if the artifactId is unknown or no checksum was supplied. Used by
   * `createChecksumValidator`/`createS3ChecksumValidator` at completion time.
   */
  getChecksum?(artifactId: string): Promise<string | null>;
}
