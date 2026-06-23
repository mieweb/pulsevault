# @mieweb/pulsevault

Fastify plugin for resumable video uploads via the [TUS protocol](https://tus.io/), with filesystem-first local storage and deep link helpers for the [Pulse](https://github.com/mieweb/pulse) mobile app.

```text
    Pulse app                   Your Fastify app
    ─────────                   ────────────────

   ┌───────────┐    pair +    ┌────────────────────────────────┐
   │ iOS / web │ ─── TUS ───► │  Pulsevault plugin             │
   └───────────┘              │  POST  /pulsevault/upload      │
                              │  PATCH /pulsevault/upload/:id  │
                              │  GET   /pulsevault/:videoid    │
                              └────────────────┬───────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Your hooks          │
                              │  • authorize         │
                              │  • validatePayload   │
                              │  • onUploadComplete  │
                              └──┬─────────────────┬─┘
                                 │                 │
                                 ▼                 ▼
                          ┌──────────────┐  ┌──────────────┐
                          │   Storage    │  │ Your systems │
                          │   adapter    │  │  DB · SSO ·  │
                          │ local / S3 / │  │  audit logs  │
                          │ GCS / custom │  │  pipelines   │
                          └──────────────┘  └──────────────┘
```

Self-hosted video capture for places that can't ship recordings to a vendor. Pulse records the walkthrough on the phone; Pulsevault receives it inside the Fastify app you already run, behind your auth, on your storage. Pair a device by QR code and upload over TUS so two-minute captures from the floor survive signal drops and device restarts.

Hook in at `authorize`, `validatePayload`, or `onUploadComplete` to bolt on whatever your institution already runs — SSO, audit logs, transcoding queues, AI pipelines. The plugin mounts three routes; the rest stays yours.

The local storage adapter writes to a stable on-disk layout (see [Local storage](#local-storage)) so you can layer post-processing — transcription, thumbnails, AI analysis — directly against the files from an `onUploadComplete` hook.

## Requirements

- Fastify `^5.x`
- Node.js `>=18`

## Installation

```sh
npm install @mieweb/pulsevault
```

## Quick start

```ts
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import pulseVault, { createLocalStorage } from "@mieweb/pulsevault";

const app = Fastify();

await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage: createLocalStorage({ workspaceDir: "./data" }),
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
});

// Your server owns videoid creation — attach auth, DB records, quotas here.
app.post("/reserve", async (_req, reply) => {
  return reply.send({ videoid: randomUUID() });
});

await app.listen({ port: 3030 });
```

## Routes

The plugin mounts the following routes under `prefix`:

| Method                         | Path                      | Description                                      |
| ------------------------------ | ------------------------- | ------------------------------------------------ |
| `POST`                         | `/pulsevault/upload`      | Create a TUS upload session                      |
| `PATCH` / `HEAD` / `DELETE` \* | `/pulsevault/upload/:id`  | Upload chunks, probe offset, cancel upload (TUS) |
| `GET`                          | `/pulsevault/:videoid`    | Stream or redirect to the uploaded video         |
| `DELETE`                       | `/pulsevault/:videoid`    | Delete a finalized upload (bytes + sidecar)      |

\* `DELETE /pulsevault/upload/:id` is TUS's own "cancel in-flight upload" — distinct from `DELETE /pulsevault/:videoid`, which removes a finalized video.

> `POST /reserve` is **not** part of the plugin. Your server implements it so you control auth, ownership, and any business logic tied to video creation.

`GET /pulsevault/:videoid` only serves uploads whose adapter has been told to mark them ready. With the built-in local adapter, that means the final PATCH has landed _and_ `validatePayload` (if configured) accepted the bytes. In-progress uploads return 404.

## Plugin options

```ts
type PulseVaultPluginOptions = {
  storage: PulseVaultStorage;
  prefix: string;
  maxUploadSize: number;
  decoratorName?: string; // default: "pulseVault"
  allowedExtensions?:
    | string[]                                    // legacy — treated as video-only
    | { video?: string[]; project?: string[] };   // per-kind (recommended)
  // defaults: { video: [".mp4"], project: [".pulse", ".zip"] }
  cache?: PulseVaultCacheOptions;
  authorize?: PulseVaultAuthorize;
  validatePayload?: PulseVaultValidatePayload;          // video uploads only
  validateProjectPayload?: PulseVaultValidatePayload;   // project uploads only
  onUploadComplete?: PulseVaultOnUploadComplete;        // video uploads only
  onProjectUploadComplete?: PulseVaultOnUploadComplete; // project uploads only
};
```

### `storage`

A `PulseVaultStorage` adapter. Use the built-in `createLocalStorage` for filesystem-backed deployments (the blessed default), `createS3Storage` for Cloudflare R2 / AWS S3 (see [Object storage](#object-storage-cloudflare-r2--aws-s3)), or implement the interface for custom backends (GCS, database, etc.).

### `prefix`

URL prefix for all plugin routes. Set to `"/pulsevault"` for the standard namespaced mount. Use `""` to mount at the root. Must start with `/` (no trailing slash) or be `""`.

> Because the plugin uses `fastify-plugin` to escape encapsulation, Fastify's native `register(..., { prefix })` is a no-op — always pass `prefix` through this option.

### `maxUploadSize`

Maximum upload size in bytes. Use `Infinity` for no cap.

### `decoratorName`

Name of the Fastify decorator that exposes the storage adapter on the instance. Defaults to `"pulseVault"`. Override when registering the plugin more than once in the same process.

For TypeScript access to the default decorator, add a side-effect import once in your app:

```ts
import "@mieweb/pulsevault/augment";
```

### `allowedExtensions`

File extensions accepted per artifact kind. Three accepted forms:

```ts
// 1. Omit entirely — uses both defaults:
//    video: [".mp4"]   project: [".pulse", ".zip"]

// 2. Flat array (legacy) — video-only; project defaults to [".pulse", ".zip"]:
allowedExtensions: [".mp4"]

// 3. Per-kind object — unset keys fall back to their defaults:
allowedExtensions: { video: [".mp4"], project: [".pulse"] }
```

All extensions must include the leading dot and are matched case-insensitively. The `kind` field in `Upload-Metadata` determines which list is checked.

### `cache`

Cache-control options for the `GET /:videoid` route, forwarded to `@fastify/send`:

```ts
type PulseVaultCacheOptions = {
  cacheControl?: boolean; // default: true
  maxAge?: string | number; // ms or ms-style string e.g. "1y". default: 0
  immutable?: boolean; // requires maxAge > 0. default: false
};
```

Upload filenames are keyed by UUID, so `immutable: true` is safe when `maxAge` is non-zero.

### `authorize`

Optional async hook called before TUS create/patch, before GET resolve, and before DELETE. Throw to reject — a `statusCode` or `status_code` number on the thrown error is used as the HTTP status (default `403`).

```ts
type PulseVaultAuthorize = (
  request: FastifyRequest,
  ctx: {
    phase: "create" | "patch" | "resolve" | "delete";
    videoid: string;
    kind: "video" | "project";  // artifact kind; always present
    token?: string;             // only on "resolve" phase
  },
) => void | Promise<void>;
```

```ts
await app.register(pulseVault, {
  // ...
  authorize: async (request, { phase, videoid, kind }) => {
    const token = request.headers.authorization?.replace("Bearer ", "");
    if (!isValid(token, videoid)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
  },
});
```

### `validatePayload`

Optional async hook that runs _after_ TUS writes the final byte but _before_ the upload is marked ready or `onUploadComplete` fires — **for `kind=video` uploads only**. Throw to reject — the plugin calls `storage.remove` to free the bytes and returns a 4xx (default 422) to the client. The sidecar never flips to `"ready"`, so the file is never served.

```ts
type PulseVaultValidatePayload = (
  request: FastifyRequest,
  ctx: {
    videoid: string;
    size: number;
    uploadId: string;
    /** Absolute path to finalized bytes for adapters that expose `getLocalPath`. */
    localPath: string | null;
  },
) => void | Promise<void>;
```

Use for magic-byte sniffing, virus scanning, size re-checks — anything that needs the final bytes. A ready-made helper ships with the package:

```ts
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
} from "@mieweb/pulsevault";

const storage = createLocalStorage({ workspaceDir: "./data" });

await app.register(pulseVault, {
  // ...
  storage,
  validatePayload: createMp4Sniffer(storage),
});
```

`createMp4Sniffer` reads the first 12 bytes and verifies the ISOBMFF `ftyp` header (MP4, MOV, M4V, 3GP). Uploads that pass the extension check but contain non-video bytes are rejected with 422 and the disk is cleaned up.

The lower-level `sniffMp4(path)` is also exported if you want to drive your own validator.

### `onUploadComplete`

Optional async hook fired once the final byte is written, `validatePayload` has passed, and the sidecar has been marked ready — **for `kind=video` uploads only**. Use it to update a database row, enqueue a job, or write an audit log. Throwing returns a `500` to the client. The video is ready at this point — if you want all-or-nothing semantics, call `storage.remove` before throwing.

```ts
type PulseVaultOnUploadComplete = (
  request: FastifyRequest,
  ctx: { videoid: string; size: number; uploadId: string },
) => void | Promise<void>;
```

### `validateProjectPayload`

Same lifecycle and signature as `validatePayload`, but fires only for `kind=project` uploads (`.pulse`, `.zip`, etc.). Use this to inspect the bundle before it is marked ready.

### `onProjectUploadComplete`

Same lifecycle and signature as `onUploadComplete`, but fires only for `kind=project` uploads. Use this to index a draft, enable cross-device editing, relay a diagnostic bundle to an issue tracker, etc. The bundle bytes are opaque to PulseVault — the consumer decides what to do with them.

### Upload-complete sequencing

When the final PATCH lands the plugin runs the following steps in order. Any step failing short-circuits the rest.

**For `kind=video`:**

1. **`validatePayload`** (optional) — throws → `storage.remove(videoid)`, HTTP 4xx (default 422).
2. **`storage.markReady(videoid)`** — flips the sidecar so `resolve()` will serve the bytes.
3. **`onUploadComplete`** (optional) — throws → HTTP 500; bytes remain ready unless the consumer removes them.

**For `kind=project`:**

1. **`validateProjectPayload`** (optional) — same semantics; throws → `storage.remove(videoid)`, HTTP 4xx.
2. **`storage.markReady(videoid)`** — flips the sidecar.
3. **`onProjectUploadComplete`** (optional) — throws → HTTP 500.

## Upload-Metadata protocol

The TUS `Upload-Metadata` header is a comma-separated list of `<key> <base64>` pairs. PulseVault reads the following keys on `POST /upload`:

| Key | Required | Description |
|---|---|---|
| `videoid` | Yes (or `projectid`) | Server-generated UUID for this upload. |
| `projectid` | Alias for `videoid` | Accepted as a synonym. Use `videoid` for new code. |
| `filename` | Yes | Original filename. The extension is validated against the kind's allowed list. |
| `kind` | No | `video` (default) or `project`. Determines the storage subdir and which hooks fire. |

Example (`kind=project`):

```
Upload-Metadata: videoid <base64(uuid)>, filename <base64("draft.pulse")>, kind <base64("project")>
```

## Local storage

```ts
import { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({
  workspaceDir: "./data", // directory for uploads; created if absent
});
```

### Filesystem layout (stable contract)

The local adapter writes uploads into flat kind-scoped subdirectories. Downstream tools may rely on this layout across minor versions:

```text
<workspaceRoot>/
  .pulsevault/<id>.json           # sidecar: { version, ext, filename, status, kind }
  video/<id><ext>                 # video upload bytes  (kind="video")
  video/<id><ext>.json            # @tus/file-store offset/metadata sidecar
  project/<id><ext>               # project bundle bytes (kind="project")
  project/<id><ext>.json          # @tus/file-store offset/metadata sidecar
```

`status` is `"uploading"` between `reserveUpload` and the successful final PATCH; `"ready"` thereafter. `GET /:id` only serves `"ready"` uploads. `kind` defaults to `"video"` when absent (back-compat with pre-kind sidecars).

The adapter exposes `storage.workspaceRoot` (absolute, resolved from `workspaceDir`) so consumers can compute per-resource paths without re-implementing the layout. `storage.getKind(id)` returns `"video" | "project" | null` for a lightweight kind check without a full `resolve()` call.

### Post-processing (transcription, thumbnails, AI)

The filesystem layout is the integration surface. Use the `onUploadComplete` hook as your trigger. For example, to hydrate an [ArtiPod](https://github.com/mieweb/artipod) with the video plus sibling artifact directories:

```ts
import path from "node:path";
import { ArtiPod, ArtiMount } from "@mieweb/artipod";
import pulseVault, { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({ workspaceDir: "./data" });

await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage,
  maxUploadSize: 5 * 1024 * 1024 * 1024,
  onUploadComplete: async (_req, { videoid }) => {
    const videoDir = path.join(storage.workspaceRoot, "video");
    const pod = new ArtiPod({ id: videoid, useMainMount: false });
    pod.addMount(new ArtiMount("video", videoDir));
    // Create these lazily as your pipeline produces artifacts:
    // pod.addMount(new ArtiMount("transcripts", path.join(root, "transcripts")));
    // pod.addMount(new ArtiMount("frames", path.join(root, "frames")));
    await pod.initialize();
    // Run a containerized transcription step, build an LLM prompt from
    // collected artifacts, etc. See the @mieweb/artipod docs for details.
  },
});
```

`@mieweb/artipod` is **not** a dependency of this plugin — install it in your app only if you want it. Any filesystem-native pipeline (ffmpeg, whisper, rsync) works equally well.

## Object storage (Cloudflare R2 / AWS S3)

`createS3Storage` is a built-in adapter that streams uploads into an S3-compatible bucket via S3 multipart upload and serves playback by redirecting the client to a short-lived **presigned URL** (so bytes never flow back through your server). Because Cloudflare R2 speaks the S3 API, the same adapter covers both R2 and AWS S3 — they differ only by endpoint and credentials.

It's **opt-in**: the AWS SDK and `@tus/s3-store` are `optionalDependencies`, loaded lazily only when you call `createS3Storage`. Install them in your app:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @tus/s3-store
```

`createS3Storage` is **async** (it lazily imports those packages), so `await` it before registering the plugin.

**Cloudflare R2:**

```ts
import pulseVault, { createS3Storage, createS3Mp4Sniffer } from "@mieweb/pulsevault";

const storage = await createS3Storage({
  bucket: "pulse-videos",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
});

await app.register(pulseVault, {
  prefix: "/pulsevault",
  storage,
  maxUploadSize: 5 * 1024 * 1024 * 1024,
  validatePayload: createS3Mp4Sniffer(storage), // ranged-read MP4 sniff
});
```

**AWS S3** — drop the custom `endpoint` and set `region`:

```ts
const storage = await createS3Storage({
  bucket: "pulse-videos",
  region: "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
```

Credentials are optional — omit `accessKeyId`/`secretAccessKey` to use the AWS SDK's default credential chain (env vars, IAM role, etc.). **Never hard-code keys; read them from the environment.**

### Object layout

```text
<bucket>/
  .pulsevault/<id>.json   # metadata sidecar: { version, ext, filename, status, kind }
  video/<id><ext>         # finalized video object   (kind="video")
  project/<id><ext>       # finalized project object (kind="project")
  <key>.info              # @tus/s3-store multipart bookkeeping (transient)
```

`resolve()` only returns a presigned URL once the sidecar `status` is `"ready"` (after the final byte lands and `validatePayload` passes), so in-progress or rejected uploads are never served. `getKind(id)` returns the kind without a full resolve.

### Options

| Option | Default | Notes |
| --- | --- | --- |
| `bucket` | — | Required. Must already exist. |
| `endpoint` | — | Custom S3 endpoint (set for R2). Omit for AWS S3. |
| `region` | `"auto"` when `endpoint` is set | Required for AWS S3. |
| `accessKeyId` / `secretAccessKey` | SDK default chain | Optional; omit both to use env/IAM credentials. |
| `sessionToken` | — | Optional STS session token for temporary credentials. |
| `forcePathStyle` | `true` when `endpoint` is set | R2 and most S3-compatible stores need path-style. |
| `presignTtlSeconds` | `900` | Lifetime of the playback presigned URL. |
| `partSize` | computed | Preferred multipart part size (≥ 5 MiB), forwarded to `@tus/s3-store`. |
| `clientConfig` | — | Advanced: extra `S3ClientConfig` merged into the client. |

> The runnable demo wires these to environment variables — see [`examples/rn-demo/.env.example`](examples/rn-demo/.env.example) for the full list (`STORAGE`, `S3_BUCKET`, `S3_ENDPOINT`, `AWS_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, …).

### Payload validation on remote storage

The default `createMp4Sniffer` reads a local file path, which doesn't exist for a bucket object. Use **`createS3Mp4Sniffer(storage)`** instead: it fetches the first 12 bytes via a small ranged GET (`storage.readHeader`) and applies the same ISOBMFF `ftyp` check, rejecting non-MP4 uploads with 422 and removing the object — no full download.

### Direct playback & CORS

Because playback is a 302 redirect to a presigned URL, a browser fetching it goes **directly** to R2/S3. If you play back from a web origin, add a bucket CORS rule allowing your origin (`GET`, and `Range` for seeking). Native clients that follow redirects need no CORS.

## Custom storage adapter

Implement `PulseVaultStorage` to back uploads with any system (S3, GCS, database, etc.):

```ts
import type {
  PulseVaultStorage,
  PulseVaultResolution,
} from "@mieweb/pulsevault";

const storage: PulseVaultStorage = {
  datastore, // @tus/server DataStore instance
  async initialize() {
    /* optional setup */
  },
  async shutdown() {
    /* optional teardown */
  },
  async reserveUpload({ videoid, filename, ext }) {
    // Called by the TUS naming function. Return the file id for the datastore.
    await db.createVideo({ videoid, filename, status: "uploading" });
    return `${videoid}${ext}`;
  },
  async resolve(videoid): Promise<PulseVaultResolution | null> {
    const video = await db.findVideo(videoid);
    if (!video || video.status !== "ready") return null;
    // Stream from local disk:
    return { kind: "stream", root: "/uploads", filename: video.filename };
    // Or redirect to a CDN / presigned URL:
    // return { kind: "redirect", url: video.signedUrl, statusCode: 302 };
  },
  async markReady(videoid) {
    // Called after `validatePayload` (if any) accepts the bytes. Flip your
    // state so `resolve` starts returning non-null. Omit this method if
    // your backend can't distinguish in-progress from finalized uploads.
    await db.updateVideo(videoid, { status: "ready" });
  },
  async remove(videoid) {
    // Called from DELETE /:videoid and from the plugin's cleanup path when
    // `validatePayload` rejects an upload. Return false if the videoid was
    // already absent.
    const result = await db.deleteVideo(videoid);
    return result.deleted;
  },
};
```

## Deep link helper

Use this to generate a `pulsecam://` deep link for pairing the Pulse mobile app with your server. Typically encoded as a QR code on a pairing page.

```ts
import { buildUploadLink } from "@mieweb/pulsevault";
import { randomUUID } from "node:crypto";

// Opens the app directly on the upload screen for a specific video.
const uploadLink = buildUploadLink({
  server: "https://example.com",
  videoid: randomUUID(), // generate server-side; skip POST /reserve on the app
  token: "secret", // optional — forwarded to your authorize hook
});
```

## Tests

```sh
npm test
```

Runs a Node `--test` suite against the built plugin. Coverage includes:

- TUS create/HEAD/PATCH resume, collision handling, extension rejection, range GETs
- Ready-gate (`GET` returns 404 while uploading)
- `DELETE /:id`
- `authorize` rejection on every phase; `kind` in authorize context
- `validatePayload` + `createMp4Sniffer` for video; `validateProjectPayload` for projects
- `onUploadComplete` and `onProjectUploadComplete` dispatch
- `kind=project` happy paths (`.pulse`, `.zip`) — correct subdir, `Content-Type`, sidecar
- Extension mismatch rejections in both directions
- `projectid` metadata alias
- `getKind()` storage method
- Legacy sidecars (no `kind` field) default to `"video"` without migration
- Sidecar corruption recovery
- `allowedExtensions` object form
- S3/R2 backend (`createS3Storage`): full resumable upload → presigned-redirect playback, `createS3Mp4Sniffer`, `DELETE`, `kind=project`, run against an in-process [s3rver](https://github.com/jamhall/s3rver) mock (no cloud credentials needed)

## Accessing storage outside the plugin routes

The storage adapter is exposed as a Fastify decorator, so you can use it in your own routes:

```ts
import "@mieweb/pulsevault/augment"; // once, for TypeScript types

app.get("/admin/video/:id", async (req, reply) => {
  const resolved = await app.pulseVault.resolve(req.params.id);
  if (!resolved) return reply.code(404).send();
  // custom logic...
});
```

## License

Source Available — free for non-commercial use under the terms in [LICENSE](LICENSE), which also requires that redistributions be published under an OSI-approved open source license. Commercial use requires a separate license from Medical Informatics Engineering, LLC — contact [helpdesk@mieweb.com](mailto:helpdesk@mieweb.com) or [mieweb.com](https://www.mieweb.com).

Copyright © 2026 Medical Informatics Engineering, LLC. All rights reserved.
