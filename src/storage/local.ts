import { FileStore } from "@tus/file-store";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
  UploadKind,
} from "./types.js";

/**
 * Per-video metadata sidecar written at
 * `<workspaceRoot>/<videoid>/.pulsevault.json`. Lets `resolve()` recover a
 * video's extension and completion state without scanning the directory,
 * and keeps the on-disk layout self-describing for downstream tools
 * (ArtiPod pipelines, ffmpeg, rsync, etc.).
 */
type Sidecar = {
  /** Sidecar schema version. Increment for breaking changes. */
  version: 1;
  /** Lowercase extension including the leading dot (e.g. `".mp4"`). */
  ext: string;
  /** Original filename from `Upload-Metadata.filename`. */
  filename: string;
  /**
   * `"uploading"` between `reserveUpload` and `markReady`; `"ready"` once
   * every post-upload validation has passed. The GET route only serves
   * `"ready"` sidecars — partially-written files never leak out.
   */
  status: "uploading" | "ready";
  /**
   * Artifact kind. Optional for back-compat — sidecars written before
   * kind was introduced are read as `"video"` with no on-disk migration.
   */
  kind?: UploadKind;
};

const SIDECAR_VERSION = 1 as const;
/** Hidden directory inside workspaceRoot that holds per-upload sidecar files. */
const PULSEVAULT_META_DIR = ".pulsevault";

type CachedMeta = { ext: string; ready: boolean; kind: UploadKind };

