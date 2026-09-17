import { isUuid } from './uuid.js';
import { errorMessage, pulseVaultError, statusCodeOf } from './errors.js';
import { finalizeArtifact, type FinalizeDeps } from './finalize.js';
import { extractAuthzMessage } from './tus-request.js';
import { normalizeUploadMetadata } from './upload-metadata.js';
import type { PulseVaultAuthorize } from './authorize.js';
import type { PulseVaultAllowedExtensions } from './options.js';
import type { PulseVaultLogger, PulseVaultRequest } from './request.js';
import type { PulseVaultOnArtifactEvent } from './pulsevaultTus.js';
import type {
  ArtifactMetadata,
  DirectUploadGrant,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from '../storage/types.js';

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

/**
 * The FULL §9 working surface — implemented by the S3/R2 adapter. Every member
 * is required (that is what `supportsDirectUpload` checks), so nothing below
 * has to re-ask whether a method exists.
 */
export type DirectUploadCapableStorage = PulseVaultStorage & {
  createDirectUpload(params: ReserveUploadParams & { size: number }): Promise<DirectUploadGrant>;
  headObjectSize(artifactId: string): Promise<number | null>;
  getMetadata(artifactId: string, opts?: { fresh?: boolean }): Promise<ArtifactMetadata | null>;
  /** Re-grant for an existing reservation; the adapter reads storage truth once and compares every identity field. */
  presignPut(
    artifactId: string,
    expected: { size: number; kind: UploadKind; ext: string; relatedTo?: string },
    ttlSeconds?: number,
  ): Promise<DirectUploadGrant>;
  remove(artifactId: string): Promise<boolean>;
};

/**
 * Cap on the JSON bodies this profile reads (a create is a few hundred bytes).
 * Owned here — with the endpoint's semantics — and consumed by every transport,
 * so the three surfaces can't enforce three different limits.
 */
export const MAX_DIRECT_UPLOAD_BODY_BYTES = 64 * 1024;

/**
 * `path.extname(...).toLowerCase()` without `node:path` — this module is in
 * the web entry's direct-upload dependency graph, which must stay loadable on
 * runtimes without Node builtins (the TUS stack is already lazy for the same
 * reason). Matches `path.extname` semantics: no dot (or only a leading dot,
 * a dotfile) → `""`.
 */
function extnameLower(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

export function supportsDirectUpload(
  storage: PulseVaultStorage,
): storage is DirectUploadCapableStorage {
  const s = storage as Partial<DirectUploadCapableStorage>;
  // The FULL §9 working surface, not just create: re-grants need `presignPut`
  // and `getMetadata`, and the failure paths need `remove` to free the id — a
  // partial adapter must not advertise a profile it can't complete.
  return (
    typeof s.createDirectUpload === 'function' &&
    typeof s.headObjectSize === 'function' &&
    typeof s.getMetadata === 'function' &&
    typeof s.presignPut === 'function' &&
    typeof s.remove === 'function'
  );
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
  body: pulseVaultError(error),
});

/**
 * `POST {prefix}/direct-uploads` — authorize, reserve (same sidecar
 * bookkeeping and single-use collision rule as a TUS create), and mint the
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
  const ext = extnameLower(normalized.filename);
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
      const message = extractAuthzMessage(authErr);
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
    return { statusCode: 201, body: { ok: true, artifactId: normalized.artifactId, ...grant } };
  } catch (reserveErr) {
    const statusCode = statusCodeOf(reserveErr, 500);
    if (statusCode >= 500) {
      logger.error(
        { err: reserveErr, artifactId: normalized.artifactId },
        'pulsevault direct-upload reserve failed',
      );
      return err(500, 'Could not create the direct upload');
    }
    if (statusCode !== 409) return err(statusCode, errorMessage(reserveErr, 'Conflict'));
    // Re-grant: the reservation already exists. If it's THIS client's own
    // incomplete direct upload (authorized above, same declared shape AND the
    // same session anchor — without that clause a token authorized for anchor
    // A could submit anchor B's known artifactId with `relatedTo: A` and walk
    // away with a PUT grant for B's artifact), a fresh presigned URL is the
    // correct answer: the client's PUT failed or its URL expired and it needs
    // a new one to retry. The adapter reads storage truth once, at mint time,
    // and compares every identity field itself.
    try {
      const regrant = await storage.presignPut(normalized.artifactId, {
        size,
        kind: normalized.kind,
        ext,
        relatedTo: normalized.relatedTo,
      });
      return { statusCode: 200, body: { ok: true, artifactId: normalized.artifactId, ...regrant } };
    } catch (regrantErr) {
      // 4xx is the conflict it is; only genuine server failures become an opaque 500.
      const regrantStatus = statusCodeOf(regrantErr, 500);
      if (regrantStatus < 500) return err(regrantStatus, errorMessage(regrantErr, 'Conflict'));
      logger.error(
        { err: regrantErr, artifactId: normalized.artifactId },
        'pulsevault direct-upload regrant failed',
      );
      return err(500, 'Could not create the direct upload');
    }
  }
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
  const { storage, authorize, logger } = deps;
  if (!supportsDirectUpload(storage)) {
    return err(501, 'This deployment does not support direct uploads');
  }
  if (!isUuid(artifactId)) {
    return err(400, '`artifactId` must be a valid UUID');
  }

  // Storage truth: another instance may have just marked this artifact ready.
  const meta = await storage.getMetadata(artifactId, { fresh: true });
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
      const message = extractAuthzMessage(authErr);
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

  // Serialize completes per artifactId in this process: two concurrent
  // `complete` calls (lost-response retry racing the original) must not both
  // observe "not ready" and run finalize — onUploadComplete firing twice would
  // contradict the documented idempotency. The loser re-reads the sidecar
  // under the lock and takes the idempotent-200 path. Cross-instance races
  // remain possible on shared object storage; consumers should treat
  // onUploadComplete as at-least-once (PROTOCOL §9.2).
  const run = (completing.get(artifactId) ?? Promise.resolve()).then(
    async (): Promise<DirectUploadResult> => {
      // Re-read under the lock: the winner of a retry race has just marked
      // this ready, and the loser must take the idempotent 200 path.
      const fresh = await storage.getMetadata(artifactId, { fresh: true });
      if (!fresh) return err(404, 'Unknown artifactId — create the direct upload first');
      if (fresh.ready) {
        return { statusCode: 200, body: { ok: true, artifactId } };
      }
      return completeUnlocked({ ...deps, storage }, request, artifactId, fresh);
    },
  );
  // The stored tail never rejects, so a failed complete can't poison the chain.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  completing.set(artifactId, tail);
  try {
    return await run;
  } finally {
    if (completing.get(artifactId) === tail) completing.delete(artifactId);
  }
}

/** In-flight completion locks, keyed by artifactId (per-process). */
const completing = new Map<string, Promise<void>>();

async function completeUnlocked(
  deps: DirectUploadDeps & { storage: DirectUploadCapableStorage },
  request: PulseVaultRequest,
  artifactId: string,
  meta: ArtifactMetadata,
): Promise<DirectUploadResult> {
  const { storage, onArtifactEvent, logger } = deps;

  // Decided on the serialized re-read, not the pre-lock snapshot: a reservation
  // without a declared size is a TUS upload — the two profiles share the
  // artifactId space but must never cross, and completing a TUS reservation
  // here would run finalize behind the tus datastore's own completion.
  if (meta.expectedSize === undefined) {
    return err(409, 'artifactId belongs to a TUS upload — complete it via the TUS protocol');
  }
  const storedSize = await storage.headObjectSize(artifactId);
  if (storedSize === null) {
    return err(409, 'No uploaded object found — PUT the bytes to the upload URL first');
  }
  if (storedSize !== meta.expectedSize) {
    // Wrong bytes landed (truncated PUT, or a different payload). Same
    // fail-closed cleanup as a validation failure: wipe; the id is spent and
    // the client mints a fresh one.
    await storage.remove(artifactId).catch((rmErr: unknown) => {
      logger.error({ err: rmErr, artifactId }, 'pulsevault failed to remove mismatched upload');
    });
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
