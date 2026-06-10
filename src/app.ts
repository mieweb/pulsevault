import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import pulseVaultRoutes, {
  type PulseVaultAuthorize,
  type PulseVaultAuthorizeContext,
  type PulseVaultAuthorizePhase,
} from "./routes/pulsevault.js";
import type { PulseVaultOnUploadComplete } from "./lib/pulsevaultTus.js";
import type { PulseVaultValidatePayload } from "./lib/magic.js";
import type { PulseVaultStorage } from "./storage/types.js";
import type { UploadKind } from "./storage/types.js";

/**
 * Subset of `@fastify/send`'s cache-related options forwarded to the GET
 * route. All upload filenames are content-addressable (keyed by the upload
 * UUID), so `immutable: true` is safe whenever you also set a non-zero
 * `maxAge`.
 */
export type PulseVaultCacheOptions = {
  /** Enable the `Cache-Control` response header. Defaults to `true`. */
  cacheControl?: boolean;
  /**
   * `max-age` for the `Cache-Control` header. Accepts a number of
   * milliseconds or an `ms`-style string such as `"1y"`. Defaults to `0`.
   */
  maxAge?: string | number;
  /**
   * Add the `immutable` directive to `Cache-Control`. Requires `maxAge > 0`
   * to take effect. Defaults to `false`.
   */
  immutable?: boolean;
};

export type PulseVaultPluginOptions = {
  /** Storage adapter. Use `createLocalStorage(...)` for filesystem-backed deployments. */
  storage: PulseVaultStorage;
  /**
   * URL prefix where the plugin's routes are mounted, e.g. `"/pulsevault"`.
   * Must be set explicitly: because this plugin is wrapped with
   * `fastify-plugin` (so its decorator escapes encapsulation), Fastify's own
   * `register(..., { prefix })` is a no-op and must be routed through this
   * option instead. Use `""` to mount at the root.
   */
  prefix: string;
  /**
   * Max TUS upload size in bytes. Required — consumers must choose an
   * explicit cap for their deployment. Use `Infinity` for no cap.
   */
  maxUploadSize: number;
  /**
   * Fastify instance decorator name under which the storage adapter is
   * exposed. Defaults to `"pulseVault"`. Override when registering this
   * plugin more than once in the same process so the decorators don't
   * collide.
   *
   * For typed access to the default decorator, add a single side-effect
   * import somewhere in your app: `import "@mieweb/pulsevault/augment"`.
   * Consumers using a custom name must skip that import and write their own
   * `declare module "fastify"` augmentation — see `./augment.ts` for the
   * template.
   */
  decoratorName?: string;
  /**
   * File extensions allowed per artifact kind. Accepts:
   * - A flat array (`[".mp4"]`) — treated as video-only; project defaults to
   *   `[".pulse", ".zip"]`. This is the legacy form for back-compat.
   * - An object with optional `video` and/or `project` keys; unset keys fall
   *   back to their defaults.
   * - Omitted entirely — defaults to `{ video: [".mp4"], project: [".pulse", ".zip"] }`.
   *
   * All extensions must include the leading dot and are matched case-insensitively.
   */
  allowedExtensions?: readonly string[] | { video?: readonly string[]; project?: readonly string[] };
  /**
   * Cache-control options forwarded to `@fastify/send` for the GET route.
   * When omitted, `@fastify/send`'s defaults apply (`Cache-Control: public,
   * max-age=0`).
   */
  cache?: PulseVaultCacheOptions;
  /**
   * Optional authorization hook. Runs before the TUS create/PATCH lifecycle
   * and before `resolve` on GET. Throw to reject the request; a thrown
   * `statusCode`/`status_code` number on the error is honored (default 403).
   *
   * The hook is called with the `FastifyRequest`, so consumers can look up
   * sessions, API keys, JWTs, etc. using whatever auth system they have
   * registered higher up in the Fastify tree.
   *
   * When omitted, the plugin performs no authorization. For production
   * deployments you almost certainly want to set this — register your auth
   * plugin on the parent scope and let the hook verify ownership of the
   * `videoid` before any bytes are written.
   */
  authorize?: PulseVaultAuthorize;
  /**
   * Optional payload-validation hook. Runs *after* TUS writes the final byte
   * but *before* the upload is marked ready or `onUploadComplete` fires.
   * Throw to reject — the plugin will call `storage.remove` to free the
   * bytes and return a 4xx (default 422) to the client. The sidecar never
   * flips to `"ready"`, so the video is never served.
   *
   * Use this for magic-byte sniffing, virus scanning, or any check that
   * needs the final bytes. Ship-ready helpers are exported from this
   * package — see `createMp4Sniffer`.
   */
  validatePayload?: PulseVaultValidatePayload;
  /**
   * Optional post-upload hook. Fires once TUS writes the final byte *and*
   * any `validatePayload` has passed, and after the adapter's `markReady`
   * has run. Use this to flip consumer state (DB row, queue job, audit
   * log). Throwing turns the upload into a 500 response; the video is
   * marked ready at this point, so consumers that want all-or-nothing
   * semantics should `storage.remove` before throwing.
   */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /**
   * Optional payload-validation hook for `kind=project` uploads. Same
   * lifecycle as `validatePayload` but only fires for project artifacts
   * (`.pulse`, `.zip`, etc.). Throwing causes `storage.remove` + 4xx.
   */
  validateProjectPayload?: PulseVaultValidatePayload;
  /**
   * Optional post-upload hook for `kind=project` uploads. Fires after
   * `validateProjectPayload` passes and `markReady` runs. Use this to
   * index the draft, enable cross-device editing, etc.
   */
  onProjectUploadComplete?: PulseVaultOnUploadComplete;
};

