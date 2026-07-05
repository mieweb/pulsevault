// Minimal Fastify demo for @mieweb/pulsevault — the smallest runnable server
// the Pulse app can pair with: plugin mount, QR pairing, flat upload listing.
// No auth, local filesystem storage. Start here; for the production-shaped
// reference (capability tokens, pulse grouping, captions, Swagger UI) see
// ../fastify-auth-demo/server.mjs.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import QRCode from 'qrcode';
import pulseVault, { createLocalStorage, buildUploadLink } from '@mieweb/pulsevault';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The route schema says `format: "uuid"` but Fastify's default Ajv doesn't
// enforce string formats — routes validate ids explicitly before they touch a
// filesystem path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const html = readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const videosHtml = readFileSync(path.join(__dirname, 'public/videos.html'), 'utf8');
const favicon = readFileSync(path.join(__dirname, 'public/favicon.png'));
const dataDir = path.join(__dirname, 'data');

// Resolve a path under dataDir and refuse anything that escapes it — the
// belt-and-suspenders companion to the UUID check above for every read that
// embeds a request-supplied id.
function insideDataDir(...segments) {
  const base = path.resolve(dataDir);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('path escapes the data directory');
  }
  return resolved;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

// Deployment-wide default advertised via GET /pulsevault/capabilities — purely
// advisory; the plugin never enforces "segment" vs "merged", it just reports
// whichever value this server passes at registration (README "Upload unit").
// Default "merged" here so this demo exercises the full merged pipeline
// (video + captions + beat manifest + thumbnail); set UPLOAD_UNIT=segment to
// test per-clip uploads instead.
const uploadUnit = process.env.UPLOAD_UNIT === 'segment' ? 'segment' : 'merged';

const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024, // max single PATCH chunk (RN app sends 1 MB chunks)
});

// Registered before any route so every one of them — the demo's own and the
// TUS/artifact routes the plugin mounts — is covered by a global per-IP
// limit (OPERATIONS.md "Rate limiting" recommends exactly this). Generous
// enough for one phone's normal HEAD/PATCH resume retries, not for a scraper
// hammering /videos or /pulsevault/artifacts/:id.
await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' });

// Swagger MUST be registered before any route (including the plugin's) so
// their schemas are picked up — the pulsevault plugin ships full OpenAPI
// schemas, so /docs documents the whole wire contract for free.
await app.register(fastifySwagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'PulseVault Fastify (minimal demo)',
      description: 'The smallest runnable Pulse-compatible server — no auth, local storage.',
      version: '0.0.1',
    },
    tags: [
      { name: 'demo', description: 'Demo server endpoints' },
      { name: 'pulsevault', description: 'Routes contributed by the `@mieweb/pulsevault` plugin' },
    ],
  },
});
await app.register(fastifySwaggerUI, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list', deepLinking: false },
});

// Serve pairing page before the plugin so it isn't swallowed by /pulsevault/artifacts/:artifactId
app.get('/', { schema: { tags: ['demo'], summary: 'Pairing page (HTML)' } }, (_req, reply) =>
  reply.type('text/html').send(html),
);

// The uploads live on their own page — /videos is the JSON API, so the page sits at /library.
app.get('/library', { schema: { tags: ['demo'], summary: 'Uploads page (HTML)' } }, (_req, reply) =>
  reply.type('text/html').send(videosHtml),
);

// The Pulse app icon, resized — referenced by <link rel="icon"> on the page.
app.get('/favicon.png', { schema: { tags: ['demo'], summary: 'Favicon (PNG)' } }, (_req, reply) =>
  reply.type('image/png').send(favicon),
);

// Reserve an artifactId for an upload. The server owns ID generation so it
// can later attach auth tokens, quotas, or other server-side state here.
app.post(
  '/reserve',
  { schema: { tags: ['demo'], summary: 'Reserve a new artifactId' } },
  async (_req, reply) => reply.send({ artifactId: randomUUID() }),
);

