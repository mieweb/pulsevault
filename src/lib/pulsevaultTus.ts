import { type DataStore, ERRORS, Server } from '@tus/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { isUuid } from './uuid.js';
import { normalizeAppVersion } from './protocol.js';
import { statusCodeOf } from './errors.js';
import type { PulseVaultValidatePayload } from './magic.js';
import { type PulseVaultRequest, type PulseVaultLogger, consoleLogger } from './request.js';
import type { PulseVaultStorage } from '../storage/types.js';
import type { UploadKind } from '../storage/types.js';
import { parseUploadKind } from '../storage/types.js';
import type { CompletionRunner, PulseVaultOnArtifactEvent } from './completion.js';

export type {
  PulseVaultOnUploadComplete,
  PulseVaultUploadCompleteContext,
  PulseVaultArtifactEvent,
  PulseVaultOnArtifactEvent,
} from './completion.js';

/**
 * Context the plugin stashes on each incoming request for the lifetime of a
 * TUS call. Shared with the tus hooks via `AsyncLocalStorage` because
 * `@tus/server` v2 hooks receive a raw `req`/`res`, not the host's request
 * wrapper (Fastify's `FastifyRequest`, Express's `req`, etc.).
 */
export type PulseVaultTusContext = {
  request: PulseVaultRequest;
  artifactId?: string;
  /** Kind resolved during TUS create; available on the same request only. */
  kind?: UploadKind;
  /** `relatedTo` resolved during TUS create; available on the same request only. */
  relatedTo?: string;
  /** Raw `checksum` metadata value (`<algorithm>:<hex>`), if the client sent one. */
  checksum?: string;
  /** The host data `authorize` returned for this create (the capability token's `context`), stored with the artifact. */
  context?: unknown;
};

export const pulseVaultTusContext = new AsyncLocalStorage<PulseVaultTusContext>();

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
  allowedExtensions: {
    video: readonly string[];
    project: readonly string[];
    captions: readonly string[];
    thumbnail: readonly string[];
  };
  /**
   * Optional payload-validation hook, called for every kind with `ctx.kind`
   * set accordingly. Runs after TUS writes the final byte but before
   * `markReady` and `onUploadComplete`. Throwing causes
   * `storage.remove?.(artifactId)` and a 4xx (default 422).
   */
  validatePayload?: PulseVaultValidatePayload;
  /** Runs the host's `onUploadComplete` (and the web-ready queue) once the final byte has been written and any `validatePayload` has passed. */
  completion: CompletionRunner;
  /** See `PulseVaultOnArtifactEvent`. */
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  /**
   * Hold every create to the shape of a pulse: a video with no `relatedTo`; a thumbnail, beat
   * manifest or captions under its own id, `relatedTo` another. See the core's `pulseShape`.
   */
  pulseShape: boolean;
  /**
   * Let a create take over an unfinished upload of the same artifactId, kind and `relatedTo`
   * once it has been idle this long (so the same token authorizes both), instead of a `409`
   * until `retention` runs. See the core's `reclaim`.
   */
  reclaim: { idleSeconds: number } | false;
  /** With the core's `lockWhenReady`: whether a TUS `DELETE` of this artifact must be refused. */
  isLocked?: (artifactId: string) => Promise<boolean>;
  /** Logger for internal diagnostics (cleanup failures, etc). Defaults to `console`. */
  logger?: PulseVaultLogger;
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

/**
 * The datastore tus drives, with termination routed through PulseVault's own removal. A TUS
 * DELETE (the client cancelling, or discarding what a failed run created) takes tus's per-upload
 * lock and calls the datastore's `remove` — which on its own drops only tus's bytes and offset
 * record: PulseVault's sidecar stays, so the artifactId 409s on every later create, and on S3 a
 * finished upload isn't removed at all (aborting its completed multipart upload fails first).
 * So both run: the datastore's removal, then `storage.remove`, which deletes the whole artifact,
 * in flight or finished. It 404s only when neither found anything to remove.
 */
