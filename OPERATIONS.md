# Operations

Deployment, scaling, and maintenance guidance for running `@mieweb/pulsevault`
in production. See `README.md` for the quick-start and plugin options, and
`PROTOCOL.md` for the wire contract.

## Upgrading to this release

This release renames `videoid` → `artifactId` and collapses the per-kind
routes into one generic route (see `CHANGELOG.md`). **No on-disk data
migration is required**: the local and S3 storage layouts never stored the
id as a field inside the sidecar JSON — the id is the filename — so existing
uploaded artifacts are immediately readable through the new
`GET /artifacts/:artifactId` route with zero changes to the files on disk.

What *does* need updating:

- Any of your own code calling the old routes directly (`GET/DELETE
  /:videoid`, `GET/DELETE /project/:projectid`) must move to `GET/DELETE
  /artifacts/:artifactId` — the old routes return `404`, not a redirect.
- Any code reading `request.pulseVault.videoid` (if you imported
  `@mieweb/pulsevault/augment`) must read `.artifactId` instead.
- If you use `validateProjectPayload`/`onProjectUploadComplete`, you'll see a
  one-time `DeprecationWarning` at startup. They still work this release —
  migrate to `validatePayload`/`onUploadComplete` with a `ctx.kind ===
  "project"` branch when convenient, before a future major version removes
  the deprecated options.
- Clients still sending `Upload-Metadata: videoid ...` (instead of
  `artifactId`) keep working — the alias is accepted indefinitely for
  protocol version 1 (see `PROTOCOL.md` §4.1) — but new client code should
  send `artifactId`.

There is no automated migration script because there is nothing on disk to
migrate. If a future release ever does change the storage layout, that
release's `OPERATIONS.md` entry will include one.

## Horizontal scaling

**The local storage adapter (`createLocalStorage`) requires either
sticky-session load-balancer routing or a shared filesystem (NFS/EFS/etc.)
across instances.** TUS resumable uploads need subsequent `PATCH`/`HEAD`
requests to reach an instance that can see the partial upload's bytes and
`@tus/file-store` offset metadata. If you run multiple instances behind a
load balancer without either of these, a retried `PATCH` that lands on a
different instance will silently fail to resume — the client's `HEAD` will
see no offset and effectively restart from byte zero, with no error
surfaced anywhere.

Two ways to actually support multiple instances:

1. **Sticky sessions**: configure your load balancer to route by client IP
   or a session cookie so all requests for one upload land on the same
   instance.
2. **Shared filesystem**: point every instance's `workspaceDir` at the same
   NFS/EFS mount. Verify your mount's durability/consistency guarantees
   under concurrent writes from multiple instances before relying on this in
   production. The local adapter changes an artifact's metadata (`.pulsevault/
   <id>.json`) under a per-artifact lock file (`<id>.json.lock`, created
   exclusively), so instances never write over each other's changes; a lock
   left by a crashed process is taken over after 30 seconds.

**The S3/R2 adapter (`createS3Storage`) has no such requirement** — every
instance talks to the same bucket, so it scales horizontally with zero
additional configuration. Prefer it for any multi-instance deployment unless
you have a specific reason to use local disk.

### S3-compatible backend collision-guard fallback

`reserveUpload`'s collision guard normally uses `PutObjectCommand`'s
`IfNoneMatch: "*"` to atomically reject a second create for an artifactId
that already has an upload. Some S3-compatible backends (older/less-complete
implementations) don't support conditional writes and reject that header
outright.
On those backends, `reserveUpload` falls back to a weaker check-then-write —
functionally the same guard, but with the original race reopened: two
truly concurrent (or retried) creates for the same artifactId can both pass
the check before either writes, and the second silently clobbers the
first's metadata. There's no way to close this without an external lock,
since it's a limitation of the backend, not this package. If your bucket
provider doesn't support `IfNoneMatch`, this fallback logs a one-time
`console.warn` per process the first time it's used — treat that warning as
a signal to either move to a backend that supports conditional writes, or
serialize artifactId creation yourself (e.g. in your own `/reserve`
endpoint) if concurrent creates for the same id are a real possibility in
your deployment.

## Resource limits and abuse prevention

`pulsevault` does not implement rate limiting or a concurrent-upload cap
itself — that's left to the operator, consistent with this project's general
principle that policy decisions belong to the deployment, not the library.
A minimal example using `@fastify/rate-limit`, scoped to just the upload
routes:

```ts
import rateLimit from "@fastify/rate-limit";