// Serve a subtitles artifact as WebVTT — exactly the bytes the app uploaded,
// word-level cue timestamps (<00:00:01.500>word) and all. The wire protocol
// calls the kind "captions" (PROTOCOL.md), but user-facing they're subtitles —
// spoken-word transcript, not accessibility captions — so the demo names this
// route that way.
app.get(
  '/subtitles/:artifactId',
  {
    schema: {
      tags: ['demo'],
      summary: 'Fetch a subtitles artifact as WebVTT',
      params: {
        type: 'object',
        properties: { artifactId: { type: 'string', format: 'uuid' } },
        required: ['artifactId'],
      },
    },
    // On top of the global per-IP limit: this route does per-request filesystem
    // reads, so it gets its own tighter budget.
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  },
  async (req, reply) => {
    const { artifactId } = req.params;
    if (!UUID_RE.test(artifactId)) return reply.code(400).send();
    let sidecar;
    try {
      sidecar = JSON.parse(
        await readFile(insideDataDir('.pulsevault', `${artifactId}.json`), 'utf8'),
      );
    } catch {
      return reply.code(404).send();
    }
    // Only serve real, finished captions uploads — never hand a video body to text/vtt.
    if (sidecar.kind !== 'captions' || sidecar.status !== 'ready') return reply.code(404).send();
    const ext = sidecar.ext ?? '.vtt';
    let text;
    try {
      text = await readFile(insideDataDir('captions', `${artifactId}${ext}`), 'utf8');
    } catch {
      return reply.code(404).send();
    }
    return reply.type('text/vtt').send(text);
  },
);

// List all uploads under dataDir. Reads each upload's sidecar to determine
// kind and subdir rather than hard-coding "video/" — handles video/project/captions.
app.get(
  '/videos',
  {
    schema: { tags: ['demo'], summary: 'List finished uploads (flat)' },
    // Crawls every sidecar on disk per request — tighter per-IP budget than the
    // global limit (the feed polls this every 8s, so 60/min is still generous).
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  },
  async (_req, reply) => {
    const pulsevaultMetaDir = path.join(dataDir, '.pulsevault');
    let entries;
    try {
      entries = await readdir(pulsevaultMetaDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return reply.send([]);
      throw err;
    }

    const uploads = await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.tmp'))
        .map(async (e) => {
          const artifactId = e.name.slice(0, -'.json'.length);
          let sidecar;
          try {
            sidecar = JSON.parse(await readFile(path.join(pulsevaultMetaDir, e.name), 'utf8'));
          } catch {
            return null;
          }
          // Only list ready uploads; skip in-progress ones.
          if (sidecar.status !== 'ready') return null;

          const kind = sidecar.kind ?? 'video';
          const ext = sidecar.ext ?? '.mp4';
          const artifactFile = `${artifactId}${ext}`;
          const artifactPath = path.join(dataDir, kind, artifactFile);
          const [artifactStat, tusMeta] = await Promise.all([
            stat(artifactPath).catch(() => null),
            readFile(`${artifactPath}.json`, 'utf8')
              .then(JSON.parse)
              .catch(() => null),
          ]);
          if (!artifactStat || artifactStat.size === 0) return null;

          return {
            artifactId,
            kind,
            filename: sidecar.filename ?? tusMeta?.metadata?.filename ?? artifactFile,
            ext,
            size: artifactStat.size,
            // Session anchor this artifact belongs to (beat videos/captions point at their
            // manifest; a merged video's captions point at the video) — lets the library page
            // group one pulse's artifacts together instead of listing them flat.
            relatedTo: sidecar.relatedTo ?? null,
            playbackUrl: `/pulsevault/artifacts/${artifactId}`,
            creation_date: tusMeta?.creation_date ?? artifactStat.birthtime.toISOString(),
          };
        }),
    );

    const ready = uploads.filter(Boolean);

    // Pair each video with its subtitles (kind "captions" on the wire) the same
    // way fastify-auth-demo does: within a pulse (shared `relatedTo ?? artifactId`
    // anchor), the app names a beat's VTT after its video, so matching filename
    // stems pair them. Fallback: a pulse with exactly one video and one subtitles
    // file is an unambiguous pair even if the stems drifted.
    const stem = (filename) => filename.replace(/\.[^.]+$/, '');
    const byAnchor = new Map();
    for (const u of ready) {
      const anchorId = u.relatedTo ?? u.artifactId;
      if (!byAnchor.has(anchorId)) byAnchor.set(anchorId, []);
      byAnchor.get(anchorId).push(u);
    }
    for (const group of byAnchor.values()) {
      const videos = group.filter((u) => u.kind === 'video');
      const subsPool = group.filter((u) => u.kind === 'captions');
      for (const video of videos) {
        const idx = subsPool.findIndex((s) => stem(s.filename) === stem(video.filename));
        const matched =
          idx >= 0
            ? subsPool.splice(idx, 1)[0]
            : videos.length === 1 && subsPool.length === 1
              ? subsPool.pop()
              : null;
        video.subtitlesUrl = matched ? `/subtitles/${matched.artifactId}` : null;
      }
    }

    return reply.send(ready.sort((a, b) => b.creation_date.localeCompare(a.creation_date)));
  },
);

