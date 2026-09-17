import { isUuid } from './uuid.js';
import { decodeUploadMetadataHeader, normalizeUploadMetadata } from './upload-metadata.js';
import { errorMessage, pulseVaultError, statusCodeOf, type PulseVaultErrorBody } from './errors.js';
import type { PulseVaultAuthorize } from './authorize.js';
import type { PulseVaultLogger, PulseVaultRequest } from './request.js';
import type { PulseVaultOnArtifactEvent } from './pulsevaultTus.js';
import type { PulseVaultStorage, UploadKind } from '../storage/types.js';

/**
 * Request-interpretation helpers shared by every transport surface — the
 * Node core (`core.ts`), the web-standard core (`web.ts`), and through them
 * the Fastify adapter. These decide WHICH artifact a request is about before
 * any authorization or storage work happens, so they must exist exactly once:
 * two surfaces disagreeing here is the URL-smuggling bug class all over again.
 */

/**
 * Pull `artifactId` (or the legacy `videoid`/`projectid` aliases), `kind`,
 * and `relatedTo` out of a raw `Upload-Metadata` header. Decoding and alias
 * precedence live in `upload-metadata.ts`, shared with `namingFunction` in
 * `pulsevaultTus.ts` — the function that decides what's actually reserved and
 * written to storage — so the artifactId `authorize()` validates can never
 * diverge from the one the upload lands under.
 */
export function parseUploadMetadataHeader(header: string): {
  artifactId: string | undefined;
  kind: UploadKind;
  relatedTo: string | undefined;
} {
  const normalized = normalizeUploadMetadata(decodeUploadMetadataHeader(header));
  return {
    artifactId: isUuid(normalized.artifactId) ? normalized.artifactId : undefined,
    kind: normalized.kind,
    relatedTo: normalized.relatedTo,
  };
}

/**
 * `@tus/server`'s `BaseHandler.getFileIdFromRequest` — the function that
 * ultimately decides which upload a PATCH/HEAD/DELETE actually operates on —
 * extracts its file id from the request URL's *last* `/`-delimited segment
 * (`reExtractFileID = /([^/]+)\/?$/`), not from the first segment after
 * `/upload/`. This MUST mirror that exact regex: a URL with extra path
 * segments after the real id (a wildcard route accepts them) would otherwise
 * let `authorize()` see and approve one artifactId while `@tus/server` writes
 * the request body against a *different* one — an attacker holding a valid
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
 * Parse the artifactId UUID from a tus upload id of the form
 * `<kind>/<artifactId><ext>` (the shape `namingFunction` in `pulsevaultTus.ts`
 * produces). Lives HERE — not in `pulsevaultTus.ts` — because this module is
 * in the web entry's always-loaded dependency graph, which must stay free of
 * Node-only imports; `pulsevaultTus.ts` (→ `@tus/server`, `node:async_hooks`)
 * imports it back so the two parsers are one function.
 */
export function artifactIdFromUploadId(id: string): string | undefined {
  // Exactly the two segments `namingFunction` generates — anything longer
  // (e.g. `video/<uuid>.mp4/extra`) would make this parser authorize one id
  // while @tus/server's datastore operates on the full decoded string.
  const segments = id.split('/');
  if (segments.length !== 2 || !segments[1]) return undefined;
  const nameWithExt = segments[1];
  // `path.extname` semantics without `node:path`: no dot / only a leading dot → no ext.
  const dot = nameWithExt.lastIndexOf('.');
  const candidate = dot > 0 ? nameWithExt.slice(0, dot) : nameWithExt;
  return isUuid(candidate) ? candidate : undefined;
}

/**
 * Decode the tus file id (base64url-encoded, shaped `<kind>/<artifactId><ext>`
 * by `namingFunction` in `pulsevaultTus.ts`) that `@tus/server` itself will
 * resolve a PATCH/HEAD/DELETE request to, and recover the artifactId via the
 * exact same parser `onUploadFinish` uses — so this can never drift from what
 * `@tus/server` actually operates on. See `tusLastUrlSegment` above for why
 * this must match the *last* URL segment.
 */