function withArtifactRemoval(
  storage: PulseVaultStorage,
  onRemoved?: (artifactId: string, kind: UploadKind) => Promise<void>,
  isLocked?: (artifactId: string) => Promise<boolean>,
): DataStore {
  const { datastore } = storage;
  if (!storage.remove && !isLocked) return datastore;
  const removeArtifact = storage.remove?.bind(storage);
  return new Proxy(datastore, {
    get(target, prop) {
      if (prop === 'remove') {
        return async (id: string): Promise<void> => {
          const artifactId = artifactIdFromUploadId(id);
          // `lockWhenReady`, checked here because tus's DELETE handler holds the per-upload lock
          // around this call: a DELETE racing the final PATCH of the same upload waits for it
          // and then sees the artifact finished.
          if (artifactId && isLocked && (await isLocked(artifactId))) {
            throw tusError(403, 'A finished artifact is locked\n');
          }
          const kind = artifactId ? await resolveKind(storage, artifactId) : undefined;
          // The datastore's own removal first — the upload's bytes and tus's records, which a
          // custom adapter's `remove` may not know about — then the artifact's.
          let uploadRemoved = false;
          let uploadError: unknown;
          try {
            await target.remove(id);
            uploadRemoved = true;
          } catch (err) {
            // Not there, or (S3) already completed: `storage.remove` below still removes it.
            uploadError = err;
          }
          const artifactRemoved = artifactId && removeArtifact ? await removeArtifact(artifactId) : false;
          if (artifactId && kind && artifactRemoved) {
            await onRemoved?.(artifactId, kind);
          }
          if (!uploadRemoved && !artifactRemoved) throw uploadError;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Parse the artifactId UUID from a tus upload id of the form `<kind>/<artifactId><ext>`. */
export function artifactIdFromUploadId(id: string): string | undefined {
  const [, nameWithExt] = id.split('/');
  if (!nameWithExt) return undefined;
  const ext = path.extname(nameWithExt);
  const candidate = ext ? nameWithExt.slice(0, -ext.length) : nameWithExt;
  return isUuid(candidate) ? candidate : undefined;
}

/**
 * Defensive upper bound on the stored display `name`. The header is base64 and
 * comma-joined with the other metadata; a runaway value would bloat every
 * request and every sidecar. 512 chars is far more than any real title and
 * still leaves generous headroom under typical proxy header limits. The client
 * should cap first; this is belt-and-suspenders so the server never trusts it.
 */
const MAX_ARTIFACT_NAME_LENGTH = 512;

/**
 * Trim a display name and hard-cap its length so a hostile or buggy client can't bloat the
 * sidecar; an all-whitespace/empty value is dropped. Capped by code point (Array.from iterates
 * code points) rather than by `.slice()`'s UTF-16 units, so a title truncated at the boundary
 * can't be left with a split surrogate pair (a half-emoji / lone surrogate).
 */
export function normalizeArtifactName(value: string | null | undefined): string | undefined {
  return (
    Array.from((value ?? '').trim())
      .slice(0, MAX_ARTIFACT_NAME_LENGTH)
      .join('') || undefined
  );
}

type ParsedUploadMetadata = {
  artifactId: string;
  filename: string;
  kind: UploadKind;
  relatedTo?: string;
  checksum?: string;
  name?: string;
  appVersion?: string;
};

/**
 * Extract and normalize the fields `namingFunction` cares about from raw
 * `Upload-Metadata`. Doesn't validate — the caller still checks `artifactId`
 * is a UUID and `filename`'s extension is allowed for `kind`.
 */
function parseUploadMetadata(
  metadata: Record<string, string | null> | undefined,
): ParsedUploadMetadata {
  // Accept `artifactId` plus the legacy `videoid`/`projectid` aliases for
  // back-compat with pre-`artifactId` clients.
  const artifactId = (
    metadata?.artifactId ??
    metadata?.videoid ??
    metadata?.projectid ??
    ''
  ).trim();
  const filename = (metadata?.filename ?? '').trim();
  // `kind` defaults to `"video"` so existing clients that don't send the field continue to work unchanged.
  const kind = parseUploadKind(metadata?.kind);
  const rawRelatedTo = (metadata?.relatedTo ?? '').trim();
  const relatedTo = isUuid(rawRelatedTo) ? rawRelatedTo : undefined;
  const checksum = (metadata?.checksum ?? '').trim() || undefined;
  // Free-form display title, trimmed and capped (see `normalizeArtifactName`).
  const name = normalizeArtifactName(metadata?.name);

  // The uploading app's version (PROTOCOL.md §4), trimmed and capped like `name`.
  const appVersion = normalizeAppVersion(metadata?.appVersion);

  return { artifactId, filename, kind, relatedTo, checksum, name, appVersion };
}

export function createPulsevaultTusServer(options: PulsevaultTusOptions) {
  const {
    storage,
    tusPath,
    maxSize,
    allowedExtensions,
    validatePayload,
    completion,
    onArtifactEvent,
    pulseShape,
    reclaim,
    isLocked,
    logger = consoleLogger,
  } = options;

  // Creates for one artifactId run one at a time in this process, so two creates that both
  // find the same idle upload can't both remove it and the second clobber the first's
  // replacement. (Across instances the local adapter's exclusive sidecar write still decides.)
  const creating = new Map<string, Promise<unknown>>();
  const serializeCreate = async <T>(artifactId: string, work: () => Promise<T>): Promise<T> => {
    const previous = creating.get(artifactId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    creating.set(artifactId, run);
    try {
      return await run;
    } finally {
      if (creating.get(artifactId) === run) creating.delete(artifactId);
    }
  };

  const server = new Server({
    path: tusPath,
    datastore: withArtifactRemoval(
      storage,
      async (artifactId, kind) => {
        await onArtifactEvent?.({ phase: 'remove', artifactId, kind, reason: 'deleted' });
      },
      isLocked,
    ),
    maxSize,
    // tus refuses an upload over `maxSize` with "Maximum size exceeded" at create (the constant)
    // or mid-stream (`StreamLimiter`'s own error, same status and body), and one whose length was
    // deferred with "upload's size exceeded" when a chunk would take it past `maxSize`. Say it in
    // the words a host can show the person who picked the file. (That second error also means a
    // chunk past the length the client declared — a client bug, left as tus words it.)
    onResponseError: async (req, err) => {
      const { status_code, body } = err as { status_code?: number; body?: string };
      const tooLarge = { status_code: 413, body: `That file is larger than ${formatBytes(maxSize)}.\n` };
      if (status_code === ERRORS.ERR_MAX_SIZE_EXCEEDED.status_code && body === ERRORS.ERR_MAX_SIZE_EXCEEDED.body) {
        return tooLarge;
      }
      if (status_code === ERRORS.ERR_SIZE_EXCEEDED.status_code && body === ERRORS.ERR_SIZE_EXCEEDED.body) {
        const encoded = new URL(req.url).pathname.split('/').pop();
        const upload = encoded
          ? await storage.datastore.getUpload(Buffer.from(encoded, 'base64url').toString('utf8')).catch(() => null)
          : null;
        if (upload?.sizeIsDeferred) return tooLarge;
      }
      return undefined;
    },
    namingFunction: async (_req, metadata) => {
      const { artifactId, filename, kind, relatedTo, checksum, name, appVersion } =
        parseUploadMetadata(metadata);

      if (!isUuid(artifactId)) {
        throw tusError(400, 'Upload-Metadata must include a valid `artifactId` UUID.\n');
      }

      const ext = path.extname(filename).toLowerCase();
      const allowed = allowedExtensions[kind];
      if (!ext || !allowed.includes(ext)) {
        throw tusError(
          400,
          `Upload-Metadata \`filename\` for kind="${kind}" must end with one of: ${allowed.join(', ')}\n`,
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

      // The shape of a pulse (PROTOCOL.md §8): the video is the anchor, created under the id the
      // pairing link named, with no `relatedTo`; its thumbnail, beat manifest and captions are
      // created under ids of their own, `relatedTo` the video. `createCapabilityAuthorize` also
      // ties the ids to the token; this structural check holds for any `authorize`.
      if (pulseShape) {
        if (kind === 'video' && relatedTo !== undefined) {
          throw tusError(403, 'A video is uploaded under its own artifactId, with no `relatedTo`.\n');
        }
        if (kind !== 'video' && (relatedTo === undefined || relatedTo === artifactId)) {
          throw tusError(
            403,
            `A ${kind} is uploaded under its own artifactId, \`relatedTo\` the video it belongs to.\n`,
          );
        }
      }

      const params = {
        artifactId,
        filename,
        ext,
        kind,
        relatedTo,
        checksum,
        name,
        appVersion,
        ...(store?.context !== undefined ? { context: store.context } : {}),
      };
      return serializeCreate(artifactId, async () => {
      try {
        return await storage.reserveUpload(params);
      } catch (err) {
        if (statusCodeOf(err, 500) !== 409 || !reclaim) throw err;
        // The id is taken. If it's an unfinished upload of the same kind and `relatedTo` — so
        // the token that authorized this create authorized that one — that has been idle long
        // enough to be abandoned (an app killed mid-upload sends no TUS DELETE; the person
        // scanned the same link again), take it over instead of answering 409 until `retention`.
        const existing = await storage.describeArtifact?.(artifactId);
        // An adapter that can't say when the upload last moved (`updatedAt` 0) never reclaims.
        const idleMs = existing && existing.updatedAt > 0 ? Date.now() - existing.updatedAt : -1;
        if (
          !existing ||
          existing.ready ||
          existing.kind !== kind ||
          existing.relatedTo !== relatedTo ||
          !(idleMs >= reclaim.idleSeconds * 1000)
        ) {
          throw err;
        }
        if (!(await storage.remove?.(artifactId))) throw err;
        logger.info({ artifactId, kind, idleMs }, 'pulsevault reclaimed an idle unfinished upload');
        await onArtifactEvent?.({ phase: 'remove', artifactId, kind, reason: 'reclaimed' });
        return storage.reserveUpload(params);
      }
      });
    },
    // Relative Location (RFC 7231 §7.1.2) so the upload URL is correct behind
    // any TLS-terminating proxy without trusting spoofable X-Forwarded-*
    // headers; clients resolve it against the request URL they already used.
    generateUrl(_req, { path: tusBasePath, id }) {
      const encoded = Buffer.from(id, 'utf8').toString('base64url');
      return `${tusBasePath}/${encoded}`;
    },
    getFileIdFromRequest(_req, lastPath) {
      if (!lastPath) {
        return;
      }
      return Buffer.from(lastPath, 'base64url').toString('utf8');
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
      // Reported on the complete/reject events so an operator can see which app build sent it.
      const appVersion = normalizeAppVersion(upload.metadata?.appVersion);

      // A final PATCH the client retried after losing the 204 finishes an upload that already
      // finished. Its bytes were validated then, and may since have been rewritten for the web
      // (so a checksum check would fail and remove a delivered video): only the completion
      // bookkeeping runs again, which itself skips a hook that was recorded.
      const finished = (await storage.describeArtifact?.(artifactId))?.ready ?? false;
      if (finished) {
        try {
          await completion.complete(store.request, { artifactId, kind: await resolveKind(storage, artifactId), size, uploadId });
        } catch (err) {
          logger.error({ err, artifactId }, 'pulsevault onUploadComplete failed');
          throw tusError(500, 'Upload completion hook failed\n');
        }
        return {};
      }

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
          const message = err instanceof Error ? err.message : 'Payload validation failed';
          try {
            await storage.remove?.(artifactId);
          } catch (rmErr) {
            logger.error({ err: rmErr, artifactId }, 'pulsevault failed to remove rejected upload');
          }
          await onArtifactEvent?.({
            phase: 'reject',
            artifactId,
            kind,
            size,
            reason: message,
            ...(appVersion ? { appVersion } : {}),
          });
          // 4xx rejection reasons are the client's business (e.g. "Checksum
          // mismatch: …"); 5xx means *our* side broke — log the real error and
          // return a generic body so internals (adapter wiring, stack detail)
          // never reach the client.
          if (status >= 500) {
            logger.error({ err, artifactId, kind }, 'pulsevault payload validation errored');
            throw tusError(status, 'Payload validation failed\n');
          }
          throw tusError(status, `${message}\n`);
        }
      }

      // 2. Flip the sidecar to "ready" so `resolve` will serve the bytes.
      //    Done *before* the consumer hook so a downstream service that
      //    reacts to `onUploadComplete` can immediately GET the artifact.
      try {
        await storage.markReady?.(artifactId);
      } catch (err) {
        // Internal failure — log the real error server-side, return a generic
        // body (a storage error message can leak paths/config to the client).
        logger.error({ err, artifactId, kind }, 'pulsevault markReady failed');
        throw tusError(500, 'Upload finalization failed\n');
      }

      // 3. Consumer hook — business logic (DB writes, queue jobs) — through the completion
      //    runner, which records that the hook finished (so one that didn't is replayed) and
      //    runs the background web-ready conversion.
      try {
        await completion.complete(store.request, { artifactId, kind, size, uploadId });
      } catch (err) {
        // Propagate as a tus error so the client sees a non-2xx and can
        // distinguish "bytes stored but completion hook failed" from
        // success. The artifact is marked ready at this point, and the
        // completion is replayed later — consumers who want "all-or-nothing"
        // should `storage.remove` before throwing.
        // The real error (often a consumer DB failure whose message can leak
        // schema/infra detail) stays in the server log, not the client body.
        logger.error({ err, artifactId, kind }, 'pulsevault onUploadComplete failed');
        throw tusError(500, 'Upload completion hook failed\n');
      }

      await onArtifactEvent?.({
        phase: 'complete',
        artifactId,
        kind,
        size,
        ...(appVersion ? { appVersion } : {}),
      });

      return {};
    },
  });

  hardenAgainstClientAbort(server, logger);

  return server;
}

/**
 * Stops a dropped upload connection from crashing the whole server process.
 *
 * @tus/server@2's `BaseHandler.writeToStore` (used by both the PATCH handler and the POST handler's
 * creation-with-upload path) pipes the incoming body (`Readable.fromWeb(req.body)`) into an internal
 * proxy via `data.pipe(proxy)` and attaches an 'error' handler to the *proxy* — but never to `data`
 * itself. `.pipe()` doesn't forward source errors, so when the client drops the connection
 * mid-transfer (a mobile app killed during an upload, a network reset, a cancelled transfer) `data`
 * emits an 'error' ('aborted' / ECONNRESET) with no listener. An unhandled stream 'error' is fatal
 * to Node: the process crashes, taking down every other in-flight upload (observed as the server
 * dying and subsequent requests 502-ing).
 *
 * We wrap each body-carrying handler's `writeToStore` to attach a no-op 'error' listener to `data`
 * before delegating. The abort then unwinds normally — the proxy/pipeline still rejects the write
 * and the stored offset simply doesn't advance, so the client resumes from the last persisted byte
 * on its next PATCH. Defensive: it no-ops if a future @tus version renames/fixes this, and the
 * extra listener is harmless if they add their own. (Long-term fix: upgrade @tus/server once it
 * handles the source-stream error itself.)
 */
function hardenAgainstClientAbort(server: Server, logger: PulseVaultLogger): void {
  const handlers = (server as unknown as { handlers?: Record<string, unknown> }).handlers ?? {};
  for (const method of ['PATCH', 'POST'] as const) {
    const handler = handlers[method] as
      | { writeToStore?: (data: NodeJS.ReadableStream, ...rest: unknown[]) => unknown }
      | undefined;
    if (!handler || typeof handler.writeToStore !== 'function') {
      logger.info(
        { method },
        'pulsevault: could not harden handler against client abort (API changed?)',
      );
      continue;
    }
    const original = handler.writeToStore.bind(handler);
    handler.writeToStore = (data, ...rest) => {
      if (data && typeof data.on === 'function') {
        data.on('error', (err: unknown) => {
          // Debug (falling back to info for loggers without it): a client dropping mid-upload is
          // an expected, per-request event on flaky mobile networks — not something to page over.
          const obj = { err: err instanceof Error ? err.message : String(err), method };
          const msg = 'pulsevault: upload body stream aborted (client disconnected mid-transfer)';
          if (logger.debug) logger.debug(obj, msg);
          else logger.info(obj, msg);
        });
      }
      return original(data, ...rest);
    };
  }
}

/** `524288000` → "500 MB", `1610612736` → "1.5 GB" (binary units, as hosts usually set them). */
function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * Resolve the artifact kind from storage for a known artifactId. Used by
 * `onUploadFinish` for chunked uploads where the kind is not in the current
 * request's context. Defaults to `"video"` for adapters that don't implement
 * `getKind` or when the artifactId is not found.
 */
async function resolveKind(storage: PulseVaultStorage, artifactId: string): Promise<UploadKind> {
  const result = await storage.getKind?.(artifactId);
  return result ?? 'video';
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
  const result = await storage.getChecksum?.(artifactId);
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
  const adapter = storage as { getLocalPath?: (artifactId: string) => Promise<string | null> };
  const result = await adapter.getLocalPath?.(artifactId);
  return typeof result === 'string' ? result : null;
}
