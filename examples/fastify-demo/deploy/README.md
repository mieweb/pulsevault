# Running `fastify-demo` on mieweb/opensource-server

Notes for deploying this demo into an [opensource-server](https://github.com/mieweb/opensource-server)
container (Proxmox LXC, systemd `/sbin/init`, fronted by a shared edge nginx),
tuned for **fast uploads**. Container in the example: 4 vCPU / 4 GB RAM / 50 GB
rootfs, one **HTTP** service `internal :3000 → pulsevaultdemo.os.mieweb.org` and
a **TCP** service on `:22` for SSH.

## Install & run as a service (don't rely on a bare `npm start`)

The container's entrypoint is `/sbin/init`, so run the demo under **systemd** —
a bare `npm start` in an SSH session dies when the session closes or the
container reboots.

```bash
# inside the container, over SSH
git clone https://github.com/mieweb/pulsevault /opt/pulsevault
cd /opt/pulsevault
npm ci && npm run build            # builds dist/ that the demo imports via file:../..
cd examples/fastify-demo && npm ci

cp deploy/pulsevaultdemo.service /etc/systemd/system/
# edit WorkingDirectory in the unit if you cloned elsewhere
systemctl daemon-reload
systemctl enable --now pulsevaultdemo
systemctl status pulsevaultdemo
journalctl -u pulsevaultdemo -f
```

`npm start` still works for a quick manual run; the unit just adds
restart-on-crash, boot persistence, and the production env below.

## Environment (set in the unit or the Container Manager dashboard)

| Var | Default | Why |
|-----|---------|-----|
| `NODE_ENV` | — | `production` |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | matches the HTTP service's internal port |
| `LOG_LEVEL` | `info` | set `warn` in prod — per-PATCH request logging is real CPU + rootfs I/O |
| `MAX_RSS_MB` | `3072` | load-shed (503) ceiling; size to the container's RAM |
| `UPLOAD_RATE_MAX` | `6000`/min | per-IP budget for `/pulsevault/upload` + `/pulsevault/artifacts` |
| `DEFAULT_RATE_MAX` | `300`/min | per-IP budget for everything else |
| `CORS_ORIGIN` | reflect any | set to lock cross-origin access down |

## What the edge nginx already does for you (verified from the platform config)

The generated per-container nginx config is already upload-friendly — **you do
not need to change anything there**:

- `proxy_request_buffering off` + `proxy_buffering off` → PATCH bodies **stream**
  straight through; no whole-body buffering at the edge.
- `client_max_body_size 2G` → generous per-request ceiling.
- HTTP/1.1 to the backend, HTTP/2 + HTTP/3 (QUIC) to clients.
- Sets `X-Forwarded-For/-Proto/-Host` + `X-Real-IP` → this demo runs with
  `trustProxy: true` so rate-limiting keys on the **real** client IP (otherwise
  every client shares the single proxy-IP bucket) and forwarded proto/host work.

## Platform constraints that DO affect uploads — know these

1. **60 s proxy timeouts** (`proxy_connect/send/read_timeout 60s`). Each TUS
   `PATCH` must complete within 60 s. Size the client's chunk so one chunk
   finishes well inside 60 s on the target network. TUS resumability recovers a
   cut-off chunk, but repeated 60 s cut-offs stall throughput.

2. **ModSecurity (OWASP CRS) is ON at the edge.** Two implications:
   - It buffers + inspects the request body up to `SecRequestBodyLimit`
     (~12.5 MB by default), which partially re-introduces buffering the
     `proxy_request_buffering off` above removed. Keep chunks modest (≤ ~10 MB)
     so each PATCH is inspected once and passed.
   - CRS rules scan bodies for attack patterns and **can false-positive on
     binary/video bytes → intermittent `403`s**. If you see sporadic upload
     `403`s, it's almost certainly the WAF, not this server. Ask the
     opensource-server admins to exclude `/pulsevault/upload` from request-body
     inspection (or disable ModSecurity for this container's upload path).

3. **Uploads land on the 50 GB rootfs** under `data/`. Old uploads accumulate —
   prune `data/` (and the `data/.pulsevault/` sidecars) periodically, or attach
   a larger/dedicated volume for a real deployment.

## Fast-upload checklist

- [x] `trustProxy` on + generous per-IP rate budget for the upload path (done in `server.mjs`)
- [x] `LOG_LEVEL=warn`, `NODE_ENV=production` (in the unit)
- [ ] Client chunk size tuned to finish a PATCH in < 60 s and stay < ~10 MB (WAF)
- [ ] Confirm no ModSecurity `403`s on a real large upload; escalate to admins if so
- [ ] Prune / mount storage for `data/` if uploads are retained
