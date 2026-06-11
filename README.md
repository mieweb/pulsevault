# @mieweb/pulsevault

Fastify plugin for resumable video uploads via the [TUS protocol](https://tus.io/), with filesystem-first local storage and deep link helpers for the [Pulse](https://github.com/mieweb/pulse) mobile app.

```text
    Pulse app                   Your Fastify app
    ─────────                   ────────────────

   ┌───────────┐    pair +    ┌──────────────────────┐
   │ iOS / web │ ─── TUS ───► │  Pulsevault plugin   │
   └───────────┘              │  POST  /upload       │
                              │  PATCH /upload/:id   │
                              │  GET   /:videoid     │
                              └──────────┬───────────┘
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
  prefix: "",
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

| Method                         | Path          | Description                                      |
| ------------------------------ | ------------- | ------------------------------------------------ |
| `POST`                         | `/upload`     | Create a TUS upload session                      |
| `PATCH` / `HEAD` / `DELETE` \* | `/upload/:id` | Upload chunks, probe offset, cancel upload (TUS) |
| `GET`                          | `/:videoid`   | Stream or redirect to the uploaded video         |
| `DELETE`                       | `/:videoid`   | Delete a finalized upload (bytes + sidecar)      |

\* `DELETE /upload/:id` is TUS's own "cancel in-flight upload" — distinct from `DELETE /:videoid`, which removes a finalized video.

> `POST /reserve` is **not** part of the plugin. Your server implements it so you control auth, ownership, and any business logic tied to video creation.

`GET /:videoid` only serves uploads whose adapter has been told to mark them ready. With the built-in local adapter, that means the final PATCH has landed _and_ `validatePayload` (if configured) accepted the bytes. In-progress uploads return 404.

## Plugin options

```ts
type PulseVaultPluginOptions = {
  storage: PulseVaultStorage;
  prefix: string;
  maxUploadSize: number;
  decoratorName?: string; // default: "pulseVault"
  allowedExtensions?: string[]; // default: [".mp4"]
  cache?: PulseVaultCacheOptions;
  authorize?: PulseVaultAuthorize;
  validatePayload?: PulseVaultValidatePayload;
  onUploadComplete?: PulseVaultOnUploadComplete;
};
```

### `storage`

A `PulseVaultStorage` adapter. Use the built-in `createLocalStorage` for filesystem-backed deployments (the blessed default) or implement the interface for custom backends (S3, GCS, etc.).

### `prefix`

URL prefix for all plugin routes. Use `""` to mount at the root or `"/pulsevault"` to namespace. Must start with `/` (no trailing slash) or be `""`.

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

File extensions accepted in `Upload-Metadata.filename`. Must include the leading dot. Defaults to `[".mp4"]`.

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

### HTTP Range Requests (RFC 7233)

`GET /:videoid` supports HTTP Range requests, allowing clients to stream specific byte ranges without downloading the entire file. This enables browser seeking in video players and iOS AVPlayer scrubbing.

**Behavior:**

- **No Range header:** Returns `200 OK` with the full file and `Accept-Ranges: bytes`.
- **Valid range (e.g., `Range: bytes=0-99`):** Returns `206 Partial Content` with the requested byte range, `Content-Range: bytes 0-99/total`, and `Content-Length`.
- **Open-ended range (e.g., `Range: bytes=512-`):** Returns `206 Partial Content` from byte 512 to EOF.
- **Suffix range (e.g., `Range: bytes=-1024`):** Returns `206 Partial Content` for the last 1024 bytes.
- **Invalid or out-of-bounds range:** Returns `416 Range Not Satisfiable` with `Content-Range: bytes */total`.

Ranges are streamed via `fs.createReadStream` with `start`/`end` offsets; the entire file is never buffered.

**Example client code:**

```ts
// Fetch bytes 0-999 (first 1000 bytes)
const res = await fetch("/api/video/abc123", {
  headers: { Range: "bytes=0-999" },
});
if (res.status === 206) {
  const chunk = await res.arrayBuffer();
  // Process 1000-byte chunk
}

// Seek to 1MB into a video (open-ended range)
const res = await fetch("/api/video/abc123", {
  headers: { Range: "bytes=1048576-" },
});
```

**Framework-independent parser:**

For framework adaptations (e.g., Hono), the `parseRangeRequest` utility parses RFC 7233 headers and returns status code, byte offsets, and response headers:

```ts
import { parseRangeRequest } from "@mieweb/pulsevault";

const result = parseRangeRequest("bytes=0-99", 1000);
// { status: 206, start: 0, end: 99, headers: { ... } }

const invalid = parseRangeRequest("bytes=9999-10000", 1000);
// { status: 416, headers: { "content-range": "bytes */1000" } }
```

### `authorize`

Optional async hook called before TUS create/patch, before GET resolve, and before DELETE. Throw to reject — a `statusCode` or `status_code` number on the thrown error is used as the HTTP status (default `403`).

```ts
type PulseVaultAuthorize = (
  request: FastifyRequest,
  ctx: {
    phase: "create" | "patch" | "resolve" | "delete";
    videoid: string;
  },
) => void | Promise<void>;
```

```ts
await app.register(pulseVault, {
  // ...
  authorize: async (request, { phase, videoid }) => {
    const token = request.headers.authorization?.replace("Bearer ", "");
    if (!isValid(token, videoid)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
  },
});
```

### `validatePayload`

Optional async hook that runs _after_ TUS writes the final byte but _before_ the upload is marked ready or `onUploadComplete` fires. Throw to reject — the plugin calls `storage.remove` to free the bytes and returns a 4xx (default 422) to the client. The sidecar never flips to `"ready"`, so the video is never served.

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

`createMp4Sniffer` performs structural MP4 validation on the finalized upload bytes. It checks that:

- `ftyp` exists near the start (ISO-BMFF container)
- both `moov` and `mdat` atoms exist
- `moov` appears before `mdat` (fast-start)
- at least one video track exists (`hdlr` = `vide`)
- duration metadata is readable (`mvhd`/`mdhd`)
- the file is not obviously truncated

Invalid uploads are rejected with `422 Unprocessable Entity`, cleaned from storage, and returned with the JSON body:

```json
{
  "error": "invalid_video_upload",
  "reason": "MP4 is not fast-start optimized. The moov atom must appear before mdat."
}
```

The server does not transcode, rewrite, or repair uploaded files.

The lower-level `sniffMp4(path)` is also exported if you want to drive your own validator.

### `onUploadComplete`

Optional async hook fired once the final byte is written, `validatePayload` has passed, and the sidecar has been marked ready. Use it to update a database row, enqueue a job, or write an audit log. Throwing returns a `500` to the client. The video is ready at this point — if you want all-or-nothing semantics, call `storage.remove` before throwing.

```ts
type PulseVaultOnUploadComplete = (
  request: FastifyRequest,
  ctx: { videoid: string; size: number; uploadId: string },
) => void | Promise<void>;
```

### Upload-complete sequencing

When the final PATCH lands, the plugin runs the following in order. Any step failing short-circuits the rest.

1. **`validatePayload`** (optional) — throws → `storage.remove(videoid)`, HTTP 4xx (default 422).
2. **`storage.markReady(videoid)`** — flips the sidecar so `resolve()` will serve the bytes.
3. **`onUploadComplete`** (optional) — throws → HTTP 500; bytes remain on disk and ready unless the consumer explicitly removes them.

## Local storage

```ts
import { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({
  workspaceDir: "./data", // directory for uploads; created if absent
});
```

### Filesystem layout (stable contract)

The local adapter writes each upload into a self-describing per-video directory. Downstream tools may rely on this layout across minor versions:

```text
<workspaceRoot>/<videoid>/
  .pulsevault.json           # sidecar: { version, ext, filename, status }
  video/<videoid><ext>       # upload bytes (partial during upload, full when ready)
  video/<videoid><ext>.json  # @tus/file-store's offset/metadata sidecar
```

`status` is `"uploading"` between `reserveUpload` and the successful final PATCH; `"ready"` thereafter. `GET /:videoid` only serves `"ready"` uploads.

The adapter exposes `storage.workspaceRoot` (absolute, resolved from `workspaceDir`) so consumers can compute per-video paths without re-implementing the layout.

### Post-processing (transcription, thumbnails, AI)

The filesystem layout is the integration surface. Use the `onUploadComplete` hook as your trigger. For example, to hydrate an [ArtiPod](https://github.com/mieweb/artipod) with the video plus sibling artifact directories:

```ts
import path from "node:path";
import { ArtiPod, ArtiMount } from "@mieweb/artipod";
import pulseVault, { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({ workspaceDir: "./data" });

await app.register(pulseVault, {
  prefix: "",
  storage,
  maxUploadSize: 5 * 1024 * 1024 * 1024,
  onUploadComplete: async (_req, { videoid }) => {
    const root = path.join(storage.workspaceRoot, videoid);
    const pod = new ArtiPod({ id: videoid, useMainMount: false });
    pod.addMount(new ArtiMount("video", path.join(root, "video")));
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

Runs a Node `--test` suite against the built plugin: TUS create/HEAD/PATCH resume, collision handling, extension rejection, range GETs, the ready-gate (`GET` returns 404 while uploading), `DELETE /:videoid`, `authorize` rejection on every phase, `validatePayload` + `createMp4Sniffer`, `onUploadComplete` dispatch, and sidecar corruption recovery.

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
