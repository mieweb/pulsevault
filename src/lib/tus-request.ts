import { isUuid } from './uuid.js';
import { decodeUploadMetadataHeader, normalizeUploadMetadata } from './upload-metadata.js';
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
  const [, nameWithExt] = id.split('/');
  if (!nameWithExt) return undefined;
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
export function extractAuthzMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Forbidden';
}
