import { MAX_REF_LENGTH } from './capability-token.js';

export type UploadLinkOptions = {
  /**
   * Full base URL the client should upload to — origin *plus* whatever
   * `prefix` you registered the plugin under (e.g.
   * `https://vault.example.org/pulsevault`, not just `https://vault.example.org`).
   * The client builds every request as `${server}/<path>` with no separate
   * prefix concept of its own. Must be `https://` (or `http://localhost`/a
   * private IP for local dev).
   */
  server: string;
  /** Opaque token forwarded to the server's `authorize` hook — typically minted with `issueCapabilityToken`. Omit for unauthenticated servers. */
  token?: string;
  /**
   * Server-side artifact UUID. Used as both the app's local draft key and the
   * `artifactId` in `Upload-Metadata`, so the app skips a separate reserve
   * step. Generate with `crypto.randomUUID()`.
   */
  artifactId: string;
  /**
   * The host's key for the place this upload goes to (protocol 2.7), e.g. `"u1:ticket:42"`: one
   * per owner and place, at most 200 characters. Pulse opens the recorder on that place's draft
   * and matches a later link for the same place on `server` + `ref`. Must be the `ref` signed
   * into `token` (`issueCapabilityToken`'s `ref`) — a client refuses the link otherwise.
   */
  ref?: string;
  /** What Pulse calls the place, e.g. a ticket's title. Trimmed to 60 characters. An unsigned hint, like the next three. */
  label?: string;
  /** What Pulse names a new recording made from this link, e.g. "Huddle update". Absent: it starts unnamed. Trimmed to 80 characters. */
  name?: string;
  /** The host app's name, shown with `label`. Trimmed to 30 characters. */
  app?: string;
  /** A page in the host to go back to after the upload (the link's `return` param). Same rules as `server`. */
  returnUrl?: string;
  /**
   * Which of the two equivalent link forms to build (PROTOCOL.md §3):
   * - `'pulsecam'` (default): `pulsecam://?<params>`, which every Pulse app opens.
   * - `'https'`: `https://mieweb.github.io/pulse/open#<params>`, a Universal Link / App Link.
   *   Phone cameras open it, it opens Pulse when it's installed, and its page sends the person
   *   to the store when it isn't. The parameters ride in the fragment, so the link host never
   *   receives the token. Only Pulse releases that claim the link host open it directly; an
   *   older Pulse lands on the page, whose "Open it" button falls back to `pulsecam://`.
   */
  form?: 'pulsecam' | 'https';
};

/**
 * Where the https form of a pairing link points: the page on the link host the Pulse app
 * claims. Fixed, because an app can only claim domains it was built with.
 */
export const PULSE_OPEN_URL = 'https://mieweb.github.io/pulse/open';

/** Deep-link wire format version. Bump when the param shape changes incompatibly. */
const LINK_VERSION = '1';
const MAX_LABEL_LENGTH = 60;
const MAX_NAME_LENGTH = 80;
const MAX_APP_LENGTH = 30;

/** The `ref` claim a token carries, read without verifying it — as a client does (PROTOCOL.md §3.1). */
function tokenRefOf(token: string | undefined): unknown {
  if (!token) return undefined;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8'),
    );
    return (claims as { ref?: unknown } | null)?.ref;
  } catch {
    return undefined;
  }
}

/**
 * Private/dev origins allowed over plain http — mirrors the Pulse client's
 * own `isPrivateDevOrigin` check (PROTOCOL.md §3) exactly, so a link this
 * helper is willing to build is also one the client is willing to accept.
 * Never extended beyond non-globally-routable address space (RFC 1918
 * private ranges, RFC 6598 carrier-grade NAT, link-local) plus
 * loopback/localhost — never a public IP or domain just because it "looks
 * internal."
 */
function isPrivateDevOrigin(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host) || // RFC 6598, 100.64.0.0/10
    /^169\.254\.\d+\.\d+$/.test(host) // link-local
  );
}

/** A URL the link may point at: https, or plain http to localhost or a private IP for dev. */
function checkedUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`buildUploadLink: \`${name}\` is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && !isPrivateDevOrigin(url)) {
    throw new Error(
      `buildUploadLink: \`${name}\` must be https:// (got "${value}") — ` +
        'the only exception is http://localhost or a private IP literal for local development.',
    );
  }
}

/** A display string: trimmed, capped by code point so it can't end in half a surrogate pair. */
function displayText(value: string | undefined, max: number): string {
  return value === undefined ? '' : Array.from(value.trim()).slice(0, max).join('').trim();
}

/**
 * Build a pairing link that opens the Pulse app directly on the upload screen
 * for a specific artifact, pointed at this server: `pulsecam://?<params>`, or
 * with `form: 'https'`, `${PULSE_OPEN_URL}#<params>`.
 *
 * `ref`, `label`, `name`, `app` and `returnUrl` (protocol 2.7) say which place in the host the
 * upload is for and what to call it, so Pulse opens the recorder on that place's draft; a Pulse
 * that predates them ignores them. Without them the link is exactly what it always was.
 *
 * No `mode` param — there's only one mode, so it was always redundant. `v`
 * lets the app refuse/explain a future incompatible link shape instead of
 * misparsing it.
 *
 * Throws if `server` isn't `https://` (or the narrow localhost/private-IP dev
 * exception PROTOCOL.md §3 carves out) — failing fast here, at the one place
 * that constructs the link, is more reliable than relying on every client to
 * independently reject a plaintext origin the operator never should have
 * issued in the first place.
 */
export function buildUploadLink(opts: UploadLinkOptions): string {
  if (opts.form !== undefined && opts.form !== 'pulsecam' && opts.form !== 'https') {
    throw new Error(`buildUploadLink: \`form\` must be 'pulsecam' or 'https' (got "${String(opts.form)}")`);
  }
  checkedUrl(opts.server, 'server');
  if (opts.returnUrl !== undefined) checkedUrl(opts.returnUrl, 'returnUrl');
  if (opts.ref !== undefined) {
    if (opts.ref === '' || opts.ref.length > MAX_REF_LENGTH) {
      throw new Error(`buildUploadLink: \`ref\` must be 1 to ${MAX_REF_LENGTH} characters`);
    }
    // A client refuses a link whose `ref` isn't the one signed into its token, so don't build one.
    if (tokenRefOf(opts.token) !== opts.ref) {
      throw new Error('buildUploadLink: `ref` must be the `ref` signed into `token` (issueCapabilityToken\'s `ref`)');
    }
  }

  const params = new URLSearchParams({
    v: LINK_VERSION,
    artifactId: opts.artifactId,
    server: opts.server,
  });
  if (opts.token) params.set('token', opts.token);
  const hints = {
    ref: opts.ref ?? '',
    label: displayText(opts.label, MAX_LABEL_LENGTH),
    name: displayText(opts.name, MAX_NAME_LENGTH),
    app: displayText(opts.app, MAX_APP_LENGTH),
    return: opts.returnUrl ?? '',
  };
  for (const [key, value] of Object.entries(hints)) if (value) params.set(key, value);
  if (opts.form === 'https') return `${PULSE_OPEN_URL}#${params.toString()}`;
  return `pulsecam://?${params.toString()}`;
}
