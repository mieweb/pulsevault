import { UPLOAD_KINDS, type UploadKind } from '../storage/types.js';
import type { PulseVaultAllowedExtensions } from './options.js';

/** Wire protocol version this release implements. See `/capabilities` and `PROTOCOL.md`. */
export const PROTOCOL_VERSION = 1;
const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_SUPPORTED_PROTOCOL_VERSION = 1;

export type PulseVaultCapabilities = {
  protocolVersion: number;
  minSupportedVersion: number;
  maxSupportedVersion: number;
  kinds: UploadKind[];
  allowedExtensions: PulseVaultAllowedExtensions;
  maxUploadSize: number;
  checksum: { algorithms: string[] };
};

/**
 * The `GET /capabilities` body (PROTOCOL.md §2), built in exactly one place so
 * the core and the Fastify plugin (which delegates to the core) can never
 * advertise different capabilities for the same deployment.
 */
export function buildCapabilities(input: {
  allowedExtensions: PulseVaultAllowedExtensions;
  maxUploadSize: number;
}): PulseVaultCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
    kinds: [...UPLOAD_KINDS],
    allowedExtensions: input.allowedExtensions,
    maxUploadSize: input.maxUploadSize,
    checksum: { algorithms: ['sha256', 'sha1', 'md5'] },
  };
}
