import type { PulseVaultStorage, UploadKind } from './storage/types.js';

/**
 * Opt-in TypeScript augmentation for the default `pulseVault` decorator and
 * the per-request `request.pulseVault` context that the plugin sets when it
 * recognizes an artifactId on the incoming request. Import for side effects
 * in one place in your app when you register the plugin with the default
 * `decoratorName`:
 *
 * ```ts
 * import "@mieweb/pulsevault/augment";
 * ```
 *
 * If you pass a custom `decoratorName`, skip this import and write your own
 * augmentation:
 *
 * ```ts
 * declare module "fastify" {
 *   interface FastifyInstance {
 *     myCustomName: PulseVaultStorage;
 *   }
 *   interface FastifyRequest {
 *     pulseVault?: { artifactId: string };
 *   }
 * }
 * ```
 *
 * **Breaking change**: this field was named `videoid` before this release.
 * It's renamed to `artifactId` here as a deliberate, separate breaking change
 * from the wire-format rename — update any code reading
 * `request.pulseVault.videoid` to `request.pulseVault.artifactId`.
 */
declare module 'fastify' {
  interface FastifyInstance {
    pulseVault: PulseVaultStorage;
  }
  interface FastifyRequest {
    /**
     * Populated by the plugin when it can extract an artifactId from the
     * incoming request (from `Upload-Metadata` on POST, the URL id on
     * PATCH/HEAD/DELETE, or the route param on GET). Present on every
     * request the plugin routes serve that refer to a valid UUID — use it
     * from your own `preHandler` / auth hooks to avoid re-parsing.
     */
    pulseVault?: { artifactId: string; kind: UploadKind; relatedTo?: string };
  }
}

export {};
