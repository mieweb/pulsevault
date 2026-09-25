# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
semantic versioning once it reaches `1.0.0` — pre-1.0, minor bumps may include
breaking changes, called out explicitly below.

## [Unreleased]

Protocol 2.2 (`PROTOCOL.md` §7.4). Protocol 2 records the `uploadUnit`
removal below as the breaking change it is; clients built for protocol 1
can't pair with this release.

### Added

- **Read-only view links** (protocol 2.2). The pairing token is a full
  capability, so a watch link carrying it let anyone holding the link
  upload to the artifact or delete it. The new `issueViewLink` option turns
  on `POST {prefix}/artifacts/:id/view-link` (authorized as the new
  `"share"` phase): for a finished artifact it returns `{ token, expiresAt }`,
  a token that only opens the artifact and the artifacts `relatedTo` it
  (`GET ?token=`). The host decides each link's lifetime, or refuses one;
  PulseVault sets none. `createViewLinkIssuer` / `issueViewToken` /
  `verifyViewToken` implement it for capability tokens: view tokens carry
  `use: "view"`, are signed with a key derived from the same secret (so a
  verifier that predates them rejects one), and `createCapabilityAuthorize`
  accepts them only for `resolve`. `/capabilities` reports `viewLinks`, and
  `protocol/schemas/view-link.schema.json` defines the response.
- **Opt-in cleanup of abandoned uploads.** The `retention` option
  (`{ abandonedAfterSeconds, sweepIntervalSeconds? }`, on the plugin and
  `createPulseVaultCore`) sweeps on a timer, removing uploads left
  unfinished past the cutoff and the related artifacts of a video that never
  finished; finished content is never touched. `sweepAbandonedUploads` runs
  one sweep for your own scheduler. Storage adapters gain an optional
  `listArtifacts`, implemented by both built-in adapters.

- **The protocol is written down as files, and CI keeps it honest.**
  `protocol/schemas/*.schema.json` define `/capabilities`, pairing links,
  `Upload-Metadata`, the beat manifest, capability-token claims and the
  `Pulse-Client` header; `protocol/openapi.json` is generated from the
  route schemas (`npm run protocol`), and so are the field tables in
  `PROTOCOL.md`. `scripts/check-protocol.mjs` fails a change that alters the
  protocol without the right version bump (oasdiff decides what's breaking
  for the HTTP routes). The `protocol/` folder is published with the package.
- **`Pulse-Client` request header and `426 Upgrade Required`** (protocol
  2.1). A client that says its newest protocol is older than this server's
  oldest gets 426 with the supported range on uploads and artifact
  requests; `/capabilities` always answers. No header, no change.
- **`Upload-Metadata.appVersion`** (protocol 2.1): stored with the artifact
  by both storage adapters and reported on the `complete`/`reject` events
  (`PulseVaultArtifactEvent.appVersion`).
- **`protocolRevision`** in `/capabilities`: the spec revision, `major.minor`.
- **CI** (`.github/workflows/ci.yml`): tests on Node 22 and 24, the protocol
  checks, the e2e against Postgres, and the Pulse app's contract suite
  against each PR's build.

### Changed

- **A TUS `DELETE` is authorized as `"delete"`, not `"patch"`.** It now
  removes the artifact (below), the same as `DELETE /artifacts/:id`, so an
  `authorize` hook sees one phase for every removal — and a rejected one is
  reported on `onArtifactEvent` like any other rejected delete. If your hook
  allows `"patch"` but refuses `"delete"`, clients can no longer cancel an
  upload through TUS; allow `"delete"` for the artifact's own token.
- **Breaking: protocol 2.** `/capabilities` reports `protocolVersion: 2` and
  accepts protocol majors 2–2, read from the new `package.json`
  `pulseProtocol` field (`{ "version": "2.1", "min": 2, "max": 2 }`).

### Removed

- **Breaking: `uploadUnit` is gone — a pulse uploads as one video; beats are
  timestamps within it** (#64). A pulse is one video (the artifact named by
  the pairing link) plus its related captions, beat manifest and thumbnail;
  a beat is a `startMs`/`endMs` range inside that video, not an upload
  strategy (`PROTOCOL.md` §8). Concretely:
  - The `uploadUnit` option is removed from the Fastify plugin and from
    `createPulseVaultCore`. Passing it now throws a `TypeError` at boot
    ("`uploadUnit` was removed — delete the option") instead of being
    silently ignored — delete the option from your config.
  - `buildUploadLink` no longer accepts or emits an `uploadUnit` param.
    Links minted by older releases stay valid: clients ignore unknown params
    (`PROTOCOL.md` §3).
  - `GET /capabilities` no longer returns an `uploadUnit` field.
  - Ship this together with the Pulse app update for mieweb/pulse#213 —
    older Pulse builds require `uploadUnit` in `/capabilities`.

### Fixed

- **A TUS `DELETE` removes the whole artifact.** It used to reach only the
  tus datastore, so PulseVault's sidecar stayed behind: the artifactId
  answered every later create with `409`, a finished upload deleted on the
  local adapter kept a `ready` sidecar pointing at nothing, and on S3 a
  finished upload wasn't deleted at all (aborting its completed multipart
  upload fails with `NoSuchUpload` before anything is removed). Termination
  now runs `storage.remove` under tus's per-upload lock — bytes, tus record
  and sidecar, in flight or finished. The S3 adapter's `remove` also deletes
  the incomplete `.part` object @tus/s3-store parks between PATCHes.

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
