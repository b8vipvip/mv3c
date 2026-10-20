# syntax=docker/dockerfile:1.7
# BuildKit cache keeps dependency layers reusable between GitHub Actions runs.
# The final runtime stage copies the pruned filesystem only, so build-time
# development dependencies do not remain hidden in lower image layers.

FROM node:24.16.0-alpine AS runtime-base

RUN apk upgrade --no-cache
RUN apk add --no-cache jemalloc
RUN apk add --no-cache python3 py3-pip uv

ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
ENV SCARF_ANALYTICS=false

COPY --from=ghcr.io/astral-sh/uv:0.9.5-python3.12-alpine /usr/local/bin/uv /usr/local/bin/uvx /bin/
RUN uv --version

FROM runtime-base AS build

ARG NODE_MAX_OLD_SPACE_SIZE=6144
ARG NPM_CI_TIMEOUT_SECONDS=1500
ARG NPM_CI_ATTEMPTS=2

RUN mkdir -p /app /app/api/logs && chown -R node:node /app /app/api/logs
WORKDIR /app
USER node

# Copy dependency manifests first so source-only changes reuse npm ci.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json
COPY --chown=node:node packages/chat/package.json ./packages/chat/package.json

RUN --mount=type=cache,id=mv3c-npm-cache,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    touch .env ; \
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
    NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run frontend && \
    npm prune --omit=dev --prefer-offline --no-audit --no-fund

# Only the final pruned filesystem is copied into the runtime image. The
# builder's full development-dependency layers are not shipped to GHCR.
FROM runtime-base AS runtime

WORKDIR /app
COPY --from=build --chown=node:node /app /app

ARG BUILD_COMMIT=
ARG BUILD_BRANCH=
ARG BUILD_DATE=
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_BRANCH=${BUILD_BRANCH}
ENV BUILD_DATE=${BUILD_DATE}

USER node
EXPOSE 3080
ENV HOST=0.0.0.0
CMD ["npm", "run", "backend"]

# Optional nginx client stage can be added independently if a separate
# static-asset deployment is needed.
