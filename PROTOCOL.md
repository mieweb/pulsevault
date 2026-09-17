# Pulse Upload Protocol

**Version 1**

This document specifies the wire contract between a Pulse client and any
server that wants to receive uploads from it. It is independent of
`@mieweb/pulsevault` — a server that implements everything in this document
is Pulse-compatible whether or not it uses this package. `@mieweb/pulsevault`
is the reference implementation.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD
NOT**, and **MAY** in this document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## 1. Overview

A server (the "operator") mints an `artifactId` and a capability `token`,
then presents them to a Pulse client via a deep link or QR code (§3). The
client uploads the artifact's bytes to the server using the [TUS v1
resumable upload protocol](https://tus.io/protocols/resumable-upload) (§4),
authenticated with the token on every request (§5). The server validates,
stores, and serves the finished artifact (§6, §7).

No central authority is involved. Any server implementing this document MAY
be used by any Pulse client. Lifecycle decisions — `artifactId` minting,
token issuance, expiry policy, secret rotation, revocation — are entirely the
operator's responsibility (§5.4). This document fixes the wire shape only,
never the policy behind it.

## 2. Capability discovery

A server MUST expose an unauthenticated `GET {prefix}/capabilities` endpoint.
The response body MUST be a JSON object with at least the following fields:

```json
{
  "protocolVersion": 1,
  "minSupportedVersion": 1,
  "maxSupportedVersion": 1,
  "kinds": ["video", "project", "captions", "thumbnail"],
  "allowedExtensions": { "video": [".mp4"], "project": [".pulse", ".zip"], "captions": [".vtt"], "thumbnail": [".jpg", ".jpeg", ".png"] },
  "maxUploadSize": 5368709120,
  "checksum": { "algorithms": ["sha256", "sha1", "md5"] }
}
```

- `protocolVersion` (integer, REQUIRED): the version of this document the
  server implements.
- `minSupportedVersion`/`maxSupportedVersion` (integer, REQUIRED): the
  inclusive range of client protocol versions this server accepts. A client
  SHOULD refuse to pair if its own version falls outside this range, and
  SHOULD show the user an actionable message ("update the app" /
  "this server needs an update") rather than a generic error.
- `kinds` (array of string, REQUIRED): artifact kinds this server accepts.
- `allowedExtensions` (object, REQUIRED): allowed file extensions per kind.
- `maxUploadSize` (integer or `null`, REQUIRED): maximum artifact size in
  bytes; `null` means the deployment declares no cap.
- `checksum.algorithms` (array of string, OPTIONAL): digest algorithms this
  server can verify (§6.3). Absent or empty means the server does not
  support checksum verification. Note for implementers: this field
  describes capability, not whether verification is actually wired in for
  every upload — a server MAY list an algorithm it's capable of checking
  even for a deployment where the operator hasn't enabled that check.
- `directUpload` (object, OPTIONAL): present iff the server supports the
  presigned direct-upload profile (§9). Currently `{ "enabled": true }`.
  Absent means TUS (§4) is the only ingestion path.

A server response to this endpoint MUST NOT include any secret. Every other
response from the server MUST include a `Protocol-Version` header carrying
the integer from `protocolVersion`.

## 3. Pairing (deep link)

A server presents a pairing link or QR code of the form:

```
pulsecam://?v=1&artifactId=<uuid>&server=<origin>&token=<opaque>
```

- `v` (REQUIRED): the deep-link schema version. A client MUST refuse and
  explain (not silently misparse) a `v` it doesn't recognize.
- `artifactId` (REQUIRED): a UUID minted by the server. The client uses this
  directly as the `artifactId` in `Upload-Metadata` (§4) — it MUST NOT
  perform a separate "reserve" round-trip when an `artifactId` is already
  present in the link.
- `server` (REQUIRED): the full **base URL** to upload to — origin plus
  whatever path prefix the operator mounted the upload routes under (e.g.
  `https://vault.example.org/pulsevault`), not merely the origin. A client
  MUST treat every route in §2/§4/§6 as `${server}/<path>` and MUST NOT
  assume or invent a separate prefix of its own. A client MUST reject any
  `server` value that is not `https://`, with the sole exception of
  `http://localhost` or a private IP literal for local development — this
  exception MUST NOT be silently extended to any other plaintext origin.
- `token` (OPTIONAL): an opaque credential forwarded on every subsequent
  request (§5). Servers SHOULD treat this as short-lived and scoped to the
  `artifactId` (or a session it anchors, §5.4), not a standing general
  credential — see §5.4 for the recommended (but not required) capability-
  token shape.

A client MUST ignore unrecognized query parameters on a link whose `v` it
supports (earlier revisions carried an `uploadUnit` param here; it is
retired — §8).

A client SHOULD display the server's origin (and, where feasible, its TLS
certificate fingerprint) to the user before uploading anything, rather than
silently proceeding — this is a trust-on-first-use decision the user should
be able to see and decline.

