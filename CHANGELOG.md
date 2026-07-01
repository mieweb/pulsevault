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

[Unreleased]: https://github.com/mieweb/pulsevault/compare/v0.0.1...HEAD
