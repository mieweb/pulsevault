import type { IncomingMessage, ServerResponse } from 'node:http';
import send from '@fastify/send';
import {
  createPulsevaultTusServer,
  pulseVaultTusContext,
  artifactIdFromUploadId,
  type PulseVaultOnUploadComplete,
  type PulseVaultOnArtifactEvent,
} from './lib/pulsevaultTus.js';
import type { PulseVaultValidatePayload } from './lib/magic.js';
import type { PulseVaultAuthorize } from './lib/authorize.js';
import { httpError, pulseVaultError, statusCodeOf } from './lib/errors.js';
import { isUuid } from './lib/uuid.js';
import {
  type PulseVaultLogger,
  type PulseVaultRequest,
  consoleLogger,
} from './lib/request.js';
import type { PulseVaultStorage, UploadKind } from './storage/types.js';
import { buildCapabilitiesPayload, PROTOCOL_VERSION } from './lib/capabilities.js';
import {
  directUploadCreate,
  directUploadComplete,
  type DirectUploadDeps,
  type DirectUploadResult,
} from './lib/direct-upload.js';
import {
  artifactIdFromTusUrl,
  extractAuthzMessage,
  parseUploadMetadataHeader,
  resolveStorageKind,
  resolveStorageRelatedTo,
} from './lib/tus-request.js';
import {
  normalizeAllowedExtensions,
  validateBasePath,
  validateMaxUploadSize,
  validateUploadUnit,
  validateAllowedExtensions,
  warnIfUsingDeprecatedProjectHooks,
  composeValidatePayload,
  composeOnUploadComplete,
  type PulseVaultAllowedExtensionsInput,
} from './lib/options.js';

/** Re-exported for consumers and the adapters; defined once in `lib/capabilities.ts`. */
export { PROTOCOL_VERSION };

export type PulseVaultCoreCacheOptions = {
  cacheControl?: boolean;
  maxAge?: string | number;
  immutable?: boolean;
};

export type PulseVaultCoreOptions = {
  /** Storage adapter. Use `createLocalStorage(...)` for filesystem-backed deployments. */
  storage: PulseVaultStorage;
  /**
   * URL path prefix where the core's routes are mounted, e.g. `"/pulsevault"`.
   * Use `""` to mount at the root. Unlike the Fastify plugin, there's no
   * framework-level prefix mechanism to lean on here — the core needs this
   * explicitly to compute the tus base path and to strip it from incoming
   * request URLs.
   */
  basePath: string;
  /**
   * Whether `handler` should itself match/strip `basePath` from incoming
   * request URLs. Defaults to `true` — correct for a raw
   * `http.createServer` callback, or any host that hands `handler` the
   * request's full, unmodified URL (unmatched paths 404). Set to `false`
   * when mounting via a framework that already strips its own mount prefix
   * before calling middleware — Express's `app.use(basePath, handler)`, or
   * Connect/Meteor's `WebApp.connectHandlers.use(basePath, handler)` — so
   * `handler` treats `req.url` as already relative to `basePath`. Either
   * way, `basePath` is still used to build the tus `Location` header
   * returned to clients.
   */
  stripBasePath?: boolean;
  /** Max TUS upload size in bytes. Required — consumers must choose an explicit cap. Use `Infinity` for no cap. */
  maxUploadSize: number;
  /** Which upload strategy this deployment expects. Purely advertised via `GET /capabilities`. Defaults to `"segment"`. */
  uploadUnit?: 'segment' | 'merged';
  /** File extensions allowed per artifact kind. See the Fastify plugin's `allowedExtensions` for the full shape. */
  allowedExtensions?: PulseVaultAllowedExtensionsInput;
  /** Cache-control options forwarded to `@fastify/send` for the GET route. */
  cache?: PulseVaultCoreCacheOptions;
  /** Optional authorization hook. See the Fastify plugin's `authorize` option for semantics. */
  authorize?: PulseVaultAuthorize;
  /** Optional payload-validation hook. See the Fastify plugin's `validatePayload` option for semantics. */
  validatePayload?: PulseVaultValidatePayload;
  /** Optional post-upload hook. See the Fastify plugin's `onUploadComplete` option for semantics. */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /** Optional low-frequency event hook. See the Fastify plugin's `onArtifactEvent` option for semantics. */
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  /** Logger for internal diagnostics (authorize rejections, tus handler failures). Defaults to `console`. */
  logger?: PulseVaultLogger;
  /** @deprecated Use `validatePayload` instead — see the Fastify plugin's option of the same name. */
  validateProjectPayload?: PulseVaultValidatePayload;
  /** @deprecated Use `onUploadComplete` instead — see the Fastify plugin's option of the same name. */
  onProjectUploadComplete?: PulseVaultOnUploadComplete;
};

