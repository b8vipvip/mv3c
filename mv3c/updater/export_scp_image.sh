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
if [[ "${1:-}" == "--preflight" ]]; then
  exit 0
fi
ARCHIVE="mv3c-$GITHUB_SHA.tar.gz"
CHECKSUM="mv3c-$GITHUB_SHA.sha256"
if [[ "${1:-}" == "--upload-only" ]]; then
  : "${MV3C_IMAGE_ARCHIVE_DIR:?An exact saved Actions archive is required for retry}"
  source_dir="$MV3C_IMAGE_ARCHIVE_DIR"
  [[ -f "$source_dir/$ARCHIVE" && -f "$source_dir/$CHECKSUM" ]] || { echo "Missing CI archive files" >&2; exit 51; }
  cp -- "$source_dir/$ARCHIVE" "$WORK/$ARCHIVE"
  cp -- "$source_dir/$CHECKSUM" "$WORK/$CHECKSUM"
  expected="$(cat "$WORK/$CHECKSUM")"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid stored image checksum" >&2; exit 52; }
  actual="$(sha256sum "$WORK/$ARCHIVE" | cut -d ' ' -f1)"
  [[ "$actual" == "$expected" ]] || { echo "Cached Actions archive SHA256 mismatch" >&2; exit 53; }
  echo "Reusing EXACT saved Actions archive (no Docker build or re-export)"
else
  docker image tag mv3c:ci "$IMAGE"
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$GITHUB_SHA"
  echo "Exporting already-tested $IMAGE; host will never compile source"
  docker save "$IMAGE" | gzip -1 > "$WORK/$ARCHIVE"
  sha256sum "$WORK/$ARCHIVE" | cut -d ' ' -f1 > "$WORK/$CHECKSUM"
fi
test -s "$WORK/$ARCHIVE"
echo "SCP archive size: $(wc -c < "$WORK/$ARCHIVE") bytes"
# Transfer fixed-size, checksum-verified chunks using SSH stdin streaming.\n# This intentionally avoids OpenSSH scp default SFTP subsystem: command-mode SSH\n# is already validated by preflight, while a broken SFTP subsystem can hang.\n# A failed Actions run can
# resume verified chunks on the next run instead of resending the entire ~700MB
# archive. Use only OpenSSH/SCP; rsync is not required on the Ubuntu host.
CHUNK_DIR="$REMOTE_DIR/.mv3c-parts-$GITHUB_SHA"
EXPECTED_SHA="$(cat "$WORK/$CHECKSUM")"
SCP_CHUNK_TIMEOUT_SECONDS=480
SCP_CHUNK_RETRIES=3
CHUNK_BYTES=16m
echo "Preparing resumable 16MiB chunks for SCP transfer"
split -b "$CHUNK_BYTES" -d -a 4 "$WORK/$ARCHIVE" "$WORK/chunk-"
pieces=("$WORK"/chunk-*)
if (( ${#pieces[@]} < 1 )); then
  echo "::error::No SCP image chunks produced" >&2
  exit 60
fi

# Avoid filling a small system disk when the archive and its assembled copy
# briefly coexist. Preserve all running containers and volumes.
free_kb="$(ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" "df -Pk '$REMOTE_DIR' | awk 'END{print \$4}'")"
[[ "$free_kb" =~ ^[0-9]+$ ]] || { echo "Unable to check destination disk space" >&2; exit 61; }
if (( free_kb < 4000000 )); then
  echo "::error::Server has less than 4GB free; refusing to upload another image archive" >&2
  exit 62
fi
ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" "mkdir -p -m 0700 '$CHUNK_DIR'"

# Fetch one checksum index for completed chunks already received during prior
# workflow attempts. Only complete, matching chunks can be skipped.
remote_index="$(ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" \
  "cd '$CHUNK_DIR' && sha256sum chunk-* 2>/dev/null || true")"
declare -A uploaded=()
while read -r hash name; do
  if [[ "$hash" =~ ^[a-f0-9]{64}$ && "$name" =~ ^chunk-[0-9]{4}$ ]]; then
    uploaded["$name"]="$hash"
  fi
done <<< "$remote_index"

total="${#pieces[@]}"
i=0
skipped=0
for piece in "${pieces[@]}"; do
  i=$((i+1))
  name="${piece##*/}"
  digest="$(sha256sum "$piece" | cut -d ' ' -f1)"
  if [[ "${uploaded[$name]:-}" == "$digest" ]]; then
    skipped=$((skipped+1))
    echo "SCP chunk $i/$total: $name cached and SHA256 verified; skip upload"
    continue
  fi
  verified=false
  for attempt in 1 2 3; do
    echo "SCP chunk $i/$total: uploading $name ($(wc -c < "$piece") bytes), attempt $attempt/$SCP_CHUNK_RETRIES"
    if timeout --signal=TERM --kill-after=10s "$SCP_CHUNK_TIMEOUT_SECONDS" \
      ssh "${SSH_OPTIONS[@]}" -T -p "$PORT" "$DEST" \
        "cat > '$CHUNK_DIR/$name.part'" < "$piece"; then
      remote_sha="$(ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" \
        "cd '$CHUNK_DIR' && test -f '$name.part' && sha256sum '$name.part' | cut -d ' ' -f1" || true)"
      if [[ "$remote_sha" == "$digest" ]] &&
         ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" \
         "cd '$CHUNK_DIR' && mv -f -- '$name.part' '$name'"; then
        verified=true
        break
      fi
      echo "::warning::SCP chunk $name failed remote SHA256 verification" >&2
    else
      echo "::warning::SSH stream chunk $name interrupted or stalled after 480s" >&2
    fi
    sleep 4
  done
  if [[ "$verified" != true ]]; then
    echo "::error::SCP segment $name failed after 3 attempts. Completed chunks remain cached for the next workflow run." >&2
    exit 63
  fi
  echo "SCP chunk $i/$total: $name delivered and verified"
done
echo "All $total chunks present ($skipped reused). Assembling original gzip with final SHA256 verification"
ssh "${SSH_OPTIONS[@]}" -p "$PORT" "$DEST" \
  "bash -s -- '$REMOTE_DIR' '$GITHUB_SHA' '$EXPECTED_SHA' '$total'" \
  < mv3c/updater/assemble_scp_image.sh
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
