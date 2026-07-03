# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
semantic versioning once it reaches `1.0.0` — pre-1.0, minor bumps may include
breaking changes, called out explicitly below.

## [Unreleased]

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

### Breaking

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

- **`kind: "captions"`** artifact type (default extension `.srt`), running
  through the same generic `validatePayload`/`onUploadComplete` hooks as
  every other kind.
- **`relatedTo`** — an optional `Upload-Metadata` key (and matching
  `ReserveUploadParams`/storage field) linking one artifact to another (e.g.
  a video's captions, or a beat belonging to a pulse manifest's session).
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
- **`uploadUnit` plugin option** (`"beat" | "merged"`, default `"beat"`) —
  purely advertised via `/capabilities`; the operator declares which upload
  strategy this deployment expects, the client branches on it. Not enforced
  by the plugin.
- **`buildUploadLink({ uploadUnit })`** (PROTOCOL.md §3, §8) — optional
  per-session override of the deployment-wide `uploadUnit`, carried on the
  pairing link itself instead of only `/capabilities`. Lets an operator run
  `"beat"` and `"merged"` sessions concurrently (staged rollout, A/B test,
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

- Replaced `examples/rn-demo` with two focused Fastify examples:
  `examples/fastify-demo` (the smallest runnable server — no auth, local
  storage, QR pairing; start here) and `examples/fastify-auth-demo`
  (production-shaped reference — capability tokens always on, failing fast at
  boot without `PULSEVAULT_SECRET`, pulse-session grouping via `relatedTo`,
  SRT→WebVTT captions, Swagger UI, artifact-event feed). Both pairing pages
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
  S3-compatible stores, and the `s3rver` mock this repo's own test suite
  runs against) — this reopens the race between concurrent/retried creates
  for the same artifactId. There's no way to close it without an external
  lock, so this is now at least surfaced: a one-time `console.warn` fires
  per process the first time a deployment falls into this degraded mode.

[Unreleased]: https://github.com/mieweb/pulsevault/compare/v0.0.1...HEAD
