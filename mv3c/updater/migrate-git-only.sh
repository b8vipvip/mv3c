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
echo "Fetching main over verified Git SSH 22 (bootstrap uses SSH 443/22/HTTPS afterwards)"
GIT_TERMINAL_PROMPT=0 timeout 60s git -C "$REPO" fetch --no-tags \
  git@github.com:b8vipvip/mv3c.git \
  refs/heads/main:refs/remotes/origin/main
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
