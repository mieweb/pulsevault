import parseRange from 'range-parser';
import type {
  PulseVaultOnUploadComplete,
  PulseVaultOnArtifactEvent,
} from './lib/pulsevaultTus.js';
import type { PulseVaultValidatePayload } from './lib/magic.js';
import type { PulseVaultAuthorize } from './lib/authorize.js';
import { pulseVaultError, statusCodeOf } from './lib/errors.js';
import { isUuid } from './lib/uuid.js';
import { type PulseVaultLogger, type PulseVaultRequest, consoleLogger } from './lib/request.js';
import type { PulseVaultStorage, UploadKind } from './storage/types.js';
import { buildCapabilitiesPayload, PROTOCOL_VERSION } from './lib/capabilities.js';
import {
  artifactIdFromTusUrl,
  extractAuthzMessage,
  parseUploadMetadataHeader,
  resolveStorageKind,
  resolveStorageRelatedTo,
} from './lib/tus-request.js';
import {
  directUploadCreate,
  directUploadComplete,
  type DirectUploadDeps,
} from './lib/direct-upload.js';
import {
  normalizeAllowedExtensions,
  validateBasePath,
  validateMaxUploadSize,
  validateAllowedExtensions,
  type PulseVaultAllowedExtensionsInput,
} from './lib/options.js';

/**
 * Web-standard (WHATWG `Request` → `Response`) core — the same
 * authorize/validate/complete orchestration, tus glue, capabilities payload,
 * artifact serving, and direct-upload endpoints as the Node core in
 * `core.ts`, but speaking fetch primitives instead of `http.IncomingMessage`/
 * `ServerResponse`. This is what runs on Bun, Deno, and edge/serverless
 * runtimes, and what makes framework mounting one line:
 *
 * ```ts
 * // Hono (any runtime it supports):
 * const vault = createPulseVaultWebHandler({ basePath: "/pulsevault", storage, maxUploadSize });
 * app.all("/pulsevault/*", (c) => vault.handler(c.req.raw));
 *
 * // Bun:
 * Bun.serve({ fetch: (req) => vault.handler(req) });
 * ```
 *
 * Caveats vs the Node core:
 * - The TUS surface (`/upload`) requires a Node-compatible runtime: the tus
 *   stack (`@tus/server` + the datastores) needs `node:async_hooks`,
 *   `node:path`, and — for local storage — `node:fs`. It is loaded lazily on
 *   the first TUS request, so on a runtime without those modules this handler
 *   still serves capabilities, direct uploads, and artifact playback (with the
 *   S3/R2 adapter, whose playback is a presigned redirect); TUS requests fail
 *   with a 500 there. For a pure V8 isolate (Cloudflare Workers), use the
 *   direct-upload control-plane pattern in `examples/workers-demo` instead.
 * - Local-filesystem serving needs `node:fs` (Node/Bun/Deno; on
 *   filesystem-less edge runtimes use the S3/R2 adapter).
 * - Uses its own minimal Range implementation (via the maintained
 *   `range-parser`) rather than `@fastify/send` — single ranges only, which
 *   is what real video players send.
 */

export type PulseVaultWebOptions = {
  /** Storage adapter. Use `createS3Storage(...)` on filesystem-less runtimes. */
  storage: PulseVaultStorage;
  /** URL path prefix the handler is mounted under, e.g. `"/pulsevault"`. `""` for the root. */
  basePath: string;
  /** Max TUS upload size in bytes. Required. Use `Infinity` for no cap. */
  maxUploadSize: number;
  /** File extensions allowed per artifact kind. Same shape as the Node core. */
  allowedExtensions?: PulseVaultAllowedExtensionsInput;
  /** Optional authorization hook — same contract as the Node core. */
  authorize?: PulseVaultAuthorize;
  /** Optional payload-validation hook — same contract as the Node core. */
  validatePayload?: PulseVaultValidatePayload;
  /** Optional post-upload hook — same contract as the Node core. */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /** Optional low-frequency event hook — same contract as the Node core. */
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  /** Logger for internal diagnostics. Defaults to `console`. */
  logger?: PulseVaultLogger;
};

export type PulseVaultWebHandler = {
  /** Fetch-style handler: route any request under `basePath` to it. Unmatched paths get a 404 Response. */
  handler: (request: Request) => Promise<Response>;
  /** One-time teardown — calls `storage.shutdown?.()`. */
  shutdown: () => Promise<void>;
};

