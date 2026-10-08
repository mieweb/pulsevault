import type { IncomingMessage, ServerResponse } from 'node:http';
import send from '@fastify/send';
import {
  createPulsevaultTusServer,
  pulseVaultTusContext,
  artifactIdFromUploadId,
  normalizeArtifactName,
  type PulseVaultOnUploadComplete,
  type PulseVaultOnArtifactEvent,
} from './lib/pulsevaultTus.js';
import {
  createCompletionRunner,
  validateCompletionOptions,
  type PulseVaultReplayOptions,
  type PulseVaultWebReadyOptions,
} from './lib/completion.js';
import type { PulseVaultValidatePayload } from './lib/magic.js';
import type {
  PulseVaultAuthorize,
  PulseVaultAuthorizeContext,
  PulseVaultAuthorizePhase,
} from './lib/authorize.js';
import type { PulseVaultIssueViewLink } from './lib/view-links.js';
import {
  type PulseVaultRetentionOptions,
  startRetentionSweep,
  validateRetentionOptions,
} from './lib/retention.js';
import { pulseVaultError, statusCodeOf } from './lib/errors.js';
import { isUuid } from './lib/uuid.js';
import { webReadyAvailable, type WebReadyResult } from './lib/web-ready.js';
import { type PulseVaultLogger, consoleLogger } from './lib/request.js';
import type {
  PulseVaultArtifactMeta,
  PulseVaultResolution,
  PulseVaultStorage,
  UploadKind,
} from './storage/types.js';
import { parseUploadKind } from './storage/types.js';
import { normalizeAppVersion } from './lib/protocol.js';
import {
  normalizeAllowedExtensions,
  validateBasePath,
  validateMaxUploadSize,
  rejectRemovedOptions,
  validateAllowedExtensions,
  warnIfUsingDeprecatedProjectHooks,
  composeValidatePayload,
  composeOnUploadComplete,
  type PulseVaultAllowedExtensionsInput,
} from './lib/options.js';
import { buildCapabilities, PROTOCOL_VERSION } from './lib/capabilities.js';
import { outdatedClientRejection } from './lib/protocol.js';

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
  /** Optional read-only view links. See the Fastify plugin's `issueViewLink` option for semantics. */
  issueViewLink?: PulseVaultIssueViewLink;
  /** Optional cleanup of abandoned uploads. See the Fastify plugin's `retention` option for semantics. */
  retention?: PulseVaultRetentionOptions;
  /**
   * Hold every create to the shape of a pulse (PROTOCOL.md §8): a video is created with no
   * `relatedTo`, and a thumbnail, beat manifest or captions under its own id, `relatedTo` the
   * video. With `createCapabilityAuthorize` the ids are also tied to the token: the video only
   * under the token's own artifactId, the rest only `relatedTo` it. Defaults to `true`; set
   * `false` for uploads that aren't pulses.
   */
  pulseShape?: boolean;
  /**
   * Let a create take over an unfinished upload of the same artifactId once it has been idle
   * this long, instead of answering `409` until `retention` removes it. Only an upload of the
   * same kind and `relatedTo`, so the token that authorized the new create authorized the old
   * one. Defaults to `{ idleSeconds: 300 }`; `false` turns it off.
   */
  reclaim?: { idleSeconds?: number } | false;
  /**
   * Once an artifact is finished, refuse to delete it — or anything `relatedTo` a finished
   * video — through the routes (`DELETE /artifacts/:id` and the TUS `DELETE`): a pulse that
   * landed stays. Removal then goes through `storage.remove` on the host's own terms. Off by
   * default.
   */
  lockWhenReady?: boolean;
  /**
   * Conform every finished video to one web-playable format (`CONFORM_TARGET`) in the
   * background, after the final `PATCH` is answered: nothing for a file already in it, a
   * lossless remux, or one ffmpeg run (a WebM, MKV or MOV becomes an MP4 at the same artifact
   * URL). `true` for the defaults, or `ensureWebReady`'s options plus `concurrency` and
   * `completeAfter`. Needs the local storage adapter. Off by default.
   */
  webReady?: PulseVaultWebReadyOptions | boolean;
  /**
   * How often a finished artifact whose `onUploadComplete` never finished is fired again, and a
   * conversion a restart interrupted is resumed. On by default, every 300 seconds, with the
   * first pass shortly after start; `false` turns it off. Needs `listArtifacts` and
   * `describeArtifact` (both built-in adapters).
   */
  replayCompletions?: PulseVaultReplayOptions | false;
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
  /** One-time teardown — stops the `retention` sweep, then calls `storage.shutdown?.()`. */
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
  /** Handles `POST /artifacts/:artifactId/view-link` (404 unless `issueViewLink` is configured). */
  handleViewLink: (req: IncomingMessage, res: ServerResponse, artifactId: string) => Promise<void>;
  /** Handles `DELETE /artifacts/:artifactId`. */
  handleArtifactDelete: (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
  ) => Promise<void>;
  /** Handles `GET /artifacts/:artifactId/status` (authorized as `status`). */
  handleStatus: (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ) => Promise<void>;
  /** Handles `GET /artifacts/:artifactId/poster`: the video's thumbnail (authorized as `resolve` on the video). */
  handlePoster: (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ) => Promise<void>;
  /** The state of one artifact, as the status route reports it — for a host that polls server-side. */
  getStatus: (artifactId: string) => Promise<PulseVaultArtifactStatus>;
  /** A video and the finished artifacts `relatedTo` it, by kind. `video` is `null` for an unknown id. */
  getPulse: (artifactId: string) => Promise<PulseVaultPulse>;
  /**
   * Record where an upload went, or why it didn't (any JSON; `null` clears it). Reported by the
   * status route as `outcome`, so a page waiting on an upload learns it from PulseVault alone.
   * Resolves `false` for an unknown artifactId.
   */
  recordOutcome: (artifactId: string, outcome: unknown) => Promise<boolean>;
  /** Run one completion-replay pass now (see `replayCompletions`). Resolves the replayed artifactIds. */
  replayCompletions: () => Promise<string[]>;
  /**
   * Whether finished videos are conformed: `webReady` is on and ffmpeg and ffprobe run on this
   * host. `false` means uploads are served exactly as uploaded — for a host's health check.
   */
  conformAvailable: () => Promise<boolean>;
};

