# Pulse Upload Protocol

<!-- BEGIN GENERATED: protocol-version (from package.json pulseProtocol — edit that, then run `npm run protocol`) -->
| | |
|---|---|
| Spec revision | `2.1` |
| Protocol majors accepted | 2 |
<!-- END GENERATED: protocol-version -->

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
Its JSON body is defined by
[`protocol/schemas/capabilities.schema.json`](protocol/schemas/capabilities.schema.json):

<!-- BEGIN GENERATED: capabilities (from protocol/schemas/capabilities.schema.json — edit that, then run `npm run protocol`) -->
| Field | Type | Required | Description |
|---|---|---|---|
| `protocolVersion` | integer | Yes | Protocol major this server implements. Also sent as the `Protocol-Version` header on every response. |
| `protocolRevision` | string | Yes | Spec revision this server implements, `major.minor`. The minor counts additions older clients can ignore. |
| `minSupportedVersion` | integer | Yes | Oldest protocol major this server accepts. Clients whose newest protocol is older get 426 Upgrade Required. |
| `maxSupportedVersion` | integer | Yes | Newest protocol major this server accepts. |
| `kinds` | string[] | Yes | Artifact kinds this server accepts. |
| `allowedExtensions` | object | Yes | Allowed file extensions per kind, lowercase with the leading dot. |
| `maxUploadSize` | number | Yes | Largest artifact the server accepts, in bytes. |
| `checksum` | object | Yes | Checksum algorithms accepted in `Upload-Metadata.checksum`. |
<!-- END GENERATED: capabilities -->

A client pairs only if its protocol range overlaps
`[minSupportedVersion, maxSupportedVersion]` (§7). If it doesn't, the client
MUST NOT pair, and SHOULD show an actionable message ("update the app" /
"this server needs an update") rather than a generic error. A client MUST
ignore fields it doesn't recognize.

`checksum.algorithms` describes capability, not whether verification is
actually wired in for every upload — a server MAY list an algorithm it's
capable of checking even where the operator hasn't enabled that check. A
client MUST treat an absent or empty list as "no checksum verification".

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

A client SHOULD ignore query params it does not recognize, so links minted by
an older or newer server stay valid. The parameters are defined by
[`protocol/schemas/deep-link.schema.json`](protocol/schemas/deep-link.schema.json).

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
| `DELETE` | `{prefix}/upload/<id>` | Delete the upload and its artifact, in flight or finished |

`PATCH` bodies MUST be the raw bytes for that offset
(`Content-Type: application/offset+octet-stream`) — never base64-encoded or
wrapped in another envelope.

### 4.1 `Upload-Metadata`

The TUS `Upload-Metadata` header (comma-separated `<key> <base64(value)>`
pairs) MUST be parsed for at least:

<!-- BEGIN GENERATED: upload-metadata (from protocol/schemas/upload-metadata.schema.json — edit that, then run `npm run protocol`) -->
| Key | Type | Required | Description |
|---|---|---|---|
| `artifactId` | string (uuid) | Yes | The artifact's id. For the video it's the pairing link's `artifactId`; related artifacts use a fresh UUID. Legacy aliases `videoid` and `projectid` are still accepted. |
| `filename` | string | Yes | Original file name. Its extension must be allowed for `kind` (see `/capabilities`). |
| `kind` | `video`, `project`, `captions`, `thumbnail` | No | Artifact kind. Defaults to `video`. |
| `relatedTo` | string (uuid) | No | The artifact this one belongs to: the video, for its captions, beat manifest and thumbnail. A capability token for the video also authorizes artifacts related to it. |
| `checksum` | string | No | `<algorithm>:<hex digest>` of the finished file, verified by servers that check checksums. |
| `name` | string | No | Display title (the draft name), sent on the video. Display-only; servers trim and cap it. |
| `appVersion` | string | No | Since 2.1. Version of the app that uploaded it, e.g. `2.1.0 (45)`. Stored with the artifact. Display-only; servers trim and cap it. |
<!-- END GENERATED: upload-metadata -->

`name` and `appVersion` are display metadata only: they MUST NOT influence
storage paths, routing, or authorization, and consumers MUST escape them for
their output context.

Metadata values are base64 per the TUS spec; a free-form value such as `name`
MUST be base64 of its **UTF-8** bytes. A client that base64-encodes a raw
Latin-1 string (e.g. a browser `btoa()`) corrupts any non-ASCII title (accents,
emoji), so encode the UTF-8 bytes explicitly.

A client MUST always send `artifactId` (not only the legacy aliases) on new
uploads. A server MUST continue accepting `videoid`/`projectid` as aliases
for `artifactId` for back-compat with clients built before `artifactId`
was the only spelling — this alias requirement holds until a protocol major
removes it (§7).

### 4.2 Resumption

A client MUST always issue a `HEAD` request to learn the authoritative
offset before resuming an interrupted upload — it MUST NOT trust a locally
cached byte count, which can be stale (server restart, a partial write that
never committed, clock differences between client and a previous session).

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
an entire upload session (a pulse's video plus its captions, beat manifest and
thumbnail) rather than requiring one token per artifact.

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
this URL. A server MUST also expose `DELETE {prefix}/artifacts/<artifactId>`.

### 6.3 Checksum (optional)

If a server supports checksum verification (advertised via `/capabilities`),
it SHOULD verify the client-supplied `checksum` metadata against the
finished file before marking the upload ready, and MUST reject a mismatch
with `422` and remove the rejected bytes. This is at-rest integrity
verification on the finished artifact — it does not substitute for
in-transit (TLS) integrity, and does not verify individual chunks as they
arrive.

## 7. Versioning

