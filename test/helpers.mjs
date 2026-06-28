// Shared TUS protocol helpers for the test suites. Backend-agnostic: every
// helper takes an explicit `baseUrl` + `prefix` so the same code drives the
// local-filesystem tests and the S3/R2 tests.

import assert from "node:assert/strict";

export function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

// Minimal ISOBMFF header: "ftyp" box with brand "isom". Enough bytes for the
// MP4 sniffers to accept and for realistic-looking upload sizes.
export const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // box size + "ftyp"
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // brand "isom" + version
]);

export function makeMp4(size) {
  if (size < MP4_HEADER.length) {
    throw new Error(`makeMp4: size ${size} < header ${MP4_HEADER.length}`);
  }
  const body = Buffer.alloc(size);
  MP4_HEADER.copy(body, 0);
  for (let i = MP4_HEADER.length; i < body.length; i++) {
    body[i] = i & 0xff;
  }
  return body;
}

export async function tusCreate(baseUrl, prefix, { videoid, filename, size, kind }) {
  const parts = [`videoid ${b64(videoid)}`, `filename ${b64(filename)}`];
  if (kind) parts.push(`kind ${b64(kind)}`);
  return fetch(`${baseUrl}${prefix}/upload`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": parts.join(","),
    },
  });
}

export async function tusPatch(url, offset, body) {
  return fetch(url, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(offset),
      "Content-Type": "application/offset+octet-stream",
    },
    body,
  });
}

export async function tusHead(url) {
  return fetch(url, {
    method: "HEAD",
    headers: { "Tus-Resumable": "1.0.0" },
  });
}

// Create + single-PATCH a complete upload. Defaults to an MP4 video; pass
// `body`/`filename`/`kind` to upload something else (e.g. a .pulse project).
export async function uploadFull(
  baseUrl,
  prefix,
  { videoid, filename = "clip.mp4", size = 1024, kind, body } = {},
) {
  const payload = body ?? makeMp4(size);
  const create = await tusCreate(baseUrl, prefix, {
    videoid,
    filename,
    size: payload.length,
    kind,
  });
  assert.equal(create.status, 201, "create");
  const location = create.headers.get("location");
  assert.ok(location, "location header");
  const patch = await tusPatch(location, 0, payload);
  assert.equal(patch.status, 204, "patch");
  return { body: payload, location };
}
