import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PulseVaultRequest } from './request.js';
import type { PulseVaultAuthorize, PulseVaultAuthorizeContext } from './authorize.js';

/**
 * Claims signed into a capability token. `kid` lets a secret be rotated with
 * an overlap window (old + new key both verify) instead of instantly
 * invalidating every outstanding token; `iat` closes a clock-skew gap where
 * signing only `exp` would let a slow server clock accept an already-expired
 * token; `issuer` binds the token to the issuing deployment's identity so a
 * secret accidentally shared between two independent orgs can't be replayed
 * across them.
 */
export type CapabilityTokenClaims = {
  /** The artifact (or session-anchor artifact — see `relatedTo`) this token authorizes. */
  artifactId: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Key id, looked up via `lookupSecret` at verify time. */
  kid: string;
  /** Issuing deployment's identity, e.g. `"https://vault.acme-hospital.org"`. */
  issuer: string;
  /**
   * `"view"` on a view token (`issueViewToken`): it only opens artifacts. Absent on the
   * capability token an upload uses.
   */
  use?: 'view';
};

const DEFAULT_EXPIRY_SECONDS = 1800; // 30 minutes — long enough for one upload session.
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;

function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * The key view tokens are signed with: derived from the deployment's secret, so it needs no new
 * configuration, but distinct from it — a verifier that predates view tokens checks the
 * signature against the secret itself and rejects a view token instead of treating it as an
 * upload capability.
 */
function viewKey(secret: string): string {
  return createHmac('sha256', secret).update('pulsevault view token v1').digest('base64url');
}

/** Constant-time string comparison, tolerant of mismatched lengths (returns `false` rather than throwing). */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type IssueCapabilityTokenOptions = {
  /** Key id this token is signed under. Required so rotation has an explicit overlap window. */
  keyId: string;
  /** Issuing deployment's identity. Required so cross-issuer replay can be rejected at verify time. */
  issuer: string;
  /** Token lifetime in seconds. Defaults to 1800 (30 minutes). */
  expirySeconds?: number;
};

/**
 * Mint a stateless, HMAC-signed capability token scoped to one artifact (or
 * session-anchor artifact). No server-side session table — verification is a
 * pure function of `(token, secret)`, so the issuing deployment can rotate
 * keys, change its TTL policy, or revoke at the artifact level entirely on
 * its own schedule. See `createCapabilityAuthorize` to use this as the
 * plugin's `authorize` hook directly.
 */
export function issueCapabilityToken(
  artifactId: string,
  secret: string,
  opts: IssueCapabilityTokenOptions,
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: CapabilityTokenClaims = {
    artifactId,
    iat: now,
    exp: now + (opts.expirySeconds ?? DEFAULT_EXPIRY_SECONDS),
    kid: opts.keyId,
    issuer: opts.issuer,
  };
  const payload = base64urlEncode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export type IssueViewTokenOptions = {
  /** Key id this token is signed under (its view key is derived from that key's secret). */
  keyId: string;
  /** Issuing deployment's identity. */
  issuer: string;
  /** Token lifetime in seconds — the host's choice for this link; there is no default. */
  expirySeconds: number;
};

/**
 * Mint a read-only view token for one artifact: it opens that artifact and the artifacts
 * `relatedTo` it (`GET {prefix}/artifacts/<id>?token=`), and nothing else — no uploads, no
 * deletes, no further view links. Signed with a key derived from `secret`, so only a verifier
 * that knows view tokens (`verifyViewToken`, `createCapabilityAuthorize`) accepts it.
 */
export function issueViewToken(
  artifactId: string,
  secret: string,
  opts: IssueViewTokenOptions,
): string {
  // At least a second: `exp` is whole seconds, so anything less is a link already expired.
  if (!Number.isFinite(opts.expirySeconds) || opts.expirySeconds < 1) {
    throw new TypeError('issueViewToken: `expirySeconds` must be a number of seconds, at least 1');
  }
  const now = Math.floor(Date.now() / 1000);
  const claims: CapabilityTokenClaims = {
    artifactId,
    iat: now,
    exp: now + Math.floor(opts.expirySeconds),
    kid: opts.keyId,
    issuer: opts.issuer,
    use: 'view',
  };
  const payload = base64urlEncode(JSON.stringify(claims));
  return `${payload}.${sign(payload, viewKey(secret))}`;
}

/** Look up the signing secret for a given key id. Return `null`/`undefined` for an unrecognized `kid`. */
export type LookupSecret = (keyId: string) => string | null | undefined;

export type VerifyCapabilityTokenOptions = {
  /** Must match the token's `issuer` claim exactly. */
  issuer: string;
  /** Clock-skew tolerance in seconds applied to both `iat` and `exp` checks. Defaults to 30. */
  clockToleranceSeconds?: number;
};

/** Decode and check a token's claims and signature; `null` for any failure. */
function verifyToken(
  token: string,
  lookupSecret: LookupSecret,
  opts: VerifyCapabilityTokenOptions,
  use: 'upload' | 'view',
): { artifactId: string; exp: number } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!payload || !signature) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  // Valid JSON that isn't an object (e.g. the literal `null`, a number, a
  // string) must fail like every other malformed token — return null rather
  // than throw on the property access below.
  if (typeof parsed !== 'object' || parsed === null) return null;
  const claims = parsed as Partial<CapabilityTokenClaims>;
  if (
    typeof claims.artifactId !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    typeof claims.kid !== 'string' ||
    typeof claims.issuer !== 'string'
  ) {
    return null;
  }
  // A view token is never an upload capability, and vice versa.
  if (use === 'view' ? claims.use !== 'view' : claims.use !== undefined) return null;

  const secret = lookupSecret(claims.kid);
  if (!secret) return null;
  const key = use === 'view' ? viewKey(secret) : secret;
  if (!timingSafeEqualStrings(signature, sign(payload, key))) return null;

  const tolerance = opts.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + tolerance) return null;
  if (claims.exp < now - tolerance) return null;
  if (claims.issuer !== opts.issuer) return null;

  return { artifactId: claims.artifactId, exp: claims.exp };
}

