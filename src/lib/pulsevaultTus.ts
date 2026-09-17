import { Server, EVENTS } from '@tus/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { isUuid } from './uuid.js';
import { httpError } from './errors.js';
import { finalizeArtifact } from './finalize.js';
import { normalizeUploadMetadata } from './upload-metadata.js';
import type { PulseVaultValidatePayload } from './magic.js';
import { type PulseVaultRequest, type PulseVaultLogger, consoleLogger } from './request.js';
import type { PulseVaultStorage } from '../storage/types.js';
import type { UploadKind } from '../storage/types.js';

/**
 * Context the plugin stashes on each incoming request for the lifetime of a
 * TUS call. Shared with the tus hooks via `AsyncLocalStorage` because
 * `@tus/server` v2 hooks receive a raw `req`/`res`, not the host's request
 * wrapper (Fastify's `FastifyRequest`, Express's `req`, etc.).
 */
export type PulseVaultTusContext = {
  request: PulseVaultRequest;
};

export const pulseVaultTusContext = new AsyncLocalStorage<PulseVaultTusContext>();

export type PulseVaultOnUploadComplete = (
  request: PulseVaultRequest,
  ctx: { artifactId: string; kind: UploadKind; size: number; uploadId: string },
) => void | Promise<void>;

/**
 * Fired at low-frequency, audit-worthy moments — never per chunk — so an
 * operator can wire one hook to get both ops metrics and a compliance audit
 * trail without hand-rolling both from the lower-level hooks.
 */
export type PulseVaultArtifactEvent = {
  phase: 'authorize' | 'complete' | 'reject';
  artifactId: string;
  kind: UploadKind;
  size?: number;
  reason?: string;
};
export type PulseVaultOnArtifactEvent = (event: PulseVaultArtifactEvent) => void | Promise<void>;

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
  /** Fired once the final byte has been written and any `validatePayload` has passed, for every kind. */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /** See `PulseVaultOnArtifactEvent`. */
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  /** Logger for internal diagnostics (cleanup failures, etc). Defaults to `console`. */
  logger?: PulseVaultLogger;
};

/**
 * Shape `@tus/server` recognizes for sending an error response. Alias of
 * `httpError` kept for its established name in this module — both tag
 * `statusCode` and `status_code` so throws originating from either Fastify
 * conventions (camelCase) or the tus convention (snake_case) surface with the
 * right HTTP status.
 */
const tusError = httpError;

// Single parser for `<kind>/<artifactId><ext>` upload ids, shared with the
// always-loaded request-interpretation module (which must stay Node-free —
// this module is the lazily-loaded Node-only side). Re-exported for the core.
import { artifactIdFromUploadId, resolveArtifactIdentity } from './tus-request.js';
export { artifactIdFromUploadId };

/**
 * Extract and normalize the fields `namingFunction` cares about from raw
 * `Upload-Metadata`. Doesn't validate — the caller still checks `artifactId`
 * is a UUID and `filename`'s extension is allowed for `kind`. Normalization
 * (incl. the artifactId alias precedence) is shared with the authorize path
 * via `lib/upload-metadata.ts` so the two can never disagree.
 */
const parseUploadMetadata = normalizeUploadMetadata;

export function createPulsevaultTusServer(options: PulsevaultTusOptions) {
  const {
    storage,
    tusPath,
    maxSize,
    allowedExtensions,
    validatePayload,
    onUploadComplete,
    onArtifactEvent,
    logger = consoleLogger,
  } = options;

  const server = new Server({
    path: tusPath,
    datastore: storage.datastore,
    maxSize,
    namingFunction: async (_req, metadata) => {
      const { artifactId, filename, kind, relatedTo, checksum, name } =
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

      return storage.reserveUpload({ artifactId, filename, ext, kind, relatedTo, checksum, name });
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
      // Both are programming errors, not client states: the host always
      // establishes a store before calling into tus, and every id this server
      // mints parses. Fail loudly — a quiet return here would leave a finished
      // upload unfinalized and never served, with nothing in the logs.
      const store = pulseVaultTusContext.getStore();
      if (!store) throw tusError(500, 'pulsevault: tus request context missing\n');
      const artifactId = artifactIdFromUploadId(upload.id);
      if (!artifactId) throw tusError(500, 'pulsevault: unparseable upload id\n');
      const size = upload.size ?? 0;
      const uploadId = upload.id;

      // `onUploadFinish` runs on the PATCH request, whose context is not the
      // POST's, so kind and checksum come from storage (a cache hit).
      const { kind, checksum } = await resolveArtifactIdentity(storage, artifactId);

      // The completion sequence (validate → markReady → consumer hook →
      // event) lives in `finalize.ts`, shared with the direct-upload complete
      // endpoint so the two ingestion paths can't diverge. Failures map to a
      // tus error here; the direct endpoint maps the same result to JSON.
      const result = await finalizeArtifact(
        { storage, validatePayload, onUploadComplete, onArtifactEvent, logger },
        store.request,
        {
          artifactId,
          kind,
          size,
          uploadId,
          checksum,
          localPath: await resolveLocalPath(storage, artifactId),
        },
      );
      if (!result.ok) {
        throw tusError(result.statusCode, `${result.message}\n`);
      }

      return {};
    },
  });

  hardenAgainstClientAbort(server, logger);

  // TUS termination (DELETE /upload/<id>) only removes what the *datastore* knows about —
  // the bytes and the offset-tracking `.info`/`.json` file. The storage adapter's own
  // artifact metadata (the `.pulsevault` sidecar written by `reserveUpload`) is invisible
  // to @tus/server, so `remove` runs here to tombstone it (the id stays spent; the sidecar
  // stops describing an upload). POST_TERMINATE fires after the 204 is already on the
  // wire, so failures are logged, never thrown.
  server.on(EVENTS.POST_TERMINATE, (_req, _res, id: string) => {
    const artifactId = artifactIdFromUploadId(id);
    if (!artifactId) return;
    void Promise.resolve()
      .then(async () => {
        if (!(await storage.remove?.(artifactId))) {
          logger.info({ artifactId }, 'pulsevault terminated upload had no metadata to sweep');
        }
      })
      .catch((err) => {
        logger.error(
          { err, artifactId },
          'pulsevault failed to clean up terminated upload metadata',
        );
      });
  });

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
      { writeToStore?: (data: NodeJS.ReadableStream, ...rest: unknown[]) => unknown } | undefined;
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
