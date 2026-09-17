# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
semantic versioning once it reaches `1.0.0` — pre-1.0, minor bumps may include
breaking changes, called out explicitly below.

## [Unreleased]

### Removed

- **Breaking: the `uploadUnit` concept is gone.** There is one way to upload a
  pulse — the video plus its related artifacts (captions, beat manifest,
  thumbnail) under a single session token. The per-clip "segment" strategy
  carried no information the beat manifest doesn't (beats are timecode ranges
  in the manifest, not separate uploads), so it was removed rather than
  maintained in parallel. Concretely: the `uploadUnit` option is removed from
  the Fastify plugin, the Node core, and the web handler; `buildUploadLink`
  no longer accepts or emits an `uploadUnit` param (clients ignore it on old
  links); `GET /capabilities` no longer returns an `uploadUnit` field; and
  PROTOCOL.md §8 now defines the single upload set. Operators who set
  `uploadUnit` must simply delete the option; clients that branched on it
  should upload the one defined set.

### Documentation

- README grew a **Deployment caveats (AWS S3 & R2)** section: the 5 GiB
  single-`PUT` cap on direct uploads, why bucket policies that enforce
  SSE-KMS per request reject presigned grant `PUT`s (use default bucket
  encryption instead), conditional-write (`If-None-Match`) support and the
  fallback's consequences, the expired-grant re-grant behavior, presigned-URL
  TTL ceilings (7 days on both AWS and R2; no custom domains on R2), and
  which lifecycle rules clean up TUS-multipart vs direct-upload debris.
- The `OPERATIONS.md` retention sample now uses the public
  `listArtifactIds()`/`getMetadata()` API instead of hand-parsing sidecar
  files.

### Changed

- **Breaking: the package entry points are flipped to match what the library
  actually is.** `@mieweb/pulsevault` (the `.` export / `main`) is now the
  **framework-agnostic core** — `createPulseVaultCore`, the storage adapters,
  and every helper; it has no Fastify dependency. The Fastify plugin moved to
  **`@mieweb/pulsevault/fastify`** (same default export, options, and
  behavior). Migration is a one-line import change:
  `import pulseVault from "@mieweb/pulsevault"` →
  `import pulseVault from "@mieweb/pulsevault/fastify"`.
  The legacy `@mieweb/pulsevault/core` subpath is kept indefinitely as an
  alias of `.` so existing core consumers (including Meteor's
  exports-map-unaware bundler, via the root `core.js` stub) are unaffected.
  `@mieweb/pulsevault/augment` is unchanged.

### Fixed

- **Direct-upload re-grants require the same session anchor.** The same-shape
  predicate compared kind/ext/size but not `relatedTo`, so a token authorized
  for anchor A could submit anchor B's known artifactId with `relatedTo: A`,
  pass authorization, and receive a fresh PUT grant for B's incomplete
  reservation. The relation is now part of the reservation's identity in the
  core and the Workers demo, and `presignPut` re-validates at mint time
  (ready or reshaped reservations lose the race as a 409, never armed as a
  grant; the create path passes such 4xx conflicts through instead of
  masking them as 500s).
- **The web entry's always-loaded graph is fully Node-builtin-free** —
  verified by walking the compiled static import graph. `artifactIdFromUploadId`
  moved from the tus module into the request-interpretation module (same
  single parser, dependency reversed), so importing
  `@mieweb/pulsevault/web` on a V8 isolate works for capabilities, direct
  uploads, and S3/R2 playback; only an actual TUS request loads the tus
  stack.
- **Direct reservations are no longer reclaimable mid-grant.** The debris
  check treated "no TUS `.info`" as a crash signature, but that is a direct
  reservation's normal live shape — after the default 60 s grace a retried
  create could yank a legitimate in-flight PUT's reservation. Staleness for
  direct reservations now also covers the presigned-URL lifetime.