/** What `GET /artifacts/:id/status` and `getStatus` report. */
export type PulseVaultArtifactStatus = {
  artifactId: string;
  /**
   * `unknown` for an id storage has never seen; `uploading` until the final byte; `processing`
   * while a web-ready conversion rewrites the bytes; `ready` once the artifact is served.
   */
  state: 'unknown' | 'uploading' | 'processing' | 'ready';
  kind?: UploadKind;
  relatedTo?: string;
  name?: string;
  /** Bytes received so far (while `uploading`), or stored (once finished), when known. */
  bytesReceived?: number;
  /** The upload's declared length, when known. */
  size?: number;
  /** Whether the host's `onUploadComplete` has finished for this artifact. */
  acknowledged?: boolean;
  /**
   * What the web-ready conversion did, once it ran: `none`, `remuxed`, `transcoded`, `conformed`,
   * or `skipped` with the reason (the original bytes serve).
   */
  webReady?: WebReadyResult;
  /** What the host recorded with `recordOutcome`, if anything. */
  outcome?: unknown;
  /** The capability token's context (`getStatus` only; the status route leaves it out). */
  context?: unknown;
};

/** A pulse: its video and the finished artifacts `relatedTo` it, one per kind (the newest wins). */
export type PulseVaultPulse = {
  video: PulseVaultArtifactMeta | null;
  thumbnail?: PulseVaultArtifactMeta;
  captions?: PulseVaultArtifactMeta;
  manifest?: PulseVaultArtifactMeta;
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
  filename: string | undefined;
  name: string | undefined;
  appVersion: string | undefined;
} {
  let artifactIdRaw: string | undefined;
  let videoidRaw: string | undefined;
  let projectidRaw: string | undefined;
  let kind: UploadKind = 'video';
  let relatedTo: string | undefined;
  let filename: string | undefined;
  let name: string | undefined;
  let appVersion: string | undefined;
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
        kind = parseUploadKind(decoded);
      } else if (key === 'relatedTo' && !relatedTo) {
        relatedTo = isUuid(decoded) ? decoded : undefined;
      } else if (key === 'filename') {
        filename ??= decoded.trim() || undefined;
      } else if (key === 'name') {
        name ??= normalizeArtifactName(decoded);
      } else if (key === 'appVersion') {
        appVersion ??= normalizeAppVersion(decoded);
      }
    } catch {
      // ignore malformed base64
    }
  }
  const candidate = (artifactIdRaw ?? videoidRaw ?? projectidRaw ?? '').trim();
  const artifactId = isUuid(candidate) ? candidate : undefined;
  return { artifactId, kind, relatedTo, filename, name, appVersion };
}

