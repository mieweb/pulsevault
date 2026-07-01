import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { S3Storage } from "../storage/s3.js";
import type { PulseVaultValidatePayload } from "./magic.js";

export type ChecksumAlgorithm = "sha256" | "sha1" | "md5";
const SUPPORTED_ALGORITHMS: readonly ChecksumAlgorithm[] = ["sha256", "sha1", "md5"];

export type ParsedChecksum = { algorithm: ChecksumAlgorithm; digest: string };

/**
 * Parse the client-supplied `Upload-Metadata.checksum` value, format
 * `<algorithm>:<hex digest>` (e.g. `sha256:9f86d0...`). Returns `null` for a
 * missing or malformed value — checksum verification is opt-in per upload,
 * not required, unless the caller treats a `null` parse as a rejection.
 */
export function parseChecksumMetadata(raw: string | undefined | null): ParsedChecksum | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const algorithm = raw.slice(0, sep).toLowerCase();
  const digest = raw.slice(sep + 1).toLowerCase();
  if (!isSupportedAlgorithm(algorithm)) return null;
  if (!/^[0-9a-f]+$/.test(digest) || digest.length === 0) return null;
  return { algorithm, digest };
}

function isSupportedAlgorithm(value: string): value is ChecksumAlgorithm {
  return (SUPPORTED_ALGORITHMS as readonly string[]).includes(value);
}

function digestBuffer(buf: Buffer, algorithm: ChecksumAlgorithm): string {
  return createHash(algorithm).update(buf).digest("hex");
}

async function digestLocalFile(path: string, algorithm: ChecksumAlgorithm): Promise<string> {
  return digestBuffer(await fs.readFile(path), algorithm);
}

function checksumError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 422 });
}

/**
 * Build a `validatePayload` (or `validateCaptionsPayload`/`validateProjectPayload`)
 * hook that verifies a client-supplied checksum against the finalized bytes
 * before the upload is marked ready — for adapters that expose `localPath`
 * (the built-in local adapter does; see `createS3ChecksumValidator` for S3/R2).
 *
 * This is at-rest corruption/tampering detection on the *finished* file, not
 * a per-chunk integrity check — the TUS protocol's Checksum extension would
 * cover chunks in flight, but the `@tus/server` version in use doesn't
 * implement it. This fills the same gap for the finished artifact instead.
 *
 * Uploads with no `checksum` metadata are passed through unchanged (the
 * client opted out); a checksum that's present but doesn't match is rejected
 * with 422 and the bytes are removed, same semantics as `createMp4Sniffer`.
 * Chain with another validator (e.g. `createMp4Sniffer`) via `next`:
 *
 * ```ts
 * validatePayload: createChecksumValidator(createMp4Sniffer(storage)),
 * ```
 */
export function createChecksumValidator(
  next?: PulseVaultValidatePayload,
): PulseVaultValidatePayload {
  return async (request, ctx) => {
    const checksum = parseChecksumMetadata(ctx.checksum);
    if (checksum) {
      if (!ctx.localPath) {
        throw checksumError(
          "Checksum verification requested but this storage adapter has no local path — use createS3ChecksumValidator for S3/R2 storage",
        );
      }
      const actual = await digestLocalFile(ctx.localPath, checksum.algorithm);
      if (actual !== checksum.digest) {
        throw checksumError(
          `Checksum mismatch: expected ${checksum.algorithm}:${checksum.digest}, got ${checksum.algorithm}:${actual}`,
        );
      }
    }
    if (next) await next(request, ctx);
  };
}

/**
 * `createChecksumValidator` for the S3/R2 backend — downloads the whole
 * finalized object (via `S3Storage.readAll`) to compute the digest, since
 * S3 has no local path to hash directly. Only worth using when checksum
 * verification is explicitly wanted; it's a full extra download per upload.
 */
export function createS3ChecksumValidator(
  storage: S3Storage,
  next?: PulseVaultValidatePayload,
): PulseVaultValidatePayload {
  return async (request, ctx) => {
    const checksum = parseChecksumMetadata(ctx.checksum);
    if (checksum) {
      const bytes = await storage.readAll(ctx.artifactId);
      if (!bytes) {
        throw Object.assign(
          new Error(`Cannot validate upload ${ctx.artifactId}: no object bytes available`),
          { statusCode: 500 },
        );
      }
      const actual = digestBuffer(bytes, checksum.algorithm);
      if (actual !== checksum.digest) {
        throw checksumError(
          `Checksum mismatch: expected ${checksum.algorithm}:${checksum.digest}, got ${checksum.algorithm}:${actual}`,
        );
      }
    }
    if (next) await next(request, ctx);
  };
}