## 4. Upload transport (TUS)

Upload transport MUST be [TUS v1](https://tus.io/protocols/resumable-upload)
core protocol (creation + core resumable upload). A server MUST mount:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `{prefix}/upload` | Create a resumable upload |
| `PATCH` | `{prefix}/upload/<id>` | Append a chunk at `Upload-Offset` |
| `HEAD` | `{prefix}/upload/<id>` | Query the current offset |
| `DELETE` | `{prefix}/upload/<id>` | Cancel an in-flight upload |

`PATCH` bodies MUST be the raw bytes for that offset
(`Content-Type: application/offset+octet-stream`) — never base64-encoded or
wrapped in another envelope.

### 4.1 `Upload-Metadata`

The TUS `Upload-Metadata` header (comma-separated `<key> <base64(value)>`
pairs) MUST be parsed for at least:

| Key | Required | Description |
|---|---|---|
| `artifactId` | Yes (or a legacy `videoid`/`projectid` alias) | UUID for this artifact. |
| `filename` | Yes | Original filename; extension validated against `kind`'s allowed list. |
| `kind` | No, defaults to `video` | `video`, `project`, `captions`, or `thumbnail`. |
| `relatedTo` | No | UUID of another artifact this one belongs to (§8). |
| `checksum` | No | `<algorithm>:<hex digest>` of the finished file (§6.3). |
| `name` | No | Free-form UTF-8 display title for the artifact (e.g. the draft name typed on the capture device). Trimmed and length-capped by the server; persisted for consumers to label the artifact. Display metadata only — it MUST NOT influence storage paths, routing, or authorization, and consumers MUST escape it for their output context. |

Metadata values are base64 per the TUS spec; a free-form value such as `name`
MUST be base64 of its **UTF-8** bytes. A client that base64-encodes a raw
Latin-1 string (e.g. a browser `btoa()`) corrupts any non-ASCII title (accents,
emoji), so encode the UTF-8 bytes explicitly.

A client MUST always send `artifactId` (not only the legacy aliases) on new
uploads. A server MUST continue accepting `videoid`/`projectid` as aliases
for `artifactId` for back-compat with clients built against protocol
version 1 before this alias was the only spelling — this alias requirement
holds for the lifetime of protocol version 1.

### 4.2 Resumption

A client MUST always issue a `HEAD` request to learn the authoritative
offset before resuming an interrupted upload — it MUST NOT trust a locally
cached byte count, which can be stale (server restart, a partial write that
never committed, clock differences between client and a previous session).

#### 4.2.1 Single-use artifactIds and create conflicts

An `artifactId` is single-use: it names one upload attempt, not a retryable
slot. The first create for an id (TUS `POST /upload` or §9 direct create)
wins; every later create for the same id — whether the previous attempt
finished, is still in flight, or died halfway — MUST be rejected with
`409 Conflict`, decided against current storage state, not a per-instance
cache. (The one exception is the §9.1 re-grant, which re-arms the *same*
reservation with a fresh grant rather than electing a new winner.)

A client MUST NOT try to recover from a `409` by deriving or guessing the
existing upload's resource URL; it MUST obtain a fresh `artifactId` (in
deployments where ids are minted with the authorization grant, a fresh
grant) and create anew. An upload the client can still name — it holds the
`Location` from its own create — remains resumable per §4.2: single-use ids
constrain creates, not resumption.

A reservation is never freed. Explicit deletion (TUS `DELETE` termination,
or `DELETE {prefix}/artifacts/<artifactId>`) and operator retention (see
OPERATIONS.md) remove the bytes and **tombstone** the id: the serving route
answers `404`, and a create for that id still answers `409`. Servers MUST
NOT reclaim or reuse a reserved or deleted id. This keeps every create
one-winner-atomic with no grace window, and it is what makes every stale
handle harmless: a stale upload URL, grant or cache entry can only ever
refer to an id whose identity cannot change.