await app.register(rateLimit, {
  max: 20,
  timeWindow: "1 minute",
  // Scope to the pulsevault prefix only — don't rate-limit your whole app
  // with upload-sized limits.
  allowList: (req) => !req.url.startsWith("/pulsevault/upload"),
});
```

Under `@mieweb/pulsevault/core` (Express, Meteor, plain `http`), use the equivalent middleware for your host — e.g. `express-rate-limit` mounted ahead of `pulseVault.handler`, scoped the same way.

## Monitoring and audit logging

Wire `onArtifactEvent` once to get both ops metrics and a compliance audit
trail from the same hook — it fires at low-frequency, audit-worthy moments
only (never per chunk): authorize rejection (on `create`/`delete`/`resolve`,
not `patch`), successful completion, and validation rejection.

**Plain structured logging** (zero new dependencies):

```ts
onArtifactEvent: (event) => {
  app.log.info(event, "pulsevault artifact event");
},
```

**Prometheus counters**:

```ts
import { Counter } from "prom-client";
const artifactEvents = new Counter({
  name: "pulsevault_artifact_events_total",
  help: "pulsevault artifact lifecycle events",
  labelNames: ["phase", "kind"],
});

onArtifactEvent: (event) => {
  artifactEvents.inc({ phase: event.phase, kind: event.kind });
  if (event.phase === "reject" || event.phase === "authorize") {
    app.log.warn(event, "pulsevault artifact event");
  }
},
```

`onArtifactEvent` isn't request-scoped (no Fastify instance to hang a logger
off of either way), so the examples above read the same under
`@mieweb/pulsevault/core` — just close over whatever logger (or `console`)
your app already uses instead of `app.log`. The core's own internal
diagnostics (authorize-rejection/error logging separate from
`onArtifactEvent`) accept an explicit `logger` option on
`createPulseVaultCore(...)` for the same reason — see "Non-Fastify hosts" in
`README.md`.

What to alert on: a sustained rise in `reject`/`authorize`-rejection events
(misconfigured auth, or an attacker probing), disk usage on the local
adapter's `workspaceDir` approaching capacity, and any `5xx` rate on the
upload routes.

## Backup and restore (local storage)

The entire state of the local adapter lives under `workspaceDir`:
`.pulsevault/` (sidecars), `video/`, `project/`, `captions/`, `thumbnail/`
(bytes). Back it up as a normal filesystem tree — there's no separate database to keep in
sync. To restore, copy the tree back and restart; in-progress uploads at
backup time will resume correctly via the normal TUS `HEAD`-then-resume path
once the client retries, or will sit as abandoned partial uploads until
`retention` removes them (see "Retention" below) if the client never retries.

## Web-ready playback (conform to one format)

Videos reach PulseVault from the Pulse app, which already uploads the format
below, and from a host's own file picker: a screen recording, an iPhone HEVC
`.mov` (often 10-bit HDR), a WebM from a browser recorder, a 4K clip. Browsers
streaming over progressive HTTP stall on a `moov` atom at the end of the file,
Firefox never decodes HEVC, Chrome usually can't without hardware support,
10-bit HDR shown as SDR looks washed out, and a 4K file is far more than a
phone needs.

With the `webReady` option on, every finished video is **conformed** to one
target (`CONFORM_TARGET`, exported from the package root):

| Property | Target |
|---|---|
| Container | MP4, `moov` at the front (faststart) |
| Video | H.264, 8-bit `yuv420p` (limited range), even width and height |
| Colour | SDR: HDR (PQ or HLG) is tone-mapped to BT.709; an SDR source keeps its own colour tags (BT.709 or BT.601), which browsers honour |
| Size | longest edge at most 1920 (`maxEdge`); aspect ratio and orientation kept — no crop, pad or stretch |
| Rotation | applied to the pixels, so every player shows it the way it was held |
| Audio | AAC; a video with no audio stays silent |

`ensureWebReady` does the least work that gets a file there:

| The upload | What happens | `action` |
|---|---|---|
| Already in the target (a Pulse upload) | nothing; bytes untouched | `none` |
| MP4 with the `moov` at the end | lossless `-c copy` faststart remux | `remuxed` |
| MP4 with an off-target stream | one ffmpeg run, in place | `transcoded` |
| Another container (`.mov`, `.m4v`, `.webm`, `.mkv`, `.3gp`, `.avi`) | one ffmpeg run into a new `<id>.mp4`: a stream copy when the streams already conform, otherwise only the off-target streams re-encoded | `conformed` |
| No ffmpeg, unreadable, failed or timed out | nothing; the original serves | `skipped` |

A re-encode scales by the longest edge, applies the rotation, tone-maps HDR
(PQ or HLG) to SDR, and converts non-AAC audio (Opus, PCM, …) to AAC. After a
container change the artifact's stored file, extension and served
`Content-Type` (`video/mp4`) follow the new file; the artifact id, and so every
URL a host stored, stay the same. The new file is written beside the original,
the artifact's sidecar switches to it, and only then is the original deleted:
a crash at any point leaves either the original serving (the conversion is
redone by the replay) or an unused original that is deleted with the
artifact.

While a video is being converted, its URL serves the original bytes with
`max-age=0` instead of the configured `cache`, so a browser that fetched it
early revalidates and gets the converted file (with a new ETag) afterwards.

A failed run is recorded as `conversion failed: ffmpeg exited with code N`;
ffmpeg's own output, which names server paths, goes only to the server log.

The result is recorded on the artifact: the status route reports it as
`webReady: { action, reason }` (a host can say "Your video is ready", or "We
couldn't convert this video, so it may not play in every browser"),
`onArtifactEvent` fires `processed` with it, and `completeAfter` hands it to
`onUploadComplete` as `ctx.webReady`.

**Prerequisite:** install ffmpeg (which includes ffprobe) on the serving host
— `apt install ffmpeg` (Debian/Ubuntu), `dnf install ffmpeg` (Fedora/EL + RPM
Fusion), or `brew install ffmpeg` (macOS). It is detected at first use; without
it every upload is still accepted and served exactly as uploaded, one warning
is logged, and `core.conformAvailable()` (also `fastify.pulseVaultCore`)
resolves `false` for a health check. HDR tone mapping uses the `scale` filter
on FFmpeg 8 and later, or `zscale` (libzimg, included in the Debian and Ubuntu
packages) on older builds. A build with neither leaves an HDR video as
uploaded and records `skipped` with what's missing: converting it without tone
mapping would give wrong colours.

```js
await app.register(pulseVault, {
  storage: createLocalStorage({ workspaceDir: dataDir }),
  validatePayload: createVideoValidator({ maxDurationSeconds: 600 }),
  webReady: { concurrency: 1, completeAfter: true },
});
```

Settings:

- `concurrency` (default `1`): conversions run one at a time per process; the
  rest wait in a queue. A conversion a restart interrupted is resumed by the
  completion replay (`replayCompletions`): an artifact isn't marked converted
  until its result is recorded.
- `timeoutSeconds` (default `60 + 10 ×` the video's duration counted in
  1080p30 seconds — a second of 4K at 120 fps counts 16 — an hour when the
  duration is unknown): a run past it is killed, the original kept, and
  `skipped` recorded with the reason.
- `probeTimeoutSeconds` (default `60`): the same guard for each ffprobe run
  over the upload, so a malformed file can't hold the queue.
- `maxEdge` (default `1920`): the longest edge of the served video.
- `transcode: false`: never re-encode; only lossless remuxes run (a `moov`
  moved to the front, or another container whose streams already conform copied
  into an `.mp4`), so no CPU cost beyond a file rewrite.
- `crf`/`preset` (defaults `23`/`veryfast`) tune the H.264 encode;
  `ffmpegPath`/`ffprobePath` point at binaries off `PATH`.

**Accepted containers.** The default video `allowedExtensions` are `.mp4`,
`.mov`, `.m4v`, `.webm`, `.mkv`, `.3gp` and `.avi` (`CONFORM_VIDEO_EXTENSIONS`);
a host's own `allowedExtensions` still overrides them. The extension only
decides what's accepted at `create`; `createVideoValidator()` checks the
received bytes by what they are: ffprobe must find a video stream with a
duration above zero that isn't a picture (a PNG, JPEG, GIF, HEIC photo or
one-frame clip is refused), and, with `maxDurationSeconds`, not longer, or the
upload is refused with `422 That file isn't a video.` / `That video is longer
than the limit of 10 minutes.` Each ffprobe run is bounded by
`probeTimeoutSeconds` (default `60`), so a malformed file can't hold the final
`PATCH` open: past it the upload is refused with `422 That video couldn't be
checked in time.` Without ffprobe it falls back to sniffing the
container's first bytes (`ftyp`, EBML or RIFF AVI). An upload over
`maxUploadSize` is refused at `create` with `413 That file is larger than
500 MB.` Without `webReady`, a WebM or MKV is served as uploaded, with its own
content type.

**Existing artifacts** — uploads that landed before `webReady` was on are
conformed once with the bundled migration script. Stop the server while it
runs (the server caches each artifact's extension, which a container change
rewrites). It is idempotent; interrupt and rerun freely:

```sh
node node_modules/@mieweb/pulsevault/scripts/web-ready-migrate.mjs /path/to/workspaceDir
# preview without modifying anything:
node node_modules/@mieweb/pulsevault/scripts/web-ready-migrate.mjs /path/to/workspaceDir --dry-run
# lossless remux only, never transcode:
node node_modules/@mieweb/pulsevault/scripts/web-ready-migrate.mjs /path/to/workspaceDir --no-transcode
```

A re-encode is one-time, quality-preserving at the default CRF but not
bit-identical, and a conformed file replaces the upload (the original is not
kept). Take a backup first if that matters to
your deployment (see "Backup and restore" above).

After a container change, tus's record of the upload still names the
uploaded file, so a client that re-sends the final `PATCH` of an upload whose
response it lost gets `410` instead of `204` (the upload did finish; the
status route says so). The Pulse app never uploads a container that changes.

Note on checksums: a conversion changes the artifact's bytes, so an
upload-time checksum recorded for it (the sidecar `checksum` from
`Upload-Metadata`) describes the original upload, not the rewritten file.
Treat `getChecksum` as upload-time provenance rather than current-file
integrity for artifacts this feature has touched.

## Retention

**Abandoned uploads** — unfinished uploads a client gave up on, and the
captions, manifest or thumbnail of a video that never finished — are cleaned
up by the opt-in `retention` option (or `sweepAbandonedUploads` from your own
scheduler); see the README's `retention` option. Both adapters support it.
Separately, a create that arrives for an unfinished upload of the same id
(the person scanned the same link again after the app died) takes it over
once it has been idle for `reclaim.idleSeconds` (300 by default), so nobody
waits for the sweep.

**Completions the host never recorded** — an `onUploadComplete` that threw,
or a restart between the final byte and the hook — are fired again by the
completion replay (`replayCompletions`, every 300 seconds by default, and
`pulseVaultCore.replayCompletions()` on demand). Nothing to schedule; make the
hook idempotent.

How long to keep **finished** content is a policy decision `pulsevault`
leaves to the operator (see `PROTOCOL.md` §1 on lifecycle ownership). A
sample cron script for the local adapter, deleting artifacts older than a
retention window (compliance-driven deletion), alongside the abandoned-upload
cutoff it predates:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({ workspaceDir: "./data" });
const sidecarDir = path.join(storage.workspaceRoot, ".pulsevault");
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h stuck "uploading"
const RETAIN_FOR_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

for (const file of await readdir(sidecarDir)) {
  if (!file.endsWith(".json")) continue;
  const artifactId = file.slice(0, -".json".length);
  const sidecarPath = path.join(sidecarDir, file);
  const [sidecar, stats] = await Promise.all([
    readFile(sidecarPath, "utf8").then(JSON.parse),
    stat(sidecarPath),
  ]);
  const ageMs = Date.now() - stats.mtimeMs;
  const stuckUploading = sidecar.status === "uploading" && ageMs > ABANDONED_AFTER_MS;
  const pastRetention = sidecar.status === "ready" && ageMs > RETAIN_FOR_MS;
  if (stuckUploading || pastRetention) {
    await storage.remove(artifactId);
    console.log(`removed ${artifactId} (${stuckUploading ? "abandoned" : "retention"})`);
  }
}
```

