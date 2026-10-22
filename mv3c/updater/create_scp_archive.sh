#!/usr/bin/env bash
# Called only after the Actions Docker image has passed its smoke tests.
# Keep the exact gzip and digest as a short-lived Actions artifact so that
# transfer-only retries use IDENTICAL bytes and can reuse uploaded chunks.
set -euo pipefail
umask 077
: "${GITHUB_SHA:?Full Git SHA required}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
OUT="${1:?Destination directory required}"
mkdir -p "$OUT"
IMAGE="mv3c:sha-$GITHUB_SHA"
docker image tag mv3c:ci "$IMAGE"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$GITHUB_SHA"
ARCHIVE="$OUT/mv3c-$GITHUB_SHA.tar.gz"
echo "Packaging smoke-tested image once for repeatable retry, SHA=$GITHUB_SHA"
docker save "$IMAGE" | gzip -1 > "$ARCHIVE"
sha256sum "$ARCHIVE" | cut -d ' ' -f1 > "$OUT/mv3c-$GITHUB_SHA.sha256"
test -s "$ARCHIVE"
echo "SCP reusable archive bytes: $(wc -c < "$ARCHIVE")"
