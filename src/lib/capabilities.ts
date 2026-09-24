import { UPLOAD_KINDS, type UploadKind } from '../storage/types.js';
import type { PulseVaultAllowedExtensions } from './options.js';
import {
  MAX_SUPPORTED_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_REVISION,
  PROTOCOL_VERSION,
} from './protocol.js';

export { PROTOCOL_REVISION, PROTOCOL_VERSION };

export type PulseVaultCapabilities = {
  protocolVersion: number;
  protocolRevision: string;
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
 * advertise different capabilities for the same deployment. Its shape is
 * `protocol/schemas/capabilities.schema.json`, checked in the tests.
 */
export function buildCapabilities(input: {
  allowedExtensions: PulseVaultAllowedExtensions;
  maxUploadSize: number;
}): PulseVaultCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    protocolRevision: PROTOCOL_REVISION,
    minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
    kinds: [...UPLOAD_KINDS],
    allowedExtensions: input.allowedExtensions,
    maxUploadSize: input.maxUploadSize,
    checksum: { algorithms: ['sha256', 'sha1', 'md5'] },
  };
}
