import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  PulseVaultAuthorize,
  PulseVaultAuthorizeContext,
  PulseVaultAuthorizePhase,
} from './authorize.js';
import type { PulseVaultRequest } from './request.js';

// Derived through a Record so adding a phase to `PulseVaultAuthorizePhase` is a
// compile error here — a hand-written array would drift silently, and tokens
// scoped to the new phase would then fail verification with no build-time signal.
const AUTHORIZE_PHASE_SET: Record<PulseVaultAuthorizePhase, true> = {
  create: true,
  patch: true,
  resolve: true,
  delete: true,
};
const AUTHORIZE_PHASES = Object.keys(AUTHORIZE_PHASE_SET) as readonly PulseVaultAuthorizePhase[];

/**
 * Claims signed into a capability token. `kid` lets a secret be rotated with
 * an overlap window (old + new key both verify) instead of instantly
 * invalidating every outstanding token; `iat` closes a clock-skew gap where
 * signing only `exp` would let a slow server clock accept an already-expired
 * token; `issuer` binds the token to the issuing deployment's identity so a
 * secret accidentally shared between two independent orgs can't be replayed
 * across them; `scope` (optional) limits which request phases the token
 * authorizes so a leaked playback URL can't be turned into upload/delete
 * capability.
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
   * Request phases this token authorizes. Omitted = every phase (the
   * pre-`scope` behavior, kept so outstanding tokens stay valid). Mint
   * playback tokens with `['resolve']` and upload-session tokens with
   * `['create', 'patch']` so each URL carries only the capability it needs —
   * a watch link that leaks via logs/history/Referer must not double as
   * upload or delete authority.
   */
  scope?: readonly PulseVaultAuthorizePhase[];
};

const DEFAULT_EXPIRY_SECONDS = 1800; // 30 minutes — long enough for one upload session.
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;

function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
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
  /**
   * Request phases this token authorizes (see `CapabilityTokenClaims.scope`).
   * Omit for an unrestricted token; prefer `['resolve']` for playback URLs and
   * `['create', 'patch']` for upload sessions.
   */
  scope?: readonly PulseVaultAuthorizePhase[];
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
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
  const payload = base64urlEncode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

/** Look up the signing secret for a given key id. Return `null`/`undefined` for an unrecognized `kid`. */
export type LookupSecret = (keyId: string) => string | null | undefined;

export type VerifyCapabilityTokenOptions = {
  /** Must match the token's `issuer` claim exactly. */
  issuer: string;
  /** Clock-skew tolerance in seconds applied to both `iat` and `exp` checks. Defaults to 30. */
  clockToleranceSeconds?: number;
};

function isAuthorizePhase(value: unknown): value is PulseVaultAuthorizePhase {
  return (AUTHORIZE_PHASES as readonly unknown[]).includes(value);
}

/**
 * Verify a token minted by `issueCapabilityToken`. Returns the authorized
 * `artifactId` (plus the token's `scope`, `null` when unrestricted) on
 * success, or `null` for any failure (malformed token, unknown `kid`, bad
 * signature, expired, issued too far in the future, issuer mismatch, or a
 * malformed `scope` claim) — deliberately collapsed to one failure shape so
 * callers can't accidentally branch on *why* a token failed and leak which
 * part was wrong to an attacker.
 */
export function verifyCapabilityToken(
  token: string,
  lookupSecret: LookupSecret,
  opts: VerifyCapabilityTokenOptions,
): { artifactId: string; scope: readonly PulseVaultAuthorizePhase[] | null } | null {
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
  // Guard the JSON *type* before property access: a payload of `null`, `42`, or
  // `"str"` is valid JSON, and reading `.artifactId` off `null` would throw —
  // violating the "returns null for any failure" contract above.
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
  // `scope` is optional (absent = unrestricted, the pre-scope contract), but a
  // *present* scope must be a well-formed phase list — fail closed on anything
  // else rather than guessing what a malformed claim meant.
  if (claims.scope !== undefined) {
    if (!Array.isArray(claims.scope) || !claims.scope.every(isAuthorizePhase)) return null;
  }

  const secret = lookupSecret(claims.kid);
  if (!secret) return null;
  if (!timingSafeEqualStrings(signature, sign(payload, secret))) return null;

  const tolerance = opts.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + tolerance) return null;
  if (claims.exp < now - tolerance) return null;
  if (claims.issuer !== opts.issuer) return null;

  return { artifactId: claims.artifactId, scope: claims.scope ?? null };
}

/** Pull a bearer token from the `Authorization` header, falling back to `ctx.token` (the `resolve`-phase query-string forward). */
function extractToken(
  request: PulseVaultRequest,
  ctx: Pick<PulseVaultAuthorizeContext, 'token'>,
): string | undefined {
  const header = request.headers.authorization;
  // RFC 7235: the auth-scheme token is case-insensitive, so accept `bearer`/`BEARER`
  // too rather than only the canonical `Bearer ` some clients happen to send.
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
 * so one token issued for a video also covers its captions/manifest/thumbnail
 * and (under `uploadUnit: "segment"`) every clip and the ordering manifest
 * uploaded in the same session, without minting a token per artifact.
 *
 * When the token carries a `scope` claim, the request's phase must be listed
 * in it — a `['resolve']` playback token is rejected for create/patch/delete
 * even though its `artifactId` matches. Tokens without `scope` authorize
 * every phase (the pre-scope contract, so outstanding tokens stay valid).
 *
 * Security note for `lookupSecret` implementations: `kid` is attacker-
 * controlled input. Back the lookup with a `Map`, a null-prototype object, or
 * an explicit comparison — a bare `keys[kid]` on a plain object resolves
 * prototype keys like `"constructor"` to functions/objects rather than
 * `undefined`.
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
    const verified = verifyCapabilityToken(token, lookupSecret, opts);
    if (!verified) {
      throw Object.assign(new Error('Invalid or expired capability token'), { statusCode: 403 });
    }
    if (ctx.artifactId !== verified.artifactId && ctx.relatedTo !== verified.artifactId) {
      throw Object.assign(new Error('Token does not authorize this artifact'), { statusCode: 403 });
    }
    if (verified.scope && !verified.scope.includes(ctx.phase)) {
      throw Object.assign(new Error('Token does not authorize this operation'), {
        statusCode: 403,
      });
    }
  };
}
