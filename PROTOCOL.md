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
  "uploadUnit": "beat",
  "kinds": ["video", "project", "captions"],
  "allowedExtensions": { "video": [".mp4"], "project": [".pulse", ".zip"], "captions": [".srt"] },
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
- `uploadUnit` (`"beat"` or `"merged"`, REQUIRED): which upload strategy this
  deployment expects (§8). The client MUST read this before doing any
  merge/upload work and branch accordingly.
- `kinds` (array of string, REQUIRED): artifact kinds this server accepts.
- `allowedExtensions` (object, REQUIRED): allowed file extensions per kind.
- `maxUploadSize` (integer, REQUIRED): maximum artifact size in bytes.
- `checksum.algorithms` (array of string, OPTIONAL): digest algorithms this
  server can verify (§6.3). Absent or empty means the server does not
  support checksum verification. Note for implementers: this field
  describes capability, not whether verification is actually wired in for
  every upload — a server MAY list an algorithm it's capable of checking
  even for a deployment where the operator hasn't enabled that check.

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
| `kind` | No, defaults to `video` | `video`, `project`, or `captions`. |
| `relatedTo` | No | UUID of another artifact this one belongs to (§8). |
| `checksum` | No | `<algorithm>:<hex digest>` of the finished file (§6.3). |

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

## 5. Authentication

### 5.1 Token transport

A client MUST send the pairing token as `Authorization: Bearer <token>` on
every `POST`/`PATCH`/`DELETE` request to `{prefix}/upload*`, and SHOULD also
send it as `?token=` on `GET` requests to a watch/playback URL (some servers
validate playback links without requiring a header, e.g. for browser
playback).

### 5.2 Server-side verification

A server MAY implement authentication however it chooses — this document
does not mandate a scheme. A server MUST reject requests it cannot authorize
with `403` (or `401` if no credential was presented at all), and SHOULD do
so before any bytes are accepted for a new upload.

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
an entire upload session (a video, its captions, and every beat + manifest
under `uploadUnit: "beat"`) rather than requiring one token per artifact.

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

A server MUST report `protocolVersion`, `minSupportedVersion`, and
`maxSupportedVersion` via `/capabilities` (§2) and `Protocol-Version` on
every response. A client encountering a server whose supported range
excludes its own version MUST NOT attempt to pair, and SHOULD surface a
clear, specific message rather than a generic failure.

## 8. Artifact relationships (`relatedTo`) and `uploadUnit`

A pulse (a short composed of one or more beats) MAY be uploaded as a single
pre-merged video (`uploadUnit: "merged"`) or as individual per-beat artifacts
plus a manifest (`uploadUnit: "beat"`) — the operator declares which via
`/capabilities` (§2); this document does not prefer one over the other.

Under `uploadUnit: "beat"`, a client uploads each beat under its own
`artifactId`, plus one manifest artifact (`kind: "project"`, a JSON document
listing the ordered beat `artifactId`s) and, optionally, per-beat captions
(`kind: "captions"`). Every non-primary artifact in the session SHOULD
declare `relatedTo` pointing at the session's anchor `artifactId` (the one
named in the pairing link) so a single capability token can authorize the
whole session (§5.4).

The relational graph of replies between beats/pulses (who replied to what,
rendering a thread) is explicitly **out of scope** for this document. That
graph is a query/relational concern for the operator's own systems, built
from `relatedTo` and whatever additional metadata the operator chooses to
record — not something a Pulse-compatible server is required to implement.

## 9. Compatibility notes

A client or server MAY support additional, non-normative extensions to this
contract (additional `Upload-Metadata` keys, additional kinds, additional
`/capabilities` fields) as long as doing so does not break a client/server
that only implements what's written here. New REQUIRED fields MUST NOT be
added to a response without a `protocolVersion` bump.
