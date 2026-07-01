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
};

/** Deep-link wire format version. Bump when the param shape changes incompatibly. */
const LINK_VERSION = "1";

/**
 * Build a `pulsecam://` deep link that opens the Pulse app directly on the
 * upload screen for a specific artifact, pointed at this server.
 *
 * No `mode` param — there's only one mode, so it was always redundant. `v`
 * lets the app refuse/explain a future incompatible link shape instead of
 * misparsing it.
 */
export function buildUploadLink(opts: UploadLinkOptions): string {
  const params = new URLSearchParams({
    v: LINK_VERSION,
    artifactId: opts.artifactId,
    server: opts.server,
  });
  if (opts.token) params.set("token", opts.token);
  return `pulsecam://?${params.toString()}`;
}
