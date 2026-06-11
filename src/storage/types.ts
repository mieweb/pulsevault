import type { DataStore } from "@tus/server";

/**
 * How the GET route should serve a resolved video. Stream means `@fastify/send`
 * reads directly from a local path; Redirect issues an HTTP 3xx to a URL the
 * adapter produced (e.g. a pre-signed object storage URL).
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

export type UploadKind = "video" | "project";

export type ReserveUploadParams = {
  /** UUID from `Upload-Metadata.videoid` (or `projectid` alias). */
  videoid: string;
  /** Raw filename from `Upload-Metadata.filename`. */
  filename: string;
  /** Lowercase extension including the leading dot, validated upstream. */
  ext: string;
  /** Artifact kind derived from `Upload-Metadata.kind`. Defaults to `"video"`. */
  kind: UploadKind;
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
   * Called by the GET route. Returns how to serve the video, or `null` if
   * the videoid is unknown *or* the upload is still in progress — adapters
   * that implement `markReady` should only return non-null once the bytes
   * have been promoted to "ready."
   */
  resolve(videoid: string): Promise<PulseVaultResolution | null>;

  /**
   * Mark an upload as fully written and safe to serve. Called by the plugin
   * after the final byte lands and any `validatePayload` + `onUploadComplete`
   * hooks succeed. Adapters that do not distinguish uploading from ready
   * (e.g. S3 multipart, which only materializes on CompleteMultipartUpload)
   * may omit this method — `resolve` will be trusted to only return finished
   * uploads in that case.
   */
  markReady?(videoid: string): Promise<void>;

  /**
   * Delete all storage associated with a videoid. Returns `true` if
   * something was removed, `false` if the videoid was already absent.
   * Called both from the `DELETE /:videoid` route and from the plugin's
   * cleanup path when `validatePayload` rejects a completed upload.
   */
  remove?(videoid: string): Promise<boolean>;

  /**
   * Return the artifact kind for a known videoid, or `null` if the videoid
   * is not found. Used by consumer routes (e.g. `report-issue`) to assert
   * the kind before acting on an upload without a full resolve.
   */
  getKind?(videoid: string): Promise<UploadKind | null>;
}
