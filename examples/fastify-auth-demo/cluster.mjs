// Node built-in `cluster` wrapper for the fastify-auth-demo.
//
// server.mjs is a single-threaded Node process — it uses ONE CPU core no
// matter how many the box has (see OPERATIONS.md "Horizontal scaling"). This
// wrapper forks one worker per core; the kernel load-balances incoming
// connections across them. It matters more here than in ../fastify-demo: this
// demo re-hashes every finished video (createChecksumValidator, a full-file
// SHA-256) before markReady, which is CPU-bound and today serializes on one
// core — clustering lets N videos hash in parallel. `node server.mjs` still
// runs a single process; this wrapper is additive.
//
// Safe with the LOCAL storage adapter: every worker on THIS box shares the
// same `data/` filesystem, so a resumable TUS PATCH/HEAD landing on a
// different worker still finds the partial bytes + @tus/file-store offset on
// disk. Across SEPARATE machines you'd need sticky sessions, shared NFS/EFS,
// or the S3/R2 adapter.
//
// Per-worker caveats specific to the AUTH demo (in-memory / connection state
// is NOT shared across workers):
//   - Postgres via Prisma: EACH worker opens its own connection pool. Prisma's
//     default pool with no `connection_limit` is `num_cpus * 2 + 1`, so on an
//     8-core box that's ~17 × 8 workers = ~136 connections — past Postgres's
//     default max_connections (100). Set a small per-client limit on
//     DATABASE_URL, e.g. `...&connection_limit=5` (5 × 8 = 40), or raise the
//     server's max_connections. This wrapper warns at boot if it's unset.
//   - The /events feed (recentEvents ring buffer) lives in ONE worker's
//     memory, so /events only shows events from whichever worker served that
//     poll — cosmetically inconsistent; uploads are unaffected. Back it with a
//     shared store (Redis/Postgres) if you need a coherent feed.
//   - reconcileArtifactIndex() runs once PER WORKER at boot (idempotent upserts
//     + a deleteMany) — a small, harmless thundering herd for typical data
//     sizes; move it to the primary (below) if your artifact table is large.
//   - @fastify/rate-limit is in-memory per-IP, so the effective limit is
//     roughly `max × WEB_CONCURRENCY`. Use Redis for a hard global limit.
//
// Migrations run ONCE, in the primary shell, before any worker forks — the
// `start:cluster` script is `prisma migrate deploy && node cluster.mjs`. Do
// NOT run migrations inside workers.
//
// Run:
//   npm run start:cluster                   # prisma migrate deploy, then cluster
//   WEB_CONCURRENCY=6 npm run start:cluster # leave 2 cores for HLS/ffmpeg
//   TOTAL_RSS_MB=12000 npm run start:cluster

import cluster from 'node:cluster';
import os from 'node:os';
import process from 'node:process';

const log = (msg) => console.log(`[cluster] ${msg}`);
const cores = os.availableParallelism();

// One worker per core by default. Override with WEB_CONCURRENCY — drop it below
// the core count once CPU-heavy HLS/ffmpeg transcoding shares this box. (Better
// still, run HLS workers as a separate pool pulling from a queue once you're on
// S3/R2 — then this can stay at the full core count.)
const workers = Math.max(1, Math.trunc(Number(process.env.WEB_CONCURRENCY ?? cores)));

