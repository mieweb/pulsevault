import type { PulseVaultStorage, UploadKind } from '../storage/types.js';
import { UPLOAD_KINDS } from '../storage/types.js';
import { supportsDirectUpload } from './direct-upload.js';
import type { PulseVaultAllowedExtensions } from './options.js';

/** Wire protocol version this release implements. See `/capabilities` and `PROTOCOL.md`. */
export const PROTOCOL_VERSION = 1;
const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_SUPPORTED_PROTOCOL_VERSION = 1;

export type CapabilitiesPayloadInput = {
  allowedExtensions: PulseVaultAllowedExtensions;
  maxUploadSize: number;
  storage: PulseVaultStorage;
};

/**
 * The `GET /capabilities` body — built in exactly one place so the Node core,
 * the web core, and (through the Node core) the Fastify adapter can never
 * advertise different capabilities for the same deployment.
 *
 * `directUpload` is advertised only when the storage adapter implements the
 * presigned direct-upload surface (`createDirectUpload`) — see PROTOCOL.md §9.
 */
export function buildCapabilitiesPayload(input: CapabilitiesPayloadInput): {
  protocolVersion: number;
  minSupportedVersion: number;
  maxSupportedVersion: number;
  kinds: UploadKind[];
  allowedExtensions: PulseVaultAllowedExtensions;
  maxUploadSize: number;
  checksum: { algorithms: string[] };
  directUpload?: { enabled: true };
} {
  const advertiseDirectUpload = supportsDirectUpload(input.storage);
  return {
    protocolVersion: PROTOCOL_VERSION,
    minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
    kinds: [...UPLOAD_KINDS],
    allowedExtensions: input.allowedExtensions,
    maxUploadSize: input.maxUploadSize,
    checksum: { algorithms: ['sha256', 'sha1', 'md5'] },
    ...(advertiseDirectUpload ? { directUpload: { enabled: true as const } } : {}),
  };
}