/** Map a file extension to the `Content-Type` the GET route should return. */
function extToContentType(ext: string): string {
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

export type LocalStorageOptions = {
  /** Directory where uploads are stored (flat kind-scoped subdirs). Resolved against CWD if relative. */
  workspaceDir: string;
};

/**
 * Local adapter storage. Layout contract (stable; downstream tools may rely
 * on it):
 *
 * ```text
 * <workspaceRoot>/
 *   .pulsevault/<videoid>.json   # sidecar: { version, ext, filename, status, kind }
 *   video/<videoid><ext>         # finalized video bytes
 *   video/<videoid><ext>.json    # @tus/file-store offset/metadata sidecar
 *   project/<videoid><ext>       # finalized project bytes
 *   project/<videoid><ext>.json  # @tus/file-store offset/metadata sidecar
 * ```
 *
 * `workspaceRoot` is exposed so consumers can layer post-processing (e.g.
 * hydrate an ArtiPod with `video/`, `transcripts/`, `frames/` mounts) against
 * the same on-disk tree from an `onUploadComplete` hook. `getLocalPath` is
 * exposed for `validatePayload` helpers that need to sniff the bytes before
 * the upload is marked ready.
 */
export type LocalStorage = PulseVaultStorage & {
  readonly workspaceRoot: string;
  /**
   * Return the absolute path to the upload bytes for `videoid`, regardless
   * of ready state. Falls back to reading the sidecar if the in-memory cache
   * is cold (so it works even after a server restart mid-upload). Returns
   * `null` if the videoid is unknown.
   */
  getLocalPath(videoid: string): Promise<string | null>;
  /**
   * Return the artifact kind for a known videoid without a full resolve.
   * Returns `null` if the videoid is unknown. Satisfies the optional
   * `PulseVaultStorage.getKind` contract.
   */
  getKind(videoid: string): Promise<UploadKind | null>;
};

export function createLocalStorage(opts: LocalStorageOptions): LocalStorage {
  const workspaceRoot = path.resolve(opts.workspaceDir);
  const datastore = new FileStore({ directory: workspaceRoot });
  // Metadata cache keyed by videoid. Populated eagerly on reserve and lazily
  // from the sidecar on cache-miss — so we never do a workspace-wide scan at
  // boot and never do a per-request readdir on the GET hot path.
  const metaCache = new Map<string, CachedMeta>();

  /** Absolute path to the hidden metadata directory. */
  const sidecarDir = (): string => path.join(workspaceRoot, PULSEVAULT_META_DIR);
  /** Absolute path to the sidecar JSON for a given videoid. */
  const sidecarPath = (videoid: string): string =>
    path.join(sidecarDir(), `${videoid}.json`);
  /** Relative path (from workspaceRoot) to the artifact bytes. */
  const artifactRelPath = (videoid: string, kind: UploadKind, ext: string): string =>
    `${kind}/${videoid}${ext}`;

  const writeSidecar = async (
    videoid: string,
    sidecar: Sidecar,
  ): Promise<void> => {
    // Atomic tmp + rename so a crash mid-write can never leave a truncated
    // JSON blob that `loadMeta` would then treat as corrupt.
    const finalPath = sidecarPath(videoid);
    const tmpPath = `${finalPath}.tmp`;
    await fs.mkdir(sidecarDir(), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(sidecar), "utf8");
    await fs.rename(tmpPath, finalPath);
  };

  const readSidecar = async (videoid: string): Promise<Sidecar | null> => {
    let raw: string;
    try {
      raw = await fs.readFile(sidecarPath(videoid), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Sidecar>;
      if (typeof parsed.ext !== "string") return null;
      if (typeof parsed.filename !== "string") return null;
      // Older sidecars (pre-status) are treated as ready so an in-place
      // upgrade doesn't hide finalized uploads. New uploads always write a
      // `status` field explicitly.
      const status: Sidecar["status"] =
        parsed.status === "uploading" ? "uploading" : "ready";
      // Older sidecars without `kind` default to `"video"` — no migration.
      const kind: UploadKind = parsed.kind === "project" ? "project" : "video";
      return {
        version: SIDECAR_VERSION,
        ext: parsed.ext,
        filename: parsed.filename,
        status,
        kind,
      };
    } catch {
      // Malformed sidecar — treat as absent. `reserveUpload` will rewrite
      // it on the next create.
      return null;
    }
  };

  const loadMeta = async (videoid: string): Promise<CachedMeta | null> => {
    const cached = metaCache.get(videoid);
    if (cached) return cached;
    const sidecar = await readSidecar(videoid);
    if (!sidecar) return null;
    const meta: CachedMeta = {
      ext: sidecar.ext,
      ready: sidecar.status === "ready",
      kind: sidecar.kind ?? "video",
    };
    metaCache.set(videoid, meta);
    return meta;
  };

  const initialize = async (): Promise<void> => {
    await fs.mkdir(sidecarDir(), { recursive: true });
  };

  const reserveUpload = async ({
    videoid,
    filename,
    ext,
    kind,
  }: ReserveUploadParams): Promise<string> => {
    // Collision guard: if an upload (in-progress or ready) already exists
    // for this videoid, refuse the new upload rather than letting
    // @tus/file-store silently reset the metadata sidecar to offset 0 and
    // overwrite the file chunk-by-chunk on subsequent PATCHes. Translates
    // to HTTP 409 via @tus/server's error path.
    const meta = await loadMeta(videoid);
    if (meta) {
      throw Object.assign(
        new Error(`videoid ${videoid} already has an upload`),
        { statusCode: 409, status_code: 409 },
      );
    }

    await fs.mkdir(path.join(workspaceRoot, kind), { recursive: true });

    await writeSidecar(videoid, {
      version: SIDECAR_VERSION,
      ext,
      filename,
      status: "uploading",
      kind,
    });

    metaCache.set(videoid, { ext, ready: false, kind });
    // @tus/file-store joins this onto its configured `directory`, so the
    // actual file lands at `<workspaceRoot>/<kind>/<videoid><ext>`.
    return artifactRelPath(videoid, kind, ext);
  };

  const resolve = async (
    videoid: string,
  ): Promise<PulseVaultResolution | null> => {
    const meta = await loadMeta(videoid);
    // Only serve ready uploads. In-progress uploads stay hidden — a client
    // GETting mid-upload would otherwise receive a truncated file.
    if (!meta || !meta.ready) return null;
    const relFile = artifactRelPath(videoid, meta.kind, meta.ext);
    try {
      const stat = await fs.stat(path.join(workspaceRoot, relFile));
      if (!stat.isFile()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
    return {
      kind: "stream",
      root: workspaceRoot,
      filename: relFile,
      contentType: extToContentType(meta.ext),
    };
  };

  const markReady = async (videoid: string): Promise<void> => {
    const sidecar = await readSidecar(videoid);
    if (!sidecar) {
      // No sidecar means no `reserveUpload` happened for this videoid — this
      // is a contract violation by the caller, not a recoverable state.
      throw new Error(
        `markReady: no sidecar for videoid ${videoid} (was reserveUpload called?)`,
      );
    }
    if (sidecar.status === "ready") {
      // Idempotent: already ready is fine, keep the cache consistent.
      metaCache.set(videoid, { ext: sidecar.ext, ready: true, kind: sidecar.kind ?? "video" });
      return;
    }
    await writeSidecar(videoid, { ...sidecar, status: "ready" });
    metaCache.set(videoid, { ext: sidecar.ext, ready: true, kind: sidecar.kind ?? "video" });
  };

  const remove = async (videoid: string): Promise<boolean> => {
    const meta = await loadMeta(videoid);
    // Drop from cache before rm so a racing `resolve` arriving after the
    // rm but before cache eviction can't hand back a stale path.
    metaCache.delete(videoid);
    if (!meta) return false;
    const artifactPath = path.join(workspaceRoot, meta.kind, `${videoid}${meta.ext}`);
    await Promise.all([
      fs.rm(artifactPath, { force: true }),
      fs.rm(`${artifactPath}.json`, { force: true }),
      fs.rm(sidecarPath(videoid), { force: true }),
    ]);
    return true;
  };

  const getLocalPath = async (videoid: string): Promise<string | null> => {
    const meta = await loadMeta(videoid);
    if (!meta) return null;
    return path.join(workspaceRoot, meta.kind, `${videoid}${meta.ext}`);
  };

  const getKind = async (videoid: string): Promise<UploadKind | null> => {
    const meta = await loadMeta(videoid);
    return meta ? meta.kind : null;
  };

  return {
    datastore,
    workspaceRoot,
    initialize,
    reserveUpload,
    resolve,
    markReady,
    remove,
    getLocalPath,
    getKind,
  };
}
