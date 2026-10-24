# syntax=docker/dockerfile:1.7
# v0.8.8
# Dependency manifests are copied before source: Docker reuses the npm-ci layer
# whenever package-lock and workspace package manifests have not changed.
# BuildKit cache persists npm tarballs across builds when dependency inputs change.

# Shared Alpine/Node runtime packages. The builder and the final runtime
# reuse this same base; only the builder has the full development toolchain.
FROM node:24.16.0-alpine AS base

# Do not run an unconditional system-wide apk upgrade on each image build.
# The pinned node:24.16.0-alpine base already provides its Alpine release;
# upgrade base images as an explicitly tested dependency change instead.
# On networks where dl-cdn.alpinelinux.org is unreachable, use HTTPS mirrors
# with bounded per-mirror retries. apk continues verifying Alpine signatures.
RUN set -eu; \
    alpine_branch="v$(cut -d. -f1,2 /etc/alpine-release)"; \
    installed=0; \
    for mirror in \
      https://mirrors.aliyun.com/alpine \
      https://mirrors.tuna.tsinghua.edu.cn/alpine \
      https://dl-cdn.alpinelinux.org/alpine; do \
      printf '%s/%s/main\n%s/%s/community\n' \
        "$mirror" "$alpine_branch" "$mirror" "$alpine_branch" \
        > /etc/apk/repositories; \
      echo "MV3C APK package installation via $mirror ($alpine_branch)"; \
      if timeout 120 apk add --no-cache jemalloc python3 py3-pip uv; then \
        installed=1; \
        break; \
      fi; \
      echo "MV3C WARNING: APK repository unavailable: $mirror; trying next HTTPS mirror" >&2; \
    done; \
    if [ "$installed" != 1 ]; then \
      echo "MV3C ERROR: every Alpine HTTPS mirror failed; no partial package installation accepted" >&2; \
      exit 1; \
    fi

# Set environment variable to use jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
# Disable dependency installation analytics before any npm lifecycle scripts run.
ENV SCARF_ANALYTICS=false

# uv and uvx are already installed by apk above. Do not fetch a second
# multi-layer Alpine/Python uv image from GHCR on production host builds.
# Alpine's 'uv' package provides both executables; verify both at build time.
RUN uv --version && uvx --version

# Set configurable max-old-space-size with default
ARG NODE_MAX_OLD_SPACE_SIZE=6144
ARG NPM_CI_TIMEOUT_SECONDS=1500
ARG NPM_CI_ATTEMPTS=2

RUN mkdir -p /app /app/api/logs && chown -R node:node /app /app/api/logs
WORKDIR /app

USER node

# Build-only workspace: npm ci may install multiple GiB of dev deps,
# which must not survive as lower filesystem layers in the runtime image.
FROM base AS build

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json
COPY --chown=node:node packages/chat/package.json ./packages/chat/package.json

RUN --mount=type=cache,id=mv3c-npm-cache,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    # Allow mounting of these files, which have no default
    touch .env ; \
    # Create directories for the volumes to inherit the correct permissions
    mkdir -p /app/client/public/images /app/logs /app/uploads /app/skill /app/data ; \
    chmod 1777 /app/data ; \
    npm config set fetch-retry-maxtimeout 600000 ; \
    npm config set fetch-retries 5 ; \
    npm config set fetch-retry-mintimeout 15000 ; \
    attempt=1 ; \
    until timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --no-audit --prefer-offline --no-fund ; do \
        status=$? ; \
        if [ "$attempt" -ge "$NPM_CI_ATTEMPTS" ]; then \
            exit "$status" ; \
        fi ; \
        echo "npm ci --no-audit failed with exit code $status; retrying attempt $((attempt + 1))/$NPM_CI_ATTEMPTS" ; \
        attempt=$((attempt + 1)) ; \
        sleep 10 ; \
    done

COPY --chown=node:node . .

ARG VITE_MCP_SANDBOX_URL=
RUN --mount=type=cache,id=mv3c-npm-cache,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    # React client build with configurable memory
    NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run frontend

# Install production dependencies in an INDEPENDENT, source-invariant layer.
# Source edits must not retrigger npm prune (historically ~96 seconds) or the
# multi-GB dev-dependency copy. This npm-ci layer is keyed only by manifests.
FROM base AS prod-deps
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json
COPY --chown=node:node packages/chat/package.json ./packages/chat/package.json
RUN --mount=type=cache,id=mv3c-npm-cache,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    npm ci --omit=dev --no-audit --prefer-offline --no-fund

# Runtime gets the cached production-only node_modules and the source/build
# outputs with every nested node_modules excluded. BusyBox tar is available
# in the pinned Alpine base. Avoid copying the ~2.4GiB dev module tree and
# exporting it into a second image layer on every source change.
FROM base AS runtime
COPY --from=prod-deps --chown=node:node /app/node_modules/ /app/node_modules/
RUN --mount=from=build,source=/app,target=/mv3c-built,ro \
    set -eu; \
    set -o pipefail; \
    tar -C /mv3c-built --exclude=node_modules --exclude='*/node_modules' -cf - . | tar -C /app -xf -; \
    test -f /app/api/server/index.js; \
    test -f /app/mv3c/entrypoint.sh; \
    test -d /app/client/dist

# Optional build metadata surfaced in Settings -> About for support triage.
# Declared here (after the heavy install/build steps) so that commit/date
# changing on every CI run does not bust the cache for dependency install
# and frontend build layers. When unset, the backend falls back to local
# git resolution (if .git is present), and finally to empty values.
ARG BUILD_COMMIT=
ARG BUILD_BRANCH=
ARG BUILD_VERSION=unreleased
ARG BUILD_DATE=
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV MV3C_VERSION=${BUILD_VERSION}
LABEL org.opencontainers.image.source="https://github.com/b8vipvip/mv3c" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.description="mv3c GitHub Actions verified release image"
ENV BUILD_BRANCH=${BUILD_BRANCH}
ENV BUILD_DATE=${BUILD_DATE}

# Node API setup
EXPOSE 3080
ENV HOST=0.0.0.0
CMD ["npm", "run", "backend"]

