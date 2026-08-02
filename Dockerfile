# syntax=docker/dockerfile:1

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages ./packages
COPY apps ./apps
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only the natively-built modules stay unbundled (see the esbuild --external list).
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @tcf/server --include-workspace-root \
  && npm cache clean --force

COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Read from disk by the drizzle migrator at runtime.
COPY apps/server/src/db/migrations ./apps/server/src/db/migrations

# Staging area for buffered post images; emptied as each post publishes.
RUN mkdir -p /app/data/media && chown -R node:node /app/data
USER node

EXPOSE 3000
CMD ["node", "apps/server/dist/server.cjs"]
