# syntax=docker/dockerfile:1
# Build context is the REPO ROOT — the example installs @mieweb/pulsevault
# from file:../.., so the library must exist inside the image at /app.
# Built by compose.yaml (context: ../..); or by hand from the repo root:
#   docker build -f examples/fastify-auth-demo/Dockerfile -t pulsevault-auth-demo .

# --- Stage 1: build the library (dist/ is not committed) --------------------
FROM node:22-slim AS lib
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Stage 2: the demo server ------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production
# Prisma's engines need OpenSSL at runtime.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=lib --chown=node:node /app /app
WORKDIR /app/examples/fastify-auth-demo
COPY --chown=node:node examples/fastify-auth-demo/package.json examples/fastify-auth-demo/package-lock.json ./
COPY --chown=node:node examples/fastify-auth-demo/prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --chown=node:node examples/fastify-auth-demo/server.mjs ./
COPY --chown=node:node examples/fastify-auth-demo/public ./public
# Uploaded videos land here; a named volume mounts over it.
RUN mkdir -p data && chown -R node:node /app/examples/fastify-auth-demo
USER node
EXPOSE 3000
# npm start = `prisma migrate deploy && node server.mjs` — the schema is
# applied against the compose Postgres before the server boots.
CMD ["npm", "start"]
