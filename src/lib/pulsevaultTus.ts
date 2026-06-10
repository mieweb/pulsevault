import { Server } from "@tus/server";
import type { FastifyRequest } from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isUuid } from "./uuid.js";
import type { PulseVaultValidatePayload } from "./magic.js";
import type { PulseVaultStorage } from "../storage/types.js";
import type { UploadKind } from "../storage/types.js";

/**
 * Context the plugin stashes on each incoming Fastify request for the lifetime
 * of a TUS call. Shared with the tus hooks via `AsyncLocalStorage` because
 * `@tus/server` v2 hooks receive a web `Request`, not the FastifyRequest.
 */
export type PulseVaultTusContext = {
  request: FastifyRequest;
  videoid?: string;
  /** Kind resolved during TUS create; available on the same request only. */
  kind?: UploadKind;
};

export const pulseVaultTusContext = new AsyncLocalStorage<PulseVaultTusContext>();

export type PulseVaultOnUploadComplete = (
  request: FastifyRequest,
  ctx: { videoid: string; size: number; uploadId: string },
) => void | Promise<void>;

export type PulsevaultTusOptions = {
  storage: PulseVaultStorage;
  /** Absolute URL path where TUS is mounted, e.g. `/pulsevault/upload`. */
  tusPath: string;
  /** Max total upload size in bytes. Use `Infinity` for no cap. */
  maxSize: number;
  /**
   * Allowed extensions per kind. Must be pre-normalized to lowercase and
   * include the leading dot.
   */
  allowedExtensions: { video: readonly string[]; project: readonly string[] };
  /**
   * Optional payload-validation hook for `kind=video` uploads. Runs after
   * TUS writes the final byte but before `markReady` and `onUploadComplete`.
   * Throwing causes `storage.remove?.(videoid)` and a 4xx (default 422).
   */
  validatePayload?: PulseVaultValidatePayload;
  /**
   * Optional payload-validation hook for `kind=project` uploads. Same
   * lifecycle as `validatePayload` but only fires for project artifacts.
   */
  validateProjectPayload?: PulseVaultValidatePayload;
  /**
   * Fired once the final byte of a `kind=video` upload has been written and
   * any `validatePayload` has passed.
   */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /**
   * Fired once the final byte of a `kind=project` upload has been written
   * and any `validateProjectPayload` has passed.
   */
  onProjectUploadComplete?: PulseVaultOnUploadComplete;
};

/**
 * Shape `@tus/server` recognizes for sending an error response. We tag both
 * `statusCode` and `status_code` so throws originating from either Fastify
 * conventions (camelCase) or the tus convention (snake_case) surface with the
 * right HTTP status.
 */
export function tusError(status: number, body: string): Error {
  return Object.assign(new Error(body), {
    statusCode: status,
    status_code: status,
    body,
  });
}

/** Parse the videoid UUID from a tus upload id of the form `<kind>/<videoid><ext>`. */
function videoidFromUploadId(id: string): string | undefined {
  const [, nameWithExt] = id.split("/");
  if (!nameWithExt) return undefined;
  const ext = path.extname(nameWithExt);
  const candidate = ext ? nameWithExt.slice(0, -ext.length) : nameWithExt;
  return isUuid(candidate) ? candidate : undefined;
}

/**
 * Extract a numeric HTTP status from a thrown error, honoring both
 * `statusCode` (Fastify) and `status_code` (tus).
 */
function statusCodeOf(err: unknown, fallback: number): number {
  const e = err as { statusCode?: unknown; status_code?: unknown };
  if (typeof e?.statusCode === "number") return e.statusCode;
  if (typeof e?.status_code === "number") return e.status_code;
  return fallback;
}

