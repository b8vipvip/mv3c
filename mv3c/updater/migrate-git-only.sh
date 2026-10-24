#!/usr/bin/env bash
# One-time, fail-closed host migration from the REST updater to the Git-only updater.
# Never builds by 'docker compose up --build' and never clears other projects' caches.
set -Eeuo pipefail
if [[ "$(id -u)" != 0 ]]; then echo "Run as root with sudo" >&2; exit 1; fi
REPO=/opt/mv3c
test -d "$REPO/.git" || { echo "Missing checkout: $REPO" >&2; exit 1; }
cd "$REPO"
echo "Stopping updater TIMER (will not interrupt active build)"
systemctl stop mv3c-updater.timer
for attempt in $(seq 1 30); do
  if ! systemctl is-active --quiet mv3c-updater.service; then break; fi
  if (( attempt == 30 )); then
    echo "Updater service is still executing; no bootstrap attempted. Do NOT remove lock." >&2
    exit 1
  fi
  sleep 4
done
# The bootstrap itself must not require port 22: the final updater prefers
# SSH 443 -> SSH 22 -> HTTPS, so stage the same transport choices here.
SSH_ORIGIN="git@github.com:b8vipvip/mv3c.git"
HTTPS_ORIGIN="https://github.com/b8vipvip/mv3c.git"
KNOWN_HOSTS=/run/mv3c-github-known-hosts
FETCH_LOG=/var/log/mv3c-migration-fetch.log
[[ ! -L "$KNOWN_HOSTS" && ! -L "$FETCH_LOG" ]] || {
  echo "Unsafe known_hosts or log symlink" >&2; exit 1;
}
umask 077
printf '%s\n' \
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  'ssh.github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  > "$KNOWN_HOSTS"
chmod 600 "$KNOWN_HOSTS"
: > "$FETCH_LOG"
chmod 600 "$FETCH_LOG"
SSH_COMMON="ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519"
SSH_443="$SSH_COMMON -o HostName=ssh.github.com -o Port=443 -o HostKeyAlias=ssh.github.com"
SSH_22="$SSH_COMMON -o HostKeyAlias=github.com"
REFSPEC="refs/heads/main:refs/remotes/origin/main"
fetch_main() {
  if [[ "$(git -C "$REPO" ls-remote --get-url "$SSH_ORIGIN")" == "$SSH_ORIGIN" ]]; then
    echo "Bootstrap fetch: trying pinned GitHub SSH 443"
    if GIT_SSH_COMMAND="$SSH_443" GIT_TERMINAL_PROMPT=0 timeout 55s \
      git -C "$REPO" fetch --no-tags "$SSH_ORIGIN" "$REFSPEC" >> "$FETCH_LOG" 2>&1; then
      echo "Bootstrap fetch succeeded via SSH 443"; return 0
    fi
    echo "Bootstrap fetch: trying pinned GitHub SSH 22"
    if GIT_SSH_COMMAND="$SSH_22" GIT_TERMINAL_PROMPT=0 timeout 55s \
      git -C "$REPO" fetch --no-tags "$SSH_ORIGIN" "$REFSPEC" >> "$FETCH_LOG" 2>&1; then
      echo "Bootstrap fetch succeeded via SSH 22"; return 0
    fi
  else
    echo "Git URL rewrite detected for SSH; skipping untrusted rewritten origin" >> "$FETCH_LOG"
  fi
  if [[ "$(git -C "$REPO" ls-remote --get-url "$HTTPS_ORIGIN")" == "$HTTPS_ORIGIN" ]]; then
    echo "Bootstrap fetch: falling back to pinned GitHub HTTPS HTTP/1.1"
    if GIT_TERMINAL_PROMPT=0 timeout 55s git -C "$REPO" \
      -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=12 \
      fetch --no-tags "$HTTPS_ORIGIN" "$REFSPEC" >> "$FETCH_LOG" 2>&1; then
      echo "Bootstrap fetch succeeded via HTTPS"; return 0
    fi
  else
    echo "Git URL rewrite detected for HTTPS; refusing untrusted source" >> "$FETCH_LOG"
  fi
  echo "All bootstrap Git transports failed; preserving existing checkout and containers." >&2
  tail -n 12 "$FETCH_LOG" >&2
  return 1
}
fetch_main
BOOT=/root/mv3c-verified-git-bootstrap.py
git -C "$REPO" show refs/remotes/origin/main:mv3c/updater/agent.py > "$BOOT"
chmod 600 "$BOOT"
python3 -m py_compile "$BOOT"
grep -q '^def verify_release_proof(' "$BOOT" || {
  echo "Git-only release verification module missing; stop" >&2; exit 1;
}
grep -q '^def verify_restored_service(' "$BOOT" || {
  echo "Safe previous-image rollback verification missing; stop" >&2; exit 1;
}
echo "Running verified official-release bootstrap. Old container remains until candidate is built."
if ! python3 "$BOOT" --repo "$REPO" --bootstrap-local; then
  echo "Bootstrap failed; updater timer stays stopped. Existing containers were not pruned." >&2
  echo "Inspect /var/log/mv3c-updater-build.log and the last reported rollback status." >&2
  exit 1
fi
# The Git checkout must now contain the updater code that we just tested.
test -f "$REPO/mv3c/updater/install.sh"
grep -q '^def verify_restored_service(' "$REPO/mv3c/updater/agent.py"
bash "$REPO/mv3c/updater/install.sh"
echo "=== Live revision evidence ==="
curl --fail --silent --show-error http://127.0.0.1:3080/api/config/version
echo
systemctl is-active mv3c-updater.timer
echo "Git-only host updater migration completed and service timer enabled."
