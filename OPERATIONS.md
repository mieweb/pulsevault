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
   production.

**The S3/R2 adapter (`createS3Storage`) has no such requirement** — every
instance talks to the same bucket, so it scales horizontally with zero
additional configuration. Prefer it for any multi-instance deployment unless
you have a specific reason to use local disk.

### S3-compatible backends must honor conditional writes

`reserveUpload`'s one-winner guarantee is `PutObjectCommand`'s
`IfNoneMatch: "*"`. The adapter verifies it **once** — `initialize()` (or
the first reserve, for hosts that skip it) writes a throwaway key under the
metadata prefix twice, the second time conditionally, and requires the
412/409 an honoring backend returns. A backend that rejects the header
(501) or, more dangerously, accepts it and silently ignores it fails that
probe and the adapter refuses to start. There is no degraded mode: without
conditional writes two creates for one artifactId can both succeed, and no
amount of check-then-write closes that. AWS S3 (since Nov 2024) and
Cloudflare R2 both qualify.

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

### One valid token can create many artifacts (`relatedTo` amplification)

A capability token authorizes its `artifactId` **and** any artifact whose
`relatedTo` metadata points at it — that's the session-anchor design that lets
one pairing upload a video plus its captions, thumbnail, and project file.
The flip side: a single leaked or hoarded token permits **unbounded artifact
creation** under that anchor, and pulsevault imposes no count. With no rate
limit that's a disk-fill amplifier from one credential — and under the
direct-upload profile (PROTOCOL.md §9) the amplified bytes go straight to
your bucket without ever transiting the server, so server-side body limits
never see them.

Mitigate in your `authorize` hook, where the policy belongs: cap artifacts
per anchor (count existing `relatedTo` matches before allowing a `create`),
constrain which `kind`s a related artifact may use, and keep token TTLs short
(a deep-link token only needs to outlive one upload session). The rate-limit
example above bounds the request *rate*; the per-anchor cap bounds the
*total*.

### Tokens ride in URLs — treat request logs as sensitive

Two places a capability token legitimately appears in a URL, by design:
pairing deep links (`pulsecam://…&token=…`) and the `?token=` fallback on
artifact `GET`s (for `<video>` tags and native players that can't set an
`Authorization` header). Consequences to plan for:

- **Reverse-proxy and access logs** capture query strings by default — scrub
  or truncate them (nginx: log `$uri`, not `$request`/`$args`) or the logs
  become a token store with a longer retention than the tokens.
- **`Referer` leakage**: a browser page that links out after loading a
  tokenized URL can leak it. Serve any web player pages with
  `Referrer-Policy: no-referrer` (or `same-origin`).
- Prefer the `Authorization` header everywhere a client can set one; treat
  `?token=` as the fallback it is. Short TTLs bound the damage of any single
  leaked URL.

The S3/R2 presigned redirect has the same property one hop later (the
presigned URL embeds its own signature); its lifetime is `presignTtlSeconds`
(default 900 s) — keep it short for the same reason.

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
once the client retries, or will simply sit as abandoned partial uploads
(see "Retention" below) if the client never retries.

## Web-ready playback (faststart remux + H.264 transcode)

Browsers streaming an MP4 over progressive HTTP stall (or fail outright) on
two things mobile capture pipelines routinely upload:

- **moov atom at the end of the file** — the player must fetch the file's tail
  before rendering frame one: seconds of startup delay behind Range requests,
  or a full download in naive players.
- **HEVC video** — Firefox never decodes it; Chrome usually can't without
  hardware support.

The `ensureWebReady` helper (exported from the package root) fixes both, in
place and atomically (tmp file + rename): a lossless sub-second
`-c copy -movflags +faststart` remux when only the moov position is wrong, and
a one-time `libx264` transcode (audio stream-copied) when the codec is
hostile. It is fail-open by design — without `ffmpeg`/`ffprobe` on `PATH` it
logs one warning and the original bytes keep serving exactly as before.

**Prerequisite:** install ffmpeg on the serving host — `apt install ffmpeg`
(Debian/Ubuntu), `dnf install ffmpeg` (Fedora/EL + RPM Fusion), or
`brew install ffmpeg` (macOS). Nothing else changes; the hook detects it at
first use.

