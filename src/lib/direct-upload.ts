import path from 'node:path';
import { isUuid } from './uuid.js';
import { statusCodeOf } from './errors.js';
import { finalizeArtifact, type FinalizeDeps } from './finalize.js';
import { normalizeUploadMetadata } from './upload-metadata.js';
import type { PulseVaultAuthorize } from './authorize.js';
import type { PulseVaultAllowedExtensions } from './options.js';
import type { PulseVaultLogger, PulseVaultRequest } from './request.js';
import type { PulseVaultOnArtifactEvent } from './pulsevaultTus.js';
import type { PulseVaultStorage, ReserveUploadParams } from '../storage/types.js';

/**
 * Transport-agnostic orchestration for the PROTOCOL.md §9 direct-upload
 * profile: the client asks the server for a presigned PUT URL, uploads the
 * bytes straight to object storage (the data plane never touches the app
 * server), then calls back to confirm — at which point the server verifies
 * the stored object and runs the exact same finalize sequence as a TUS
 * upload. Both the Node core and the web core call these functions and only
 * add their own (req,res)/(Request,Response) glue, so the profile can't
 * behave differently across surfaces.
 */

/** The storage surface direct uploads need — implemented by the S3/R2 adapter. */
export type DirectUploadCapableStorage = PulseVaultStorage & {
  createDirectUpload(
    params: ReserveUploadParams & { size: number },
    opts?: { ttlSeconds?: number },
  ): Promise<{ uploadUrl: string; expiresAt: string; headers: Record<string, string> }>;
  headObjectSize(artifactId: string): Promise<number | null>;
};

export function supportsDirectUpload(
  storage: PulseVaultStorage,
): storage is DirectUploadCapableStorage {
  const s = storage as Partial<DirectUploadCapableStorage>;
  return typeof s.createDirectUpload === 'function' && typeof s.headObjectSize === 'function';
}

export type DirectUploadDeps = FinalizeDeps & {
  storage: PulseVaultStorage;
  allowedExtensions: PulseVaultAllowedExtensions;
  maxUploadSize: number;
  authorize?: PulseVaultAuthorize;
  onArtifactEvent?: PulseVaultOnArtifactEvent;
  logger: PulseVaultLogger;
};

/** Plain data result each transport turns into its own response object. */
export type DirectUploadResult = { statusCode: number; body: Record<string, unknown> };

const err = (statusCode: number, error: string): DirectUploadResult => ({
  statusCode,
  body: { ok: false, error },
});

/**
 * `POST {prefix}/direct-uploads` — authorize, reserve (same sidecar
 * bookkeeping and collision/debris rules as a TUS create), and mint the
 * presigned PUT URL. Body fields mirror the TUS `Upload-Metadata` fields plus
 * the mandatory `size` (signed into the URL, so the grant can only upload
 * exactly the declared payload).
 */
export async function directUploadCreate(
  deps: DirectUploadDeps,
  request: PulseVaultRequest,
  rawBody: unknown,
): Promise<DirectUploadResult> {
  const { storage, allowedExtensions, maxUploadSize, authorize, onArtifactEvent, logger } = deps;
  if (!supportsDirectUpload(storage)) {
    return err(501, 'This deployment does not support direct uploads');
  }

  if (typeof rawBody !== 'object' || rawBody === null) {
    return err(400, 'Request body must be a JSON object');
  }
  const raw = rawBody as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  // Same normalization (alias precedence, name capping, checksum trimming) as
  // the TUS metadata path — one rulebook for both ingestion profiles.
  const normalized = normalizeUploadMetadata({
    artifactId: str(raw.artifactId),
    videoid: str(raw.videoid),
    projectid: str(raw.projectid),
    filename: str(raw.filename),
    kind: str(raw.kind),
    relatedTo: str(raw.relatedTo),
    checksum: str(raw.checksum),
    name: str(raw.name),
  });

  if (!isUuid(normalized.artifactId)) {
    return err(400, '`artifactId` must be a valid UUID');
  }
  const ext = path.extname(normalized.filename).toLowerCase();
  const allowed = allowedExtensions[normalized.kind];
  if (!ext || !allowed.includes(ext)) {
    return err(
      400,
      `\`filename\` for kind="${normalized.kind}" must end with one of: ${allowed.join(', ')}`,
    );
  }
  const size = raw.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    return err(400, '`size` must be a positive integer byte count');
  }
  if (size > maxUploadSize) {
    return err(413, `\`size\` exceeds the maximum upload size (${maxUploadSize} bytes)`);
  }

  if (authorize) {
    try {
      await authorize(request, {
        phase: 'create',
        artifactId: normalized.artifactId,
        kind: normalized.kind,
        relatedTo: normalized.relatedTo,
      });
    } catch (authErr) {
      const statusCode = statusCodeOf(authErr, 403);
      const message = authErr instanceof Error && authErr.message ? authErr.message : 'Forbidden';
      logger.info(
        { err: authErr, artifactId: normalized.artifactId, phase: 'create', statusCode },
        'pulsevault authorize rejected',
      );
      await onArtifactEvent?.({
        phase: 'authorize',
        artifactId: normalized.artifactId,
        kind: normalized.kind,
        reason: message,
      });
      return err(statusCode, message);
    }
  }

  try {
    const grant = await storage.createDirectUpload({
      artifactId: normalized.artifactId,
      filename: normalized.filename,
      ext,
      kind: normalized.kind,
      relatedTo: normalized.relatedTo,
      checksum: normalized.checksum,
      name: normalized.name,
      size,
    });
    return {
      statusCode: 201,
      body: {
        ok: true,
        artifactId: normalized.artifactId,
        uploadUrl: grant.uploadUrl,
        expiresAt: grant.expiresAt,
        headers: grant.headers,
      },
    };
  } catch (reserveErr) {
    const statusCode = statusCodeOf(reserveErr, 500);
    if (statusCode >= 500) {
      logger.error(
        { err: reserveErr, artifactId: normalized.artifactId },
        'pulsevault direct-upload reserve failed',
      );
      return err(500, 'Could not create the direct upload');
    }
    if (statusCode === 409) {
      // Re-grant: the reservation already exists. If it's THIS client's own
      // incomplete direct upload (authorized above, same declared shape), a
      // fresh presigned URL is the correct answer — the client lost or
      // outlived the previous grant (app kill, URL TTL) and needs a new one
      // to retry the PUT. A finished artifact, or a reservation with a
      // different shape (size/kind/ext), stays a genuine conflict.
      const existing = await storage.getMetadata?.(normalized.artifactId);
      const sameShape =
        existing &&
        !existing.ready &&
        existing.kind === normalized.kind &&
        existing.ext === ext &&
        (existing.expectedSize === undefined || existing.expectedSize === size);
      if (sameShape) {
        try {
          const regrant = await regrantDirectUpload(storage, normalized.artifactId, size);
          if (regrant) {
            return {
              statusCode: 200,
              body: {
                ok: true,
                artifactId: normalized.artifactId,
                uploadUrl: regrant.uploadUrl,
                expiresAt: regrant.expiresAt,
                headers: regrant.headers,
              },
            };
          }
        } catch (regrantErr) {
          logger.error(
            { err: regrantErr, artifactId: normalized.artifactId },
            'pulsevault direct-upload regrant failed',
          );
          return err(500, 'Could not create the direct upload');
        }
      }
    }
    const message =
      reserveErr instanceof Error && reserveErr.message ? reserveErr.message : 'Conflict';
    return err(statusCode, message);
  }
}