/** Lowercase extension of a filename, with the leading dot; `undefined` when it has none. */
function extensionOf(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot).toLowerCase() : undefined;
}

/** The hook-context fields that come from stored metadata, for every phase after `create`. */
function describedFields(
  meta: PulseVaultArtifactMeta | null,
): Pick<PulseVaultAuthorizeContext, 'name' | 'appVersion' | 'filename' | 'ext' | 'context'> {
  if (!meta) return {};
  return {
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.appVersion ? { appVersion: meta.appVersion } : {}),
    filename: meta.filename,
    ext: meta.ext,
    ...(meta.context !== undefined ? { context: meta.context } : {}),
  };
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
 *
 * Implemented with plain string ops (not the regex itself) because the
 * unanchored-start regex is polynomial on adversarial inputs (CodeQL
 * js/polynomial-redos). Semantics are identical: after stripping at most one
 * trailing `/`, the match is the non-empty run of non-`/` characters at the
 * end of the string, or no match if that run is empty (e.g. `a//`).
 */
function tusLastUrlSegment(url: string): string | undefined {
  const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return segment.length > 0 ? segment : undefined;
}

/**
 * Decode the tus file id (base64url-encoded, shaped `<kind>/<artifactId><ext>`
 * by `namingFunction` in `lib/pulsevaultTus.ts`) that `@tus/server` itself
 * will resolve a PATCH/HEAD/DELETE request to, and recover the artifactId via
 * the exact same parser `onUploadFinish` uses — so this can never drift from
 * what `@tus/server` actually operates on. See `tusLastUrlSegment` above
 * for why this must match the *last* URL segment, not the first one after
 * `/upload/`.
 */