The tus resource id this implementation mints happens to be
`base64url("<kind>/<artifactId><ext>")`. As of this version that is an
internal implementation detail — clients MUST NOT construct upload URLs
from it.

### 4.3 `Location` header validation

The TUS spec permits the `POST /upload` response's `Location` header to be
absolute or relative, and takes no position on where it may point. A client
MUST resolve `Location` against the request's own origin and MUST reject
(rather than follow) a result whose origin differs from the server it is
already talking to. Without this check, a malicious or compromised server
could return an absolute `Location` on a different host and receive every
subsequent `HEAD`/`PATCH`/`DELETE` request for that upload — each carrying
the bearer token per §5.1 — redirecting the credential to that host instead.
This is the "token redirect" threat named in
[RFC 6750 §10.4](https://datatracker.ietf.org/doc/html/rfc6750#section-10.4)
(a bearer token accepted by, or in this case sent to, a party other than the
one it was issued for) and matches the same-origin validation
[OWASP recommends](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)
for any server-supplied redirect target before resending credentials.

### 4.4 Consistent request routing (server-side)

A server implementation MUST resolve which artifact a `PATCH`/`HEAD`/`DELETE`
request under `{prefix}/upload/<id>` applies to the same way for every
purpose within that request — the identifier an authorization check is run
against MUST be the exact identifier the request is actually applied to. A
server MUST NOT use one code path (e.g. a hand-rolled URL parser feeding an
`authorize` hook) to decide "which artifact is this for" and a different code
path (e.g. an underlying TUS library's own request routing) to decide "which
artifact do I actually read or write" — any divergence between the two lets a
party authorized for one artifact write to, or probe, a different artifact
they are not authorized for, by exploiting a URL shape the two parsers
disagree on (e.g. extra path segments after the real id, which many routers
accept on a wildcard route). Where a server is layered over an existing TUS
implementation, resolve the identifier for authorization by calling that
library's own identifier-resolution logic directly (or an exact copy of it)
rather than an independent reimplementation — two parsers that happen to
agree on well-formed requests can still silently disagree on adversarial
ones.

## 5. Authentication

### 5.1 Token transport

A client MUST send the pairing token as `Authorization: Bearer <token>` on
every `POST`/`PATCH`/`HEAD`/`DELETE` request to `{prefix}/upload*`, and SHOULD also
send it as `?token=` on `GET` requests to a watch/playback URL (some servers
validate playback links without requiring a header, e.g. for browser
playback). See §4.3 for why the resource URL these requests target must
itself be validated before the token is attached to a request against it.

### 5.2 Server-side verification

A server MAY implement authentication however it chooses — this document
does not mandate a scheme. A server MUST reject requests it cannot authorize
with `403` (or `401` if no credential was presented at all), and SHOULD do
so before any bytes are accepted for a new upload. This applies uniformly to
every phase of an upload's lifecycle — creation, each `PATCH` chunk, `HEAD`
offset queries, and `DELETE` (both the in-flight-cancel route and the
finalized-artifact route) — not only to the initial `POST`. A server
implementation MUST NOT skip authorization for `PATCH`/`HEAD` merely because
an internal helper failed to recover the artifactId from the resource URL;
that failure MUST be treated as an authorization failure (reject), not as
"no artifactId to check, so allow." See §4.4 for the related requirement
that the artifactId resolved for this check must be the one the request is
actually applied to.

### 5.3 Rejection responses

Error responses MUST be JSON of the shape `{ "ok": false, "error": string }`.

### 5.4 Recommended capability-token shape (non-normative)

Servers that don't already have an auth scheme are encouraged (not required)
to use a stateless, HMAC-signed token with at least:

```json
{ "artifactId": "<uuid>", "iat": 1234567890, "exp": 1234569690, "kid": "2026-06", "issuer": "https://vault.example.org" }
```

`kid` lets a secret rotate with an overlap window instead of instantly
invalidating every outstanding token. `iat` (signed alongside `exp`) closes a
clock-skew gap where signing only expiry would let a slow clock accept an
expired token. `issuer` prevents a token minted by one deployment from being
replayed against a different one that happens to share a secret. A token MAY
authorize an artifact other than the one it names if that artifact declares
the token's `artifactId` as its `relatedTo` (§8) — this lets one token cover
an entire upload session (the pulse video plus its captions, beat manifest
and thumbnail) rather than requiring one token per artifact.

This shape is exactly what `@mieweb/pulsevault`'s `issueCapabilityToken`/
`verifyCapabilityToken`/`createCapabilityAuthorize` implement, but any server
is free to use its own scheme entirely — only §5.1–§5.3 are normative.

## 6. Storage and validation

### 6.1 Readiness

A server MUST NOT serve (via `GET`) an artifact's bytes until the upload is
fully written and any payload validation has passed. An in-progress or
rejected upload MUST return `404` from the serving route, not partial or
corrupt bytes.

### 6.2 Serving

A server MUST expose `GET {prefix}/artifacts/<artifactId>` returning either
the bytes directly or a redirect to a URL serving them (e.g. a presigned
object-storage URL). The kind is resolved server-side; it is not encoded in
this URL. A server MUST also expose `DELETE {prefix}/artifacts/<artifactId>`,
which removes the bytes and tombstones the id (§4.2.1): `204` on the first
delete, `404` when the id is unknown or already deleted. A deleted id is
never reusable.

### 6.3 Checksum (optional)

If a server supports checksum verification (advertised via `/capabilities`),
it SHOULD verify the client-supplied `checksum` metadata against the
finished file before marking the upload ready, and MUST reject a mismatch
with `422` and remove the rejected bytes. This is at-rest integrity
verification on the finished artifact — it does not substitute for
in-transit (TLS) integrity, and does not verify individual chunks as they
arrive.

## 7. Versioning

A server MUST report `protocolVersion`, `minSupportedVersion`, and
`maxSupportedVersion` via `/capabilities` (§2) and `Protocol-Version` on
every response. A client encountering a server whose supported range
excludes its own version MUST NOT attempt to pair, and SHOULD surface a
clear, specific message rather than a generic failure.

## 8. Artifact relationships (`relatedTo`) and the upload set

A **pulse** (a short composed of one or more recorded **segments**) is
uploaded as one video plus its related artifacts. Earlier protocol revisions
defined a second, per-segment upload strategy selected via an `uploadUnit`
field; it is **retired** — beat timing rides in the beat manifest below, so
per-segment uploads carried no information the merged set doesn't.

> **Terminology:** a **segment** is a recorded clip (the source unit). A
> **beat** is a *timecode range on the pulse's timeline* — one recorded
> segment's start/end within the video — carried in the beat manifest.

A client uploads one video as the session anchor, plus (all as related
artifacts):

- **captions** (`kind: "captions"`, `<draftId>.vtt`) — WebVTT for the whole
  merged video, OPTIONAL (absent when the video has no speech or no on-device
  model was available); MAY carry word-level inline cue timestamps like
  `<00:00:01.500>word` for karaoke rendering;
- a **beat manifest** (`kind: "project"`, e.g. `<draftId>-beats.pulse`) giving
  each recorded segment's precise `startMs`/`endMs` on the pulse's timeline,
  contiguous and summing to the true `durationMs` (groundwork for
  keyframe-aligned deep links / HLS);
- a **thumbnail** (`kind: "thumbnail"`, `<draftId>.jpg`) — the pulse's poster
  frame.

```json
{ "version": 1, "type": "beat-manifest", "durationMs": 47320,
  "beats": [ { "segmentId": "<local id>", "order": 0, "startMs": 0, "endMs": 4210 } ] }
```

Every non-anchor artifact in the session SHOULD declare `relatedTo` pointing
at the session's anchor `artifactId` (the one named in the pairing link) so a
single capability token can authorize the whole session (§5.4).

The relational graph of replies between segments/pulses (who replied to what,
rendering a thread) is explicitly **out of scope** for this document. That
graph is a query/relational concern for the operator's own systems, built
from `relatedTo` and whatever additional metadata the operator chooses to
record — not something a Pulse-compatible server is required to implement.

## 9. Direct upload profile (presigned data plane)

An OPTIONAL ingestion profile for deployments where upload bytes should go
straight to object storage (S3/R2) instead of through the application server
— serverless/edge control planes, or operators avoiding double bandwidth.
Advertised via the `directUpload` capability field (§2); a client MUST NOT
attempt these endpoints against a server that doesn't advertise it.

Trade-off vs TUS, stated plainly: a direct upload is a single HTTP `PUT` —
retryable from zero but **not resumable mid-file**. TUS remains the default
and the right choice for large files on flaky mobile networks; this profile
is an operator opt-in. Servers supporting this profile MUST still support
TUS (§4).

### 9.1 Create

`POST {prefix}/direct-uploads` with a JSON body carrying the same fields as
the TUS `Upload-Metadata` (§4.1) plus a mandatory exact byte count:

```json
{
  "artifactId": "<uuid>",
  "filename": "clip.mp4",
  "kind": "video",
  "relatedTo": "<uuid, optional>",
  "checksum": "<algorithm>:<hex, optional>",
  "name": "<display title, optional>",
  "size": 12345678
}
```

Authentication and authorization are identical to a TUS create (§5): the
same bearer token, checked against the same `artifactId`/`relatedTo` scope.
The reservation shares the artifactId space and collision rules with TUS
(§4.2.1) — a 409 means the id already has an upload, and the same
single-use rule applies: the client obtains a fresh artifactId rather than
contesting the existing one.

Success is `201`:

```json
{
  "ok": true,
  "artifactId": "<uuid>",
  "uploadUrl": "https://… presigned PUT URL …",
  "expiresAt": "2026-09-16T12:00:00.000Z",
  "headers": { "Content-Type": "video/mp4", "Content-Length": "12345678" }
}
```

The client MUST `PUT` the exact bytes to `uploadUrl` before `expiresAt`,
sending the returned `headers` verbatim (the server SHOULD sign them into
the grant so the URL can only upload the declared payload shape). The
`uploadUrl` is a bearer credential — the client MUST NOT log it or send it
anywhere but the storage host it names.

Errors: `400` invalid body, `401`/`403` per §5, `409` id already in use,
`413` `size` over `maxUploadSize`, `501` profile not supported.

**Re-grant.** A repeated create for an artifactId whose reservation exists
but is not yet complete, with the same declared shape (`kind`, extension,
`size`), MUST return a fresh grant with status `200` rather than `409` —
this is how a client that lost its grant (killed mid-session) or outlived
its `expiresAt` retries without a dead end. A create for a **ready**
artifact, or with a different declared shape, remains `409`. The re-grant
decision MUST be made against current storage state, not a per-instance
cache — another instance may have just completed the artifact.

**Stale grants.** A presigned URL cannot be revoked by deleting its
reservation — it stays valid until `expiresAt`. Because a deleted id is
tombstoned (§4.2.1), a grant that outlives its reservation can only write
bytes nothing will ever reserve again or serve (a `complete` for that id is
`404`); operators expire such orphans with storage lifecycle rules. Within
a single reservation the holder of an unexpired grant can by construction
still overwrite its own object until `expiresAt` — including briefly after
`complete` — so operators requiring strictly immutable-after-ready bytes
SHOULD use short grant TTLs or the TUS profile.

### 9.2 Complete

After the `PUT` succeeds, the client MUST confirm:

`POST {prefix}/direct-uploads/{artifactId}/complete` (no body; same bearer
token — authorized like a TUS `PATCH`).

The server MUST verify the stored object exists and matches the declared
`size`, MUST run the same post-upload validation it applies to TUS uploads
(§6), and only then mark the artifact ready. Responses:

- `200 { "ok": true }` — artifact is ready. Completing an already-ready
  artifact MUST return `200` again without re-running hooks (idempotent, so
  a client can retry a complete whose response it lost). Servers SHOULD
  serialize concurrent completes for one artifactId; across multiple server
  instances sharing object storage that cannot be guaranteed, so consumer
  hooks (`onUploadComplete` and equivalents) MUST tolerate at-least-once
  delivery. If a consumer hook fails AFTER the artifact was marked ready,
  the server returns `5xx` but a retried complete takes the idempotent
  `200` path without re-running the hook — a consumer that must never lose
  its side effect should make the hook atomic (`storage.remove` + throw on
  failure, after which the client creates anew under a fresh artifactId) or
  reconcile from artifact listings.
- `409` — no stored object yet (the `PUT` didn't happen or didn't finish).
  The client retries the `PUT`, then completes again.
- `422` — the stored object failed verification (size mismatch or §6
  validation). The server MUST delete the stored bytes, exactly like a
  failed TUS validation; the artifactId is spent, and the client creates
  anew under a fresh one.

An artifact for which `complete` never arrives MUST NOT be served (§6.1);
operators SHOULD age out such reservations via retention (§4.2.1) and expire
the underlying stored object via storage lifecycle rules.

## 10. Compatibility notes

A client or server MAY support additional, non-normative extensions to this
contract (additional `Upload-Metadata` keys, additional kinds, additional
`/capabilities` fields) as long as doing so does not break a client/server
that only implements what's written here. New REQUIRED fields MUST NOT be
added to a response without a `protocolVersion` bump.
