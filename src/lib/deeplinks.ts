export type UploadLinkOptions = {
  /** Full origin of the PulseVault server. */
  server: string;
  /** Opaque token forwarded to the server's `authorize` hook. Omit for unauthenticated servers. */
  token?: string;
  /**
   * Server-side video UUID. Used as both the app's local draft key and the
   * `videoid` in `Upload-Metadata`, so the app skips `POST /reserve`.
   * Generate with `crypto.randomUUID()`.
   */
  videoid: string;
};

/**
 * Build a `pulsecam://` deep link that opens the Pulse app directly on the
 * upload screen for a specific draft, pointed at this server.
 */
export function buildUploadLink(opts: UploadLinkOptions): string {
  const params = new URLSearchParams({ mode: "upload", videoid: opts.videoid, server: opts.server });
  if (opts.token) params.set("token", opts.token);
  return `pulsecam://?${params.toString()}`;
}