export function artifactIdFromTusUrl(url: string): string | undefined {
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
 * Resolve the artifact kind for an artifactId from storage. Adapters without
 * `getKind` (or that don't know the id) resolve to `"video"`.
 */
export async function resolveStorageKind(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<UploadKind> {
  return (await storage.getKind?.(artifactId)) ?? 'video';
}

/** Resolve the `relatedTo` artifact for an artifactId from storage, if the adapter supports it. */
export async function resolveStorageRelatedTo(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<string | undefined> {
  return (await storage.getRelatedTo?.(artifactId)) ?? undefined;
}

/** Message an authorize rejection surfaces to the client. */
export const extractAuthzMessage = (err: unknown): string => errorMessage(err, 'Forbidden');

/** The identity of the artifact a request is about — one storage read where the adapter has `getMetadata`. */
export type ArtifactIdentity = { kind: UploadKind; relatedTo: string | undefined };

export async function resolveArtifactIdentity(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<ArtifactIdentity> {
  if (storage.getMetadata) {
    const meta = await storage.getMetadata(artifactId);
    return { kind: meta?.kind ?? 'video', relatedTo: meta?.relatedTo };
  }
  return {
    kind: await resolveStorageKind(storage, artifactId),
    relatedTo: await resolveStorageRelatedTo(storage, artifactId),
  };
}

/** What an authorize decision needs: the hook, the storage identity comes from, and the ops sinks. */
export type AuthorizeDeps = {
  storage: PulseVaultStorage;
  authorize?: PulseVaultAuthorize;
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  logger: PulseVaultLogger;
};

/** An authorize outcome as data — each transport renders the rejection in its own response type. */
export type AuthorizeDecision<T> =
  | ({ ok: true } & T)
  | { ok: false; statusCode: number; body: PulseVaultErrorBody };

async function runAuthorize(
  deps: AuthorizeDeps,
  request: PulseVaultRequest,
  ctx: Parameters<PulseVaultAuthorize>[1],
  emitEvent: boolean,
): Promise<{ ok: true } | { ok: false; statusCode: number; body: PulseVaultErrorBody }> {
  try {
    await deps.authorize?.(request, ctx);
    return { ok: true };
  } catch (err) {
    const statusCode = statusCodeOf(err, 403);
    const message = extractAuthzMessage(err);
    const { artifactId, phase, kind } = ctx;
    deps.logger.info({ err, artifactId, phase, statusCode }, 'pulsevault authorize rejected');
    if (emitEvent) {
      await deps.onArtifactEvent?.({ phase: 'authorize', artifactId, kind, reason: message });
    }
    return { ok: false, statusCode, body: pulseVaultError(message) };
  }
}

/**
 * The authorize decision for a TUS request — ONE function for every surface,
 * so the phase derivation, the OPTIONS preflight bypass, the PROTOCOL §5.2
 * unresolvable-id rule, the rejection mapping, the log line, and the event
 * can't drift between the Node core and the web core (two hand-mirrored
 * copies is how the preflight bypass ended up on only one of them).
 * Transport glue renders the result; it makes no decisions of its own.
 */
export async function authorizeTusRequest(
  deps: AuthorizeDeps,
  request: PulseVaultRequest,
  input: { method: string | undefined; url: string; uploadMetadata: string | undefined },
): Promise<AuthorizeDecision<{ artifactId: string | undefined } & ArtifactIdentity>> {
  const none = { artifactId: undefined, kind: 'video' as const, relatedTo: undefined };
  // OPTIONS is the tus capabilities/CORS preflight — no artifact, no bytes,
  // and browsers can't attach the bearer header to it. Let @tus/server answer.
  if (input.method === 'OPTIONS') return { ok: true, ...none };
  const phase = input.method === 'POST' ? 'create' : 'patch';
  let identity: { artifactId: string | undefined } & ArtifactIdentity = none;
  if (phase === 'create') {
    if (input.uploadMetadata) identity = parseUploadMetadataHeader(input.uploadMetadata);
  } else {
    const artifactId = artifactIdFromTusUrl(input.url);
    if (artifactId) {
      identity = { artifactId, ...(await resolveArtifactIdentity(deps.storage, artifactId)) };
    }
  }
  if (!deps.authorize) return { ok: true, ...identity };
  const { artifactId, kind, relatedTo } = identity;
  if (!artifactId) {
    if (phase === 'create') return { ok: true, ...identity };
    // PROTOCOL.md §5.2: an unresolvable artifactId on an in-flight request is
    // an authorization failure — reject, don't fall through to "nothing to check".
    deps.logger.info({ url: input.url, phase }, 'pulsevault authorize rejected: unresolvable artifactId');
    return {
      ok: false,
      statusCode: 403,
      body: pulseVaultError('Unable to resolve artifact for authorization'),
    };
  }
  // Rejections at create are events (the client is asking for a new artifact); per-chunk
  // PATCH rejections are not, or a rejected upload would spam one event per chunk.
  const decision = await runAuthorize(
    deps,
    request,
    { phase, artifactId, kind, relatedTo },
    phase === 'create',
  );
  return decision.ok ? { ok: true, ...identity } : decision;
}

/** The same decision for the artifact GET/HEAD/DELETE routes: UUID check, identity, `authorize` for the phase. */
export async function authorizeArtifactRequest(
  deps: AuthorizeDeps,
  request: PulseVaultRequest,
  input: { artifactId: string; phase: 'resolve' | 'delete'; token?: string },
): Promise<AuthorizeDecision<ArtifactIdentity>> {
  const { artifactId, phase, token } = input;
  if (!isUuid(artifactId)) {
    return { ok: false, statusCode: 400, body: pulseVaultError('`artifactId` must be a valid UUID') };
  }
  const identity = await resolveArtifactIdentity(deps.storage, artifactId);
  const decision = await runAuthorize(deps, request, { phase, artifactId, ...identity, token }, true);
  return decision.ok ? { ok: true, ...identity } : decision;
}