- **Terminate cleanup is generation-gated.** The `POST_TERMINATE` sweep runs
  after the 204; if the freed artifactId was already re-reserved by the time
  it ran, it could delete the NEW reservation's state. The sweep now reads
  storage truth first and skips reservations younger than the termination.
- **Local storage: reclaim sweeps the stale reservation's bytes** (and its
  datastore `.json`) before re-reserving — `@tus/file-store` writes at
  offsets, so a fresh upload over longer leftover bytes would have kept the
  stale tail. And `datastoreInfoExists` only treats `ENOENT` as "absent":
  an `EACCES`/`EIO` blip can no longer reclassify a live upload as debris.
- **The direct-upload module is Node-builtin-free** (`path.extname` replaced
  with a pure helper), completing the web entry's loadability on runtimes
  without Node compatibility.
- **Workers demo:** presigned PUTs now sign the grant's `Content-Type` into
  `X-Amz-SignedHeaders` (the declared size stays enforced at `complete` —
  `Content-Length` is a fetch-forbidden header runtimes may strip before
  signing), and object URLs are path-style, matching the S3 adapter's R2
  convention.
- **Direct-upload grants are fenced by per-reservation object keys.** A
  presigned `PUT` URL outlives the reservation that minted it (deleting the
  reservation cannot revoke the URL), so each direct reservation now writes
  its bytes to its own key (`<kind>/<id>.<suffix><ext>`, recorded in the
  sidecar). A superseded grant firing late lands on a key nothing reads from
  instead of silently overwriting a newer reservation's — or a ready
  artifact's — object. TUS uploads are unaffected (deterministic base key,
  written server-side). PROTOCOL.md §9.1 now specifies the fencing
  requirement and the residual same-reservation TTL window.
- **Direct-upload re-grant and complete decisions now read storage truth, not
  the per-process metadata cache.** On multi-instance deployments sharing one
  bucket, a stale cached `"uploading"` entry could re-grant a `PUT` against
  an artifact another instance had just completed and validated;
  `getMetadata` gained an opt-in `{ fresh: true }` read used by both
  decision points.
- **The adapters' metadata caches can no longer resurrect a deleted
  artifact.** A cache fill that started before a `remove()` and finished
  after its evictions could re-insert the deleted artifact's metadata and
  serve it indefinitely; fills now capture a deletion epoch before reading
  and are discarded if any deletion landed meanwhile.
- **Local storage serializes reclaim/remove per artifactId.** The multi-step
  reclaim (read → liveness check → unlink → exclusive re-create) and
  `remove()`'s deletes could interleave across concurrent callers — two
  reclaimers could both "win" (the slower unlink erasing the winner's fresh
  reservation), and a remove could delete files a concurrent reclaim had just
  re-reserved. A per-artifact in-process lock closes every such interleave;
  plain concurrent creates keep the lock-free atomic `wx` fast path.
  (In-process is the honest scope: multiple processes sharing one local
  workspace were never a supported topology — use the S3 adapter for that.)
- **The web handler serves zero-byte artifacts.** A valid zero-length upload
  previously crashed the streaming path (`fs.createReadStream` rejects
  `end: -1`); it now returns the empty `200` the headers describe, and
  unsatisfiable ranges over it get the correct `416`.
- **The web entry no longer hard-requires Node built-ins at import time.**
  The tus stack (`@tus/server` → `node:async_hooks`/`node:path`) is loaded
  lazily on the first TUS request, so `createPulseVaultWebHandler` can boot
  on runtimes without Node compatibility and still serve capabilities,
  direct uploads, and S3/R2 artifact redirects; the docstring now states the
  TUS surface's runtime requirements honestly.
- **Workers demo hardening:** capability-token signatures are verified with
  `crypto.subtle.verify` (constant-time) instead of a string compare; the
  reservation write is atomic via a signed S3-API `PUT` with
  `If-None-Match: "*"` (two concurrent creates can no longer both claim
  `201`); object keys carry the same per-reservation fencing suffix as the
  S3 adapter; `DELETE /artifacts/:id` (PROTOCOL §6.2) is implemented; and
  the TUS `501` / prefixed `404` responses carry `Protocol-Version`.