const DEFAULT_DECORATOR_NAME = "pulseVault";
const DEFAULT_VIDEO_EXTENSIONS: readonly string[] = [".mp4"];
const DEFAULT_PROJECT_EXTENSIONS: readonly string[] = [".pulse", ".zip"];
const EXTENSION_REGEX = /^\.[^.\s/\\]+$/;

/**
 * Normalize the consumer's `allowedExtensions` option (legacy array or per-kind
 * object) into the canonical `{ video, project }` shape the route layer expects.
 */
function normalizeAllowedExtensions(
  raw: PulseVaultPluginOptions["allowedExtensions"],
): { video: readonly string[]; project: readonly string[] } {
  if (!raw) {
    return { video: DEFAULT_VIDEO_EXTENSIONS, project: DEFAULT_PROJECT_EXTENSIONS };
  }
  if (Array.isArray(raw)) {
    // Legacy flat array: treat as video-only, project keeps its default.
    return {
      video: (raw as readonly string[]).map((e) => e.toLowerCase()),
      project: DEFAULT_PROJECT_EXTENSIONS,
    };
  }
  const obj = raw as { video?: readonly string[]; project?: readonly string[] };
  return {
    video: (obj.video ?? DEFAULT_VIDEO_EXTENSIONS).map((e) => e.toLowerCase()),
    project: (obj.project ?? DEFAULT_PROJECT_EXTENSIONS).map((e) => e.toLowerCase()),
  };
}

function validateOptions(opts: PulseVaultPluginOptions): void {
  if (opts.prefix !== "" && (!opts.prefix.startsWith("/") || opts.prefix.endsWith("/"))) {
    throw new TypeError(
      "`prefix` must be '' or start with '/' with no trailing slash (e.g. '/pulsevault')",
    );
  }
  if (!(opts.maxUploadSize > 0)) {
    throw new TypeError(
      "`maxUploadSize` must be a positive number (use Infinity for no cap)",
    );
  }
  if (opts.allowedExtensions) {
    const exts = Array.isArray(opts.allowedExtensions)
      ? (opts.allowedExtensions as readonly string[])
      : [
          ...((opts.allowedExtensions as { video?: readonly string[] }).video ?? []),
          ...((opts.allowedExtensions as { project?: readonly string[] }).project ?? []),
        ];
    for (const ext of exts) {
      if (!EXTENSION_REGEX.test(ext)) {
        throw new TypeError(
          `\`allowedExtensions\` entry ${JSON.stringify(ext)} must start with '.' and contain no nested dots, slashes, or whitespace (e.g. '.mp4')`,
        );
      }
    }
  }
}

const app: FastifyPluginAsync<PulseVaultPluginOptions> = async (
  fastify,
  opts,
) => {
  validateOptions(opts);

  // Register the shutdown hook *before* awaiting initialize() so any partial
  // state the adapter allocates mid-init still gets cleaned up if Fastify
  // later tears the plugin down.
  fastify.addHook("onClose", async () => {
    await opts.storage.shutdown?.();
  });
  await opts.storage.initialize?.();

  const decoratorName = opts.decoratorName ?? DEFAULT_DECORATOR_NAME;
  const allowedExtensions = normalizeAllowedExtensions(opts.allowedExtensions);

  fastify.decorate(decoratorName, opts.storage);

  await fastify.register(pulseVaultRoutes, {
    prefix: opts.prefix,
    storage: opts.storage,
    maxUploadSize: opts.maxUploadSize,
    allowedExtensions,
    cache: opts.cache,
    authorize: opts.authorize,
    validatePayload: opts.validatePayload,
    validateProjectPayload: opts.validateProjectPayload,
    onUploadComplete: opts.onUploadComplete,
    onProjectUploadComplete: opts.onProjectUploadComplete,
  });
};

export default fp(app, {
  name: "pulsevault",
  fastify: "5.x",
});

export { createLocalStorage } from "./storage/local.js";
export type { LocalStorage, LocalStorageOptions } from "./storage/local.js";
export type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from "./storage/types.js";
export type {
  PulseVaultAuthorize,
  PulseVaultAuthorizeContext,
  PulseVaultAuthorizePhase,
} from "./routes/pulsevault.js";
export type { PulseVaultOnUploadComplete } from "./lib/pulsevaultTus.js";
export { sniffMp4, createMp4Sniffer } from "./lib/magic.js";
export type { PulseVaultValidatePayload } from "./lib/magic.js";
export { buildUploadLink } from "./lib/deeplinks.js";
export type { UploadLinkOptions } from "./lib/deeplinks.js";