export function createPulsevaultTusServer(options: PulsevaultTusOptions) {
  const {
    storage,
    tusPath,
    maxSize,
    allowedExtensions,
    validatePayload,
    validateProjectPayload,
    onUploadComplete,
    onProjectUploadComplete,
  } = options;

  return new Server({
    path: tusPath,
    datastore: storage.datastore,
    maxSize,
    namingFunction: async (_req, metadata) => {
      // Accept both `videoid` and `projectid` as the UUID key (alias for
      // back-compat with the Pulse mobile client).
      const videoid =
        (metadata?.videoid ?? metadata?.projectid ?? "").trim();
      const filename = (metadata?.filename ?? "").trim();
      // `kind` defaults to `"video"` so existing clients that don't send
      // the field continue to work without any changes.
      const rawKind = (metadata?.kind ?? "").trim().toLowerCase();
      const kind: UploadKind = rawKind === "project" ? "project" : "video";

      if (!isUuid(videoid)) {
        throw tusError(
          400,
          "Upload-Metadata must include a valid `videoid` (or `projectid`) UUID.\n",
        );
      }

      const ext = path.extname(filename).toLowerCase();
      const allowed = allowedExtensions[kind];
      if (!ext || !allowed.includes(ext)) {
        throw tusError(
          400,
          `Upload-Metadata \`filename\` for kind="${kind}" must end with one of: ${allowed.join(", ")}\n`,
        );
      }

      // Store kind in the AsyncLocalStorage context so the authorize hook
      // (already running) and onUploadFinish (same-request uploads) can
      // read it without a storage round-trip.
      const store = pulseVaultTusContext.getStore();
      if (store) {
        store.kind = kind;
      }

      return storage.reserveUpload({ videoid, filename, ext, kind });
    },
    generateUrl(_req, { proto, host, path: tusBasePath, id }) {
      const encoded = Buffer.from(id, "utf8").toString("base64url");
      return `${proto}://${host}${tusBasePath}/${encoded}`;
    },
    getFileIdFromRequest(_req, lastPath) {
      if (!lastPath) {
        return;
      }
      return Buffer.from(lastPath, "base64url").toString("utf8");
    },
    onUploadFinish: async (_req, upload) => {
      // Completion sequence: validate → markReady → consumer hook. Each step
      // gates the next; failure anywhere short-circuits with a tus error
      // (and cleans up disk state for validation failures specifically).
      const store = pulseVaultTusContext.getStore();
      if (!store) {
        // Should not happen — the Fastify layer always establishes a store
        // before calling into tus. Bail quietly rather than crash.
        return {};
      }
      const videoid = videoidFromUploadId(upload.id);
      if (!videoid) {
        return {};
      }
      const size = upload.size ?? 0;
      const uploadId = upload.id;

      // Resolve the kind: prefer the context value (set during the same
      // request's namingFunction for single-request uploads), fall back to
      // a storage lookup (cheap in-memory cache hit for chunked uploads).
      const kind: UploadKind = store.kind ?? (await resolveKind(storage, videoid));

      // Pick the right validate and complete hooks based on kind.
      const effectiveValidate = kind === "project" ? validateProjectPayload : validatePayload;
      const effectiveComplete = kind === "project" ? onProjectUploadComplete : onUploadComplete;

      // 1. Validate payload (magic bytes, virus scan, etc.). If this throws
      //    we wipe the bytes from storage — the client gets a 4xx, the
      //    sidecar is gone, and they can safely retry with a corrected file.
      if (effectiveValidate) {
        try {
          await effectiveValidate(store.request, {
            videoid,
            size,
            uploadId,
            localPath: await resolveLocalPath(storage, videoid),
          });
        } catch (err) {
          const status = statusCodeOf(err, 422);
          const message =
            err instanceof Error ? err.message : "Payload validation failed";
          try {
            await storage.remove?.(videoid);
          } catch (rmErr) {
            store.request.log.error(
              { err: rmErr, videoid },
              "pulsevault failed to remove rejected upload",
            );
          }
          throw tusError(status, `${message}\n`);
        }
      }

      // 2. Flip the sidecar to "ready" so `resolve` will serve the bytes.
      //    Done *before* the consumer hook so a downstream service that
      //    reacts to `onUploadComplete` can immediately GET the video.
      try {
        await storage.markReady?.(videoid);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "markReady failed";
        throw tusError(500, `${message}\n`);
      }

      // 3. Consumer hook — business logic (DB writes, queue jobs).
      if (effectiveComplete) {
        try {
          await effectiveComplete(store.request, { videoid, size, uploadId });
        } catch (err) {
          // Propagate as a tus error so the client sees a non-2xx and can
          // distinguish "bytes stored but completion hook failed" from
          // success. The video is marked ready at this point — consumers
          // who want "all-or-nothing" should `storage.remove` before
          // throwing.
          const message =
            err instanceof Error ? err.message : "onUploadComplete failed";
          throw tusError(500, `${message}\n`);
        }
      }

      return {};
    },
  });
}

/**
 * Resolve the artifact kind from storage for a known videoid. Used by
 * `onUploadFinish` for chunked uploads where the kind is not in the current
 * request's context. Defaults to `"video"` for adapters that don't implement
 * `getKind` or when the videoid is not found.
 */
async function resolveKind(
  storage: PulseVaultStorage,
  videoid: string,
): Promise<UploadKind> {
  const candidate = (storage as { getKind?: unknown }).getKind;
  if (typeof candidate !== "function") return "video";
  const result = await (candidate as (id: string) => Promise<UploadKind | null>)(videoid);
  return result ?? "video";
}

/**
 * If the adapter exposes `getLocalPath` (the built-in local adapter does),
 * resolve the videoid to an absolute disk path for `validatePayload`. For
 * other adapters, returns `null` and the validator is expected to fetch
 * bytes through whatever API it knows about.
 */
async function resolveLocalPath(
  storage: PulseVaultStorage,
  videoid: string,
): Promise<string | null> {
  const candidate = (storage as { getLocalPath?: unknown }).getLocalPath;
  if (typeof candidate !== "function") return null;
  const result = await (candidate as (id: string) => Promise<string | null>)(
    videoid,
  );
  return typeof result === "string" ? result : null;
}
