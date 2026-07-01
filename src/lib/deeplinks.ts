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
   * Per-session override of the deployment-wide `uploadUnit` advertised via
   * `GET /capabilities` (PROTOCOL.md §8). Omit to let the client fall back to
   * whatever `/capabilities` reports — the same behavior as before this field
   * existed. Set this when an operator wants "beat" and "merged" sessions
   * live at the same time (e.g. different pairing flows, a/b testing, a
   * gradual rollout) rather than one fixed value for the whole deployment:
   * `/capabilities` can only ever report one current value, and a client
   * that reads it separately from opening the link is racing whatever the
   * server was serving at that moment, not the value this specific session
   * was paired under.
   */
  uploadUnit?: 'beat' | 'merged';
};

/** Deep-link wire format version. Bump when the param shape changes incompatibly. */
const LINK_VERSION = '1';

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

/**
 * Build a `pulsecam://` deep link that opens the Pulse app directly on the
 * upload screen for a specific artifact, pointed at this server.
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
  let server: URL;
  try {
    server = new URL(opts.server);
  } catch {
    throw new Error(`buildUploadLink: \`server\` is not a valid URL: ${opts.server}`);
  }
  if (server.protocol !== 'https:' && !isPrivateDevOrigin(server)) {
    throw new Error(
      `buildUploadLink: \`server\` must be https:// (got "${opts.server}") — ` +
        'the only exception is http://localhost or a private IP literal for local development.',
    );
  }

  if (opts.uploadUnit !== undefined && opts.uploadUnit !== 'beat' && opts.uploadUnit !== 'merged') {
    throw new Error(`buildUploadLink: \`uploadUnit\` must be "beat" or "merged" (got "${opts.uploadUnit}")`);
  }

  const params = new URLSearchParams({
    v: LINK_VERSION,
    artifactId: opts.artifactId,
    server: opts.server,
  });
  if (opts.token) params.set('token', opts.token);
  if (opts.uploadUnit) params.set('uploadUnit', opts.uploadUnit);
  return `pulsecam://?${params.toString()}`;
}