type ConnectNext = (err?: unknown) => void;

export type PulseVaultCore = {
  /**
   * Connect-style request handler — mount directly as Express middleware
   * (`app.use(basePath, core.handler)`), Meteor middleware
   * (`WebApp.connectHandlers.use(basePath, core.handler)`), or a bare
   * `http.createServer` callback. `next` is optional so it also works as a
   * raw `http.createServer((req, res) => core.handler(req, res))` handler.
   */
  handler: (req: IncomingMessage, res: ServerResponse, next?: ConnectNext) => Promise<void>;
  /** One-time teardown — calls `storage.shutdown?.()`. */
  shutdown: () => Promise<void>;
  /** Handles a TUS create/patch/head/delete request directly (any method under `/upload`). */
  handleTus: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Writes the `GET /capabilities` JSON payload. */
  handleCapabilities: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Resolves and streams/redirects `GET /artifacts/:artifactId`. */
  handleArtifactGet: (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ) => Promise<void>;
  /** Handles `DELETE /artifacts/:artifactId`. */
  handleArtifactDelete: (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
  ) => Promise<void>;
  /** Handles `POST /direct-uploads` (reads + parses the JSON body itself). */
  handleDirectUploadCreate: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Handles `POST /direct-uploads/:artifactId/complete`. */
  handleDirectUploadComplete: (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
  ) => Promise<void>;
  /**
   * Data-level direct-upload create — for host adapters that already parsed
   * the JSON body (e.g. Fastify). Returns the status/body to send.
   */
  directUploadCreate: (request: PulseVaultRequest, body: unknown) => Promise<DirectUploadResult>;
  /** Data-level direct-upload complete — see `directUploadCreate`. */
  directUploadComplete: (
    request: PulseVaultRequest,
    artifactId: string,
  ) => Promise<DirectUploadResult>;
};

/**
 * Request interpretation (which artifact is this request about?) is shared
 * with the web-standard core via `lib/tus-request.ts` — see that module for
 * the URL-smuggling rationale behind `artifactIdFromTusUrl`.
 */
const parseUploadMetadata = parseUploadMetadataHeader;

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Every response from a pulsevault route carries the wire protocol version
 * it implements, so a client can detect "this server is too old/new for me"
 * without a dedicated round-trip. Called at the top of each granular handler
 * (rather than only in the aggregate `handler`) so it's also applied when a
 * host framework — e.g. the Fastify adapter, which hijacks the reply and
 * calls these directly — bypasses the aggregate router entirely. Must run
 * before any `writeHead`/`end` call below: `setHeader` values merge into
 * whatever headers object a later `writeHead` call passes.
 */
function stampProtocolVersion(res: ServerResponse): void {
  res.setHeader('Protocol-Version', String(PROTOCOL_VERSION));
}

type PulseVaultRequestContext = { artifactId: string; kind: UploadKind; relatedTo?: string };

/** Same augmentation as `augment.ts`'s `FastifyRequest.pulseVault`, applied to a raw request. */
function stashPulseVaultContext(req: IncomingMessage, ctx: PulseVaultRequestContext): void {
  (req as IncomingMessage & { pulseVault?: PulseVaultRequestContext }).pulseVault = ctx;
}

