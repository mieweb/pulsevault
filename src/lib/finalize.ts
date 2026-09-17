import { statusCodeOf } from './errors.js';
import type { PulseVaultLogger, PulseVaultRequest } from './request.js';
import type { PulseVaultValidatePayload } from './magic.js';
import type { PulseVaultOnArtifactEvent, PulseVaultOnUploadComplete } from './pulsevaultTus.js';
import type { PulseVaultStorage, UploadKind } from '../storage/types.js';

export type FinalizeDeps = {
  storage: PulseVaultStorage;
  validatePayload?: PulseVaultValidatePayload;
  onUploadComplete?: PulseVaultOnUploadComplete;
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  logger: PulseVaultLogger;
};

export type FinalizeInput = {
  artifactId: string;
  kind: UploadKind;
  size: number;
  /** Datastore id of the upload (the tus upload id; for direct uploads the same `<kind>/<id><ext>` key). */
  uploadId: string;
  checksum?: string;
  localPath: string | null;
};

export type FinalizeResult = { ok: true } | { ok: false; statusCode: number; message: string };

/**
 * THE completion sequence for a fully-written upload, shared by the TUS
 * `onUploadFinish` hook and the direct-upload `complete` endpoint so the two
 * ingestion paths can never diverge on validation/cleanup semantics:
 *
 * 1. `validatePayload` (magic bytes, checksum, virus scan…). Failure wipes the
 *    bytes from storage and the client gets a 4xx. The id is spent either way
 *    (single-use); the client mints a fresh one. 5xx reasons stay server-side.
 * 2. `markReady` — flips the sidecar so `resolve` will serve the bytes. Done
 *    *before* the consumer hook so a downstream service reacting to
 *    `onUploadComplete` can immediately GET the artifact.
 * 3. `onUploadComplete` — consumer business logic (DB writes, queue jobs).
 *    The artifact is already ready; consumers wanting all-or-nothing should
 *    `storage.remove` before throwing.
 * 4. `onArtifactEvent({ phase: "complete" })`.
 *
 * Returns a result instead of throwing so each transport maps it to its own
 * error shape (tus error vs JSON response).
 */
export async function finalizeArtifact(
  deps: FinalizeDeps,
  request: PulseVaultRequest,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const { storage, validatePayload, onUploadComplete, onArtifactEvent, logger } = deps;
  const { artifactId, kind, size, uploadId, checksum, localPath } = input;

  if (validatePayload) {
    try {
      await validatePayload(request, {
        artifactId,
        size,
        uploadId,
        localPath,
        ...(checksum ? { checksum } : {}),
        kind,
      });
    } catch (err) {
      const statusCode = statusCodeOf(err, 422);
      const message = err instanceof Error ? err.message : 'Payload validation failed';
      // Best effort: the rejection stands whether or not the wipe lands. A
      // stuck "uploading" reservation with bytes behind it is what the
      // retention sweep exists for.
      await storage.remove?.(artifactId).catch((rmErr: unknown) => {
        logger.error({ err: rmErr, artifactId }, 'pulsevault failed to remove rejected upload');
      });
      await onArtifactEvent?.({ phase: 'reject', artifactId, kind, size, reason: message });
      // 4xx rejection reasons are the client's business (e.g. "Checksum
      // mismatch: …"); 5xx means *our* side broke — log the real error and
      // return a generic body so internals never reach the client.
      if (statusCode >= 500) {
        logger.error({ err, artifactId, kind }, 'pulsevault payload validation errored');
        return { ok: false, statusCode, message: 'Payload validation failed' };
      }
      return { ok: false, statusCode, message };
    }
  }

  try {
    await storage.markReady?.(artifactId);
  } catch (err) {
    logger.error({ err, artifactId, kind }, 'pulsevault markReady failed');
    return { ok: false, statusCode: 500, message: 'Upload finalization failed' };
  }

  if (onUploadComplete) {
    try {
      await onUploadComplete(request, { artifactId, kind, size, uploadId });
    } catch (err) {
      logger.error({ err, artifactId, kind }, 'pulsevault onUploadComplete failed');
      return { ok: false, statusCode: 500, message: 'Upload completion hook failed' };
    }
  }

  await onArtifactEvent?.({ phase: 'complete', artifactId, kind, size });
  return { ok: true };
}
