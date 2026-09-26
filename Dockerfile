# syntax=docker/dockerfile:1.7
# Multi-stage build for the backend. One image, two process roles:
#   API:     node dist/main.js     (default CMD)
#   Worker:  node dist/worker.js
#   Migrate: docker build --target migrate  ->  prisma migrate deploy (owner credentials)
#   Provision a tenant: node dist/cli/provision-tenant.js --slug <s> --name <n> [--template <t>]
# The API and worker must connect as a member of the lip_app role (ADR 0008).

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter @lip/api build \
 && pnpm --filter @lip/api deploy --prod --legacy /out

# Runs pending database migrations, then exits. Use as a release/init job with
# MIGRATION_DATABASE_URL (schema owner). Runs as the unprivileged `node` user;
# calls the Prisma CLI directly so no package manager is needed at runtime.
FROM node:${NODE_VERSION} AS migrate
# CHECKPOINT_DISABLE: no Prisma version-check call from a production job.
ENV NODE_ENV=production CHECKPOINT_DISABLE=1
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/api
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# Tenant templates, used by the provisioning CLI (node dist/cli/provision-tenant.js).
COPY --from=build --chown=node:node /repo/apps/api/config ./config
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/live" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