/**
 * Mint a fresh presigned PUT for an existing, incomplete reservation without
 * re-reserving. Duck-typed on an optional adapter method (`presignPut`, which
 * looks the reservation up itself) so the S3 adapter can expose it without
 * widening the required storage contract.
 */
async function regrantDirectUpload(
  storage: PulseVaultStorage,
  artifactId: string,
  size: number,
): Promise<{ uploadUrl: string; expiresAt: string; headers: Record<string, string> } | null> {
  const candidate = (storage as { presignPut?: unknown }).presignPut;
  if (typeof candidate !== 'function') return null;
  return (
    candidate as (
      artifactId: string,
      size: number,
    ) => Promise<{ uploadUrl: string; expiresAt: string; headers: Record<string, string> }>
  )(artifactId, size);
}

/**
 * `POST {prefix}/direct-uploads/:artifactId/complete` — verify the object the
 * client claims to have PUT actually landed with the declared size, then run
 * the shared finalize sequence (validatePayload → markReady →
 * onUploadComplete → event). Idempotent: completing an already-ready artifact
 * returns 200 without re-running hooks, so a client can safely retry a
 * complete whose response it lost.
 */
export async function directUploadComplete(
  deps: DirectUploadDeps,
  request: PulseVaultRequest,
  artifactId: string,
): Promise<DirectUploadResult> {
  const { storage, authorize, onArtifactEvent, logger } = deps;
  if (!supportsDirectUpload(storage)) {
    return err(501, 'This deployment does not support direct uploads');
  }
  if (!isUuid(artifactId)) {
    return err(400, '`artifactId` must be a valid UUID');
  }

  const meta = await storage.getMetadata?.(artifactId);
  if (!meta) return err(404, 'Unknown artifactId — create the direct upload first');

  if (authorize) {
    try {
      // Completing is the direct profile's "writing bytes" moment — same
      // phase and token scope as a TUS PATCH.
      await authorize(request, {
        phase: 'patch',
        artifactId,
        kind: meta.kind,
        relatedTo: meta.relatedTo,
      });
    } catch (authErr) {
      const statusCode = statusCodeOf(authErr, 403);
      const message = authErr instanceof Error && authErr.message ? authErr.message : 'Forbidden';
      logger.info(
        { err: authErr, artifactId, phase: 'patch', statusCode },
        'pulsevault authorize rejected',
      );
      return err(statusCode, message);
    }
  }

  if (meta.ready) {
    return { statusCode: 200, body: { ok: true, artifactId } };
  }

  const storedSize = await storage.headObjectSize(artifactId);
  if (storedSize === null) {
    return err(409, 'No uploaded object found — PUT the bytes to the upload URL first');
  }
  if (meta.expectedSize !== undefined && storedSize !== meta.expectedSize) {
    // Wrong bytes landed (truncated PUT, or a different payload). Same
    // fail-closed cleanup as a validation failure: wipe and let the client
    // re-create with a fresh grant.
    try {
      await storage.remove?.(artifactId);
    } catch (rmErr) {
      logger.error({ err: rmErr, artifactId }, 'pulsevault failed to remove mismatched upload');
    }
    await onArtifactEvent?.({
      phase: 'reject',
      artifactId,
      kind: meta.kind,
      size: storedSize,
      reason: 'Uploaded size does not match the declared size',
    });
    return err(
      422,
      `Uploaded size (${storedSize}) does not match the declared size (${meta.expectedSize})`,
    );
  }

  const result = await finalizeArtifact(deps, request, {
    artifactId,
    kind: meta.kind,
    size: storedSize,
    uploadId: `${meta.kind}/${artifactId}${meta.ext}`,
    checksum: meta.checksum,
    localPath: null,
  });
  if (!result.ok) return err(result.statusCode, result.message);
  return { statusCode: 200, body: { ok: true, artifactId } };
}