The protocol has a version `major.minor`, written once in `@mieweb/pulsevault`'s
`package.json` (`pulseProtocol`) — the reference implementation reads it from
there, and npm keeps it for every published release.

- The **major** changes only for breaking changes. It's `protocolVersion` in
  `/capabilities` and the `Protocol-Version` header, and it's what pairing
  compares.
- The **minor** counts additions an older client or server can safely ignore
  (a new optional field, key or header). It's `protocolRevision`.

A server MUST report `protocolVersion`, `protocolRevision`,
`minSupportedVersion` and `maxSupportedVersion` via `/capabilities` (§2), and
`Protocol-Version` on every response. A client supports a range of majors;
it pairs only if that range overlaps the server's, and speaks the highest
major both support. If they don't overlap, it MUST NOT pair, and SHOULD
surface a clear, specific message rather than a generic failure.

### 7.1 Changing the protocol

Every fact about the protocol lives in `protocol/`: the JSON Schemas in
`protocol/schemas/`, and `protocol/openapi.json`, generated from the plugin's
route schemas. The field tables in this document are generated from the same
files (`npm run protocol`). CI enforces the rules:

- Anything under `protocol/` changes → `pulseProtocol.version` MUST change.
- A **breaking** change — removing a field, key or parameter; making one
  required; removing an allowed value; changing a type — MUST bump the major.
  Anything else bumps the minor.
- Every version MUST have a row in the history below saying what changed.

### 7.2 `Pulse-Client` (since 2.1)

A client SHOULD send `Pulse-Client` on every request, saying what it is and
which protocol majors it speaks:

```
Pulse-Client: Pulse/2.1.0 (45; ios); protocol=1-2
```

On uploads and artifact requests, a server MUST answer
`426 Upgrade Required` when the client's newest major is older than the
server's `minSupportedVersion`, with a JSON body carrying `error`,
`minSupportedVersion` and `maxSupportedVersion`. `/capabilities` MUST always
answer, so the client can learn why. A request without the header is handled
as before this header existed. A client that gets `426` SHOULD tell the user
to update the app. See
[`protocol/schemas/pulse-client.schema.json`](protocol/schemas/pulse-client.schema.json).

A client SHOULD also check `/capabilities` again before starting an upload to
a server it paired with earlier: a server can be upgraded in between.

### 7.3 Where it's defined

<!-- BEGIN GENERATED: schemas (from protocol/schemas/ — edit that, then run `npm run protocol`) -->
| File | Defines |
|---|---|
| [`openapi.json`](protocol/openapi.json) | Every HTTP route, generated from the plugin |
| [`beat-manifest.schema.json`](protocol/schemas/beat-manifest.schema.json) | Beat manifest |
| [`capabilities.schema.json`](protocol/schemas/capabilities.schema.json) | GET /capabilities response |
| [`capability-token.schema.json`](protocol/schemas/capability-token.schema.json) | Capability token claims |
| [`deep-link.schema.json`](protocol/schemas/deep-link.schema.json) | Pairing link query parameters |
| [`pulse-client.schema.json`](protocol/schemas/pulse-client.schema.json) | Pulse-Client request header |
| [`upload-metadata.schema.json`](protocol/schemas/upload-metadata.schema.json) | TUS Upload-Metadata keys |
<!-- END GENERATED: schemas -->

### 7.4 History

| Version | Change |
|---|---|
| 1.0 | First version. `/capabilities` and pairing links carried `uploadUnit` (`segment` or `merged`). |
| 2.0 | **Breaking:** `uploadUnit` removed from `/capabilities` and pairing links — a pulse always uploads as one video (§8). Clients built for 1.0 required it. |
| 2.1 | Added `protocolRevision` to `/capabilities`, the `Pulse-Client` header with `426 Upgrade Required` (§7.2), and `Upload-Metadata.appVersion` (§4.1). |

## 8. Artifact relationships (`relatedTo`)

A pulse (a short composed of one or more recorded clips) uploads as **one
video** — the session anchor, named by the pairing link's `artifactId` (§3) —
plus these related artifacts:

- **captions** (`kind: "captions"`, `<draftId>.vtt`) — WebVTT for the whole
  video, OPTIONAL (absent when the video has no speech or no on-device model
  was available); MAY carry word-level inline cue timestamps like
  `<00:00:01.500>word` for karaoke rendering;
- a **beat manifest** (`kind: "project"`, e.g. `<draftId>-beats.pulse`)
  listing the pulse's beats (below);
- a **thumbnail** (`kind: "thumbnail"`, `<draftId>.jpg`) — the pulse's poster
  frame.

A **beat** is a timestamp range inside the video: where one recorded clip
starts and ends (`startMs`/`endMs`). A pulse's beats are contiguous and sum to
the video's `durationMs`. The beat manifest is groundwork for keyframe-aligned
deep links / HLS; it does not change how the video is uploaded.

```json
{ "version": 1, "type": "beat-manifest", "durationMs": 47320,
  "beats": [ { "segmentId": "<local id>", "order": 0, "startMs": 0, "endMs": 4210 } ] }
```

Every non-anchor artifact SHOULD declare `relatedTo` pointing at the anchor
`artifactId` so a single capability token can authorize the whole session
(§5.4).

The relational graph of replies between pulses (who replied to what,
rendering a thread) is explicitly **out of scope** for this document. That
graph is a query/relational concern for the operator's own systems, built
from `relatedTo` and whatever additional metadata the operator chooses to
record — not something a Pulse-compatible server is required to implement.

## 9. Compatibility notes

A client or server MAY support additional, non-normative extensions to this
contract (additional `Upload-Metadata` keys, additional kinds, additional
`/capabilities` fields) as long as doing so does not break a client/server
that only implements what's written here. Changes to the protocol itself
follow §7.1.
