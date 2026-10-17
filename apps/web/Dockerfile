# ─────────────────────────────────────────────────────────────────────────────
#  Digital Archive web interface (Next.js, standalone output)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# Enables `output: "standalone"` (see next.config.mjs).
ENV NEXT_OUTPUT=standalone

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @archive/shared... --filter @archive/web...

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @archive/shared build

# NEXT_PUBLIC_* values are inlined at build time, so they must be present now.
ARG NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_SITE_NAME
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME
RUN pnpm --filter @archive/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init curl \
 && rm -rf /var/lib/apt/lists/*

# The standalone bundle already contains the trimmed node_modules it needs.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
