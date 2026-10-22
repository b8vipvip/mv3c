#!/usr/bin/env bash
# Actions-only prebuilt Docker image transfer. No build/install on the server.
set -euo pipefail
umask 077

: "${GITHUB_SHA:?Expected immutable Actions Git SHA}"
: "${MV3C_SCP_HOST:?Configure MV3C_SCP_HOST}"
: "${MV3C_SCP_USER:?Configure MV3C_SCP_USER}"
: "${MV3C_SCP_PRIVATE_KEY:?Configure MV3C_SCP_PRIVATE_KEY}"
: "${MV3C_SCP_KNOWN_HOSTS:?Configure MV3C_SCP_KNOWN_HOSTS}"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid SHA" >&2; exit 1; }
[[ "$MV3C_SCP_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid server hostname" >&2; exit 1; }
[[ "$MV3C_SCP_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { echo "Invalid SCP user" >&2; exit 1; }
PORT="${MV3C_SCP_PORT:-22}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || { echo "Invalid SSH port" >&2; exit 1; }
REMOTE_DIR="/var/lib/mv3c-prebuilt/incoming"
IMAGE="mv3c:sha-$GITHUB_SHA"
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/mv3c-scp-XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
printf '%s\n' "$MV3C_SCP_PRIVATE_KEY" > "$WORK/deploy_key"
printf '%s\n' "$MV3C_SCP_KNOWN_HOSTS" > "$WORK/known_hosts"
chmod 600 "$WORK/deploy_key" "$WORK/known_hosts"
ssh-keygen -y -f "$WORK/deploy_key" >/dev/null
SSH_OPTIONS=(-o BatchMode=yes -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$WORK/known_hosts" -o ConnectTimeout=15
  -o ServerAliveInterval=20 -o ServerAliveCountMax=5 -i "$WORK/deploy_key")
SCP_OPTIONS=(-o BatchMode=yes -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$WORK/known_hosts" -o ConnectTimeout=15
  -o ServerAliveInterval=20 -o ServerAliveCountMax=5 -i "$WORK/deploy_key" -P "$PORT")
# Verify pinned host identity and receiver BEFORE exporting ~700MB.
# Never accept an opportunistically scanned host key.
HOST_LOOKUP="$MV3C_SCP_HOST"
if (( 10#$PORT != 22 )); then
  HOST_LOOKUP="[$MV3C_SCP_HOST]:$((10#$PORT))"
fi
if ! ssh-keygen -F "$HOST_LOOKUP" -f "$WORK/known_hosts" >/dev/null 2>&1; then
  echo "::error title=SSH known_hosts mismatch::MV3C_SCP_KNOWN_HOSTS has no trusted key for the exact MV3C_SCP_HOST and port. For port 22 use HOST ssh-ed25519 AAAA...; otherwise use [HOST]:PORT ssh-ed25519 AAAA... . Use the server SSH host key, not the upload account key or fingerprint." >&2
  exit 47
fi
if ! ssh-keygen -F "$HOST_LOOKUP" -f "$WORK/known_hosts" | grep -q "ssh-ed25519"; then
  echo "::error title=SSH key type mismatch::MV3C_SCP_KNOWN_HOSTS does not pin an ED25519 host key for this SSH destination." >&2
  exit 48
fi
DEST="$MV3C_SCP_USER@$MV3C_SCP_HOST"
echo "Checking strict SSH host identity, upload key and inbox before image export"
if ! ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" "test -w '$REMOTE_DIR'"; then
  echo "::error title=SSH/SCP preflight failed::Check pinned server host key, SSH upload private key authorization and inbox permissions. Image export was skipped." >&2
  exit 49
fi
echo "SSH/SCP receiver preflight succeeded"
docker image tag mv3c:ci "$IMAGE"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$GITHUB_SHA"
ARCHIVE="mv3c-$GITHUB_SHA.tar.gz"
CHECKSUM="mv3c-$GITHUB_SHA.sha256"
echo "Exporting already-tested $IMAGE; host will never compile source"
docker save "$IMAGE" | gzip -1 > "$WORK/$ARCHIVE"
sha256sum "$WORK/$ARCHIVE" | cut -d ' ' -f1 > "$WORK/$CHECKSUM"
test -s "$WORK/$ARCHIVE"
echo "SCP archive size: $(wc -c < "$WORK/$ARCHIVE") bytes"
# Stage both files before publishing checksum sidecar as the ready marker.
scp "${SCP_OPTIONS[@]}" "$WORK/$ARCHIVE" "$DEST:$REMOTE_DIR/$ARCHIVE.part"
scp "${SCP_OPTIONS[@]}" "$WORK/$CHECKSUM" "$DEST:$REMOTE_DIR/$CHECKSUM.part"
ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" \
  "cd '$REMOTE_DIR' && mv -f '$ARCHIVE.part' '$ARCHIVE' && mv -f '$CHECKSUM.part' '$CHECKSUM'"
# Limit queued archives to the newest two if automatic updating is paused.
# Previous runtime images live in Docker; archive files are delivery queues,
# not backup copies. Avoid accumulating >1GB per CI commit on a 40GB disk.
ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" \
  "cd '$REMOTE_DIR' && for old in \$(ls -1t mv3c-*.tar.gz 2>/dev/null | tail -n +3); do case \$old in mv3c-*.tar.gz) rm -f -- \"\$old\" \"\${old%.tar.gz}.sha256\";; esac; done"
echo "SCP upload complete: $ARCHIVE, commit=$GITHUB_SHA"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "### CI-built image delivered by SSH/SCP" >> "$GITHUB_STEP_SUMMARY"
  echo "- Commit: \`$GITHUB_SHA\`" >> "$GITHUB_STEP_SUMMARY"
  echo "- File: \`$REMOTE_DIR/$ARCHIVE\`" >> "$GITHUB_STEP_SUMMARY"
  echo "- Host updater can now load and switch the verified artifact." >> "$GITHUB_STEP_SUMMARY"
fi
