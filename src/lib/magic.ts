import fs from "node:fs/promises";
import type { FastifyRequest } from "fastify";
import type { LocalStorage } from "../storage/local.js";
import type { S3Storage } from "../storage/s3.js";

/**
 * Optional plugin-level hook: after TUS writes the final byte but before the
 * upload is marked ready (or the consumer's `onUploadComplete` runs),
 * validate the payload bytes. Throw to reject — the plugin translates the
 * throw into a 422 response, calls `storage.remove?.(videoid)` to free the
 * disk, and never flips the sidecar to `"ready"`.
 *
 * The `localPath` field is populated for adapters that expose
 * `getLocalPath` (the built-in local adapter does). For adapters whose
 * bytes don't live on local disk (S3, etc.), `localPath` is `null` and the
 * validator has to fetch bytes through whatever API the adapter provides.
 */
export type PulseVaultValidatePayload = (
  request: FastifyRequest,
  ctx: {
    artifactId: string;
    size: number;
    uploadId: string;
    /** Absolute local path to the finalized bytes, or `null` if unavailable. */
    localPath: string | null;
  },
) => void | Promise<void>;

/**
 * Check whether a file's first bytes match the ISO base media file format
 * (`ftyp` box at offset 4), which covers MP4, MOV, M4V, 3GP, and related
 * containers. This is the same check tools like `file(1)` and ffprobe use
 * to identify MP4-family videos.
 *
 * Not a full MP4 parse — just a ~12-byte sniff. Enough to reject uploads
 * that are obviously not video (PDFs, HTML, random bytes) before the
 * server ever serves them back as `video/mp4`.
 */
export async function sniffMp4(filePath: string): Promise<boolean> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fd.read(buf, 0, 12, 0);
    if (bytesRead < 12) return false;
    return hasFtypBox(buf);
  } finally {
    await fd.close();
  }
}

/**
 * Whether a buffer's first 12 bytes carry an ISO base media `ftyp` box.
 * Bytes 4..7 must spell "ftyp" (ASCII 0x66 0x74 0x79 0x70). The first four
 * bytes are the box size and the four after "ftyp" are the brand (e.g.
 * "isom", "mp42", "qt  ") — brand validation is left to downstream tools.
 */
function hasFtypBox(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return (
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  );
}

/**
 * Build a `validatePayload` hook that enforces every uploaded file is a
 * valid MP4-family container. Only works with `LocalStorage` (or any
 * adapter that exposes `getLocalPath`) — pulls the path from the storage
 * and runs `sniffMp4` against it.
 *
 * Usage:
 * ```ts
 * const storage = createLocalStorage({ workspaceDir: "./data" });
 * await app.register(pulseVault, {
 *   storage,
 *   validatePayload: createMp4Sniffer(storage),
 *   // ...
 * });
 * ```
 */
export function createMp4Sniffer(
  storage: LocalStorage,
): PulseVaultValidatePayload {
  return async (_request, { artifactId }) => {
    const localPath = await storage.getLocalPath(artifactId);
    if (!localPath) {
      throw Object.assign(
        new Error(
          `Cannot validate upload ${artifactId}: no local path available`,
        ),
        { statusCode: 500 },
      );
    }
    const ok = await sniffMp4(localPath);
    if (!ok) {
      throw Object.assign(
        new Error("Uploaded bytes are not a valid MP4 (missing ftyp header)"),
        { statusCode: 422 },
      );
    }
  };
}

/**
 * `createMp4Sniffer` for the S3 / R2 backend. Instead of opening a local file,
 * it asks the adapter for the first 12 bytes of the finalized object via a
 * small ranged GET (`S3Storage.readHeader`) and applies the same `ftyp` check.
 * Runs in the same lifecycle slot — after `@tus/s3-store` completes the
 * multipart upload (so the object is readable) but before `markReady` — so a
 * non-MP4 upload is removed and never served.
 *
 * Usage:
 * ```ts
 * const storage = await createS3Storage({ ... });
 * await app.register(pulseVault, {
 *   storage,
 *   validatePayload: createS3Mp4Sniffer(storage),
 *   // ...
 * });
 * ```
 */
export function createS3Mp4Sniffer(
  storage: S3Storage,
): PulseVaultValidatePayload {
  return async (_request, { artifactId }) => {
    const header = await storage.readHeader(artifactId, 12);
    if (!header) {
      throw Object.assign(
        new Error(`Cannot validate upload ${artifactId}: no object bytes available`),
        { statusCode: 500 },
      );
    }
    if (!hasFtypBox(header)) {
      throw Object.assign(
        new Error("Uploaded bytes are not a valid MP4 (missing ftyp header)"),
        { statusCode: 422 },
      );
    }
  };
}
