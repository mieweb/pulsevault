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
   * What Pulse calls the place this upload goes to, e.g. a ticket's title (protocol 2.7). Cut to
   * 60 characters.
   *
   * This and the next three are unsigned display hints (PROTOCOL.md §3.1). They act only on a
   * link whose `token` carries a `ref` (`issueCapabilityToken`'s `ref`), the place's signed key,
   * which Pulse reads from the token; on any other link Pulse ignores them. Control and
   * bidirectional-formatting characters are removed, a hint that is blank (or not a string) is
   * left out, and a longer one is cut at a whole character. They travel in clear in the link and
   * its QR code, so nothing private belongs in them.
   */
  label?: string | null;
  /**
   * What Pulse names a new recording made from this link, e.g. "Huddle update". Absent: it
   * starts unnamed. Cut to 80 characters.
   */
  name?: string | null;
  /** The host app's name, shown with `label`. Cut to 30 characters. */
  app?: string | null;
  /**
   * A page in the host to go back to after the upload (the link's `return` param): `https://`
   * like `server`, with no username or password, at most 512 characters once normalized. The
   * link carries it normalized (`new URL(returnUrl).href`).
   */
  returnUrl?: string | null;
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

/** Caps on the link hints (PROTOCOL.md §3.1), in characters: Unicode code points. */
const MAX_LABEL_LENGTH = 60;
const MAX_NAME_LENGTH = 80;
const MAX_APP_LENGTH = 30;
const MAX_RETURN_URL_LENGTH = 512;

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
function checkedUrl(value: string, name: string): URL {
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
  return url;
}

/**
 * The link's `return` param: `returnUrl` as the URL parser reads it (`href`), so every client
 * sees the URL that was checked here, whatever its own parser makes of stray whitespace,
 * backslashes or a non-ASCII host. Blank or not a string: none.
 */
function returnParam(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const url = checkedUrl(value, 'returnUrl');
  // `https://app.example.org@evil.example/` reads as the first host and opens the second.
  if (url.username !== '' || url.password !== '') {
    throw new Error('buildUploadLink: `returnUrl` must not carry a username or password');
  }
  if (url.href.length > MAX_RETURN_URL_LENGTH) {
    throw new Error(
      `buildUploadLink: \`returnUrl\` must be at most ${MAX_RETURN_URL_LENGTH} characters (got ${url.href.length})`,
    );
  }
  return url.href;
}

/**
 * A display hint as the link carries it: one line of plain text, at most `max` characters
 * (code points). Control characters and line breaks become a space, bidirectional-formatting
 * characters (which can reorder the text shown around them) are dropped, and a longer text is cut
 * at a whole user-perceived character, never through an emoji sequence or an accent. Blank,
 * invisible or not a string: none.
 */
function displayText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\p{Bidi_Control}/gu, '')
    .trim();
  if (/^[\s\p{Cf}]*$/u.test(text)) return '';
  if (Array.from(text).length <= max) return text;
  let cut = '';
  let length = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    length += Array.from(segment).length;
    if (length > max) break;
    cut += segment;
  }
  return cut.trim();
}

/**
 * Build a pairing link that opens the Pulse app directly on the upload screen
 * for a specific artifact, pointed at this server: `pulsecam://?<params>`, or
 * with `form: 'https'`, `${PULSE_OPEN_URL}#<params>`.
 *
 * `label`, `name`, `app` and `returnUrl` (protocol 2.7) say what to call the place the upload
 * is for and the recording made for it; which place that is, Pulse reads from the token's `ref`
 * claim, and without one it ignores them. A Pulse that predates them ignores them too, and
 * without them the link is exactly what it always was.
 *
 * No `mode` param — there's only one mode, so it was always redundant. `v`
 * lets the app refuse/explain a future incompatible link shape instead of
 * misparsing it.
 *
 * Throws if `server` isn't `https://` (or the narrow localhost/private-IP dev
 * exception PROTOCOL.md §3 carves out) — failing fast here, at the one place
 * that constructs the link, is more reliable than relying on every client to
 * independently reject a plaintext origin the operator never should have
 * issued in the first place. `returnUrl` is held to the same rule, and throws
 * as well when it carries a username or password or is longer than 512
 * characters.
 */
export function buildUploadLink(opts: UploadLinkOptions): string {
  if (opts.form !== undefined && opts.form !== 'pulsecam' && opts.form !== 'https') {
    throw new Error(`buildUploadLink: \`form\` must be 'pulsecam' or 'https' (got "${String(opts.form)}")`);
  }
  checkedUrl(opts.server, 'server');

  const params = new URLSearchParams({
    v: LINK_VERSION,
    artifactId: opts.artifactId,
    server: opts.server,
  });
  if (opts.token) params.set('token', opts.token);
  const hints = {
    label: displayText(opts.label, MAX_LABEL_LENGTH),
    name: displayText(opts.name, MAX_NAME_LENGTH),
    app: displayText(opts.app, MAX_APP_LENGTH),
    return: returnParam(opts.returnUrl),
  };
  for (const [key, value] of Object.entries(hints)) if (value) params.set(key, value);
  if (opts.form === 'https') return `${PULSE_OPEN_URL}#${params.toString()}`;
  return `pulsecam://?${params.toString()}`;
}
