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

### S3-compatible backend collision-guard fallback

`reserveUpload`'s collision guard normally uses `PutObjectCommand`'s
`IfNoneMatch: "*"` to atomically reject a second create for an artifactId
that already has an upload. Some S3-compatible backends (older/less-complete
implementations; the `s3rver` mock this package's own test suite runs
against) don't support conditional writes and reject that header outright.
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
once the client retries, or will simply sit as abandoned partial uploads
(see "Retention" below) if the client never retries.

## Retention

`pulsevault` has no built-in retention/expiry feature — this is intentionally
left to the operator (see `PROTOCOL.md` §1 on lifecycle ownership). A sample
cron script for the local adapter, deleting artifacts whose sidecar has been
`"uploading"` for longer than a cutoff (abandoned uploads) or that are older
than a retention window (compliance-driven deletion):

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