if (cluster.isPrimary) {
  log(`primary ${process.pid} starting ${workers} worker(s) on a ${cores}-core host`);

  // Prisma connection-pool sanity check: without a per-client limit, N workers
  // can blow past Postgres's max_connections (see the header note).
  if (process.env.DATABASE_URL && !/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
    log(
      `WARNING: DATABASE_URL has no connection_limit — ${workers} workers may exhaust ` +
        `Postgres max_connections. Append e.g. "?connection_limit=5" (or raise max_connections).`,
    );
  }

  // under-pressure's maxRssBytes (MAX_RSS_MB in server.mjs) is PER PROCESS.
  // Give TOTAL_RSS_MB (the whole box's budget) and we split it per worker;
  // otherwise we warn. Note Postgres runs elsewhere (compose/RDS), so the
  // budget here is for the Node workers only.
  const workerEnv = {};
  const totalRssMb = Number(process.env.TOTAL_RSS_MB ?? 0);
  if (totalRssMb > 0) {
    const perWorker = Math.max(512, Math.floor(totalRssMb / workers));
    workerEnv.MAX_RSS_MB = String(perWorker); // overrides any inherited MAX_RSS_MB
    log(`RSS budget: ${totalRssMb} MB ÷ ${workers} = ${perWorker} MB/worker`);
  } else if (process.env.MAX_RSS_MB) {
    log(
      `note: MAX_RSS_MB=${process.env.MAX_RSS_MB} is PER WORKER now ` +
        `(×${workers} = ${Number(process.env.MAX_RSS_MB) * workers} MB total). ` +
        `Set TOTAL_RSS_MB to split a whole-box budget instead.`,
    );
  } else {
    log(
      `note: no RSS budget set — under-pressure defaults to 3072 MB PER WORKER ` +
        `(×${workers} = ${3072 * workers} MB). Set TOTAL_RSS_MB=<box budget> to split it.`,
    );
  }

  // --- respawn with a crash-loop guard -------------------------------------
  // A dead worker is replaced. But this demo `process.exit(1)`s on missing
  // PULSEVAULT_SECRET / DATABASE_URL, so a misconfig makes every worker die
  // instantly — respawning forever would be a fork bomb. Bail after too many
  // rapid crashes with a non-zero exit that surfaces the real problem.
  const MIN_HEALTHY_MS = 10_000;
  const MAX_RAPID_CRASHES = workers * 2 + 4;
  let shuttingDown = false;
  let rapidCrashes = 0;

  const fork = () => {
    const worker = cluster.fork(workerEnv);
    worker.startedAt = Date.now();
    return worker;
  };

  for (let i = 0; i < workers; i++) fork();

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers).length === 0) {
        log('all workers drained — exiting');
        process.exit(0);
      }
      return;
    }
    const upMs = Date.now() - (worker.startedAt ?? 0);
    if (upMs < MIN_HEALTHY_MS) {
      rapidCrashes++;
      if (rapidCrashes > MAX_RAPID_CRASHES) {
        console.error(
          `[cluster] ${rapidCrashes} workers crashed within ${MIN_HEALTHY_MS / 1000}s of boot — ` +
            `likely a startup/config error (missing PULSEVAULT_SECRET / DATABASE_URL, ` +
            `port already in use, unreachable Postgres). Giving up.`,
        );
        process.exit(1);
      }
    } else {
      rapidCrashes = 0; // a worker that ran healthily resets the counter
    }
    console.warn(
      `[cluster] worker ${worker.process.pid} exited (code=${code ?? '-'} signal=${signal ?? '-'}) — respawning`,
    );
    fork();
  });

  // --- graceful shutdown ----------------------------------------------------
  // Drain in-flight uploads/playbacks, then force-kill stragglers after a grace
  // window (a cut-off TUS upload is resumable via HEAD). A second signal kills
  // immediately.
  const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000);
  const shutdown = (signal) => {
    if (shuttingDown) {
      log(`second ${signal} — force-killing now`);
      for (const worker of Object.values(cluster.workers)) worker.kill('SIGKILL');
      process.exit(1);
    }
    shuttingDown = true;
    const live = Object.values(cluster.workers);
    log(`${signal} — draining ${live.length} worker(s), ${GRACE_MS / 1000}s grace`);
    for (const worker of live) worker.disconnect();
    setTimeout(() => {
      log('grace elapsed — force-killing remaining workers');
      for (const worker of Object.values(cluster.workers)) worker.kill('SIGKILL');
      process.exit(0);
    }, GRACE_MS).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} else {
  // Worker. The process manager (systemd control-group, Docker) also delivers
  // SIGTERM/SIGINT straight to us; ignore it so the primary orchestrates a
  // drain via disconnect() instead of terminating immediately and cutting off
  // in-flight uploads. The primary's post-grace SIGKILL is the backstop.
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});

  // Boot the unmodified demo server. It calls app.listen() on the shared port;
  // cluster hands each worker a load-balanced share of the connections.
  await import('./server.mjs');
}
