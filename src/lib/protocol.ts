import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';

/**
 * The protocol this release implements, read from `package.json` `pulseProtocol` — the one
 * place it's written down (PROTOCOL.md §7). npm keeps the field for every published version,
 * so which release spoke which protocol can always be looked up.
 *
 * - `version` is the spec revision, `major.minor`. The major changes only for breaking changes
 *   and is what pairing compares; the minor counts additions older clients can ignore.
 * - `min`/`max` are the protocol majors this release accepts from clients.
 */
type PulseProtocol = { version: string; min: number; max: number };

const require = createRequire(import.meta.url);
const { pulseProtocol } = require('../../package.json') as { pulseProtocol: PulseProtocol };

/** Spec revision this release implements, e.g. `"2.1"`. */
export const PROTOCOL_REVISION = pulseProtocol.version;
/** Protocol major this release implements (the `Protocol-Version` response header). */
export const PROTOCOL_VERSION = Number(PROTOCOL_REVISION.split('.')[0]);
export const MIN_SUPPORTED_PROTOCOL_VERSION = pulseProtocol.min;
export const MAX_SUPPORTED_PROTOCOL_VERSION = pulseProtocol.max;

if (
  !/^\d+\.\d+$/.test(PROTOCOL_REVISION) ||
  MIN_SUPPORTED_PROTOCOL_VERSION > PROTOCOL_VERSION ||
  MAX_SUPPORTED_PROTOCOL_VERSION < PROTOCOL_VERSION
) {
  throw new Error(`package.json pulseProtocol is inconsistent: ${JSON.stringify(pulseProtocol)}`);
}

/**
 * What a client says about itself in the `Pulse-Client` request header (PROTOCOL.md §7):
 * `<product>/<version> [(<details>)]; protocol=<min>[-<max>]`, e.g.
 * `Pulse/2.1.0 (45; ios); protocol=1-2`. Optional: a client that doesn't send it is treated as
 * before this header existed.
 */
export type PulseClient = { raw: string; protocolMin?: number; protocolMax?: number };

export function parsePulseClient(value: string | string[] | undefined): PulseClient | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return null;
  const match = raw.match(/(?:^|;)\s*protocol=(\d+)(?:-(\d+))?\s*(?:;|$)/);
  if (!match) return { raw };
  const protocolMin = Number(match[1]);
  const protocolMax = match[2] === undefined ? protocolMin : Number(match[2]);
  return protocolMax < protocolMin ? { raw } : { raw, protocolMin, protocolMax };
}

/**
 * The `426 Upgrade Required` body for a client whose newest protocol is older than this server's
 * oldest, or `null` if the client is fine (or didn't say).
 */
export function outdatedClientRejection(
  req: IncomingMessage,
): { error: string; minSupportedVersion: number; maxSupportedVersion: number } | null {
  const client = parsePulseClient(req.headers['pulse-client']);
  if (client?.protocolMax === undefined || client.protocolMax >= MIN_SUPPORTED_PROTOCOL_VERSION) {
    return null;
  }
  const range =
    MIN_SUPPORTED_PROTOCOL_VERSION === MAX_SUPPORTED_PROTOCOL_VERSION
      ? `${MIN_SUPPORTED_PROTOCOL_VERSION}`
      : `${MIN_SUPPORTED_PROTOCOL_VERSION}–${MAX_SUPPORTED_PROTOCOL_VERSION}`;
  return {
    error: `This server needs a client that speaks upload protocol ${range}. Update the app and try again.`,
    minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
  };
}

/**
 * Defensive cap on the stored `appVersion` metadata: a version string, never a document.
 * Capped by code point so a truncated value can't end in half a surrogate pair.
 */
const MAX_APP_VERSION_LENGTH = 64;

/** The client app version from `Upload-Metadata.appVersion`, trimmed and capped. */
export function normalizeAppVersion(value: string | null | undefined): string | undefined {
  return (
    Array.from((value ?? '').trim())
      .slice(0, MAX_APP_VERSION_LENGTH)
      .join('') || undefined
  );
}
