#!/usr/bin/env node
// Scripted end-to-end smoke test: boots the fastify-auth-demo reference server, then
// drives a real TUS upload against it with a plain Node script — no mobile
// app or simulator required. Catches contract drift between this package and
// its own demo automatically, in CI, rather than only by a human noticing on
// a simulator. Run with `npm run e2e` (see package.json).
//
// Exits non-zero (and prints what failed) on any assertion failure.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(__dirname, "..", "examples", "fastify-auth-demo");

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = `${BASE}/pulsevault`;
const PULSEVAULT_SECRET = "e2e-smoke-test-secret";

/** Extracts the `token` query param from a `pulsecam://` deep link, the same way a real client parses it. */
function tokenFromDeepLink(deepLink) {
  return new URL(deepLink.replace("pulsecam://", "http://x/")).searchParams.get("token");
}

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);
function makeMp4(size) {
  const body = Buffer.alloc(size);
  MP4_HEADER.copy(body, 0);
  return body;
}

async function waitForReady(child, timeoutMs = 15_000) {
  let buffer = "";
  const onData = (chunk) => {
    buffer += chunk.toString();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const deadline = Date.now() + timeoutMs;
  while (!buffer.includes("PulseVault auth demo running")) {
    if (Date.now() > deadline) {
      throw new Error(`Server did not start within ${timeoutMs}ms. Output so far:\n${buffer}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.stdout.off("data", onData);
  child.stderr.off("data", onData);
}

async function main() {
  // The auth demo is Postgres-only (Prisma). Bring up its compose db service
  // (a no-op if it's already running — Docker is required for this e2e) and
  // apply the schema, exactly as `npm start` would.
  const DATABASE_URL =
    process.env.DATABASE_URL || "postgres://pulsevault:pulsevault@127.0.0.1:5433/pulsevault";
  if (!process.env.DATABASE_URL) {
    console.log("Starting compose Postgres (docker compose up -d db --wait)...");
    const dbUp = spawnSync("docker", ["compose", "up", "-d", "db", "--wait"], {
      cwd: demoDir,
      env: { ...process.env, PULSEVAULT_SECRET },
      stdio: "inherit",
    });
    assert.equal(dbUp.status, 0, "docker compose up -d db should succeed (Docker is required for e2e)");
  }
  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: demoDir,
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });
  assert.equal(migrate.status, 0, "prisma migrate deploy should succeed");

  // 0. The auth demo's fail-fast contract: booting without PULSEVAULT_SECRET
  // must exit non-zero instead of falling back to an open server.
  {
    const env = { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", PULSEVAULT_ISSUER: BASE, DATABASE_URL };
    delete env.PULSEVAULT_SECRET;
    const noSecret = spawn(process.execPath, ["server.mjs"], { cwd: demoDir, env, stdio: "ignore" });
    const [code] = await once(noSecret, "exit");
    assert.notEqual(code, 0, "booting without PULSEVAULT_SECRET should exit non-zero");
    console.log("  ✓ refuses to boot without PULSEVAULT_SECRET");
  }

  console.log("Starting fastify-auth-demo server...");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: demoDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PULSEVAULT_SECRET,
      PULSEVAULT_ISSUER: BASE,
      DATABASE_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exitedEarly = false;
  child.once("exit", (code) => {
    if (!main.done) {
      exitedEarly = true;
      console.error(`fastify-auth-demo server exited early with code ${code}`);
    }
  });

  try {
    await waitForReady(child);
    console.log("Server ready. Running checks...");

    // 1. Capabilities discovery — unauthenticated, reports protocol version range.
    const capsRes = await fetch(`${PREFIX}/capabilities`);
    assert.equal(capsRes.status, 200, "GET /capabilities should be 200");
    const caps = await capsRes.json();
    assert.equal(typeof caps.protocolVersion, "number");
    assert.ok(caps.minSupportedVersion <= caps.protocolVersion);
    assert.ok(caps.protocolVersion <= caps.maxSupportedVersion);
    assert.ok(["beat", "merged"].includes(caps.uploadUnit));
    console.log(`  ✓ /capabilities reports protocolVersion=${caps.protocolVersion}, uploadUnit=${caps.uploadUnit}`);

    // 2a. Dashboard routes are Better Auth-protected: no session -> 401.
    const unauthed = await fetch(`${BASE}/deeplinks`);
    assert.equal(unauthed.status, 401, "GET /deeplinks without a session should be 401");

    // 2b. Create a dashboard account (sign-up signs you in and sets a session
    // cookie). The auth DB persists across runs, so fall back to sign-in.
    // Node's fetch sends `Origin: null` on POSTs, which Better Auth's CSRF
    // check rightly rejects — send the real origin like a browser would.
    const authHeaders = { "content-type": "application/json", origin: BASE };
    const credentials = { email: "e2e@example.test", password: "e2e-password-123", name: "E2E" };
    let authRes = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(credentials),
    });
    if (!authRes.ok) {
      authRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ email: credentials.email, password: credentials.password }),
      });
    }
    assert.ok(authRes.ok, `dashboard sign-up/sign-in should succeed, got ${authRes.status}`);
    const cookie = authRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    assert.ok(cookie.length > 0, "sign-in should set a session cookie");
    console.log("  ✓ dashboard: /deeplinks without a session -> 401; Better Auth sign-in issues one");

    // 2c. Pairing — mints an artifactId + a real HMAC-signed capability token
    // (issueCapabilityToken), carried in the deep link exactly as a real
    // client would receive it. Requires the dashboard session from 2b.
    const linkRes = await fetch(`${BASE}/deeplinks`, { headers: { cookie } });
    assert.equal(linkRes.status, 200, "GET /deeplinks should be 200");
    const { artifactId, upload: deepLink, authMode } = await linkRes.json();
    assert.ok(artifactId, "deeplinks response should include an artifactId");
    assert.ok(deepLink.startsWith("pulsecam://"), "deep link should use the pulsecam scheme");
    assert.equal(authMode, true, "PULSEVAULT_SECRET is set, so authMode should be true");
    const token = tokenFromDeepLink(deepLink);
    assert.ok(token, "deep link should carry a capability token when PULSEVAULT_SECRET is set");
    console.log(`  ✓ /deeplinks minted artifactId=${artifactId} with a signed capability token`);

    // 3. Full chunked TUS upload, authorized with the real capability token.
    const body = makeMp4(2 * 1024 * 1024);
    const digest = createHash("sha256").update(body).digest("hex");
    const metadata = [
      `artifactId ${b64(artifactId)}`,
      `filename ${b64("clip.mp4")}`,
      `checksum ${b64(`sha256:${digest}`)}`,
    ].join(",");

    const create = await fetch(`${PREFIX}/upload`, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(body.length),
        "Upload-Metadata": metadata,
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(create.status, 201, `create should be 201, got ${create.status}`);
    const location = create.headers.get("location");
    assert.ok(location, "create response should include a Location header");
    console.log("  ✓ TUS create succeeded");

    const half = body.length / 2;
    const patch1 = await fetch(location, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
        Authorization: `Bearer ${token}`,
      },
      body: body.subarray(0, half),
    });
    assert.equal(patch1.status, 204, `first PATCH should be 204, got ${patch1.status}`);

    // Resume via HEAD before the second chunk — never trust a cached offset.
    const head = await fetch(location, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", Authorization: `Bearer ${token}` },
    });
    assert.equal(Number(head.headers.get("upload-offset")), half, "HEAD should report the offset after chunk 1");

    const patch2 = await fetch(location, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(half),
        "Content-Type": "application/offset+octet-stream",
        Authorization: `Bearer ${token}`,
      },
      body: body.subarray(half),
    });
    assert.equal(patch2.status, 204, `second PATCH should be 204, got ${patch2.status}`);
    console.log("  ✓ chunked PATCH + HEAD-based resume succeeded, checksum accepted");

    // 4. Verify the artifact is actually retrievable and byte-identical. The
    // demo's authorize hook reads the resolve-phase token from `?token=`
    // (forwarded from the watch URL), not the Authorization header — that's
    // the documented contract for the "resolve" phase specifically.
    const get = await fetch(`${PREFIX}/artifacts/${artifactId}?token=${token}`);
    assert.equal(get.status, 200, `GET /artifacts/:id should be 200, got ${get.status}`);
    const got = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(got, body), 0, "downloaded bytes should match what was uploaded");
    console.log("  ✓ GET /artifacts/:artifactId serves the exact uploaded bytes");

    // 5. No credential at all -> 401; a well-formed but wrong/unrelated token -> 403.
    // createCapabilityAuthorize distinguishes these (PROTOCOL.md §5.2) — neither is
    // silently accepted.
    const noToken = await fetch(`${PREFIX}/artifacts/${artifactId}`);
    assert.equal(noToken.status, 401, "GET with no token should be 401");
    const other = await fetch(`${BASE}/deeplinks`, { headers: { cookie } }).then((r) => r.json());
    const otherToken = tokenFromDeepLink(other.upload);
    const wrongToken = await fetch(`${PREFIX}/artifacts/${artifactId}?token=${otherToken}`);
    assert.equal(wrongToken.status, 403, "GET with a token for a different artifact should be 403");
    console.log("  ✓ no token -> 401, wrong-artifact token -> 403");

    console.log("\nAll e2e checks passed.");
  } finally {
    main.done = true;
    if (!exitedEarly) child.kill();
    await once(child, "exit").catch(() => {});
  }
}

main().catch((err) => {
  console.error("\ne2e smoke test FAILED:", err);
  process.exitCode = 1;
});
