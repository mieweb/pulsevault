// Node built-in `cluster` wrapper for the fastify-demo.
//
// server.mjs is a single-threaded Node process — it uses ONE CPU core no
// matter how many the box has (see OPERATIONS.md "Horizontal scaling"). This
// wrapper forks one worker per core; the kernel load-balances incoming
// connections across them, so every core does upload/playback work instead of
// one. `node server.mjs` still runs a single process — this wrapper is
// additive and the server never imports it.
//
// Safe with the LOCAL storage adapter: every worker on THIS box shares the
// same `data/` filesystem, so a resumable TUS PATCH/HEAD that lands on a
// different worker than the one that created the upload still finds the
// partial bytes + @tus/file-store offset on disk (local.ts falls back to
// reading the sidecar on an in-memory cache miss, and the create collision
// guard is an atomic `wx` write — both cross-process safe). That "shared
// filesystem" condition OPERATIONS.md calls out is automatically met within
// one machine. Across SEPARATE machines you'd still need sticky sessions, a
// shared NFS/EFS mount, or — the real answer — the S3/R2 adapter.
//
// Per-worker caveats (in-memory state is NOT shared across workers):
//   - @fastify/rate-limit is an in-memory per-IP store, so the effective
//     limit is roughly `max × WEB_CONCURRENCY`. Point it at Redis for a hard
//     global limit.
//   - @fastify/under-pressure measures each worker's own event loop / RSS —
//     which is what you want — but MAX_RSS_MB is therefore PER WORKER (see
//     TOTAL_RSS_MB below).
//
// Run:
//   node cluster.mjs                        # one worker per core
//   npm run start:cluster                   # same, loads .env
//   WEB_CONCURRENCY=6 node cluster.mjs      # leave 2 cores for HLS/ffmpeg
//   TOTAL_RSS_MB=12000 node cluster.mjs     # split a whole-box RSS budget

import cluster from 'node:cluster';
import os from 'node:os';
import process from 'node:process';

const log = (msg) => console.log(`[cluster] ${msg}`);
const cores = os.availableParallelism();

// One worker per core by default. Override with WEB_CONCURRENCY — drop it below
// the core count once CPU-heavy HLS/ffmpeg transcoding shares this box, so
// transcoding and web serving aren't fighting over the same cores. (Better
// still, run HLS workers as a separate process pool pulling from a queue once
// you're on S3/R2 — then this can stay at the full core count.)
const workers = Math.max(1, Math.trunc(Number(process.env.WEB_CONCURRENCY ?? cores)));

if (cluster.isPrimary) {
  log(`primary ${process.pid} starting ${workers} worker(s) on a ${cores}-core host`);

  // under-pressure's maxRssBytes (MAX_RSS_MB in server.mjs) is measured PER
  // PROCESS. With N workers, a single MAX_RSS_MB lets the box believe it has
  // N× its real memory. Give TOTAL_RSS_MB (the whole box's budget) and we split
  // it per worker and pass it down via the worker env; otherwise we just warn.
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
  // A dead worker is replaced so a crash never permanently loses a core. But if
  // workers die almost immediately and repeatedly, that's a startup/config
  // error (port in use, bad env), not a transient crash — respawning forever
  // would be a fork bomb, so the primary gives up with a non-zero exit instead.
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
            `likely a startup/config error (port already in use, bad env). Giving up.`,
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
  // Stop accepting new connections and let in-flight uploads/playbacks drain,
  // then force-kill any stragglers after a grace window. A cut-off TUS upload
  // is resumable via HEAD, so even the force-kill isn't data loss. A second
  // signal skips the wait and kills immediately (handy for Ctrl-C in dev).
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
  // SIGTERM/SIGINT straight to us; ignore it so the primary can orchestrate a
  // drain via disconnect() instead of the default "terminate immediately",
  // which would cut off in-flight uploads. The primary's post-grace SIGKILL is
  // the backstop. (A clean per-worker close would need server.mjs to export
  // app.close(); ignoring + primary-drain avoids modifying the demo server.)
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});

  // Boot the unmodified demo server. It calls app.listen() on the shared port;
  // cluster hands each worker a load-balanced share of the connections.
  await import('./server.mjs');
}
