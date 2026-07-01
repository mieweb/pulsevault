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
import { pulseVaultError } from './lib/errors.js';
import { isUuid } from './lib/uuid.js';
import { type PulseVaultLogger, consoleLogger } from './lib/request.js';
import type { PulseVaultStorage, UploadKind } from './storage/types.js';
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

/** Wire protocol version this release implements. See `/capabilities` and `PROTOCOL.md`. */
export const PROTOCOL_VERSION = 1;
const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_SUPPORTED_PROTOCOL_VERSION = 1;

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
  /** Which upload strategy this deployment expects. Purely advertised via `GET /capabilities`. Defaults to `"beat"`. */
  uploadUnit?: 'beat' | 'merged';
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
};

/**
 * Pull `artifactId` (or the legacy `videoid`/`projectid` aliases), `kind`,
 * and `relatedTo` out of a raw `Upload-Metadata` header. Format is a
 * comma-separated list of `<key> <base64-value>` pairs (tus v1 creation
 * extension).
 *
 * Alias precedence is a fixed priority (`artifactId` beats `videoid` beats
 * `projectid`, regardless of header order) so this always agrees with
 * `namingFunction` in `lib/pulsevaultTus.ts` — which uses the same
 * `?? `-chain precedence to decide what's actually reserved/written to
 * storage. If these two disagreed, `authorize()` could validate ownership of
 * a different artifactId than the one the upload actually lands under.
 */
function parseUploadMetadata(header: string): {
  artifactId: string | undefined;
  kind: UploadKind;
  relatedTo: string | undefined;
} {
  let artifactIdRaw: string | undefined;
  let videoidRaw: string | undefined;
  let projectidRaw: string | undefined;
  let kind: UploadKind = 'video';
  let relatedTo: string | undefined;
  for (const pair of header.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep);
    const value = trimmed.slice(sep + 1).trim();
    if (!value) continue;
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (key === 'artifactId') {
        artifactIdRaw ??= decoded;
      } else if (key === 'videoid') {
        videoidRaw ??= decoded;
      } else if (key === 'projectid') {
        projectidRaw ??= decoded;
      } else if (key === 'kind') {
        const lower = decoded.trim().toLowerCase();
        kind = lower === 'project' ? 'project' : lower === 'captions' ? 'captions' : 'video';
      } else if (key === 'relatedTo' && !relatedTo) {
        relatedTo = isUuid(decoded) ? decoded : undefined;
      }
    } catch {
      // ignore malformed base64
    }
  }
  const candidate = (artifactIdRaw ?? videoidRaw ?? projectidRaw ?? '').trim();
  const artifactId = isUuid(candidate) ? candidate : undefined;
  return { artifactId, kind, relatedTo };
}

/**
 * `@tus/server`'s `BaseHandler.getFileIdFromRequest` — the function that
 * ultimately decides which upload a PATCH/HEAD/DELETE actually operates on —
 * extracts its file id from the request URL's *last* `/`-delimited segment
 * (`reExtractFileID = /([^/]+)\/?$/`), not from the first segment after
 * `/upload/`. This MUST mirror that exact regex: a URL with extra path
 * segments after the real id (Fastify's `/upload/*` route accepts them) would
 * otherwise let `authorize()` see and approve one artifactId (whichever this
 * function resolved) while `@tus/server` writes the request body against a
 * *different* one (whichever it resolved) — an attacker holding a valid
 * token for their own artifact could smuggle a second, victim artifactId as
 * a trailing path segment and have their bytes land there instead, fully
 * bypassing authorization for the artifact actually written to.
 */
const TUS_LAST_URL_SEGMENT = /([^/]+)\/?$/;

/**
 * Decode the tus file id (base64url-encoded, shaped `<kind>/<artifactId><ext>`
 * by `namingFunction` in `lib/pulsevaultTus.ts`) that `@tus/server` itself
 * will resolve a PATCH/HEAD/DELETE request to, and recover the artifactId via
 * the exact same parser `onUploadFinish` uses — so this can never drift from
 * what `@tus/server` actually operates on. See `TUS_LAST_URL_SEGMENT` above
 * for why this must match the *last* URL segment, not the first one after
 * `/upload/`.
 */
function artifactIdFromTusUrl(url: string): string | undefined {
  const match = TUS_LAST_URL_SEGMENT.exec(url);
  if (!match?.[1]) return undefined;
  let lastSegment: string;
  try {
    lastSegment = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(lastSegment, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  return artifactIdFromUploadId(decoded);
}

/**
 * Resolve the artifact kind for an artifactId from storage. Duck-typed so it
 * works with any adapter (those without `getKind` return `"video"`).
 */
async function resolveStorageKind(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<UploadKind> {
  const candidate = (storage as { getKind?: unknown }).getKind;
  if (typeof candidate !== 'function') return 'video';
  const result = await (candidate as (id: string) => Promise<UploadKind | null>)(artifactId);
  return result ?? 'video';
}

/** Resolve the `relatedTo` artifact for an artifactId from storage, if the adapter supports it. */
async function resolveStorageRelatedTo(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<string | undefined> {
  const candidate = (storage as { getRelatedTo?: unknown }).getRelatedTo;
  if (typeof candidate !== 'function') return undefined;
  const result = await (candidate as (id: string) => Promise<string | null>)(artifactId);
  return result ?? undefined;
}

function extractAuthzStatus(err: unknown): number {
  const e = err as { statusCode?: unknown; status_code?: unknown };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.status_code === 'number') return e.status_code;
  return 403;
}

function extractAuthzMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Forbidden';
}

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
  const uploadUnit = options.uploadUnit ?? 'beat';
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

    if (!authorize || !artifactId) {
      return { ok: true, artifactId, kind, relatedTo };
    }

    try {
      await authorize(req, { phase, artifactId, kind, relatedTo });
      return { ok: true, artifactId, kind, relatedTo };
    } catch (err) {
      const statusCode = extractAuthzStatus(err);
      const message = extractAuthzMessage(err);
      logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
      if (phase === 'create') {
        await onArtifactEvent?.({ phase: 'authorize', artifactId, kind, reason: message });
      }
      writeJson(res, statusCode, pulseVaultError(message));
      return { ok: false };
    }
  };

  const handleTus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stampProtocolVersion(res);
    const phase: 'create' | 'patch' = req.method === 'POST' ? 'create' : 'patch';
    const authz = await runAuthorize(req, res, phase);
    if (!authz.ok) return;

    try {
      await pulseVaultTusContext.run({ request: req, artifactId: authz.artifactId }, () =>
        tusServer.handle(req, res),
      );
    } catch (err) {
      logger.error({ err }, 'pulsevault tus handler failed');
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    }
  };

  const handleCapabilities = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stampProtocolVersion(res);
    writeJson(res, 200, {
      protocolVersion: PROTOCOL_VERSION,
      minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
      maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
      uploadUnit,
      kinds: ['video', 'project', 'captions'],
      allowedExtensions,
      maxUploadSize,
      checksum: { algorithms: ['sha256', 'sha1', 'md5'] },
    });
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
      const statusCode = extractAuthzStatus(err);
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
  };

  const handleArtifactGet = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ): Promise<void> => {
    stampProtocolVersion(res);
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
    result.stream.pipe(res);
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

    const url = new URL(req.url ?? '/', 'http://internal');
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
