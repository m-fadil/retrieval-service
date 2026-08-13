# syntax=docker/dockerfile:1

# Dependencies are installed once and shared by the build and runtime stages so
# a source-only change does not re-run npm ci.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
# tsconfig compiles src and test with rootDir ".", so the entrypoint lands at
# dist/src/server.js. Both trees are copied to keep the image build and a local
# `npm run build` producing the same layout.
COPY src ./src
COPY test ./test
RUN npm run build

# Production dependency tree, resolved from the same lockfile.
FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Drop privileges: nothing here needs root at runtime.
USER node

EXPOSE 3000

# The health routes are the only ones the API key guard exempts, so the check
# needs no credentials. Liveness deliberately, not readiness: a restart cannot
# fix an unreachable Qdrant, and /health/ready reports 503 for that so a load
# balancer — which can act on it — is the one that sees it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node runs as PID 1. server.ts installs SIGTERM/SIGINT handlers so `docker
# stop` drains in-flight requests instead of waiting out the kill timeout.
# Nothing here spawns children, so a separate init is not required; pass
# `--init` (or `init: true` in compose) if you want zombie reaping anyway.
CMD ["node", "dist/src/server.js"]
