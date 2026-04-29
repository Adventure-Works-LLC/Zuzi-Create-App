# syntax=docker/dockerfile:1.6

# Multi-stage Docker build for Next 16 standalone output.
#
# Why this exists: Railway's Railpack auto-detection deploys the ENTIRE post-
# build `/app` directory (sources + full node_modules incl. devDeps + .next/
# build output + .next/standalone/ duplicate) — image lands at ~276MB even
# though `.next/standalone/` itself is only ~47MB. The whole point of
# `output: 'standalone'` (next.config.ts) is to deploy ONLY that subset onto
# a fresh runtime base, which Railpack doesn't do natively.
#
# Vercel-canonical pattern: two stages. Builder rebuilds inside this image
# (importantly: on Linux, so native modules like better-sqlite3 and sharp
# get the right binaries). Runner is a fresh tiny base + the standalone
# subset. Final image: ~80–110MB.
#
# Railway picks up this Dockerfile automatically and skips Railpack auto-
# detection. To revert to Railpack, delete this file.

# ---- builder ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# Native module compile prerequisites:
#   python3 / make / g++  → better-sqlite3, bcryptjs's optional deps
#   libc6-compat          → glibc shim alpine needs for prebuilt binaries
ENV PYTHONUNBUFFERED=1
RUN apk add --no-cache python3 make g++ libc6-compat

# Cache the dep install layer when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the build context. The .dockerignore filters out runtime
# state (data/), local artifacts (.next/, samples/inputs/), agent worktrees,
# and IDE noise — see that file for the full list.
COPY . .

# Railway sets RAILWAY_GIT_COMMIT_SHA as a build-time variable; surface it
# to scripts/stamp-sw.ts via ARG so the service worker's cache key embeds
# the deploy SHA. Without this, the SW would stamp "dev" or fall through
# to `git rev-parse HEAD` (which won't be available in the Docker context
# since .git is excluded by .dockerignore).
ARG RAILWAY_GIT_COMMIT_SHA
ENV RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA}

# Runs (in order, all gated):
#   1. check:prompts  → fail-fast on prompt-builder regression
#   2. stamp:sw       → embed RAILWAY_GIT_COMMIT_SHA into public/sw.js
#   3. next build     → produces .next/standalone/ with traced runtime deps
#                       (Linux binaries since this stage is alpine)
#   4. setup-standalone.mjs → copies .next/static + public into the
#                              standalone tree, scrubs data/samples/tmp
RUN npm run build

# ---- runner ----------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Default Railway sets PORT; we set 8080 as a sensible fallback for parity
# with the previous `next start -p 8080` configuration.
ENV PORT=8080

# better-sqlite3 + sharp's prebuilt Linux binaries link against glibc;
# alpine ships musl. libc6-compat is the standard shim.
RUN apk add --no-cache libc6-compat

# Run as non-root. Lightly hardened — Railway-issued FS permissions on the
# Volume mount must allow uid 1001 to read/write /data; that's set on the
# Railway service, not in the image.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# Copy ONLY the standalone runtime tree. Post-build, `.next/standalone/`
# already contains:
#   server.js                 — Next's standalone server entry
#   .next/static/             — copied in by setup-standalone.mjs
#   public/                   — copied in by setup-standalone.mjs
#   drizzle/                  — included by outputFileTracingIncludes
#   node_modules/             — only what `next build` traced as reachable;
#                                does NOT include devDependencies (tsx,
#                                drizzle-kit, eslint, @types/*, etc.)
#   package.json              — minimal manifest for Node module resolution
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs

EXPOSE 8080

# Standalone server reads PORT from env. Migrations run inside the server
# process via instrumentation.ts before any request is served; no separate
# `db:migrate` step.
CMD ["node", "server.js"]