- **TUS termination (`DELETE /upload/<id>`) now sweeps the adapter's own
  artifact metadata** (the `.pulsevault` sidecar and caches) via
  `@tus/server`'s `POST_TERMINATE` event. Previously only the datastore's
  bytes/offset state was removed, leaving a permanent `"uploading"` sidecar
  behind — the cancelled artifactId stayed `409`-reserved forever and the
  paired client's only escape was re-pairing for a fresh id.
- **`reserveUpload` no longer 409s crash debris forever.** Both storage
  adapters now distinguish a genuine collision (a `ready` artifact, or an
  `uploading` one whose datastore state still exists, or a sidecar younger
  than the reclaim grace — a concurrent create in flight) from an orphaned
  `"uploading"` sidecar with no datastore state (a kill between reserve and
  datastore create, or a pre-cleanup termination), and reclaim the latter.
  New `reclaimGraceMs` option on both adapters (default 60 000 ms). Sidecars
  now carry a `reservedAt` timestamp to age-gate this without relying on
  filesystem mtimes.
- **`remove()` could resurrect deleted artifacts in the metadata cache**: a
  concurrent read racing between the pre-delete cache eviction and the
  (slow, I/O-bound) deletes re-populated the cache from the still-present
  sidecar, and the stale entry outlived the deletion. Both adapters now
  evict again after the deletes complete.

### Added

- **Web-standard core: `@mieweb/pulsevault/web`.** `createPulseVaultWebHandler`
  serves the whole protocol as a WHATWG `Request → Response` handler — one-line
  mounts under Hono (any runtime), Bun, Deno, and fetch-style meta-framework
  routes, with its own single-`Range`/`HEAD` artifact serving (via the
  maintained `range-parser`) instead of Node streaming internals. New
  [`examples/hono-demo`](examples/hono-demo). tus uploads still need a
  `node:fs`-capable runtime for the datastore; pure V8 isolates use the
  direct-upload profile below.
- **Direct-upload profile (PROTOCOL.md §9): presigned PUT data plane.**
  `POST {prefix}/direct-uploads` authorizes + reserves (same artifactId
  space/collision/debris rules as TUS) and returns a presigned `PUT` URL with
  `Content-Type`/`Content-Length` signed in; `POST
  {prefix}/direct-uploads/:artifactId/complete` verifies the stored object's
  size and runs the exact same validate → markReady → onUploadComplete
  sequence as TUS (shared `lib/finalize.ts`, so the two ingestion paths cannot
  diverge). Served by the Node core, the web core, and the Fastify adapter;
  advertised via the new `directUpload` capability field only when the storage
  adapter supports it (the S3/R2 adapter's new
  `createDirectUpload`/`headObjectSize`; local storage answers `501`).
  Explicitly single-`PUT` (retryable, not mid-file resumable) — TUS remains
  the default transport.
- **[`examples/workers-demo`](examples/workers-demo)**: a Cloudflare Workers
  control plane implementing the wire contract from PROTOCOL.md alone —
  WebCrypto capability tokens, direct uploads against R2 via `aws4fetch`
  presigning, presigned playback redirects — documenting the recommended
  V8-isolate deployment shape.
- **Cloudflare R2 auto-configuration in `createS3Storage`.** When `endpoint`
  is an `*.r2.cloudflarestorage.com` URL, the `@tus/s3-store` datastore now
  defaults to `partSize`/`minPartSize` of 8 MiB (R2 requires all non-trailing
  multipart parts to be the same size) and `useTags: false` (R2 does not
  implement `PutObjectTagging`; with tags on, every completed upload attempts
  a tagging call). New `minPartSize`, `maxMultipartParts`, and `useTags`
  options are forwarded for explicit control on any backend.
