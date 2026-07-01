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
  artifactId?: string;
  /** Kind resolved during TUS create; available on the same request only. */
  kind?: UploadKind;
  /** `relatedTo` resolved during TUS create; available on the same request only. */
  relatedTo?: string;
  /** Raw `checksum` metadata value (`<algorithm>:<hex>`), if the client sent one. */
  checksum?: string;
};

export const pulseVaultTusContext = new AsyncLocalStorage<PulseVaultTusContext>();

export type PulseVaultOnUploadComplete = (
  request: FastifyRequest,
  ctx: { artifactId: string; kind: UploadKind; size: number; uploadId: string },
) => void | Promise<void>;

/**
 * Fired at low-frequency, audit-worthy moments — never per chunk — so an
 * operator can wire one hook to get both ops metrics and a compliance audit
 * trail without hand-rolling both from the lower-level hooks.
 */
export type PulseVaultArtifactEvent = {
  phase: "authorize" | "complete" | "reject";
  artifactId: string;
  kind: UploadKind;
  size?: number;
  reason?: string;
};
export type PulseVaultOnArtifactEvent = (
  event: PulseVaultArtifactEvent,
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
  allowedExtensions: { video: readonly string[]; project: readonly string[]; captions: readonly string[] };
  /**
   * Optional payload-validation hook, called for every kind with `ctx.kind`
   * set accordingly. Runs after TUS writes the final byte but before
   * `markReady` and `onUploadComplete`. Throwing causes
   * `storage.remove?.(artifactId)` and a 4xx (default 422).
   */
  validatePayload?: PulseVaultValidatePayload;
  /** Fired once the final byte has been written and any `validatePayload` has passed, for every kind. */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /** See `PulseVaultOnArtifactEvent`. */
  onArtifactEvent?: PulseVaultOnArtifactEvent;
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

/** Parse the artifactId UUID from a tus upload id of the form `<kind>/<artifactId><ext>`. */
function artifactIdFromUploadId(id: string): string | undefined {
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
    onUploadComplete,
    onArtifactEvent,
  } = options;

  return new Server({
    path: tusPath,
    datastore: storage.datastore,
    maxSize,
    namingFunction: async (_req, metadata) => {
      // Accept `artifactId` plus the legacy `videoid`/`projectid` aliases for
      // back-compat with pre-`artifactId` clients.
      const artifactId = (
        metadata?.artifactId ?? metadata?.videoid ?? metadata?.projectid ?? ""
      ).trim();
      const filename = (metadata?.filename ?? "").trim();
      // `kind` defaults to `"video"` so existing clients that don't send
      // the field continue to work without any changes.
      const rawKind = (metadata?.kind ?? "").trim().toLowerCase();
      const kind: UploadKind =
        rawKind === "project" ? "project" : rawKind === "captions" ? "captions" : "video";
      const rawRelatedTo = (metadata?.relatedTo ?? "").trim();
      const relatedTo = isUuid(rawRelatedTo) ? rawRelatedTo : undefined;
      const checksum = (metadata?.checksum ?? "").trim() || undefined;

      if (!isUuid(artifactId)) {
        throw tusError(
          400,
          "Upload-Metadata must include a valid `artifactId` UUID.\n",
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

      // Store kind/relatedTo/checksum in the AsyncLocalStorage context so the
      // authorize hook (already running) and onUploadFinish (same-request
      // uploads) can read them without a storage round-trip.
      const store = pulseVaultTusContext.getStore();
      if (store) {
        store.kind = kind;
        store.relatedTo = relatedTo;
        store.checksum = checksum;
      }

      return storage.reserveUpload({ artifactId, filename, ext, kind, relatedTo, checksum });
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
      const artifactId = artifactIdFromUploadId(upload.id);
      if (!artifactId) {
        return {};
      }
      const size = upload.size ?? 0;
      const uploadId = upload.id;

      // Resolve kind/checksum: prefer the context value (set during the same
      // request's namingFunction for single-request uploads), fall back to a
      // storage lookup (cheap in-memory cache hit) for chunked uploads, or —
      // just as commonly — a single-PATCH upload sent as two separate HTTP
      // requests (create, then patch), where `onUploadFinish` runs on the
      // PATCH request's own fresh context, not the one `namingFunction`
      // populated during the earlier POST.
      const kind: UploadKind = store.kind ?? (await resolveKind(storage, artifactId));
      const checksum = store.checksum ?? (await resolveChecksum(storage, artifactId));

      // 1. Validate payload (magic bytes, checksum, virus scan, etc.). If
      //    this throws we wipe the bytes from storage — the client gets a
      //    4xx, the sidecar is gone, and they can safely retry with a
      //    corrected file. The same hook runs for every kind; consumers that
      //    want kind-specific behavior branch on `ctx.kind` themselves.
      if (validatePayload) {
        try {
          await validatePayload(store.request, {
            artifactId,
            size,
            uploadId,
            localPath: await resolveLocalPath(storage, artifactId),
            ...(checksum ? { checksum } : {}),
            kind,
          });
        } catch (err) {
          const status = statusCodeOf(err, 422);
          const message =
            err instanceof Error ? err.message : "Payload validation failed";
          try {
            await storage.remove?.(artifactId);
          } catch (rmErr) {
            store.request.log.error(
              { err: rmErr, artifactId },
              "pulsevault failed to remove rejected upload",
            );
          }
          await onArtifactEvent?.({ phase: "reject", artifactId, kind, size, reason: message });
          throw tusError(status, `${message}\n`);
        }
      }

      // 2. Flip the sidecar to "ready" so `resolve` will serve the bytes.
      //    Done *before* the consumer hook so a downstream service that
      //    reacts to `onUploadComplete` can immediately GET the artifact.
      try {
        await storage.markReady?.(artifactId);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "markReady failed";
        throw tusError(500, `${message}\n`);
      }

      // 3. Consumer hook — business logic (DB writes, queue jobs).
      if (onUploadComplete) {
        try {
          await onUploadComplete(store.request, { artifactId, kind, size, uploadId });
        } catch (err) {
          // Propagate as a tus error so the client sees a non-2xx and can
          // distinguish "bytes stored but completion hook failed" from
          // success. The artifact is marked ready at this point — consumers
          // who want "all-or-nothing" should `storage.remove` before
          // throwing.
          const message =
            err instanceof Error ? err.message : "onUploadComplete failed";
          throw tusError(500, `${message}\n`);
        }
      }

      await onArtifactEvent?.({ phase: "complete", artifactId, kind, size });

      return {};
    },
  });
}

/**
 * Resolve the artifact kind from storage for a known artifactId. Used by
 * `onUploadFinish` for chunked uploads where the kind is not in the current
 * request's context. Defaults to `"video"` for adapters that don't implement
 * `getKind` or when the artifactId is not found.
 */
async function resolveKind(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<UploadKind> {
  const candidate = (storage as { getKind?: unknown }).getKind;
  if (typeof candidate !== "function") return "video";
  const result = await (candidate as (id: string) => Promise<UploadKind | null>)(artifactId);
  return result ?? "video";
}

/**
 * Resolve the `checksum` metadata from storage for a known artifactId. Same
 * rationale as `resolveKind` — `namingFunction`'s in-memory context doesn't
 * survive past the request it ran on, so completion (which may run on a
 * later, separate request) needs a storage-backed fallback.
 */
async function resolveChecksum(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<string | undefined> {
  const candidate = (storage as { getChecksum?: unknown }).getChecksum;
  if (typeof candidate !== "function") return undefined;
  const result = await (candidate as (id: string) => Promise<string | null>)(artifactId);
  return result ?? undefined;
}

/**
 * If the adapter exposes `getLocalPath` (the built-in local adapter does),
 * resolve the artifactId to an absolute disk path for `validatePayload`. For
 * other adapters, returns `null` and the validator is expected to fetch
 * bytes through whatever API it knows about.
 */
async function resolveLocalPath(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<string | null> {
  const candidate = (storage as { getLocalPath?: unknown }).getLocalPath;
  if (typeof candidate !== "function") return null;
  const result = await (candidate as (id: string) => Promise<string | null>)(
    artifactId,
  );
  return typeof result === "string" ? result : null;
}
