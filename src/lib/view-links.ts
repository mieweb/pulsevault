import { issueViewToken } from './capability-token.js';
import type { PulseVaultRequest } from './request.js';
import type { UploadKind } from '../storage/types.js';

/** A read-only view link, as `POST {prefix}/artifacts/<id>/view-link` returns it (PROTOCOL.md §6.4). */
export type PulseVaultViewLink = {
  /** Opens the artifact as `GET {prefix}/artifacts/<id>?token=<token>`, and nothing more. */
  token: string;
  /** When the link stops working, in seconds since the Unix epoch. */
  expiresAt: number;
};

/** The finished artifact a view link is being minted for. */
export type PulseVaultViewLinkContext = {
  artifactId: string;
  kind: UploadKind;
  relatedTo?: string;
};

/**
 * Mints a view link, or returns `null` to refuse one for this artifact. Called for a finished
 * artifact after `authorize` allowed the request as `"share"`. The host decides each link —
 * how long it works, whether this artifact gets one at all — so PulseVault sets no lifetime of
 * its own.
 */
export type PulseVaultIssueViewLink = (
  request: PulseVaultRequest,
  ctx: PulseVaultViewLinkContext,
) => PulseVaultViewLink | null | Promise<PulseVaultViewLink | null>;

export type ViewLinkIssuerOptions = {
  /** Key id to sign under — the same keys as capability tokens (view tokens derive their own key). */
  keyId: string;
  /** The secret for `keyId`. */
  secret: string;
  /** Issuing deployment's identity; must match what `createCapabilityAuthorize` verifies. */
  issuer: string;
  /**
   * How long each link works, in seconds: a fixed number, or decided per link from the request
   * and the artifact. Return `null` from the function to refuse a link.
   */
  expirySeconds:
    | number
    | ((
        request: PulseVaultRequest,
        ctx: PulseVaultViewLinkContext,
      ) => number | null | Promise<number | null>);
};

/**
 * A ready-made `issueViewLink` for deployments using capability tokens: signs a view token
 * (`issueViewToken`) that `createCapabilityAuthorize` accepts for opening the artifact, and only
 * that.
 *
 * ```ts
 * issueViewLink: createViewLinkIssuer({
 *   keyId, secret, issuer,
 *   expirySeconds: (_request, { kind }) => (kind === 'video' ? 30 * 86_400 : 7 * 86_400),
 * }),
 * ```
 */
export function createViewLinkIssuer(opts: ViewLinkIssuerOptions): PulseVaultIssueViewLink {
  const { keyId, secret, issuer, expirySeconds } = opts;
  // A fixed lifetime that can't work fails here, at boot — not as a 500 on every link.
  if (
    typeof expirySeconds !== 'function' &&
    !(typeof expirySeconds === 'number' && Number.isFinite(expirySeconds) && expirySeconds >= 1)
  ) {
    throw new TypeError(
      'createViewLinkIssuer: `expirySeconds` must be a number of seconds (at least 1) or a function',
    );
  }
  return async (request, ctx) => {
    const seconds =
      typeof expirySeconds === 'function' ? await expirySeconds(request, ctx) : expirySeconds;
    if (seconds === null) return null;
    const token = issueViewToken(ctx.artifactId, secret, {
      keyId,
      issuer,
      expirySeconds: seconds,
    });
    // The token's own `exp`, so the two can't disagree by the second the signing took.
    const claims = JSON.parse(
      Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8'),
    ) as { exp: number };
    return { token, expiresAt: claims.exp };
  };
}