function artifactIdFromTusUrl(url: string): string | undefined {
  const rawSegment = tusLastUrlSegment(url);
  if (!rawSegment) return undefined;
  let lastSegment: string;
  try {
    lastSegment = decodeURIComponent(rawSegment);
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

/**
 * Refuse a client whose `Pulse-Client` header says its newest protocol is older than this
 * server's oldest: `426 Upgrade Required` with the supported range, instead of letting it fail
 * somewhere mid-upload (PROTOCOL.md §7). A client that doesn't send the header is let through.
 * `/capabilities` never refuses, so an old client can still learn why. Returns true if it answered.
 */
function rejectOutdatedClient(req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = outdatedClientRejection(req);
  if (!rejection) return false;
  writeJson(res, 426, rejection);
  return true;
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
  rejectRemovedOptions(options);
  validateBasePath(options.basePath, 'basePath');
  validateMaxUploadSize(options.maxUploadSize);
  validateAllowedExtensions(options.allowedExtensions);
  warnIfUsingDeprecatedProjectHooks(options);

  const { storage, basePath, maxUploadSize, cache, authorize, onArtifactEvent, issueViewLink } =
    options;
  const stripBasePath = options.stripBasePath ?? true;
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
  validateRetentionOptions(options.retention, storage);
  const retentionSweep = options.retention
    ? startRetentionSweep(storage, options.retention, logger, async ({ artifactId, kind }) => {
        await onArtifactEvent?.({ phase: 'remove', artifactId, kind, reason: 'abandoned' });
      })
    : null;

  const pulseShape = options.pulseShape ?? true;
  const lockWhenReady = options.lockWhenReady === true;
  const describe = (artifactId: string): Promise<PulseVaultArtifactMeta | null> =>
    typeof storage.describeArtifact === 'function'
      ? storage.describeArtifact(artifactId)
      : Promise.resolve(null);
  if (options.reclaim !== undefined && options.reclaim !== false) {
    const { idleSeconds } = options.reclaim;
    if (idleSeconds !== undefined && !(idleSeconds >= 0 && Number.isFinite(idleSeconds))) {
      throw new TypeError('`reclaim.idleSeconds` must be a number of seconds, at least 0');
    }
  }
  const reclaim =
    options.reclaim === false ? false : { idleSeconds: options.reclaim?.idleSeconds ?? 300 };
  const replay = options.replayCompletions === false ? false : (options.replayCompletions ?? {});
  validateCompletionOptions({ storage, webReady: options.webReady, replay });
  const completion = createCompletionRunner({
    storage,
    onUploadComplete,
    onArtifactEvent,
    webReady: options.webReady,
    replay,
    logger,
  });
  completion.start();

  const tusPath = `${basePath}/upload`;
  const tusServer = createPulsevaultTusServer({
    storage,
    tusPath,
    maxSize: maxUploadSize,
    allowedExtensions,
    validatePayload,
    completion,
    onArtifactEvent,
    pulseShape,
    reclaim,
    ...(lockWhenReady ? { isLocked: (artifactId: string) => isLocked(artifactId) } : {}),
    logger,
  });

  /**
   * With `lockWhenReady`, whether a delete must be refused: the artifact is finished, or it
   * belongs to a finished video. The check reads storage just before the removal; the TUS
   * `DELETE` additionally runs under tus's per-upload lock, so it can't interleave with the
   * final chunk of the same upload.
   */
  const isFinished = async (artifactId: string): Promise<boolean> => {
    // `describeArtifact` reads storage itself; `resolve` may answer from a per-instance cache
    // that hasn't seen another instance finish the upload.
    if (typeof storage.describeArtifact === 'function') {
      return (await storage.describeArtifact(artifactId))?.ready ?? false;
    }
    return (await storage.resolve(artifactId)) !== null;
  };
  const isLocked = async (artifactId: string, relatedTo?: string): Promise<boolean> => {
    if (!lockWhenReady) return false;
    const meta = await describe(artifactId);
    if (meta ? meta.ready : await isFinished(artifactId)) return true;
    const parent =
      relatedTo ?? meta?.relatedTo ?? (await resolveStorageRelatedTo(storage, artifactId));
    return parent !== undefined && (await isFinished(parent));
  };

  /**
   * Run the consumer's `authorize` hook (if any) for a TUS request. Returns
   * `true` iff the request may proceed; on rejection, this function already
   * wrote the response.
   */
  const runAuthorize = async (
    req: IncomingMessage,
    res: ServerResponse,
    phase: 'create' | 'patch' | 'delete',
  ): Promise<
    | {
        ok: true;
        artifactId: string | undefined;
        kind: UploadKind;
        relatedTo?: string;
        /** What `authorize` returned on `create`: the context to store with the artifact. */
        context?: unknown;
      }
    | { ok: false }
  > => {
    let artifactId: string | undefined;
    let kind: UploadKind = 'video';
    let relatedTo: string | undefined;
    let fields: Pick<PulseVaultAuthorizeContext, 'name' | 'appVersion' | 'filename' | 'ext' | 'context'> =
      {};
    if (phase === 'create') {
      const meta = req.headers['upload-metadata'];
      if (typeof meta === 'string') {
        const parsed = parseUploadMetadata(meta);
        ({ artifactId, kind, relatedTo } = parsed);
        fields = {
          ...(parsed.name ? { name: parsed.name } : {}),
          ...(parsed.appVersion ? { appVersion: parsed.appVersion } : {}),
          ...(parsed.filename ? { filename: parsed.filename } : {}),
          ...(extensionOf(parsed.filename) ? { ext: extensionOf(parsed.filename) } : {}),
        };
      }
    } else {
      artifactId = artifactIdFromTusUrl(req.url ?? '');
      if (artifactId) {
        const described = await describe(artifactId);
        kind = described?.kind ?? (await resolveStorageKind(storage, artifactId));
        relatedTo = described?.relatedTo ?? (await resolveStorageRelatedTo(storage, artifactId));
        fields = describedFields(described);
      }
    }

    if (artifactId) {
      stashPulseVaultContext(req, { artifactId, kind, relatedTo });
    }

    if (!authorize) {
      return { ok: true, artifactId, kind, relatedTo };
    }

    if (!artifactId && phase !== 'create') {
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
      const result = await authorize(req, { phase, artifactId, kind, relatedTo, ...fields });
      const context = phase === 'create' && result ? result.context : undefined;
      return { ok: true, artifactId, kind, relatedTo, ...(context !== undefined ? { context } : {}) };
    } catch (err) {
      const statusCode = statusCodeOf(err, 403);
      const message = extractAuthzMessage(err);
      logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
      // Like the artifact routes: every rejected create or delete is reported, never a per-chunk
      // `patch`.
      if (phase !== 'patch') {
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
    if (rejectOutdatedClient(req, res)) return;
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
    // A TUS DELETE removes the whole artifact, in flight or finished (see `withArtifactRemoval`),
    // exactly as `DELETE /artifacts/:id` does — so it's authorized as the same `delete`.
    const phase: 'create' | 'patch' | 'delete' =
      req.method === 'POST' ? 'create' : req.method === 'DELETE' ? 'delete' : 'patch';
    try {
      // Inside the try: runAuthorize does storage I/O (kind/relatedTo resolution)
      // and header writes of its own — an adapter fault or a consumer error with
      // a bogus statusCode there must fail closed too, not hang the hijacked socket.
      const authz = await runAuthorize(req, res, phase);
      if (!authz.ok) return;
      // `lockWhenReady` for a TUS DELETE is checked inside the datastore's removal, under tus's
      // per-upload lock (see `withArtifactRemoval`).

      await pulseVaultTusContext.run(
        {
          request: req,
          artifactId: authz.artifactId,
          ...(authz.context !== undefined ? { context: authz.context } : {}),
        },
        () => tusServer.handle(req, res),
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
        buildCapabilities({ allowedExtensions, maxUploadSize, viewLinks: !!issueViewLink }),
      );
    } catch (err) {
      failClosed(res, err, 'capabilities');
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
    phase: Exclude<PulseVaultAuthorizePhase, 'create' | 'patch'>,
    token?: string,
  ): Promise<{ kind: UploadKind; relatedTo: string | undefined } | undefined> => {
    if (!isUuid(artifactId)) {
      writeJson(res, 400, pulseVaultError('`artifactId` must be a valid UUID'));
      return undefined;
    }

    const described = await describe(artifactId);
    const kind = described?.kind ?? (await resolveStorageKind(storage, artifactId));
    const relatedTo = described?.relatedTo ?? (await resolveStorageRelatedTo(storage, artifactId));
    stashPulseVaultContext(req, { artifactId, kind, relatedTo });

    if (!authorize) return { kind, relatedTo };

    try {
      await authorize(req, {
        phase,
        artifactId,
        kind,
        relatedTo,
        token,
        ...describedFields(described),
      });
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
    if (rejectOutdatedClient(req, res)) return;
    try {
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'delete');
      if (!prepared) return;

      if (typeof storage.remove !== 'function') {
        writeJson(res, 501, pulseVaultError('Storage adapter does not support delete'));
        return;
      }
      if (await isLocked(artifactId, prepared.relatedTo)) {
        writeJson(res, 403, pulseVaultError('A finished artifact is locked'));
        return;
      }

      const removed = await storage.remove(artifactId);
      if (!removed) {
        writeJson(res, 404, pulseVaultError('Artifact not found'));
        return;
      }
      await onArtifactEvent?.({
        phase: 'remove',
        artifactId,
        kind: prepared.kind,
        reason: 'deleted',
      });
      res.writeHead(204);
      res.end();
    } catch (err) {
      failClosed(res, err, 'artifact delete');
    }
  };

  /**
   * `POST /artifacts/:artifactId/view-link` (PROTOCOL.md §6.4): a read-only link to a finished
   * artifact, minted by the host's `issueViewLink` once `authorize` allowed the request as
   * `"share"`. 404 when the host didn't configure view links, or the artifact isn't finished;
   * 403 when the host refuses a link for it.
   */
  const handleViewLink = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
  ): Promise<void> => {
    stampProtocolVersion(res);
    if (rejectOutdatedClient(req, res)) return;
    try {
      if (!issueViewLink) {
        writeJson(res, 404, pulseVaultError('View links are not enabled on this server'));
        return;
      }
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'share');
      if (!prepared) return;

      // Only a finished artifact gets a link: one still uploading might never finish.
      if (!(await storage.resolve(artifactId))) {
        writeJson(res, 404, pulseVaultError('Artifact not found'));
        return;
      }
      const link = await issueViewLink(req, { artifactId, ...prepared });
      if (!link) {
        writeJson(res, 403, pulseVaultError('No view link for this artifact'));
        return;
      }
      writeJson(res, 200, { token: link.token, expiresAt: link.expiresAt });
    } catch (err) {
      failClosed(res, err, 'view link');
    }
  };

  const handleArtifactGet = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ): Promise<void> => {
    stampProtocolVersion(res);
    if (rejectOutdatedClient(req, res)) return;
    try {
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'resolve', token);
      if (!prepared) return;

      const resolved = await storage.resolve(artifactId);
      if (!resolved) {
        writeJson(res, 404, pulseVaultError('Artifact not found'));
        return;
      }
      // While a video is being converted its URL serves the original bytes, which the conversion
      // replaces: revalidate instead of the configured (possibly `immutable`) cache, so nobody
      // keeps the original once the converted file is in place.
      const meta = completion.converts('video') ? await describe(artifactId) : null;
      const converting = meta !== null && completion.converts(meta.kind) && !meta.converted;
      await serveResolution(req, res, resolved, converting);
    } catch (err) {
      failClosed(res, err, 'artifact get');
    }
  };

  /**
   * Stream or redirect to a resolved artifact — the tail of the GET route, shared with the poster
   * route. An artifact URL names immutable bytes once finished, so it takes the configured
   * `cache`; the poster URL is a lookup whose answer changes when a newer thumbnail lands, and a
   * video still being converted is about to change, so those are revalidated on every request
   * (`mustRevalidate`).
   */
  const serveResolution = async (
    req: IncomingMessage,
    res: ServerResponse,
    resolved: PulseVaultResolution,
    mustRevalidate = false,
  ): Promise<void> => {
    if (resolved.kind === 'redirect') {
      res.writeHead(resolved.statusCode ?? 302, {
        Location: resolved.url,
        ...(mustRevalidate ? { 'cache-control': 'no-store' } : {}),
      });
      res.end();
      return;
    }

    const cacheOptions = mustRevalidate
      ? { cacheControl: true, maxAge: 0, immutable: false }
      : cache;
    const result = await send(req, resolved.filename, { root: resolved.root, ...cacheOptions });

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
  };

  /** The declared length and bytes received of an upload, from tus's own record. */
  const uploadProgress = async (
    meta: PulseVaultArtifactMeta,
  ): Promise<{ size?: number; bytesReceived?: number }> => {
    try {
      const upload = await storage.datastore.getUpload(`${meta.kind}/${meta.artifactId}${meta.ext}`);
      return {
        ...(typeof upload.size === 'number' ? { size: upload.size } : {}),
        ...(typeof upload.offset === 'number' ? { bytesReceived: upload.offset } : {}),
      };
    } catch {
      return {};
    }
  };

  const getStatus = async (artifactId: string): Promise<PulseVaultArtifactStatus> => {
    const meta = isUuid(artifactId) ? await describe(artifactId) : null;
    if (!meta) return { artifactId, state: 'unknown' };
    const state = !meta.ready
      ? 'uploading'
      : completion.converts(meta.kind) && !meta.converted
        ? 'processing'
        : 'ready';
    return {
      artifactId,
      state,
      kind: meta.kind,
      ...(meta.relatedTo ? { relatedTo: meta.relatedTo } : {}),
      ...(meta.name ? { name: meta.name } : {}),
      ...(await uploadProgress(meta)),
      acknowledged: meta.acknowledged,
      ...(meta.webReady ? { webReady: meta.webReady } : {}),
      ...(meta.outcome !== undefined ? { outcome: meta.outcome } : {}),
      ...(meta.context !== undefined ? { context: meta.context } : {}),
    };
  };

  const getPulse = async (artifactId: string): Promise<PulseVaultPulse> => {
    const video = isUuid(artifactId) ? await describe(artifactId) : null;
    const pulse: PulseVaultPulse = { video };
    if (!video || typeof storage.listRelated !== 'function') return pulse;
    for await (const record of storage.listRelated(artifactId)) {
      if (!record.ready) continue;
      const slot =
        record.kind === 'thumbnail'
          ? 'thumbnail'
          : record.kind === 'captions'
            ? 'captions'
            : record.kind === 'project'
              ? 'manifest'
              : null;
      if (!slot) continue;
      // One per kind: a pulse uploads each once, and a retry that re-sent one is the newer —
      // by when it finished (`readyAt`), which later bookkeeping never moves.
      const meta = await describe(record.artifactId);
      if (!meta) continue;
      const current = pulse[slot];
      if (current && (current.readyAt ?? current.updatedAt) >= (meta.readyAt ?? meta.updatedAt)) continue;
      pulse[slot] = meta;
    }
    return pulse;
  };

  const recordOutcome = async (artifactId: string, outcome: unknown): Promise<boolean> => {
    if (typeof storage.patchArtifact !== 'function') {
      throw new TypeError('recordOutcome needs a storage adapter with `patchArtifact`');
    }
    if (!isUuid(artifactId)) return false;
    return storage.patchArtifact(artifactId, { outcome: outcome === undefined ? null : outcome });
  };

  /**
   * `GET /artifacts/:artifactId/status`: where an upload is, for a page waiting on it. Authorized
   * as `status`, which `createCapabilityAuthorize` grants to the pairing token and to a view token.
   */
  const handleStatus = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ): Promise<void> => {
    stampProtocolVersion(res);
    if (rejectOutdatedClient(req, res)) return;
    try {
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'status', token);
      if (!prepared) return;
      res.setHeader('cache-control', 'no-store');
      // The token's context is the host's data about the upload, not the viewer's business.
      const { context: _context, ...status } = await getStatus(artifactId);
      writeJson(res, 200, status);
    } catch (err) {
      failClosed(res, err, 'artifact status');
    }
  };

  /**
   * `GET /artifacts/:artifactId/poster`: the finished thumbnail `relatedTo` the video, served as
   * the artifact route would serve it. Authorized as `resolve` on the video, so whoever may watch
   * it may see its poster. 404 until the poster has landed.
   */
  const handlePoster = async (
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    token: string | undefined,
  ): Promise<void> => {
    stampProtocolVersion(res);
    if (rejectOutdatedClient(req, res)) return;
    try {
      const prepared = await prepareArtifactRequest(req, res, artifactId, 'resolve', token);
      if (!prepared) return;
      const { thumbnail } = await getPulse(artifactId);
      const resolved = thumbnail ? await storage.resolve(thumbnail.artifactId) : null;
      if (!resolved) {
        res.setHeader('cache-control', 'no-store');
        writeJson(res, 404, pulseVaultError('No poster for this artifact'));
        return;
      }
      await serveResolution(req, res, resolved, true);
    } catch (err) {
      failClosed(res, err, 'artifact poster');
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
    const viewLinkMatch = pathname.match(/^\/artifacts\/([^/]+)\/view-link$/);
    if (viewLinkMatch?.[1] && req.method === 'POST') {
      await handleViewLink(req, res, viewLinkMatch[1]);
      return;
    }
    const statusMatch = pathname.match(/^\/artifacts\/([^/]+)\/status$/);
    if (statusMatch?.[1] && req.method === 'GET') {
      await handleStatus(req, res, statusMatch[1], url.searchParams.get('token') ?? undefined);
      return;
    }
    const posterMatch = pathname.match(/^\/artifacts\/([^/]+)\/poster$/);
    if (posterMatch?.[1] && req.method === 'GET') {
      await handlePoster(req, res, posterMatch[1], url.searchParams.get('token') ?? undefined);
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
      await retentionSweep?.stop();
      await completion.stop();
      await storage.shutdown?.();
    },
    handleTus,
    handleCapabilities,
    handleArtifactGet,
    handleViewLink,
    handleArtifactDelete,
    handleStatus,
    handlePoster,
    getStatus,
    getPulse,
    recordOutcome,
    replayCompletions: () => completion.replay(),
    conformAvailable: () =>
      options.webReady
        ? webReadyAvailable(typeof options.webReady === 'object' ? options.webReady : {})
        : Promise.resolve(false),
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
  PulseVaultArtifactMeta,
  PulseVaultArtifactPatch,
  PulseVaultArtifactRecord,
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from './storage/types.js';
export type {
  PulseVaultAuthorize,
  PulseVaultAuthorizeContext,
  PulseVaultAuthorizePhase,
  PulseVaultAuthorizeResult,
} from './lib/authorize.js';
export type {
  PulseVaultOnUploadComplete,
  PulseVaultUploadCompleteContext,
  PulseVaultOnArtifactEvent,
  PulseVaultArtifactEvent,
} from './lib/pulsevaultTus.js';
export type { PulseVaultWebReadyOptions, PulseVaultReplayOptions } from './lib/completion.js';
export { sniffMp4, createMp4Sniffer, createS3Mp4Sniffer, sniffVideo, createVideoValidator } from './lib/magic.js';
export type { VideoValidatorOptions } from './lib/magic.js';
export type { PulseVaultValidatePayload } from './lib/magic.js';
export {
  ensureWebReady,
  scanMoovPosition,
  probeVideo,
  webReadyAvailable,
  CONFORM_TARGET,
  CONFORM_VIDEO_EXTENSIONS,
} from './lib/web-ready.js';
export type { WebReadyAction, WebReadyOptions, WebReadyResult, MoovPosition, VideoProbe } from './lib/web-ready.js';
export { buildUploadLink } from './lib/deeplinks.js';
export type { UploadLinkOptions } from './lib/deeplinks.js';
export {
  issueCapabilityToken,
  verifyCapabilityToken,
  issueViewToken,
  verifyViewToken,
  createCapabilityAuthorize,
} from './lib/capability-token.js';
export type {
  CapabilityTokenClaims,
  IssueCapabilityTokenOptions,
  IssueViewTokenOptions,
  VerifyCapabilityTokenOptions,
  LookupSecret,
} from './lib/capability-token.js';
export { createViewLinkIssuer } from './lib/view-links.js';
export { sweepAbandonedUploads } from './lib/retention.js';
export type { PulseVaultRetentionOptions } from './lib/retention.js';
export type {
  PulseVaultIssueViewLink,
  PulseVaultViewLink,
  PulseVaultViewLinkContext,
  ViewLinkIssuerOptions,
} from './lib/view-links.js';
export {
  createChecksumValidator,
  createS3ChecksumValidator,
  parseChecksumMetadata,
} from './lib/checksum.js';
export type { ChecksumAlgorithm, ParsedChecksum } from './lib/checksum.js';
export { type PulseVaultRequest, type PulseVaultLogger } from './lib/request.js';
