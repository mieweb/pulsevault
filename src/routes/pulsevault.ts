import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
  FastifySchema,
} from "fastify";
import send from "@fastify/send";
import type { PulseVaultCacheOptions } from "../app.js";
import {
  createPulsevaultTusServer,
  pulseVaultTusContext,
  type PulseVaultOnUploadComplete,
  type PulseVaultOnArtifactEvent,
} from "../lib/pulsevaultTus.js";
import type { PulseVaultValidatePayload } from "../lib/magic.js";
import { pulseVaultError } from "../lib/errors.js";
import { isUuid } from "../lib/uuid.js";
import type { PulseVaultStorage } from "../storage/types.js";
import type { UploadKind } from "../storage/types.js";

/** Wire protocol version this release implements. See `/capabilities` and `PROTOCOL.md`. */
export const PROTOCOL_VERSION = 1;
const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_SUPPORTED_PROTOCOL_VERSION = 1;

// Internal augmentation — mirrored in the opt-in `./augment.ts` re-export so
// consumers can `import "@mieweb/pulsevault/augment"` and get the
// same typing. Kept here as well so the plugin itself typechecks regardless
// of whether the consumer ever imports the augment module.
declare module "fastify" {
  interface FastifyRequest {
    pulseVault?: { artifactId: string; kind: UploadKind; relatedTo?: string };
  }
}

export type PulseVaultAuthorizePhase =
  | "create"
  | "patch"
  | "resolve"
  | "delete";

export type PulseVaultAuthorizeContext = {
  phase: PulseVaultAuthorizePhase;
  artifactId: string;
  /** Artifact kind: `"video"`, `"project"`, or `"captions"`. Always present. */
  kind: UploadKind;
  /** Bearer / query-string token forwarded from the watch URL, if present. Only populated during the `"resolve"` phase. */
  token?: string;
  /**
   * The session-anchor artifact this one declared via `Upload-Metadata.relatedTo`,
   * if any. Lets `createCapabilityAuthorize` authorize an artifact against a
   * token scoped to the session it belongs to rather than its own id.
   */
  relatedTo?: string;
};

export type PulseVaultAuthorize = (
  request: FastifyRequest,
  ctx: PulseVaultAuthorizeContext,
) => void | Promise<void>;

export type PulseVaultRoutesOptions = {
  storage: PulseVaultStorage;
  maxUploadSize: number;
  allowedExtensions: { video: readonly string[]; project: readonly string[]; captions: readonly string[] };
  /** Advertised via `GET /capabilities` so the client knows which upload strategy this server expects. */
  uploadUnit: "beat" | "merged";
  cache?: PulseVaultCacheOptions;
  authorize?: PulseVaultAuthorize;
  validatePayload?: PulseVaultValidatePayload;
  onUploadComplete?: PulseVaultOnUploadComplete;
  onArtifactEvent?: PulseVaultOnArtifactEvent;
} & FastifyPluginOptions;

/**
 * Pull `artifactId` (or the legacy `videoid`/`projectid` aliases), `kind`,
 * and `relatedTo` out of a raw `Upload-Metadata` header. Format is a
 * comma-separated list of `<key> <base64-value>` pairs (tus v1 creation
 * extension).
 */
function parseUploadMetadata(
  header: string,
): { artifactId: string | undefined; kind: UploadKind; relatedTo: string | undefined } {
  let artifactId: string | undefined;
  let kind: UploadKind = "video";
  let relatedTo: string | undefined;
  for (const pair of header.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(" ");
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep);
    const value = trimmed.slice(sep + 1).trim();
    if (!value) continue;
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      if ((key === "artifactId" || key === "videoid" || key === "projectid") && !artifactId) {
        artifactId = isUuid(decoded) ? decoded : undefined;
      } else if (key === "kind") {
        const lower = decoded.trim().toLowerCase();
        kind = lower === "project" ? "project" : lower === "captions" ? "captions" : "video";
      } else if (key === "relatedTo" && !relatedTo) {
        relatedTo = isUuid(decoded) ? decoded : undefined;
      }
    } catch {
      // ignore malformed base64
    }
  }
  return { artifactId, kind, relatedTo };
}

/**
 * Decode the last URL segment of a tus PATCH/HEAD/DELETE (base64url-encoded
 * id) and extract the first path component, which the plugin always shapes as
 * the artifactId (see `pulseVaultTus.ts`).
 */