- **PROTOCOL.md §4.2.1**: the deterministic tus id scheme
  (`base64url("<kind>/<artifactId><ext>")`) is now a documented, stable part
  of protocol version 1, together with the client-side `409` recovery it
  enables (derive the resource URL, confirm with `HEAD`, resume) and the
  server-side debris-reclaim recommendation.
- **`getMetadata(artifactId)`** on both storage adapters (and the optional
  `PulseVaultStorage` contract) returns the whole artifact record — kind, ext,
  filename, ready, relatedTo, checksum, name, reservedAt — in one read, and
  **`LocalStorage.listArtifactIds()`** enumerates known artifacts. Together
  they replace consumers hand-parsing `.pulsevault` sidecar files (all four
  example servers now use them; the sidecar schema is no longer part of any
  consumer's code).

### Internal

- Storage adapters now share one sidecar module (`storage/sidecar.ts`):
  schema, parsing/normalization, bounded metadata cache, staleness gate, and
  the reserve-conflict error were previously hand-mirrored between the local
  and S3 adapters. Upload-Metadata normalization — including the
  security-relevant artifactId alias precedence that the authorize and
  reserve paths must agree on — is likewise single-sourced in
  `lib/upload-metadata.ts`, and all HTTP-mapped throws share
  `httpError(status, message)`.

## [0.3.0] - 2026-09-16

### Changed

- **Breaking: Node.js 20 is no longer supported** (`engines.node` is now
  `>=22`). Node 20 reached end-of-life on 2026-04-30; Node 22 (maintenance
  LTS) and Node 24 (active LTS) remain supported.

## [0.2.0] - 2026-09-14

This release reworks the upload contract for genuine multi-tenant use — any
third party can implement a compatible server from `PROTOCOL.md` alone, not
just by reading this package's source. It bundles several breaking changes
into one release rather than spreading them across several; see "Upgrading"
in `OPERATIONS.md` for the migration path.

### Security

The `videoid` → `artifactId` / generic-route rework above introduced two
related authorization bugs in `core.ts`'s `PATCH`/`HEAD` handling. Both are
fixed in this same release; upgrade before this reaches a published version
if you've evaluated against an intermediate build.

- **`authorize` was never actually invoked for `PATCH`/`HEAD`/in-flight-`DELETE`
  under `{prefix}/upload/<id>`**, regardless of configuration — including the
  built-in `createCapabilityAuthorize`. The helper that recovered an
  artifactId from the tus resource URL for the `authorize` context assumed
  the wrong shape for the current `<kind>/<artifactId><ext>` tus id and never
  successfully extracted a UUID, so the "no artifactId, so allow" fallback
  silently took over on every such request. Since an artifactId is not a
  secret (it's carried in the pairing deep link/QR code by design, per
  `PROTOCOL.md` §3), this let anyone who had seen a pairing link write bytes
  into that upload with no token at all. Fixed by resolving the artifactId
  through the same parser the actual upload-completion path uses, and by
  making authorization-context resolution failure a hard reject rather than
  a silent allow (`PROTOCOL.md` §5.2).
- **A crafted multi-segment `PATCH` URL could write bytes to a different
  artifact than the one `authorize()` checked.** The `authorize`-context URL
  parser took the first path segment after `/upload/`, while `@tus/server`'s
  own request routing (which decides what's actually read/written) takes the
  URL's last segment — a divergence exploitable via extra path segments
  (accepted by the `/upload/*` wildcard route). A party holding a valid
  token for their own artifact could append a second, victim artifactId as a
  trailing segment: `authorize()` saw and approved their own id, while the
  request body landed on the victim's file. Fixed by resolving the
  authorization-context artifactId via the exact same last-segment
  extraction `@tus/server` itself uses (`PROTOCOL.md` §4.4, a new normative
  requirement on server implementations generally, not just this package).
- Both are covered by new regression tests in `test/plugin.test.mjs` that
  fail against the pre-fix code and pass against the fix.
- **Removed `s3rver`** (unmaintained) from the dev/test toolchain, clearing
  its open `npm audit` findings: its dependency chain carried high-severity
  advisories (`busboy`/`dicer`) and forced pinning `fast-xml-parser` via an
  `overrides` entry plus a hand-written API-compat shim. The S3 suite now runs
  against `test/mock-s3.mjs`, a zero-dependency in-memory S3 double
  implementing exactly the eleven operations the code under test uses. Unlike
  s3rver it enforces `If-None-Match: "*"` (412), so the adapter's atomic
  reserve collision guard is now genuinely exercised — a concurrent-reserve
  test that was impossible against s3rver has been added. The `ListParts` shim
  (s3rver never implemented it) is gone too.
- **5xx responses no longer echo internal error messages.** A `markReady`,
  `onUploadComplete`, or 5xx-class `validatePayload` failure now logs the real
  error server-side and returns a generic body, so a consumer's DB/storage error
  text (schema names, paths, infra detail) can't reach the uploading client. 4xx
  validation rejections (e.g. checksum mismatch) keep their descriptive messages.
- **Storage subdirectories are created with mode `0o750`** so the upload tree
  isn't world-readable under a permissive umask.

### Breaking

- **Node.js `>=20` is now required** (`engines.node` was `>=18`). Node 18 is
  past end-of-life; every dependency floor in this release is tested against
  20+ only.
- **The `fastify` peer-dependency floor rose from `^5.8.5` to `^5.12.1`**,
  which is the first release fixing GHSA-w2qp-rph6-63g4 (schema-validation
  bypass via root primitive coercion mismatch, moderate) and
  GHSA-3m5p-2c4r-xxw2 (`X-Forwarded-*` spoofing under `trustProxy`
  hop-count, moderate). Refreshing the lockfile alongside it also clears the
  transitive `find-my-way` HTTP/2 DDoS advisory (GHSA-c96f-x56v-gq3h, high)
  and the `fast-uri` host-confusion/SSRF advisory cluster (high).
- **Renamed `videoid` → `artifactId`** across the storage interface
  (`ReserveUploadParams`, `PulseVaultStorage` methods), the `authorize`
  context (`PulseVaultAuthorizeContext`), the `validatePayload`/
  `onUploadComplete` hook contexts, the `request.pulseVault` TypeScript
  augmentation (`./augment.ts` — a separate breaking change from the wire
  rename, since it's the published type surface, not the HTTP contract), and
  the deep-link query parameter built by `buildUploadLink`. `videoid`/
  `projectid` remain accepted as legacy aliases in `Upload-Metadata` — only
  the *primary* name changed, not backward compatibility for existing
  clients' requests.
- **Collapsed the per-kind routes into one generic route.** `GET/DELETE
  /:videoid` and `GET/DELETE /project/:projectid` are gone; replaced by
  `GET/DELETE /artifacts/:artifactId`, which resolves the kind from storage
  rather than the URL. This also means `kind=captions` artifacts (new, see
  below) don't need a third route pair.
- **`validateProjectPayload`/`onProjectUploadComplete` are deprecated** (not
  yet removed) in favor of the now-generic `validatePayload`/
  `onUploadComplete`, which receive `ctx.kind` and run for every artifact
  kind. Passing either deprecated option now emits a one-time
  `DeprecationWarning` at plugin registration.
- **`allowedExtensions` requires a `captions` default to be considered** if
  you were relying on the exact shape of the normalized object internally
  (public consumers passing `allowedExtensions` as documented are unaffected
  — the new key just has a default like `video`/`project` already did).

### Added

- **`name`** — an optional `Upload-Metadata` key carrying a free-form UTF-8
  display title for the artifact (e.g. the draft name typed on the capture
  device). Trimmed and hard-capped server-side (512 chars), persisted to the
  sidecar alongside `relatedTo`/`checksum`, and exposed via the new optional
  `getName` storage method (and `ReserveUploadParams.name`). Display-only
  metadata: it never influences storage paths, routing, or authorization, and
  consumers must escape it for their own output context. Optional everywhere,
  so older clients that don't send it and consumers that don't read it are
  unaffected. Documented in `PROTOCOL.md` §4.1 as a non-normative extension.
- **`kind: "captions"`** artifact type (default extension `.vtt`), running
  through the same generic `validatePayload`/`onUploadComplete` hooks as
  every other kind. WebVTT carries word-level inline cue timestamps
  (`<00:00:01.500>word`) for karaoke rendering, and both storage adapters
  serve `.vtt` artifacts with the `text/vtt` content type.
- **`relatedTo`** — an optional `Upload-Metadata` key (and matching
  `ReserveUploadParams`/storage field) linking one artifact to another (e.g.
  a merged video's captions/beat-manifest/thumbnail, or a clip belonging to a
  segment ordering manifest's session).
  Storage adapters expose it via the new optional `getRelatedTo` method.
- **`checksum`** — an optional `Upload-Metadata` key (`<algorithm>:<hex
  digest>`) verified post-upload via the new `createChecksumValidator`
  (local storage) / `createS3ChecksumValidator` (S3/R2) helpers, chainable
  with `createMp4Sniffer`. This is at-rest integrity verification on the
  finished file, not a per-chunk check — `@tus/server`'s installed version
  doesn't implement the TUS Checksum extension, which would have covered
  chunks in flight.
- **`src/lib/capability-token.ts`**: `issueCapabilityToken`,
  `verifyCapabilityToken`, `createCapabilityAuthorize` — a stateless,
  HMAC-signed capability-token scheme with `kid` (key rotation with an
  overlap window), `iat` (clock-skew tolerance), and `issuer` (cross-deployment
  replay protection) claims. Fully optional — bring your own `authorize` if
  you have existing auth.
- **`GET {prefix}/capabilities`** — unauthenticated discovery route reporting
  `protocolVersion`, `minSupportedVersion`/`maxSupportedVersion`,
  `uploadUnit`, `kinds`, `allowedExtensions`, `maxUploadSize`, and supported
  checksum algorithms. Lets independently-versioned deployments and clients
  detect compatibility before pairing.
- **`uploadUnit` plugin option** (`"segment" | "merged"`, default `"segment"`) —
  purely advertised via `/capabilities`; the operator declares which upload
  strategy this deployment expects, the client branches on it. Not enforced
  by the plugin. `"segment"` uploads each recorded clip plus an ordering
  manifest; `"merged"` uploads one pre-merged video plus its captions, a
  beat-timecode manifest, and a thumbnail. (A "beat" is a timecode range on
  the merged timeline, not an upload unit.)
- **`kind: "thumbnail"`** artifact type (default extensions `.jpg`/`.jpeg`/
  `.png`) — the pulse poster frame uploaded alongside a merged video, running
  through the same generic `validatePayload`/`onUploadComplete` hooks and a
  `thumbnail/` storage subdir like every other kind.
- **`buildUploadLink({ uploadUnit })`** (PROTOCOL.md §3, §8) — optional
  per-session override of the deployment-wide `uploadUnit`, carried on the
  pairing link itself instead of only `/capabilities`. Lets an operator run
  `"segment"` and `"merged"` sessions concurrently (staged rollout, A/B test,
  per-tenant policy) without racing a client's separate `/capabilities` fetch
  against a single, deployment-wide value. Fully backward compatible: omit it
  and a client falls back to `/capabilities` exactly as before.
- **`onArtifactEvent` plugin option** — one low-frequency hook (authorize
  rejection, completion, validation rejection — never per chunk) covering
  both ops metrics and a compliance audit trail from a single integration
  point.
- **`Protocol-Version` response header** on every route this plugin mounts.
- **`@mieweb/pulsevault/core`** — a framework-agnostic entry point with no
  Fastify dependency. `createPulseVaultCore(...)` returns a connect-style
  `handler(req, res, next?)` usable directly as Express middleware
  (`app.use(prefix, handler)`), Meteor middleware
  (`WebApp.connectHandlers.use(prefix, handler)`), or a bare
  `http.createServer` callback — same options, hooks, and storage adapters as
  the Fastify plugin (which is now itself a thin adapter over this core, so
  behavior can't drift between the two). See "Non-Fastify hosts" in
  `README.md`, and `examples/express-demo`/`examples/meteor-demo` for full
  runnable servers verified against the real frameworks.
  - As part of this, `PulseVaultAuthorize`/`PulseVaultValidatePayload`/
    `PulseVaultOnUploadComplete`'s `request` parameter is now typed as the
    generic `PulseVaultRequest` (just `{ headers }`) instead of
    `FastifyRequest` — `FastifyRequest` still satisfies it structurally, so
    untyped/inferred hook callbacks (the documented pattern) are unaffected;
    only an explicit `(request: FastifyRequest, ctx) => ...` annotation on
    one of these three hooks would need loosening.
- Bounded, insertion-order-evicting in-memory metadata cache in both storage
  adapters (`metaCacheLimit` option, default 10,000 entries) — previously
  unbounded for the life of the process.
- `S3Storage.readAll` — full-object read, used by `createS3ChecksumValidator`.
- `S3Storage.digestAll` — streams a finalized object through a hash digest
  without buffering the whole thing into memory first; the streaming
  counterpart to `readAll`, now used internally by
  `createS3ChecksumValidator` (see "Fixed" below).

### Changed

- Dependency floors bumped to current patch releases: `@fastify/send`
  `^4.1.1`, `@tus/s3-store` `^2.0.6`, AWS SDK `^3.1131.0`, TypeScript
  `^6.0.3`, `@types/node` `^25.9.6`. `@tus/server`/`@tus/file-store` stay
  deliberately pinned at `2.0.0` (Meteor `srvx` exports issue — see the
  Meteor compatibility entry below); `fastify-plugin` stays on `^5.1.0`
  (v6 is a major, out of scope for a security-motivated bump).
- Replaced `examples/rn-demo` with two focused Fastify examples:
  `examples/fastify-demo` (the smallest runnable server — no auth, local
  storage, QR pairing; start here) and `examples/fastify-auth-demo`
  (production-shaped reference — capability tokens always on, failing fast at
  boot without `PULSEVAULT_SECRET`, pulse-session grouping via `relatedTo`,
  WebVTT captions, Swagger UI, artifact-event feed). Both pairing pages
  are React (pinned ESM CDN builds, no bundler). Both examples are
  local-storage only; S3 wiring is documented in the README's S3 section
  rather than demonstrated in an example. `npm run e2e` now drives
  `fastify-auth-demo` and additionally asserts the fail-fast boot contract.
- `examples/fastify-auth-demo` gained a [Better Auth](https://better-auth.com)
  dashboard layer: the human-facing routes (`/deeplinks`, `/pulses`,
  `/events`, `/reserve`) require an email+password session, while the vault
  routes the Pulse app talks to stay capability-token authorized — two auth
  systems for two audiences, per PROTOCOL.md §5. The demo is Postgres-only,
  run through Docker Compose (`compose.yaml` + `Dockerfile`; `npm run db:up`
  + `npm start` for bare-metal dev against the same db), with one Prisma
  schema (`prisma/schema.prisma`, migrations committed and applied by
  `npm start`) holding both the auth tables and an **artifact index**:
  `onUploadComplete` writes each finished upload once, authorized deletes
  prune it, a boot-time reconcile keeps it honest against the filesystem
  sidecars (still the source of truth), and `/pulses` becomes one indexed
  query instead of a per-request sidecar crawl. `npm run e2e` provisions the
  compose db, applies migrations, and covers the 401 gate plus the
  sign-up/sign-in flow.

### Fixed

- **Artifact `GET`/`DELETE` handlers now fail closed.** They run on a hijacked
  socket, so a thrown storage error (S3 unreachable, disk fault) previously left
  the socket hung until timeout; each now emits a `500` (or destroys the socket
  if headers are already sent), mirroring the TUS handler. `GET` streams also
  catch a mid-stream read error instead of letting an unhandled `'error'` crash
  the process, and destroy the source stream on client disconnect so file
  descriptors aren't leaked. Covered by `test/fail-closed.test.mjs`.
- A consumer error carrying an out-of-range `statusCode` (e.g. `42`) now degrades
  to the handler's fallback status instead of crashing `res.writeHead`; a
  malformed request-target that `URL` can't parse returns `400` instead of an
  uncaught throw.
- Checksum verification requested against an adapter with no local path now
  reports `500` (server misconfiguration) instead of `422` (which wrongly
  implied the client's file was rejected).
- `verifyCapabilityToken` no longer throws on a token whose payload is valid
  JSON but not an object (e.g. the literal `null`) — it returns `null` like
  every other failure, per its single-failure-shape contract.
- Bearer-token extraction accepts the auth scheme case-insensitively per
  RFC 7235 (`bearer`/`BEARER`), not only the canonical `Bearer `.
- `maxUploadSize` enforcement and the in-progress-upload 404 behavior now
  have explicit test coverage proving bytes are rejected/hidden at the right
  point, not just implied by the implementation.
- **Meteor compatibility.** Meteor's bundler doesn't resolve `package.json`
  `"exports"` subpath maps, which broke both this package's own `"./core"`
  entry and, transitively, `@tus/server`'s dependency on `srvx` (which as of
  `@tus/server@2.1.0` ships *only* subpath exports, no legacy `main`
  fallback). Fixed two ways: `@tus/server`/`@tus/file-store` are pinned to
  `2.0.0` (the last release before the `srvx` migration — everything added
  in `2.1.0`–`2.4.1` was either the `srvx` migration itself, follow-up
  fixes for regressions it introduced, or one unused `exposedHeaders`
  option, so nothing this package relies on is lost); and plain root-level
  `core.js`/`core.d.ts`/`augment.js`/`augment.d.ts` files now ship alongside
  the `"exports"` map, so resolvers that ignore `"exports"` (Meteor's
  included) still find these entry points via ordinary relative-path
  resolution. Verified against a real Meteor 3.4 app: `WebApp.connectHandlers`
  resolves `@mieweb/pulsevault/core` cleanly and a full TUS
  create → PATCH → GET round-trip works.
- **Unbounded memory use during checksum validation.** `createChecksumValidator`
  read the whole finalized file into a single `Buffer` via `fs.readFile`
  before hashing; combined with the documented-supported `maxUploadSize:
  Infinity`, a large upload could exhaust process memory just to verify its
  checksum. Now streams the file through the hash via `createReadStream` +
  a stream pipeline. `createS3ChecksumValidator` had the same issue via
  `S3Storage.readAll`'s full-object buffer — now uses the new streaming
  `S3Storage.digestAll` instead.
- **Silent TOCTOU on S3-compatible backends without `IfNoneMatch` support.**
  `reserveUpload`'s conditional-write collision guard falls back to a
  weaker check-then-write on backends that reject `IfNoneMatch` (some
  S3-compatible stores) — this reopens the race between concurrent/retried
  creates
  for the same artifactId. There's no way to close it without an external
  lock, so this is now at least surfaced: a one-time `console.warn` fires
  per process the first time a deployment falls into this degraded mode.

[Unreleased]: https://github.com/mieweb/pulsevault/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/mieweb/pulsevault/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mieweb/pulsevault/compare/v0.0.1...v0.2.0