/**
 * Build the framework-agnostic core: the same authorize/validatePayload/
 * onUploadComplete/onArtifactEvent orchestration, tus glue, capabilities
 * payload, and artifact GET/DELETE logic the Fastify plugin uses, operating
 * on raw `(req, res)` instead of Fastify's `request`/`reply` wrappers. Both
 * the Fastify plugin and this factory ultimately call into the same
 * `lib/pulsevaultTus.js` tus server, so behavior can't drift between them.
 */
export function createPulseVaultCore(options: PulseVaultCoreOptions): PulseVaultCore {
  validateBasePath(options.basePath, 'basePath');
  validateMaxUploadSize(options.maxUploadSize);
  validateUploadUnit(options.uploadUnit);
  validateAllowedExtensions(options.allowedExtensions);
  warnIfUsingDeprecatedProjectHooks(options);

  const { storage, basePath, maxUploadSize, cache, authorize, onArtifactEvent } = options;
  const stripBasePath = options.stripBasePath ?? true;
  const uploadUnit = options.uploadUnit ?? 'segment';
  const allowedExtensions = normalizeAllowedExtensions(options.allowedExtensions);
  const validatePayload = composeValidatePayload(
    options.validatePayload,
    options.validateProjectPayload,
  );
  const onUploadComplete = composeOnUploadComplete(
    options.onUploadComplete,
    options.onProjectUploadComplete,
  );
  const logger = options.logger ?? consoleLogger;

  const tusPath = `${basePath}/upload`;
  const tusServer = createPulsevaultTusServer({
    storage,
    tusPath,
    maxSize: maxUploadSize,
    allowedExtensions,
    validatePayload,
    onUploadComplete,
    onArtifactEvent,
    logger,
  });

  /**
   * Run the consumer's `authorize` hook (if any) for a TUS request. Returns
   * `true` iff the request may proceed; on rejection, this function already
   * wrote the response.
   */
  const runAuthorize = async (
    req: IncomingMessage,
    res: ServerResponse,
    phase: 'create' | 'patch',
  ): Promise<
    | { ok: true; artifactId: string | undefined; kind: UploadKind; relatedTo?: string }
    | { ok: false }
  > => {
    let artifactId: string | undefined;
    let kind: UploadKind = 'video';
    let relatedTo: string | undefined;
    if (phase === 'create') {
      const meta = req.headers['upload-metadata'];
      if (typeof meta === 'string') {
        ({ artifactId, kind, relatedTo } = parseUploadMetadata(meta));
      }
    } else {
      artifactId = artifactIdFromTusUrl(req.url ?? '');
      if (artifactId) {
        kind = await resolveStorageKind(storage, artifactId);
        relatedTo = await resolveStorageRelatedTo(storage, artifactId);
      }
    }

    if (artifactId) {
      stashPulseVaultContext(req, { artifactId, kind, relatedTo });
    }

    if (!authorize) {
      return { ok: true, artifactId, kind, relatedTo };
    }

    if (!artifactId && phase === 'patch') {
      // PROTOCOL.md §5.2: failing to resolve the artifactId for an in-flight
      // upload request is an authorization failure — reject, don't fall
      // through to "no artifactId to check, so allow".
      logger.info({ url: req.url, phase }, 'pulsevault authorize rejected: unresolvable artifactId');
      writeJson(res, 403, pulseVaultError('Unable to resolve artifact for authorization'));
      return { ok: false };
    }

    if (!artifactId) {
      return { ok: true, artifactId, kind, relatedTo };
    }

    try {
      await authorize(req, { phase, artifactId, kind, relatedTo });
      return { ok: true, artifactId, kind, relatedTo };
    } catch (err) {
      const statusCode = statusCodeOf(err, 403);
      const message = extractAuthzMessage(err);
      logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
      if (phase === 'create') {
        await onArtifactEvent?.({ phase: 'authorize', artifactId, kind, reason: message });
      }
      writeJson(res, statusCode, pulseVaultError(message));
      return { ok: false };
    }
  };

  /**
   * Fail closed on an unexpected handler error. Host frameworks call these
   * handlers on a *hijacked* socket (e.g. Fastify's `reply.hijack()`), so a
   * thrown error is never turned into a response by the framework — without
   * this the socket would hang until the client/server timeout. If headers are
   * already on the wire we can only destroy the socket; otherwise emit a 500.
   */
  const failClosed = (res: ServerResponse, err: unknown, context: string): void => {
    logger.error({ err }, `pulsevault ${context} failed`);
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Internal Server Error');
  };

  const handleTus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stampProtocolVersion(res);
    // A client that drops the connection mid-request — a mobile app killed during a PATCH, a
    // network reset, a cancelled upload — makes Node emit an 'error' ('aborted' / ECONNRESET) on
    // the raw request (and sometimes response) stream. Node treats an unhandled 'error' event as
    // fatal: with no listener it re-throws and crashes the whole process, killing every other
    // in-flight upload. It fires from the socket-close handler on a later tick, so the try/catch
    // below never sees it. Attach no-op listeners so an aborted connection is just a dropped
    // request: @tus/server sees the truncated body, the stored offset simply doesn't advance, and
    // the client resumes from the last persisted byte on its next PATCH.
    req.on('error', () => {});
    res.on('error', () => {});
    const phase: 'create' | 'patch' = req.method === 'POST' ? 'create' : 'patch';
    try {
      // Inside the try: runAuthorize does storage I/O (kind/relatedTo resolution)
      // and header writes of its own — an adapter fault or a consumer error with
      // a bogus statusCode there must fail closed too, not hang the hijacked socket.
      const authz = await runAuthorize(req, res, phase);
      if (!authz.ok) return;

      await pulseVaultTusContext.run({ request: req, artifactId: authz.artifactId }, () =>
        tusServer.handle(req, res),
      );
    } catch (err) {
      failClosed(res, err, 'tus handler');
    }
  };

  const handleCapabilities = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stampProtocolVersion(res);
    try {
      writeJson(
        res,
        200,
        buildCapabilitiesPayload({ uploadUnit, allowedExtensions, maxUploadSize, storage }),
      );
    } catch (err) {
      failClosed(res, err, 'capabilities');
    }
  };

  const directDeps: DirectUploadDeps = {
    storage,
    allowedExtensions,
    maxUploadSize,
    authorize,
    validatePayload,
    onUploadComplete,
    onArtifactEvent,
    logger,
  };

  // Data-level entry points (no req/res) so host adapters with their own body
  // parsing (Fastify) can call straight in without double-reading the stream.
  const directCreate = (request: PulseVaultRequest, body: unknown) =>
    directUploadCreate(directDeps, request, body);
  const directComplete = (request: PulseVaultRequest, artifactId: string) =>
    directUploadComplete(directDeps, request, artifactId);

  /** Collect a small JSON request body; 413s beyond the cap (these bodies are a few hundred bytes). */
  const readJsonBody = (req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limitBytes) {
          req.removeAllListeners('data');
          reject(httpError(413, 'Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(httpError(400, 'Request body must be JSON'));
        }
      });
      req.on('error', reject);
    });

  const handleDirectUploadCreate = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    stampProtocolVersion(res);
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (bodyErr) {
        writeJson(
          res,
          statusCodeOf(bodyErr, 400),
          pulseVaultError(bodyErr instanceof Error ? bodyErr.message : 'Bad Request'),
        );
        return;
      }
      const result = await directCreate(req, body);
      writeJson(res, result.statusCode, result.body);
    } catch (err) {
      failClosed(res, err, 'direct-upload create');
    }
  };

  const handleDirectUploadComplete = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
  ): Promise<void> => {
    stampProtocolVersion(res);
    try {
      const result = await directComplete(req, artifactId);
      writeJson(res, result.statusCode, result.body);
    } catch (err) {
      failClosed(res, err, 'direct-upload complete');
    }
  };

  /**
   * Shared prelude for the artifact GET/DELETE handlers: resolve `kind`/
   * `relatedTo` from storage, stash the request context, then run `authorize`
   * (if configured) for the given phase. Returns `undefined` (having already
   * written the response) when validation fails or `authorize` rejects.
   */
  const prepareArtifactRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    phase: 'resolve' | 'delete',
    token?: string,
  ): Promise<{ kind: UploadKind; relatedTo: string | undefined } | undefined> => {
    if (!isUuid(artifactId)) {
      writeJson(res, 400, pulseVaultError('`artifactId` must be a valid UUID'));
      return undefined;
    }

    const kind = await resolveStorageKind(storage, artifactId);
    const relatedTo = await resolveStorageRelatedTo(storage, artifactId);
    stashPulseVaultContext(req, { artifactId, kind, relatedTo });

    if (!authorize) return { kind, relatedTo };

    try {
      await authorize(req, { phase, artifactId, kind, relatedTo, token });
      return { kind, relatedTo };
    } catch (err) {
      const statusCode = statusCodeOf(err, 403);
      const message = extractAuthzMessage(err);
      logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
      await onArtifactEvent?.({ phase: 'authorize', artifactId, kind, reason: message });
      writeJson(res, statusCode, pulseVaultError(message));
      return undefined;
    }
  };

  const handleArtifactDelete = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
  ): Promise<void> => {
    stampProtocolVersion(res);
    try {
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'delete');
      if (!prepared) return;

      if (typeof storage.remove !== 'function') {
        writeJson(res, 501, pulseVaultError('Storage adapter does not support delete'));
        return;
      }

      const removed = await storage.remove(artifactId);
      if (!removed) {
        writeJson(res, 404, pulseVaultError('Artifact not found'));
        return;
      }
      res.writeHead(204);
      res.end();
    } catch (err) {
      failClosed(res, err, 'artifact delete');
    }
  };

  const handleArtifactGet = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ): Promise<void> => {
    stampProtocolVersion(res);
    try {
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'resolve', token);
      if (!prepared) return;

      const resolved = await storage.resolve(artifactId);
      if (!resolved) {
        writeJson(res, 404, pulseVaultError('Artifact not found'));
        return;
      }

      if (resolved.kind === 'redirect') {
        res.writeHead(resolved.statusCode ?? 302, { Location: resolved.url });
        res.end();
        return;
      }

      const result = await send(req, resolved.filename, { root: resolved.root, ...cache });

      if (result.type === 'error') {
        writeJson(res, result.statusCode, pulseVaultError(result.metadata.error.message));
        return;
      }

      const headers = { ...result.headers };
      // If the storage adapter provided an explicit content type (e.g. for
      // non-standard extensions like `.pulse`), override what @fastify/send
      // would otherwise infer from the filename.
      if (resolved.contentType) {
        headers['content-type'] = resolved.contentType;
      }
      res.writeHead(result.statusCode, headers);
      // Headers are on the wire now, so a mid-stream read error (file removed
      // after stat, disk error) can't become a 500 — destroy the socket instead
      // of letting an unhandled 'error' crash the process. Destroy the source on
      // client disconnect so the file descriptor is never leaked.
      result.stream.on('error', (err) => failClosed(res, err, 'artifact stream'));
      // A client that aborts mid-download makes the *response* stream emit its own
      // 'error' (ECONNRESET / EPIPE). `.pipe` doesn't forward that, and an unhandled
      // 'error' on `res` is fatal to the process — so swallow it (the 'close' handler
      // above already tears down the source and reclaims the fd).
      res.on('error', () => {});
      res.on('close', () => result.stream.destroy());
      result.stream.pipe(res);
    } catch (err) {
      failClosed(res, err, 'artifact get');
    }
  };

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: ConnectNext,
  ): Promise<void> => {
    // (Protocol-Version is stamped by each granular handler below, so it's
    // applied consistently whether reached through this router or called
    // directly by a host framework's own routing.)
    const notFound = () => {
      if (next) {
        next();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    };

    // A raw socket can present a request-target `new URL` refuses to parse
    // (e.g. an absolute-form or garbage target from a non-HTTP client probing
    // the port) — that's the client's malformed request, not our 500, and it
    // must not escape as an uncaught throw on a hijacked/raw response.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://internal');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    let pathname = url.pathname;
    if (stripBasePath && basePath !== '') {
      if (pathname === basePath) {
        pathname = '';
      } else if (pathname.startsWith(`${basePath}/`)) {
        pathname = pathname.slice(basePath.length);
      } else {
        notFound();
        return;
      }
    }
    if (pathname === '') pathname = '/';

    if (pathname === '/upload' || pathname.startsWith('/upload/')) {
      await handleTus(req, res);
      return;
    }
    if (pathname === '/capabilities' && req.method === 'GET') {
      await handleCapabilities(req, res);
      return;
    }
    if (pathname === '/direct-uploads' && req.method === 'POST') {
      await handleDirectUploadCreate(req, res);
      return;
    }
    const completeMatch = pathname.match(/^\/direct-uploads\/([^/]+)\/complete$/);
    if (completeMatch?.[1] && req.method === 'POST') {
      await handleDirectUploadComplete(req, res, decodeURIComponent(completeMatch[1]));
      return;
    }
    const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
    if (artifactMatch?.[1]) {
      const artifactId = artifactMatch[1];
      if (req.method === 'GET') {
        await handleArtifactGet(req, res, artifactId, url.searchParams.get('token') ?? undefined);
        return;
      }
      if (req.method === 'DELETE') {
        await handleArtifactDelete(req, res, artifactId);
        return;
      }
    }
    notFound();
  };

  return {
    handler,
    shutdown: async () => {
      await storage.shutdown?.();
    },
    handleTus,
    handleCapabilities,
    handleArtifactGet,
    handleArtifactDelete,
    handleDirectUploadCreate,
    handleDirectUploadComplete,
    directUploadCreate: directCreate,
    directUploadComplete: directComplete,
  };
}