// One deeplink + matching QR per request. artifactId is generated server-side
// so it stays the source of truth. `server` must include the plugin's
// `prefix` ("/pulsevault") — the client builds every request as
// `${server}/<path>` with no prefix concept of its own. With no auth there's
// no issuer to stay consistent with, so deriving `server` from request
// headers is fine here.
//
// `?uploadUnit=segment|merged` lets this *one* pairing link override the
// deployment-wide default set above (PROTOCOL.md §3, §8) — handy for testing
// both modes without restarting the server. Omit it and the link carries no
// override; the client falls back to whatever `/capabilities` reports.
app.get(
  '/deeplinks',
  { schema: { tags: ['demo'], summary: 'Mint a pairing deep link + QR code' } },
  async (req, reply) => {
    const proto = req.headers['x-forwarded-proto'] ?? 'http';
    const requestHost = req.headers['x-forwarded-host'] ?? req.headers.host;
    const server = `${proto}://${requestHost}/pulsevault`;
    const artifactId = randomUUID();

    const requestedUploadUnit = req.query?.uploadUnit;
    if (
      requestedUploadUnit !== undefined &&
      requestedUploadUnit !== 'segment' &&
      requestedUploadUnit !== 'merged'
    ) {
      return reply
        .code(400)
        .send({ error: '`uploadUnit` query param must be "segment" or "merged"' });
    }

    const upload = buildUploadLink({
      server,
      artifactId,
      ...(requestedUploadUnit && { uploadUnit: requestedUploadUnit }),
    });
    const qrUpload = await QRCode.toDataURL(upload, {
      width: 224,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });

    return reply.send({ upload, artifactId, qrUpload });
  },
);

// Mount plugin under /pulsevault so TUS is at POST /pulsevault/upload and
// artifact GET is at /pulsevault/artifacts/:artifactId. This is the smallest
// working mount — no authorize, no validatePayload, no hooks.
await app.register(pulseVault, {
  prefix: '/pulsevault',
  storage: createLocalStorage({ workspaceDir: dataDir }),
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  uploadUnit,
  // All kinds stay enabled — a merged-mode session uploads a .pulse beat
  // manifest, .vtt captions and a .jpg thumbnail alongside the video (and a
  // segment-mode session uploads a .pulse ordering manifest); rejecting any of
  // those would make this a broken pairing target.
  allowedExtensions: {
    video: ['.mp4'],
    project: ['.pulse', '.zip'],
    captions: ['.vtt'],
    thumbnail: ['.jpg', '.jpeg', '.png'],
  },
});

await app.listen({ port, host });
console.log(`\nPulseVault fastify-demo running on http://localhost:${port}/`);
