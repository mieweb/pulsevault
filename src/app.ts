import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import pulseVaultRoutes, { type PulseVaultAuthorize } from "./routes/pulsevault.js";
import type { PulseVaultOnUploadComplete, PulseVaultOnArtifactEvent } from "./lib/pulsevaultTus.js";
import type { PulseVaultValidatePayload } from "./lib/magic.js";
import type { PulseVaultStorage } from "./storage/types.js";
import type { UploadKind } from "./storage/types.js";
import {
  normalizeAllowedExtensions,
  validateBasePath,
  validateMaxUploadSize,
  validateUploadUnit,
  validateAllowedExtensions,
  warnIfUsingDeprecatedProjectHooks,
  composeValidatePayload,
  composeOnUploadComplete,
} from "./lib/options.js";

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
   * Which upload strategy this deployment expects: `"beat"` uploads each
   * clip individually (no client-side merge/re-encode pass) plus a manifest
   * artifact for ordering, while `"merged"` expects one pre-merged video per
   * pulse. Purely advertised via `GET /capabilities` for the client to branch
   * on — `pulsevault` doesn't enforce either. Defaults to `"beat"`.
   */
  uploadUnit?: "beat" | "merged";
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
   * - A flat array (`[".mp4"]`) — treated as video-only; project/captions
   *   default. This is the legacy form for back-compat.
   * - An object with optional `video`/`project`/`captions` keys; unset keys
   *   fall back to their defaults.
   * - Omitted entirely — defaults to
   *   `{ video: [".mp4"], project: [".pulse", ".zip"], captions: [".srt"] }`.
   *
   * All extensions must include the leading dot and are matched case-insensitively.
   */
  allowedExtensions?:
    | readonly string[]
    | { video?: readonly string[]; project?: readonly string[]; captions?: readonly string[] };
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
   * The hook is called with the actual `FastifyRequest` (typed more loosely
   * as `PulseVaultRequest` — the shared shape this option also uses under
   * `@mieweb/pulsevault/core` — since only `.headers` is guaranteed; cast if
   * you need Fastify-specific fields), so consumers can look up sessions,
   * API keys, JWTs, etc. using whatever auth system they have registered
   * higher up in the Fastify tree. Use `createCapabilityAuthorize` (from
   * `./lib/capability-token.js`) for a secure-by-default option that doesn't
   * require writing your own.
   *
   * When omitted, the plugin performs no authorization. For production
   * deployments you almost certainly want to set this — register your auth
   * plugin on the parent scope and let the hook verify ownership of the
   * `artifactId` before any bytes are written.
   */
  authorize?: PulseVaultAuthorize;
  /**
   * Optional payload-validation hook, called for every artifact kind with
   * `ctx.kind` set accordingly. Runs *after* TUS writes the final byte but
   * *before* the upload is marked ready or `onUploadComplete` fires. Throw to
   * reject — the plugin will call `storage.remove` to free the bytes and
   * return a 4xx (default 422) to the client. The sidecar never flips to
   * `"ready"`, so the artifact is never served.
   *
   * Use this for magic-byte sniffing, checksum verification, virus scanning,
   * or any check that needs the final bytes. Ship-ready helpers are exported
   * from this package — see `createMp4Sniffer`, `createChecksumValidator`.
   */
  validatePayload?: PulseVaultValidatePayload;
  /**
   * Optional post-upload hook, fired once TUS writes the final byte *and*
   * any `validatePayload` has passed, and after the adapter's `markReady`
   * has run — for every artifact kind, with `ctx.kind` set accordingly. Use
   * this to flip consumer state (DB row, queue job, audit log). Throwing
   * turns the upload into a 500 response; the artifact is marked ready at
   * this point, so consumers that want all-or-nothing semantics should
   * `storage.remove` before throwing.
   */
  onUploadComplete?: PulseVaultOnUploadComplete;
  /**
   * Optional low-frequency event hook — fired on authorize rejection (create
   * phase and delete/resolve, never per-chunk patch), upload completion, and
   * payload-validation rejection. One hook covers both ops metrics and a
   * compliance audit trail; see `OPERATIONS.md` for wiring examples.
   */
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  /**
   * @deprecated Use `validatePayload` instead — it now receives `ctx.kind`
   * and runs for every artifact kind, including `"project"`. Still honored
   * this release (mapped onto `validatePayload` when `kind === "project"`),
   * but will be removed in a future major version. Passing this triggers a
   * one-time `DeprecationWarning` at registration.
   */
  validateProjectPayload?: PulseVaultValidatePayload;
  /**
   * @deprecated Use `onUploadComplete` instead — it now receives `ctx.kind`
   * and runs for every artifact kind, including `"project"`. Still honored
   * this release (mapped onto `onUploadComplete` when `kind === "project"`),
   * but will be removed in a future major version. Passing this triggers a
   * one-time `DeprecationWarning` at registration.
   */
  onProjectUploadComplete?: PulseVaultOnUploadComplete;
};

const DEFAULT_DECORATOR_NAME = "pulseVault";

const app: FastifyPluginAsync<PulseVaultPluginOptions> = async (
  fastify,
  opts,
) => {
  validateBasePath(opts.prefix, "prefix");
  validateMaxUploadSize(opts.maxUploadSize);
  validateUploadUnit(opts.uploadUnit);
  validateAllowedExtensions(opts.allowedExtensions);
  warnIfUsingDeprecatedProjectHooks(opts);

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
    uploadUnit: opts.uploadUnit ?? "beat",
    allowedExtensions,
    cache: opts.cache,
    authorize: opts.authorize,
    validatePayload: composeValidatePayload(opts.validatePayload, opts.validateProjectPayload),
    onUploadComplete: composeOnUploadComplete(opts.onUploadComplete, opts.onProjectUploadComplete),
    onArtifactEvent: opts.onArtifactEvent,
  });
};

export default fp(app, {
  name: "pulsevault",
  fastify: "5.x",
});

export { createLocalStorage } from "./storage/local.js";
export type { LocalStorage, LocalStorageOptions } from "./storage/local.js";
export { createS3Storage } from "./storage/s3.js";
export type { S3Storage, S3StorageOptions } from "./storage/s3.js";
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
export type {
  PulseVaultOnUploadComplete,
  PulseVaultOnArtifactEvent,
  PulseVaultArtifactEvent,
} from "./lib/pulsevaultTus.js";
export { sniffMp4, createMp4Sniffer, createS3Mp4Sniffer } from "./lib/magic.js";
export type { PulseVaultValidatePayload } from "./lib/magic.js";
export { buildUploadLink } from "./lib/deeplinks.js";
export type { UploadLinkOptions } from "./lib/deeplinks.js";
export {
  issueCapabilityToken,
  verifyCapabilityToken,
  createCapabilityAuthorize,
} from "./lib/capability-token.js";
export type {
  CapabilityTokenClaims,
  IssueCapabilityTokenOptions,
  VerifyCapabilityTokenOptions,
  LookupSecret,
} from "./lib/capability-token.js";
export {
  createChecksumValidator,
  createS3ChecksumValidator,
  parseChecksumMetadata,
} from "./lib/checksum.js";
export type { ChecksumAlgorithm, ParsedChecksum } from "./lib/checksum.js";
export type { PulseVaultRequest, PulseVaultLogger } from "./lib/request.js";
