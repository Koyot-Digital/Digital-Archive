# ─────────────────────────────────────────────────────────────────────────────
#  Digital Archive API
#
#  One image, two entrypoints: `start:text` and `start:images`. The compose
#  file runs it twice with different commands so the two services can be
#  scaled, restarted and tunnelled independently while sharing one build.
#
#  Debian slim rather than Alpine: sharp's prebuilt libvips binaries are
#  glibc-first, and musl builds have historically been the source of
#  "works on my machine" image-pipeline failures.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── build: full install, compile shared + api ───────────────────────────────
FROM base AS builder
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @archive/shared... --filter @archive/api...

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @archive/shared build \
 && pnpm --filter @archive/api build

# ── prod deps: the same lockfile, without the toolchain ─────────────────────
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter @archive/shared... --filter @archive/api...

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

# Dumb-init reaps zombies and forwards SIGTERM, so graceful shutdown works.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY package.json pnpm-workspace.yaml ./

# The storage volume is mounted here; own it as the unprivileged user.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/apps/api

EXPOSE 4001 4002
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/entry/text.js"]
