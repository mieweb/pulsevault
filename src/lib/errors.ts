export type PulseVaultErrorBody = {
  ok: false;
  error: string;
};

export function pulseVaultError(error: string): PulseVaultErrorBody {
  return { ok: false, error };
}

/**
 * The one way this package throws an HTTP-mapped error. Tags the status under
 * both spellings so it surfaces correctly through every layer that inspects
 * thrown errors — `statusCode` (Fastify/consumer convention, read by
 * `statusCodeOf`) and `status_code` + `body` (the shape `@tus/server` turns
 * into an HTTP response).
 */
export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: status,
    status_code: status,
    body: message,
  });
}

/** A usable HTTP status: an integer in 100–599. Anything else would make `res.writeHead` throw. */
function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * Extract a numeric HTTP status from a thrown error, honoring both `statusCode`
 * (Fastify convention) and `status_code` (tus convention). Returns `fallback`
 * when neither is a *valid* HTTP status — a consumer hook throwing
 * `{ statusCode: 42 }` must degrade to the fallback, not crash `writeHead`.
 */
export function statusCodeOf(err: unknown, fallback: number): number {
  const e = err as { statusCode?: unknown; status_code?: unknown };
  if (isHttpStatus(e?.statusCode)) return e.statusCode;
  if (isHttpStatus(e?.status_code)) return e.status_code;
  return fallback;
}