/** Cap for small JSON request bodies — mirrors the Node core's `readJsonBody` limit. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

/** Buffer a request body, aborting with `BodyTooLarge` once it exceeds `limit` bytes. */
async function readBodyCapped(request: Request, limit: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Project a web `Request`'s headers into the `{ headers }` record shape every hook takes. */
function toPulseVaultRequest(request: Request): PulseVaultRequest {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { headers };
}

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Protocol-Version': String(PROTOCOL_VERSION),
    },
  });
}

function text(statusCode: number, body: string): Response {
  return new Response(body, {
    status: statusCode,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'Protocol-Version': String(PROTOCOL_VERSION),
    },
  });
}

/** Every response carries the wire protocol version — same rule as the Node core. */
function stampProtocolVersion(res: Response): Response {
  if (res.headers.get('Protocol-Version')) return res;
  const headers = new Headers(res.headers);
  headers.set('Protocol-Version', String(PROTOCOL_VERSION));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function createPulseVaultWebHandler(options: PulseVaultWebOptions): PulseVaultWebHandler {
  validateBasePath(options.basePath, 'basePath');
  validateMaxUploadSize(options.maxUploadSize);
  validateAllowedExtensions(options.allowedExtensions);

  const { storage, basePath, maxUploadSize, authorize, onArtifactEvent } = options;
  const allowedExtensions = normalizeAllowedExtensions(options.allowedExtensions);
  // The web surface is new — it never had the deprecated per-kind hooks, so
  // there's nothing to compose or warn about.
  const validatePayload = options.validatePayload;
  const onUploadComplete = options.onUploadComplete;
  const logger = options.logger ?? consoleLogger;

  // The tus stack is the one piece of this module with hard Node-API
  // dependencies (`@tus/server` → node:async_hooks/node:path). Loading it
  // lazily — once, on the first TUS request — keeps this entry importable on
  // runtimes without Node compatibility, where the capabilities, direct-upload,
  // and artifact routes (S3/R2 redirects) are fully serviceable on their own.
  type TusModule = typeof import('./lib/pulsevaultTus.js');
  let tusRuntime: Promise<{
    tusServer: ReturnType<TusModule['createPulsevaultTusServer']>;
    tusContext: TusModule['pulseVaultTusContext'];
  }> | null = null;
  const loadTusRuntime = () =>
    (tusRuntime ??= import('./lib/pulsevaultTus.js').then((m) => ({
      tusServer: m.createPulsevaultTusServer({
        storage,
        tusPath: `${basePath}/upload`,
        maxSize: maxUploadSize,
        allowedExtensions,
        validatePayload,
        onUploadComplete,
        onArtifactEvent,
        logger,
      }),
      tusContext: m.pulseVaultTusContext,
    })));

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

  /** Run `authorize` for a TUS request; returns a rejection Response, or null to proceed. */
  const runTusAuthorize = async (
    request: Request,
    pathname: string,
  ): Promise<{ response: Response | null; artifactId?: string }> => {
    // OPTIONS is the tus capabilities/CORS preflight — no artifact, no bytes,
    // and browsers can't attach the bearer header to it. Let @tus/server answer.
    if (request.method === 'OPTIONS') return { response: null };
    const phase: 'create' | 'patch' = request.method === 'POST' ? 'create' : 'patch';
    let artifactId: string | undefined;
    let kind: UploadKind = 'video';
    let relatedTo: string | undefined;
    if (phase === 'create') {
      const meta = request.headers.get('upload-metadata');
      if (meta) ({ artifactId, kind, relatedTo } = parseUploadMetadataHeader(meta));
    } else {
      artifactId = artifactIdFromTusUrl(pathname);
      if (artifactId) {
        kind = await resolveStorageKind(storage, artifactId);
        relatedTo = await resolveStorageRelatedTo(storage, artifactId);
      }
    }

    if (!authorize) return { response: null, artifactId };

    if (!artifactId && phase === 'patch') {
      // PROTOCOL.md §5.2: an unresolvable artifactId on an in-flight request
      // is an authorization failure, not a pass.
      logger.info(
        { url: pathname, phase },
        'pulsevault authorize rejected: unresolvable artifactId',
      );
      return {
        response: json(403, pulseVaultError('Unable to resolve artifact for authorization')),
      };
    }
    if (!artifactId) return { response: null, artifactId };

    try {
      await authorize(toPulseVaultRequest(request), { phase, artifactId, kind, relatedTo });
      return { response: null, artifactId };
    } catch (err) {
      const statusCode = statusCodeOf(err, 403);
      const message = extractAuthzMessage(err);
      logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
      if (phase === 'create') {
        await onArtifactEvent?.({ phase: 'authorize', artifactId, kind, reason: message });
      }
      return { response: json(statusCode, pulseVaultError(message)) };
    }
  };

  const handleTus = async (request: Request, pathname: string): Promise<Response> => {
    try {
      const { tusServer, tusContext } = await loadTusRuntime();
      const authz = await runTusAuthorize(request, pathname);
      if (authz.response) return authz.response;
      const response = await tusContext.run(
        { request: toPulseVaultRequest(request), artifactId: authz.artifactId },
        () => tusServer.handleWeb(request),
      );
      return stampProtocolVersion(response);
    } catch (err) {
      logger.error({ err }, 'pulsevault tus handler failed');
      return text(500, 'Internal Server Error');
    }
  };

  /** Shared authorize prelude for artifact GET/HEAD/DELETE. */
  const prepareArtifactRequest = async (
    request: Request,
    artifactId: string,
    phase: 'resolve' | 'delete',
    token?: string,
  ): Promise<Response | null> => {
    if (!isUuid(artifactId)) {
      return json(400, pulseVaultError('`artifactId` must be a valid UUID'));
    }
    if (!authorize) return null;
    const kind = await resolveStorageKind(storage, artifactId);
    const relatedTo = await resolveStorageRelatedTo(storage, artifactId);
    try {
      await authorize(toPulseVaultRequest(request), { phase, artifactId, kind, relatedTo, token });
      return null;
    } catch (err) {
      const statusCode = statusCodeOf(err, 403);
      const message = extractAuthzMessage(err);
      logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
      await onArtifactEvent?.({ phase: 'authorize', artifactId, kind, reason: message });
      return json(statusCode, pulseVaultError(message));
    }
  };

  /**
   * Stream a local file as a web Response with single-Range support (what
   * video players actually send: `bytes=a-b`, `bytes=a-`, `bytes=-n`).
   * `node:fs`/`node:stream` are imported lazily so this module can load on
   * runtimes without a filesystem — the S3/R2 adapter's redirect path never
   * reaches here.
   */
  const streamLocalFile = async (
    request: Request,
    absolutePath: string,
    contentType: string,
  ): Promise<Response> => {
    const [{ createReadStream }, { stat }, { Readable }] = await Promise.all([
      import('node:fs'),
      import('node:fs/promises'),
      import('node:stream'),
    ]);
    let size: number;
    try {
      const st = await stat(absolutePath);
      if (!st.isFile()) return json(404, pulseVaultError('Artifact not found'));
      size = st.size;
    } catch {
      return json(404, pulseVaultError('Artifact not found'));
    }

    const baseHeaders: Record<string, string> = {
      'content-type': contentType,
      // Serving user-uploaded bytes — never let a browser second-guess the vetted type.
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'Protocol-Version': String(PROTOCOL_VERSION),
    };

    let start = 0;
    let end = size - 1;
    let status = 200;
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const parsed = parseRange(size, rangeHeader, { combine: true });
      // -1: unsatisfiable → 416 with the total size, per RFC 9110 §14.4.
      if (parsed === -1) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
        });
      }
      // -2 (malformed) or a non-bytes unit: ignore the header, serve 200. A
      // disjoint multi-range request (`combine: true` already merged adjacent/
      // overlapping ones) also gets the full 200 — this handler serves single
      // ranges only, and answering 206 with just the first range would silently
      // drop the rest.
      if (parsed !== -2 && parsed.type === 'bytes' && parsed.length === 1) {
        const first = parsed[0]!;
        start = first.start;
        end = first.end;
        status = 206;
        baseHeaders['content-range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    baseHeaders['content-length'] = String(end - start + 1);

    if (request.method === 'HEAD') {
      return new Response(null, { status, headers: baseHeaders });
    }

    // Nothing to stream for a zero-byte artifact (a valid TUS upload) — and
    // `fs.createReadStream` rejects `end: -1` outright — so return the empty
    // body the headers above already describe.
    if (end < start) {
      return new Response(null, { status, headers: baseHeaders });
    }

    const nodeStream = createReadStream(absolutePath, { start, end });
    const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return new Response(body, { status, headers: baseHeaders });
  };

  const handleArtifactGet = async (
    request: Request,
    artifactId: string,
    token: string | undefined,
  ): Promise<Response> => {
    try {
      const rejected = await prepareArtifactRequest(request, artifactId, 'resolve', token);
      if (rejected) return rejected;
      const resolved = await storage.resolve(artifactId);
      if (!resolved) return json(404, pulseVaultError('Artifact not found'));
      if (resolved.kind === 'redirect') {
        return new Response(null, {
          status: resolved.statusCode ?? 302,
          headers: { location: resolved.url, 'Protocol-Version': String(PROTOCOL_VERSION) },
        });
      }
      // Lazy import keeps node:path off edge runtimes' critical path too.
      const { join } = await import('node:path');
      return await streamLocalFile(
        request,
        join(resolved.root, resolved.filename),
        resolved.contentType ?? 'application/octet-stream',
      );
    } catch (err) {
      logger.error({ err }, 'pulsevault artifact get failed');
      return text(500, 'Internal Server Error');
    }
  };

  const handleArtifactDelete = async (request: Request, artifactId: string): Promise<Response> => {
    try {
      const rejected = await prepareArtifactRequest(request, artifactId, 'delete');
      if (rejected) return rejected;
      if (typeof storage.remove !== 'function') {
        return json(501, pulseVaultError('Storage adapter does not support delete'));
      }
      const removed = await storage.remove(artifactId);
      if (!removed) return json(404, pulseVaultError('Artifact not found'));
      return new Response(null, {
        status: 204,
        headers: { 'Protocol-Version': String(PROTOCOL_VERSION) },
      });
    } catch (err) {
      logger.error({ err }, 'pulsevault artifact delete failed');
      return text(500, 'Internal Server Error');
    }
  };

  const handler = async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return text(400, 'Bad Request');
    }
    let pathname = url.pathname;
    if (basePath !== '') {
      if (pathname === basePath) {
        pathname = '';
      } else if (pathname.startsWith(`${basePath}/`)) {
        pathname = pathname.slice(basePath.length);
      } else {
        return text(404, 'Not Found');
      }
    }
    if (pathname === '') pathname = '/';

    if (pathname === '/upload' || pathname.startsWith('/upload/')) {
      return handleTus(request, url.pathname);
    }
    if (pathname === '/capabilities' && request.method === 'GET') {
      return json(200, buildCapabilitiesPayload({ allowedExtensions, maxUploadSize, storage }));
    }
    if (pathname === '/direct-uploads' && request.method === 'POST') {
      try {
        // Same 64 KiB cap as the Node core's readJsonBody — these bodies are a
        // few hundred bytes, and an uncapped request.json() would buffer an
        // arbitrarily large body into memory before parsing (worst on the edge
        // runtimes this handler exists for). Content-Length-declared bodies
        // fail fast; chunked ones are capped while streaming.
        const declared = Number(request.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
          return json(413, pulseVaultError('Request body too large'));
        }
        let raw: Uint8Array;
        try {
          raw = new Uint8Array(await readBodyCapped(request, MAX_JSON_BODY_BYTES));
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            return json(413, pulseVaultError('Request body too large'));
          }
          throw err;
        }
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return json(400, pulseVaultError('Request body must be JSON'));
        }
        const result = await directUploadCreate(directDeps, toPulseVaultRequest(request), body);
        return json(result.statusCode, result.body);
      } catch (err) {
        logger.error({ err }, 'pulsevault direct-upload create failed');
        return text(500, 'Internal Server Error');
      }
    }
    const completeMatch = pathname.match(/^\/direct-uploads\/([^/]+)\/complete$/);
    if (completeMatch?.[1] && request.method === 'POST') {
      try {
        const result = await directUploadComplete(
          directDeps,
          toPulseVaultRequest(request),
          // No decode: valid ids are plain UUIDs, and decodeURIComponent on a
          // malformed escape would throw into the 500 path for what is 400 input.
          completeMatch[1],
        );
        return json(result.statusCode, result.body);
      } catch (err) {
        logger.error({ err }, 'pulsevault direct-upload complete failed');
        return text(500, 'Internal Server Error');
      }
    }
    const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
    if (artifactMatch?.[1]) {
      // No decode — same reasoning as the complete route above.
      const artifactId = artifactMatch[1];
      if (request.method === 'GET' || request.method === 'HEAD') {
        return handleArtifactGet(request, artifactId, url.searchParams.get('token') ?? undefined);
      }
      if (request.method === 'DELETE') {
        return handleArtifactDelete(request, artifactId);
      }
    }
    return text(404, 'Not Found');
  };

  return {
    handler,
    shutdown: async () => {
      await storage.shutdown?.();
    },
  };
}
