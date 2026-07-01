import type { IncomingHttpHeaders } from 'node:http';

/**
 * Structural request shape the plugin's internals and hooks rely on.
 * `FastifyRequest`, Express's `req`, and a raw `http.IncomingMessage` all
 * satisfy this already (they all expose `.headers`), so the same hook
 * implementations work unmodified under the Fastify plugin and the
 * framework-agnostic core.
 */
export type PulseVaultRequest = {
  headers: IncomingHttpHeaders;
};

/**
 * Structural logger shape used for the plugin's own internal diagnostics
 * (authorize rejections, tus handler failures, cleanup errors) — satisfied
 * by Pino (Fastify's `request.log`) and by the `consoleLogger` fallback
 * below, so non-Fastify hosts don't need to bring their own logger.
 */
export type PulseVaultLogger = {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

/** Default logger for hosts that don't supply one. */
export const consoleLogger: PulseVaultLogger = {
  info(obj, msg) {
    if (msg) console.info(msg, obj);
    else console.info(obj);
  },
  error(obj, msg) {
    if (msg) console.error(msg, obj);
    else console.error(obj);
  },
};