/**
 * Verify a token minted by `issueCapabilityToken`. Returns the authorized
 * `artifactId` on success, or `null` for any failure (malformed token,
 * unknown `kid`, bad signature, expired, issued too far in the future,
 * issuer mismatch, or a view token) — deliberately collapsed to one failure
 * shape so callers can't accidentally branch on *why* a token failed and leak
 * which part was wrong to an attacker.
 */
export function verifyCapabilityToken(
  token: string,
  lookupSecret: LookupSecret,
  opts: VerifyCapabilityTokenOptions,
): { artifactId: string } | null {
  const verified = verifyToken(token, lookupSecret, opts, 'upload');
  return verified && { artifactId: verified.artifactId };
}

/**
 * Verify a view token minted by `issueViewToken`. Returns the `artifactId` it opens and its
 * `exp`, or `null` for any failure — including an upload capability token, which is not a view
 * token.
 */
export function verifyViewToken(
  token: string,
  lookupSecret: LookupSecret,
  opts: VerifyCapabilityTokenOptions,
): { artifactId: string; exp: number } | null {
  return verifyToken(token, lookupSecret, opts, 'view');
}

/** Pull a bearer token from the `Authorization` header, falling back to `ctx.token` (the `resolve`-phase query-string forward). */
function extractToken(
  request: PulseVaultRequest,
  ctx: Pick<PulseVaultAuthorizeContext, 'token'>,
): string | undefined {
  const header = request.headers.authorization;
  // Match the auth scheme case-insensitively per RFC 7235 (clients may send
  // `bearer `/`BEARER `); the prefix is fixed-length so the slice is unchanged.
  if (typeof header === 'string' && /^Bearer /i.test(header)) {
    return header.slice('Bearer '.length);
  }
  return ctx.token;
}

/**
 * Ready-made `authorize` hook backed by `verifyCapabilityToken`. Pass this
 * directly as the plugin's `authorize` option for a secure-by-default setup
 * with no custom auth code:
 *
 * ```ts
 * await app.register(pulseVault, {
 *   // ...
 *   authorize: createCapabilityAuthorize((kid) => keys[kid] ?? null, {
 *     issuer: "https://vault.acme-hospital.org",
 *   }),
 * });
 * ```
 *
 * Authorizes the request if the token's `artifactId` matches either the
 * artifact being acted on, or that artifact's `relatedTo` session anchor —
 * so one token issued for a pulse's video also covers its captions, beat
 * manifest and thumbnail uploaded in the same session, without minting a
 * token per artifact.
 *
 * A view token (`issueViewToken`) is accepted only to open an artifact (the
 * `"resolve"` phase). Every other phase — uploading, deleting, and minting a
 * view link (`"share"`) — needs the capability token itself, so a shared link
 * can't be used to change anything or to extend itself.
 */
export function createCapabilityAuthorize(
  lookupSecret: LookupSecret,
  opts: VerifyCapabilityTokenOptions,
): PulseVaultAuthorize {
  return async (request, ctx) => {
    const token = extractToken(request, ctx);
    if (!token) {
      throw Object.assign(new Error('Missing capability token'), { statusCode: 401 });
    }
    const verified =
      verifyCapabilityToken(token, lookupSecret, opts) ??
      (ctx.phase === 'resolve' ? verifyViewToken(token, lookupSecret, opts) : null);
    if (!verified) {
      throw Object.assign(new Error('Invalid or expired capability token'), { statusCode: 403 });
    }
    if (ctx.artifactId !== verified.artifactId && ctx.relatedTo !== verified.artifactId) {
      throw Object.assign(new Error('Token does not authorize this artifact'), { statusCode: 403 });
    }
  };
}