**New uploads** — wire it into `onUploadComplete` (the fastify-demo ships with
this enabled):

```js
const storage = createLocalStorage({ workspaceDir: dataDir });
await app.register(pulseVault, {
  storage,
  onUploadComplete: async (_request, { artifactId, kind }) => {
    if (kind !== "video") return;
    const localPath = await storage.getLocalPath(artifactId);
    if (localPath) await ensureWebReady(localPath, { logger: app.log });
  },
});
```

Options: `{ transcode: false }` restricts it to the lossless remux (no CPU
cost beyond a file rewrite); `crf`/`preset` tune the transcode
(defaults `23`/`veryfast`); `ffmpegPath`/`ffprobePath` point at binaries off
`PATH`.

**Existing artifacts** — uploads that landed before the hook existed are fixed
once with the bundled migration script (idempotent; interrupt and rerun
freely, already-fixed files are skipped for free):

```sh
node node_modules/@mieweb/pulsevault/scripts/web-ready-migrate.mjs /path/to/workspaceDir
# preview without modifying anything:
node node_modules/@mieweb/pulsevault/scripts/web-ready-migrate.mjs /path/to/workspaceDir --dry-run
# lossless remux only, never transcode:
node node_modules/@mieweb/pulsevault/scripts/web-ready-migrate.mjs /path/to/workspaceDir --no-transcode
```

A transcode re-encodes the video stream (one-time, quality-preserving at the
default CRF but not bit-identical). Take a backup first if that matters to
your deployment (see "Backup and restore" above).

Note on checksums: a remux or transcode changes the artifact's bytes, so an
upload-time checksum recorded for it (the sidecar `checksum` from
`Upload-Metadata`) describes the original upload, not the rewritten file.
Treat `getChecksum` as upload-time provenance rather than current-file
integrity for artifacts this feature has touched.

## Retention

`pulsevault` has no built-in retention/expiry feature — this is intentionally
left to the operator (see `PROTOCOL.md` §1 on lifecycle ownership). A sample
cron script for the local adapter, deleting artifacts whose sidecar has been
`"uploading"` for longer than a cutoff (abandoned uploads) or that are older
than a retention window (compliance-driven deletion):

> **Direct uploads (PROTOCOL.md §9).** A direct-upload reservation whose
> `complete` never arrives leaves an `"uploading"` sidecar plus (possibly) a
> stored object the client PUT but never confirmed. The abandoned-upload
> cutoff below covers the sidecar; on S3/R2 also add a bucket lifecycle rule
> for unconfirmed objects. ArtifactIds are single-use (PROTOCOL.md §4.2.1):
> this sweep reclaims an abandoned reservation's bytes, and the id itself
> stays spent — clients never re-contest one; they mint a fresh id per
> attempt.

Both built-in adapters implement `listArtifactIds()`/`getMetadata()`, so the
same sweep runs unchanged against local disk or an S3/R2 bucket (where it is
a paginated `ListObjectsV2` over the metadata prefix). `remove()` deletes the
bytes and rewrites the sidecar as a `"deleted"` tombstone rather than
deleting it, so a removed id can never be reserved again; `getMetadata()`
reports a tombstone as absent, so the sweep below skips it. A tombstone is
a few hundred bytes — keep them. An unparseable sidecar (crash debris, a
foreign schema) is tombstoned the same way.

```ts
import { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({ workspaceDir: "./data" });
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h stuck "uploading"
const RETAIN_FOR_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

for (const artifactId of await storage.listArtifactIds()) {
  const meta = await storage.getMetadata(artifactId);
  if (!meta) continue;
  // reservedAt is absent on sidecars written before v0.3; treat those as old.
  const ageMs = Date.now() - (meta.reservedAt ?? 0);
  const stuckUploading = !meta.ready && ageMs > ABANDONED_AFTER_MS;
  const pastRetention = meta.ready && ageMs > RETAIN_FOR_MS;
  if (stuckUploading || pastRetention) {
    await storage.remove(artifactId);
    console.log(`removed ${artifactId} (${stuckUploading ? "abandoned" : "retention"})`);
  }
}
```

Run this on whatever schedule your retention policy requires. For S3/R2
storage, prefer your bucket provider's native lifecycle-policy feature (S3
Lifecycle Rules, R2 Object Lifecycle) over a custom script where available.

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