Run this on whatever schedule your retention policy requires. For S3/R2
storage, prefer your bucket provider's native lifecycle-policy feature (S3
Lifecycle Rules, R2 Object Lifecycle) over a custom script where available —
and let `retention` handle abandoned uploads, which a lifecycle rule can't tell
apart from finished ones (it doesn't read the sidecar's status).

## Secrets management

If you use `createCapabilityAuthorize`, you supply the HMAC secret(s)
yourself via `lookupSecret`. For local development, reading from an
environment variable is fine. For production, read from your organization's
actual secrets manager instead of a raw env var — e.g.:

```ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const keys: Record<string, string> = {};
async function loadKey(kid: string) {
  const res = await client.send(new GetSecretValueCommand({ SecretId: `pulsevault/${kid}` }));
  keys[kid] = res.SecretString!;
}
```

Rotate by adding the new `kid` to your lookup table alongside the old one,
switching issuance to the new `kid`, and removing the old entry only after
its longest-lived outstanding token has expired.

View links (`issueViewLink` / `createViewLinkIssuer`) are signed with a key
derived from the same secrets, so they rotate with them — and since they can
be much longer-lived than an upload token, keep a retired `kid` in the table
as long as the view links you still want working, or remove it to revoke
every view link signed under it at once. Deleting a video stops its view
links opening the video (the `GET` then 404s), but the links keep opening its
related captions, manifest and thumbnail until those are deleted too — by the
client, or by `retention` once the video has been gone past its cutoff.