// Re-exported so a non-Fastify consumer never needs to import from both `.`
// and `./core` for a normal setup — these are already framework-agnostic
// and identical to what the `.` (Fastify) entry point re-exports.
export { createLocalStorage } from './storage/local.js';
export type { LocalStorage, LocalStorageOptions } from './storage/local.js';
export { createS3Storage } from './storage/s3.js';
export type { S3Storage, S3StorageOptions } from './storage/s3.js';
export type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from './storage/types.js';
export type {
  PulseVaultAuthorize,
  PulseVaultAuthorizeContext,
  PulseVaultAuthorizePhase,
} from './lib/authorize.js';
export type {
  PulseVaultOnUploadComplete,
  PulseVaultOnArtifactEvent,
  PulseVaultArtifactEvent,
} from './lib/pulsevaultTus.js';
export { sniffMp4, createMp4Sniffer, createS3Mp4Sniffer } from './lib/magic.js';
export type { PulseVaultValidatePayload } from './lib/magic.js';
export { ensureWebReady, scanMoovPosition } from './lib/web-ready.js';
export type { WebReadyAction, WebReadyOptions, WebReadyResult, MoovPosition } from './lib/web-ready.js';
export { buildUploadLink } from './lib/deeplinks.js';
export type { UploadLinkOptions } from './lib/deeplinks.js';
export {
  issueCapabilityToken,
  verifyCapabilityToken,
  createCapabilityAuthorize,
} from './lib/capability-token.js';
export type {
  CapabilityTokenClaims,
  IssueCapabilityTokenOptions,
  VerifyCapabilityTokenOptions,
  LookupSecret,
} from './lib/capability-token.js';
export {
  createChecksumValidator,
  createS3ChecksumValidator,
  parseChecksumMetadata,
} from './lib/checksum.js';
export type { ChecksumAlgorithm, ParsedChecksum } from './lib/checksum.js';
export { type PulseVaultRequest, type PulseVaultLogger } from './lib/request.js';
export { createPulseVaultWebHandler } from './web.js';
export type { PulseVaultWebHandler, PulseVaultWebOptions } from './web.js';
export { supportsDirectUpload } from './lib/direct-upload.js';
export type {
  DirectUploadCapableStorage,
  DirectUploadResult,
} from './lib/direct-upload.js';
export type { ArtifactMetadata } from './storage/types.js';
