import { isUuid } from './uuid.js';
import type { UploadKind } from '../storage/types.js';
import { parseUploadKind } from '../storage/types.js';

/**
 * THE single implementation of Upload-Metadata field normalization — most
 * importantly the artifactId alias precedence (`artifactId` beats the legacy
 * `videoid` beats `projectid`). Both the authorize path (`core.ts`, parsing
 * the raw header before @tus/server runs) and the reserve path
 * (`namingFunction` in `pulsevaultTus.ts`, receiving @tus/server's decoded
 * record) MUST resolve the same artifactId for the same request — if they
 * disagreed, `authorize()` could approve ownership of a different artifact
 * than the one the upload actually lands under. Keeping the rule in one
 * function makes that divergence impossible rather than merely commented
 * against.
 */

/**
 * Defensive upper bound on the stored display `name`. The header is base64 and
 * comma-joined with the other metadata; a runaway value would bloat every
 * request and every sidecar. 512 chars is far more than any real title and
 * still leaves generous headroom under typical proxy header limits. The client
 * should cap first; this is belt-and-suspenders so the server never trusts it.
 */
export const MAX_ARTIFACT_NAME_LENGTH = 512;

export type NormalizedUploadMetadata = {
  /**
   * Alias-resolved, trimmed artifactId candidate — NOT validated. Callers
   * apply their own policy: the reserve path 400s a non-UUID, the authorize
   * path treats it as "no artifactId present".
   */
  artifactId: string;
  filename: string;
  kind: UploadKind;
  /** Validated UUID or undefined. */
  relatedTo?: string;
  /** Raw `<algorithm>:<hex>` value, trimmed; undefined when empty/absent. */
  checksum?: string;
  /** Display title, trimmed and code-point-capped; undefined when empty/absent. */
  name?: string;
};

/**
 * Normalize a decoded Upload-Metadata record (as produced by @tus/server's
 * metadata parser, or by `decodeUploadMetadataHeader` below).
 */
export function normalizeUploadMetadata(
  metadata: Record<string, string | null | undefined> | undefined,
): NormalizedUploadMetadata {
  // Accept `artifactId` plus the legacy `videoid`/`projectid` aliases for
  // back-compat with pre-`artifactId` clients. Fixed priority regardless of
  // header order.
  const artifactId = (
    metadata?.artifactId ??
    metadata?.videoid ??
    metadata?.projectid ??
    ''
  ).trim();
  const filename = (metadata?.filename ?? '').trim();
  // `kind` defaults to `"video"` so existing clients that don't send the field keep working.
  const kind = parseUploadKind(metadata?.kind);
  const rawRelatedTo = (metadata?.relatedTo ?? '').trim();
  const relatedTo = isUuid(rawRelatedTo) ? rawRelatedTo : undefined;
  const checksum = (metadata?.checksum ?? '').trim() || undefined;
  // Free-form display title. Trim, then hard-cap length so a hostile or buggy
  // client can't bloat the sidecar; an all-whitespace/empty value is dropped.
  // Cap by code point (Array.from iterates code points) rather than by
  // `.slice()`'s UTF-16 units, so a title truncated at the boundary can't be
  // left with a split surrogate pair (a half-emoji / lone surrogate).
  const name =
    Array.from((metadata?.name ?? '').trim())
      .slice(0, MAX_ARTIFACT_NAME_LENGTH)
      .join('') || undefined;

  return { artifactId, filename, kind, relatedTo, checksum, name };
}

/**
 * Decode a raw `Upload-Metadata` header (comma-separated `<key> <base64>`
 * pairs, tus v1 creation extension) into a record for
 * `normalizeUploadMetadata`. First occurrence of a key wins — the tus spec
 * requires unique keys and @tus/server rejects duplicates outright, so this
 * only shapes requests that are about to 400 anyway; first-wins just keeps
 * the pre-refactor behavior of the authorize path byte-for-byte.
 */
export function decodeUploadMetadataHeader(header: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const pair of header.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep);
    const value = trimmed.slice(sep + 1).trim();
    if (!value || key in record) continue;
    try {
      record[key] = Buffer.from(value, 'base64').toString('utf8');
    } catch {
      // ignore malformed base64
    }
  }
  return record;
}