function artifactIdFromTusUrl(url: string): string | undefined {
  const match = url.match(/\/upload\/([^/?#]+)/);
  if (!match?.[1]) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const first = decoded.split("/", 1)[0];
  return isUuid(first) ? first : undefined;
}

/**
 * Resolve the artifact kind for an artifactId from storage. Duck-typed so it
 * works with any adapter (those without `getKind` return `"video"`).
 */
async function resolveStorageKind(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<UploadKind> {
  const candidate = (storage as { getKind?: unknown }).getKind;
  if (typeof candidate !== "function") return "video";
  const result = await (candidate as (id: string) => Promise<UploadKind | null>)(artifactId);
  return result ?? "video";
}

/** Resolve the `relatedTo` artifact for an artifactId from storage, if the adapter supports it. */
async function resolveStorageRelatedTo(
  storage: PulseVaultStorage,
  artifactId: string,
): Promise<string | undefined> {
  const candidate = (storage as { getRelatedTo?: unknown }).getRelatedTo;
  if (typeof candidate !== "function") return undefined;
  const result = await (candidate as (id: string) => Promise<string | null>)(artifactId);
  return result ?? undefined;
}

function extractAuthzStatus(err: unknown): number {
  const e = err as { statusCode?: unknown; status_code?: unknown };
  if (typeof e?.statusCode === "number") return e.statusCode;
  if (typeof e?.status_code === "number") return e.status_code;
  return 403;
}

function extractAuthzMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Forbidden";
}

// Local extension of FastifySchema that allows the OpenAPI-flavored fields
// (`tags`, `summary`, `description`) without pulling `@fastify/swagger` into
// the plugin's type surface. Consumers that register `@fastify/swagger` get
// the real module augmentation and these become native.
type OpenApiRouteSchema = FastifySchema & {
  tags?: string[];
  summary?: string;
  description?: string;
};

const pulseVaultErrorResponse = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["ok", "error"],
};

const tusRouteSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "TUS resumable upload endpoint",
  description:
    "TUS v1 resumable upload protocol.\n\n" +
    "- `POST` creates a new upload. The `Upload-Metadata` header must include base64-encoded key/value pairs:\n" +
    "  - `artifactId` (or the legacy `videoid`/`projectid` aliases) — a UUID generated by your server.\n" +
    "  - `filename` — original filename; the extension must match the kind's allowed list.\n" +
    "  - `kind` — `video` (default), `project`, or `captions`. Determines the storage subdir and which completion hooks fire.\n" +
    "  - `relatedTo` — optional UUID of another artifact this one belongs to (e.g. a video's captions, or a beat belonging to a pulse manifest's session).\n" +
    "  - `checksum` — optional `<algorithm>:<hex digest>` of the finished file, verified post-upload if a checksum validator is configured.\n" +
    "- `PATCH` appends a chunk at the offset given by `Upload-Offset`, with `Content-Type: application/offset+octet-stream`.\n" +
    "- `HEAD` returns the current offset for a resumable upload.\n" +
    "- `DELETE` cancels an in-flight upload.\n\n" +
    "See https://tus.io/protocols/resumable-upload for the full protocol.",
  response: {
    400: { description: "Invalid request.", ...pulseVaultErrorResponse },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
  },
};

const artifactDeleteSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Delete an uploaded artifact",
  description:
    "Deletes all storage for an artifactId (bytes + sidecar metadata), regardless of kind. Runs the `authorize` hook with `phase: \"delete\"` before the adapter's `remove` is called. Returns 204 on success, 404 if the artifactId was unknown, 501 if the adapter does not implement `remove`.",
  params: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        format: "uuid",
        description: "UUID of the upload to delete.",
      },
    },
    required: ["artifactId"],
  },
  response: {
    400: {
      description: "`artifactId` is not a valid UUID.",
      ...pulseVaultErrorResponse,
    },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
    404: { description: "Artifact not found.", ...pulseVaultErrorResponse },
    501: {
      description: "Storage adapter does not implement delete.",
      ...pulseVaultErrorResponse,
    },
  },
};

const artifactGetSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Serve a previously uploaded artifact",
  description:
    "Resolves the `artifactId` through the configured storage adapter and either streams the bytes or redirects (for CDN-backed adapters). The artifact's kind (video, project, or captions) is resolved from storage, not the URL. Runs the `authorize` hook before resolve.",
  params: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        format: "uuid",
        description: "UUID returned from the upload flow.",
      },
    },
    required: ["artifactId"],
  },
  querystring: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "Optional bearer token for pre-authenticated watch links. Forwarded to the `authorize` hook as `ctx.token` so parent servers can validate it without a separate login step.",
      },
    },
  },
  response: {
    400: {
      description: "`artifactId` is not a valid UUID.",
      ...pulseVaultErrorResponse,
    },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
    404: { description: "Artifact not found.", ...pulseVaultErrorResponse },
  },
};

const capabilitiesSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Discover this deployment's protocol version and configuration",
  description:
    "Unauthenticated — the response carries no secrets. Lets a client detect protocol compatibility before pairing, and which upload strategy (`uploadUnit`) this server expects.",
  response: {
    200: {
      type: "object",
      properties: {
        protocolVersion: { type: "number" },
        minSupportedVersion: { type: "number" },
        maxSupportedVersion: { type: "number" },
        uploadUnit: { type: "string", enum: ["beat", "merged"] },
        kinds: { type: "array", items: { type: "string" } },
        allowedExtensions: {
          type: "object",
          properties: {
            video: { type: "array", items: { type: "string" } },
            project: { type: "array", items: { type: "string" } },
            captions: { type: "array", items: { type: "string" } },
          },
        },
        maxUploadSize: { type: "number" },
        checksum: {
          type: "object",
          properties: { algorithms: { type: "array", items: { type: "string" } } },
        },
      },
    },
  },
};

const pulseVaultRoutes: FastifyPluginAsync<PulseVaultRoutesOptions> = async (
  fastify,
  opts,
) => {
  const {
    storage,
    maxUploadSize,
    allowedExtensions,
    uploadUnit,
    cache,
    authorize,
    validatePayload,
    onUploadComplete,
    onArtifactEvent,
  } = opts;
  // `fastify.prefix` is `""` when the plugin is mounted at the root.
  const tusPath = `${fastify.prefix}/upload`;

  const tusServer = createPulsevaultTusServer({
    storage,
    tusPath,
    maxSize: maxUploadSize,
    allowedExtensions,
    validatePayload,
    onUploadComplete,
    onArtifactEvent,
  });

  fastify.addContentTypeParser(
    "application/offset+octet-stream",
    (_request, _payload, done) => {
      done(null);
    },
  );

  // Every response from this plugin carries the wire protocol version it
  // implements, so a client can detect "this server is too old/new for me"
  // without a dedicated round-trip.
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("Protocol-Version", String(PROTOCOL_VERSION));
  });

  /**
   * Run the consumer's `authorize` hook (if any) for a TUS request. Returns
   * `true` iff the request may proceed; on rejection, this function already
   * wrote the response.
   */
  const runAuthorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    phase: "create" | "patch",
  ): Promise<
    | { ok: true; artifactId: string | undefined; kind: UploadKind; relatedTo?: string }
    | { ok: false }
  > => {
    let artifactId: string | undefined;
    let kind: UploadKind = "video";
    let relatedTo: string | undefined;
    if (phase === "create") {
      const meta = request.headers["upload-metadata"];
      if (typeof meta === "string") {
        ({ artifactId, kind, relatedTo } = parseUploadMetadata(meta));
      }
    } else {
      artifactId = artifactIdFromTusUrl(request.url);
      // For PATCH/HEAD, resolve kind/relatedTo from storage (cache hit after reserve).
      if (artifactId) {
        kind = await resolveStorageKind(storage, artifactId);
        relatedTo = await resolveStorageRelatedTo(storage, artifactId);
      }
    }

    if (artifactId) {
      request.pulseVault = { artifactId, kind, relatedTo };
    }

    if (!authorize) {
      return { ok: true, artifactId, kind, relatedTo };
    }

    // If we can't extract an artifactId, let tus produce its own 4xx for
    // malformed input rather than synthesize a fake authorize failure.
    if (!artifactId) {
      return { ok: true, artifactId, kind, relatedTo };
    }

    try {
      await authorize(request, { phase, artifactId, kind, relatedTo });
      return { ok: true, artifactId, kind, relatedTo };
    } catch (err) {
      const statusCode = extractAuthzStatus(err);
      const message = extractAuthzMessage(err);
      request.log.info(
        { err, artifactId, phase, statusCode },
        "pulsevault authorize rejected",
      );
      // Only the create phase is a meaningful, low-frequency audit point —
      // patch runs once per chunk and would make this noisy.
      if (phase === "create") {
        await onArtifactEvent?.({ phase: "authorize", artifactId, kind, reason: message });
      }
      await reply.code(statusCode).send(pulseVaultError(message));
      return { ok: false };
    }
  };

  const tusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const phase: "create" | "patch" =
      request.method === "POST" ? "create" : "patch";

    const authz = await runAuthorize(request, reply, phase);
    if (!authz.ok) return;

    // Once hijacked, Fastify will not write to this reply on our behalf, so we
    // must translate any unexpected throw from `@tus/server` into a response
    // ourselves — otherwise the socket stays open until the client times out.
    reply.hijack();
    try {
      await pulseVaultTusContext.run(
        { request, artifactId: authz.artifactId },
        () => tusServer.handle(request.raw, reply.raw),
      );
    } catch (err) {
      request.log.error({ err }, "pulsevault tus handler failed");
      if (reply.raw.headersSent || reply.raw.writableEnded) {
        reply.raw.destroy();
        return;
      }
      reply.raw.statusCode = 500;
      reply.raw.setHeader("content-type", "text/plain; charset=utf-8");
      reply.raw.end("Internal Server Error");
    }
  };

  const tusMethods = ["POST", "PATCH", "HEAD", "DELETE", "OPTIONS"] as const;
  fastify.route({
    method: [...tusMethods],
    url: "/upload",
    schema: tusRouteSchema,
    handler: tusHandler,
  });
  fastify.route({
    method: [...tusMethods],
    url: "/upload/*",
    schema: tusRouteSchema,
    handler: tusHandler,
  });

  fastify.get("/capabilities", { schema: capabilitiesSchema }, async (_request, reply) => {
    return reply.send({
      protocolVersion: PROTOCOL_VERSION,
      minSupportedVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
      maxSupportedVersion: MAX_SUPPORTED_PROTOCOL_VERSION,
      uploadUnit,
      kinds: ["video", "project", "captions"],
      allowedExtensions,
      maxUploadSize,
      checksum: { algorithms: ["sha256", "sha1", "md5"] },
    });
  });

  fastify.delete(
    "/artifacts/:artifactId",
    { schema: artifactDeleteSchema },
    async (request, reply) => {
      const artifactId = (request.params as { artifactId?: unknown })?.artifactId;
      if (!isUuid(artifactId)) {
        return reply
          .code(400)
          .send(pulseVaultError("`artifactId` must be a valid UUID"));
      }

      const kind = await resolveStorageKind(storage, artifactId);
      const relatedTo = await resolveStorageRelatedTo(storage, artifactId);
      request.pulseVault = { artifactId, kind, relatedTo };

      if (authorize) {
        try {
          await authorize(request, { phase: "delete", artifactId, kind, relatedTo });
        } catch (err) {
          const statusCode = extractAuthzStatus(err);
          const message = extractAuthzMessage(err);
          request.log.info(
            { err, artifactId, phase: "delete", statusCode },
            "pulsevault authorize rejected",
          );
          await onArtifactEvent?.({ phase: "authorize", artifactId, kind, reason: message });
          return reply.code(statusCode).send(pulseVaultError(message));
        }
      }

      if (typeof storage.remove !== "function") {
        return reply
          .code(501)
          .send(
            pulseVaultError(
              "Storage adapter does not support delete",
            ),
          );
      }

      const removed = await storage.remove(artifactId);
      if (!removed) {
        return reply.code(404).send(pulseVaultError("Artifact not found"));
      }
      return reply.code(204).send();
    },
  );

  fastify.get("/artifacts/:artifactId", { schema: artifactGetSchema }, async (request, reply) => {
    const artifactId = (request.params as { artifactId?: unknown })?.artifactId;
    if (!isUuid(artifactId)) {
      return reply
        .code(400)
        .send(pulseVaultError("`artifactId` must be a valid UUID"));
    }

    // Resolve kind/relatedTo before setting request.pulseVault so authorize
    // hooks get a fully-populated context (cache hit after reserveUpload).
    const kind = await resolveStorageKind(storage, artifactId);
    const relatedTo = await resolveStorageRelatedTo(storage, artifactId);
    request.pulseVault = { artifactId, kind, relatedTo };

    // Extract the optional token forwarded by the mobile app in the watch URL.
    const token = (request.query as { token?: string })?.token;

    // Run authorize *before* resolve so consumers can reject without the
    // response leaking "this artifactId exists but you don't own it" vs. "no
    // such artifactId".
    if (authorize) {
      try {
        await authorize(request, { phase: "resolve", artifactId, kind, relatedTo, token });
      } catch (err) {
        const statusCode = extractAuthzStatus(err);
        const message = extractAuthzMessage(err);
        request.log.info(
          { err, artifactId, phase: "resolve", statusCode },
          "pulsevault authorize rejected",
        );
        await onArtifactEvent?.({ phase: "authorize", artifactId, kind, reason: message });
        return reply.code(statusCode).send(pulseVaultError(message));
      }
    }

    const resolved = await storage.resolve(artifactId);
    if (!resolved) {
      return reply.code(404).send(pulseVaultError("Artifact not found"));
    }

    if (resolved.kind === "redirect") {
      return reply.redirect(resolved.url, resolved.statusCode ?? 302);
    }

    const result = await send(request.raw, resolved.filename, {
      root: resolved.root,
      ...cache,
    });

    if (result.type === "error") {
      return reply
        .code(result.statusCode)
        .send(pulseVaultError(result.metadata.error.message));
    }

    // If the storage adapter provided an explicit content type (e.g. for
    // non-standard extensions like `.pulse`), override what @fastify/send
    // would otherwise infer from the filename.
    if (resolved.contentType) {
      reply.header("content-type", resolved.contentType);
    }

    for (const [name, value] of Object.entries(result.headers)) {
      reply.header(name, value);
    }
    return reply.code(result.statusCode).send(result.stream);
  });
};

export default pulseVaultRoutes;
