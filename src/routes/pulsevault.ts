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
} from "../lib/pulsevaultTus.js";
import type { PulseVaultValidatePayload } from "../lib/magic.js";
import { pulseVaultError } from "../lib/errors.js";
import { isUuid } from "../lib/uuid.js";
import type { PulseVaultStorage } from "../storage/types.js";
import type { UploadKind } from "../storage/types.js";

// Internal augmentation — mirrored in the opt-in `./augment.ts` re-export so
// consumers can `import "@mieweb/pulsevault/augment"` and get the
// same typing. Kept here as well so the plugin itself typechecks regardless
// of whether the consumer ever imports the augment module.
declare module "fastify" {
  interface FastifyRequest {
    pulseVault?: { videoid: string; kind: UploadKind };
  }
}

export type PulseVaultAuthorizePhase =
  | "create"
  | "patch"
  | "resolve"
  | "delete";

export type PulseVaultAuthorizeContext = {
  phase: PulseVaultAuthorizePhase;
  videoid: string;
  /** Artifact kind: `"video"` for MP4 uploads, `"project"` for `.pulse`/`.zip` bundles. */
  kind: UploadKind;
  /** Bearer / query-string token forwarded from the watch URL, if present. Only populated during the `"resolve"` phase. */
  token?: string;
};

export type PulseVaultAuthorize = (
  request: FastifyRequest,
  ctx: PulseVaultAuthorizeContext,
) => void | Promise<void>;

export type PulseVaultRoutesOptions = {
  storage: PulseVaultStorage;
  maxUploadSize: number;
  allowedExtensions: { video: readonly string[]; project: readonly string[] };
  cache?: PulseVaultCacheOptions;
  authorize?: PulseVaultAuthorize;
  validatePayload?: PulseVaultValidatePayload;
  validateProjectPayload?: PulseVaultValidatePayload;
  onUploadComplete?: PulseVaultOnUploadComplete;
  onProjectUploadComplete?: PulseVaultOnUploadComplete;
} & FastifyPluginOptions;

/**
 * Pull `videoid` (or `projectid` alias) and `kind` out of a raw
 * `Upload-Metadata` header. Format is a comma-separated list of
 * `<key> <base64-value>` pairs (tus v1 creation extension).
 */
function parseUploadMetadata(
  header: string,
): { videoid: string | undefined; kind: UploadKind } {
  let videoid: string | undefined;
  let kind: UploadKind = "video";
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
      if ((key === "videoid" || key === "projectid") && !videoid) {
        videoid = isUuid(decoded) ? decoded : undefined;
      } else if (key === "kind") {
        kind = decoded.trim().toLowerCase() === "project" ? "project" : "video";
      }
    } catch {
      // ignore malformed base64
    }
  }
  return { videoid, kind };
}

/**
 * Decode the last URL segment of a tus PATCH/HEAD/DELETE (base64url-encoded
 * id) and extract the first path component, which the plugin always shapes as
 * the videoid (see `pulseVaultTus.ts`).
 */
function videoidFromTusUrl(url: string): string | undefined {
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
 * Resolve the artifact kind for a videoid from storage. Duck-typed so it
 * works with any adapter (those without `getKind` return `"video"`).
 */
async function resolveStorageKind(
  storage: PulseVaultStorage,
  videoid: string,
): Promise<UploadKind> {
  const candidate = (storage as { getKind?: unknown }).getKind;
  if (typeof candidate !== "function") return "video";
  const result = await (candidate as (id: string) => Promise<UploadKind | null>)(videoid);
  return result ?? "video";
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
    "  - `videoid` (or `projectid` alias) — a UUID generated by your server.\n" +
    "  - `filename` — original filename; the extension must match the kind's allowed list.\n" +
    "  - `kind` — `video` (default) or `project`. Determines the storage subdir and which completion hooks fire.\n" +
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

const videoDeleteSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Delete an uploaded video",
  description:
    "Deletes all storage for a videoid (bytes + sidecar metadata). Only deletes `kind=video` uploads — returns 404 for project artifacts (use `DELETE /project/:projectid` instead). Runs the `authorize` hook with `phase: \"delete\"` before the adapter's `remove` is called. Returns 204 on success, 404 if the videoid was unknown, 501 if the adapter does not implement `remove`.",
  params: {
    type: "object",
    properties: {
      videoid: {
        type: "string",
        format: "uuid",
        description: "UUID of the upload to delete.",
      },
    },
    required: ["videoid"],
  },
  response: {
    400: {
      description: "`videoid` is not a valid UUID.",
      ...pulseVaultErrorResponse,
    },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
    404: { description: "Video not found.", ...pulseVaultErrorResponse },
    501: {
      description: "Storage adapter does not implement delete.",
      ...pulseVaultErrorResponse,
    },
  },
};

const videoGetSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Serve a previously uploaded video",
  description:
    "Resolves the `videoid` through the configured storage adapter and either streams the bytes or redirects (for CDN-backed adapters). Only serves `kind=video` uploads — returns 404 for project artifacts (use `GET /project/:projectid` instead). Runs the `authorize` hook before resolve.",
  params: {
    type: "object",
    properties: {
      videoid: {
        type: "string",
        format: "uuid",
        description: "UUID returned from the reserve/TUS-create flow.",
      },
    },
    required: ["videoid"],
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
      description: "`videoid` is not a valid UUID.",
      ...pulseVaultErrorResponse,
    },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
    404: { description: "Video not found.", ...pulseVaultErrorResponse },
  },
};

const projectGetSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Serve a previously uploaded project artifact",
  description:
    "Resolves the `projectid` through the configured storage adapter and streams the bytes. Only serves `kind=project` uploads — returns 404 for video artifacts. Runs the `authorize` hook before resolve.",
  params: {
    type: "object",
    properties: {
      projectid: {
        type: "string",
        format: "uuid",
        description: "UUID of the project upload.",
      },
    },
    required: ["projectid"],
  },
  querystring: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "Optional bearer token for pre-authenticated watch links. Forwarded to the `authorize` hook as `ctx.token`.",
      },
    },
  },
  response: {
    400: {
      description: "`projectid` is not a valid UUID.",
      ...pulseVaultErrorResponse,
    },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
    404: { description: "Project not found.", ...pulseVaultErrorResponse },
  },
};

const projectDeleteSchema: OpenApiRouteSchema = {
  tags: ["pulsevault"],
  summary: "Delete an uploaded project artifact",
  description:
    "Deletes all storage for a projectid (bytes + sidecar metadata). Only deletes `kind=project` uploads — returns 404 for video artifacts. Runs the `authorize` hook with `phase: \"delete\"` before the adapter's `remove` is called.",
  params: {
    type: "object",
    properties: {
      projectid: {
        type: "string",
        format: "uuid",
        description: "UUID of the project upload to delete.",
      },
    },
    required: ["projectid"],
  },
  response: {
    400: {
      description: "`projectid` is not a valid UUID.",
      ...pulseVaultErrorResponse,
    },
    403: {
      description: "Authorize hook rejected the request.",
      ...pulseVaultErrorResponse,
    },
    404: { description: "Project not found.", ...pulseVaultErrorResponse },
    501: {
      description: "Storage adapter does not implement delete.",
      ...pulseVaultErrorResponse,
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
    cache,
    authorize,
    validatePayload,
    validateProjectPayload,
    onUploadComplete,
    onProjectUploadComplete,
  } = opts;
  // `fastify.prefix` is `""` when the plugin is mounted at the root.
  const tusPath = `${fastify.prefix}/upload`;

  const tusServer = createPulsevaultTusServer({
    storage,
    tusPath,
    maxSize: maxUploadSize,
    allowedExtensions,
    validatePayload,
    validateProjectPayload,
    onUploadComplete,
    onProjectUploadComplete,
  });

  fastify.addContentTypeParser(
    "application/offset+octet-stream",
    (_request, _payload, done) => {
      done(null);
    },
  );

  /**
   * Run the consumer's `authorize` hook (if any) for a TUS request. Returns
   * `true` iff the request may proceed; on rejection, this function already
   * wrote the response.
   */
  const runAuthorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    phase: "create" | "patch",
  ): Promise<{ ok: true; videoid: string | undefined; kind: UploadKind } | { ok: false }> => {
    let videoid: string | undefined;
    let kind: UploadKind = "video";
    if (phase === "create") {
      const meta = request.headers["upload-metadata"];
      if (typeof meta === "string") {
        ({ videoid, kind } = parseUploadMetadata(meta));
      }
    } else {
      videoid = videoidFromTusUrl(request.url);
      // For PATCH/HEAD, resolve kind from storage (cache hit after reserve).
      if (videoid) {
        kind = await resolveStorageKind(storage, videoid);
      }
    }

    if (videoid) {
      request.pulseVault = { videoid, kind };
    }

    if (!authorize) {
      return { ok: true, videoid, kind };
    }

    // If we can't extract a videoid, let tus produce its own 4xx for malformed
    // input rather than synthesize a fake authorize failure.
    if (!videoid) {
      return { ok: true, videoid, kind };
    }

    try {
      await authorize(request, { phase, videoid, kind });
      return { ok: true, videoid, kind };
    } catch (err) {
      const statusCode = extractAuthzStatus(err);
      const message = extractAuthzMessage(err);
      request.log.info(
        { err, videoid, phase, statusCode },
        "pulsevault authorize rejected",
      );
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
        { request, videoid: authz.videoid },
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

  fastify.delete(
    "/:videoid",
    { schema: videoDeleteSchema },
    async (request, reply) => {
      const videoid = (request.params as { videoid?: unknown })?.videoid;
      if (!isUuid(videoid)) {
        return reply
          .code(400)
          .send(pulseVaultError("`videoid` must be a valid UUID"));
      }

      const deleteKind = await resolveStorageKind(storage, videoid);

      // This route is video-only. Project artifacts must use DELETE /project/:projectid.
      if (deleteKind !== "video") {
        return reply.code(404).send(pulseVaultError("Video not found"));
      }

      request.pulseVault = { videoid, kind: deleteKind };

      if (authorize) {
        try {
          await authorize(request, { phase: "delete", videoid, kind: deleteKind });
        } catch (err) {
          const statusCode = extractAuthzStatus(err);
          const message = extractAuthzMessage(err);
          request.log.info(
            { err, videoid, phase: "delete", statusCode },
            "pulsevault authorize rejected",
          );
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

      const removed = await storage.remove(videoid);
      if (!removed) {
        return reply.code(404).send(pulseVaultError("Video not found"));
      }
      return reply.code(204).send();
    },
  );

  fastify.get("/:videoid", { schema: videoGetSchema }, async (request, reply) => {
    const videoid = (request.params as { videoid?: unknown })?.videoid;
    if (!isUuid(videoid)) {
      return reply
        .code(400)
        .send(pulseVaultError("`videoid` must be a valid UUID"));
    }

    // Resolve kind before setting request.pulseVault so authorize hooks get
    // a fully-populated context (cache hit after reserveUpload).
    const resolvedKind = await resolveStorageKind(storage, videoid);

    // This route is video-only. Project artifacts must use GET /project/:projectid.
    if (resolvedKind !== "video") {
      return reply.code(404).send(pulseVaultError("Video not found"));
    }

    request.pulseVault = { videoid, kind: resolvedKind };

    // Extract the optional token forwarded by the mobile app in the watch URL.
    const token = (request.query as { token?: string })?.token;

    // Run authorize *before* resolve so consumers can reject without the
    // response leaking "this videoid exists but you don't own it" vs. "no such
    // videoid".
    if (authorize) {
      try {
        await authorize(request, { phase: "resolve", videoid, kind: resolvedKind, token });
      } catch (err) {
        const statusCode = extractAuthzStatus(err);
        const message = extractAuthzMessage(err);
        request.log.info(
          { err, videoid, phase: "resolve", statusCode },
          "pulsevault authorize rejected",
        );
        return reply.code(statusCode).send(pulseVaultError(message));
      }
    }

    const resolved = await storage.resolve(videoid);
    if (!resolved) {
      return reply.code(404).send(pulseVaultError("Video not found"));
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

  fastify.delete(
    "/project/:projectid",
    { schema: projectDeleteSchema },
    async (request, reply) => {
      const projectid = (request.params as { projectid?: unknown })?.projectid;
      if (!isUuid(projectid)) {
        return reply
          .code(400)
          .send(pulseVaultError("`projectid` must be a valid UUID"));
      }

      const deleteKind = await resolveStorageKind(storage, projectid);

      // This route is project-only. Video artifacts must use DELETE /:videoid.
      if (deleteKind !== "project") {
        return reply.code(404).send(pulseVaultError("Project not found"));
      }

      request.pulseVault = { videoid: projectid, kind: "project" };

      if (authorize) {
        try {
          await authorize(request, { phase: "delete", videoid: projectid, kind: "project" });
        } catch (err) {
          const statusCode = extractAuthzStatus(err);
          const message = extractAuthzMessage(err);
          request.log.info(
            { err, videoid: projectid, phase: "delete", statusCode },
            "pulsevault authorize rejected",
          );
          return reply.code(statusCode).send(pulseVaultError(message));
        }
      }

      if (typeof storage.remove !== "function") {
        return reply
          .code(501)
          .send(pulseVaultError("Storage adapter does not support delete"));
      }

      const removed = await storage.remove(projectid);
      if (!removed) {
        return reply.code(404).send(pulseVaultError("Project not found"));
      }
      return reply.code(204).send();
    },
  );

  fastify.get("/project/:projectid", { schema: projectGetSchema }, async (request, reply) => {
    const projectid = (request.params as { projectid?: unknown })?.projectid;
    if (!isUuid(projectid)) {
      return reply
        .code(400)
        .send(pulseVaultError("`projectid` must be a valid UUID"));
    }

    const resolvedKind = await resolveStorageKind(storage, projectid);

    // This route is project-only. Video artifacts must use GET /:videoid.
    if (resolvedKind !== "project") {
      return reply.code(404).send(pulseVaultError("Project not found"));
    }

    request.pulseVault = { videoid: projectid, kind: "project" };

    const token = (request.query as { token?: string })?.token;

    if (authorize) {
      try {
        await authorize(request, { phase: "resolve", videoid: projectid, kind: "project", token });
      } catch (err) {
        const statusCode = extractAuthzStatus(err);
        const message = extractAuthzMessage(err);
        request.log.info(
          { err, videoid: projectid, phase: "resolve", statusCode },
          "pulsevault authorize rejected",
        );
        return reply.code(statusCode).send(pulseVaultError(message));
      }
    }

    const resolved = await storage.resolve(projectid);
    if (!resolved) {
      return reply.code(404).send(pulseVaultError("Project not found"));
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
