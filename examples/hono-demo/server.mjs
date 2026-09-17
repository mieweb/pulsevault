// Minimal Hono demo for @mieweb/pulsevault — the web-standard handler makes
// the mount a single wildcard route. This file runs on Node via
// @hono/node-server, but the `app.all(...)` line is runtime-portable: the
// identical Hono app serves on Bun (`Bun.serve({ fetch: app.fetch })`) and
// Deno (`Deno.serve(app.fetch)`) unchanged, because the vault handler speaks
// WHATWG Request/Response — no Node req/res anywhere.
//
// No auth, local storage — the smallest runnable pairing target for the Pulse
// app. See ../fastify-auth-demo for the production-shaped setup (capability
// tokens, DB index), which applies to this mount style identically: pass the
// same `authorize`/`validatePayload` hooks to `createPulseVaultWebHandler`.

import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPulseVaultWebHandler } from "@mieweb/pulsevault/web";
import { createLocalStorage, buildUploadLink } from "@mieweb/pulsevault";

const PORT = Number(process.env.PORT || 3032);
const dataDir = process.env.PULSEVAULT_DIR || "./data";

const storage = createLocalStorage({ workspaceDir: dataDir });
await storage.initialize?.();

const vault = createPulseVaultWebHandler({
  basePath: "/pulsevault",
  storage,
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
});

const app = new Hono();

// The whole vault — TUS, capabilities, artifact serving, direct uploads — is
// this one line. c.req.raw is the WHATWG Request on every Hono runtime.
app.all("/pulsevault/*", (c) => vault.handler(c.req.raw));

// Your server owns artifactId creation — attach auth, DB records, quotas here.
app.post("/reserve", (c) => c.json({ artifactId: randomUUID() }));

// One pairing deep link per request, same shape the other demos serve.
app.get("/deeplinks", (c) => {
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  const artifactId = randomUUID();
  const link = buildUploadLink({
    artifactId,
    server: `${proto}://${host}/pulsevault`,
  });
  return c.json({ artifactId, link });
});

app.get("/", (c) =>
  c.text(
    "pulsevault hono demo\n\nGET  /deeplinks — mint a pairing link\nPOST /reserve   — mint an artifactId\nALL  /pulsevault/* — the vault (TUS at /pulsevault/upload)\n",
  ),
);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`pulsevault hono demo listening on http://localhost:${info.port}`);
});
