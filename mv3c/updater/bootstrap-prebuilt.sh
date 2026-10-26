#!/usr/bin/env bash
# Bootstrap v0.1.22 -> newest already-delivered official prebuilt Release.
# Same canonical Python agent, systemd lock, MongoDB job and rollback lifecycle.
set -Eeuo pipefail
umask 077
test "$#" -eq 1 || { echo "Usage: sudo bash bootstrap-prebuilt.sh vX.Y.Z"; exit 2; }
VERSION="$1"
[[ "$VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 2
REPO=/opt/mv3c
[[ "$(id -u)" == 0 && -d "$REPO/.git" ]] || exit 1
cd "$REPO"
[[ "$(git symbolic-ref --short HEAD)" == main ]] || exit 1
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Uncommitted tracked files"; exit 1; }
case "$(git config --local --get remote.origin.url)" in
  https://github.com/b8vipvip/mv3c.git|https://github.com/b8vipvip/mv3c|git@github.com:b8vipvip/mv3c.git) ;;
  *) echo "Untrusted origin"; exit 1 ;;
esac
[[ "$(git remote get-url origin)" == "$(git config --local --get remote.origin.url)" ]] || exit 1
[[ ! -e .mv3c-local-build-transaction.json ]] || { echo "Unfinished deployment transaction"; exit 1; }
if systemctl is-active --quiet mv3c-updater.service; then
  echo "Another canonical updater is running"; exit 1
fi
systemctl disable --now mv3c-updater.timer
echo "Original updater timer paused for one-time handoff."
state="$(timeout 50s docker compose exec -T mv3c node /app/mv3c/updater/bridge.cjs state)"
printf '%s' "$state" | python3 -c '
import json,sys
s=json.load(sys.stdin)
assert not s.get("activeJob") and not s.get("pendingJob"), "Update queue busy"
assert (s.get("config") or {}).get("autoDeployEnabled") is False, "Unattended deploy enabled"
print("Canonical update queue is empty")
'
# Read only trusted Git refs; no source reset or Docker action here.
KNOWN=/run/mv3c-github-known-hosts
[[ ! -L "$KNOWN" ]] || exit 1
printf '%s\n' \
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  'ssh.github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$KNOWN"
chmod 600 "$KNOWN"
SSH_BASE="-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o UserKnownHostsFile=$KNOWN -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519"
SPECS=(
  'refs/heads/main:refs/remotes/origin/main'
  'refs/tags/v*:refs/mv3c-release/tags/v*'
  'refs/tags/mv3c-verified/v*:refs/mv3c-release/proofs/v*'
  'refs/tags/mv3c-image/v*:refs/mv3c-release/images/v*'
)
fetched=0
for transport in ssh443 ssh22 https; do
  case "$transport" in
    ssh443) url=git@github.com:b8vipvip/mv3c.git
      ssh_command="ssh $SSH_BASE -o HostName=ssh.github.com -o Port=443 -o HostKeyAlias=ssh.github.com" ;;
    ssh22) url=git@github.com:b8vipvip/mv3c.git
      ssh_command="ssh $SSH_BASE -o HostKeyAlias=github.com" ;;
    https) url=https://github.com/b8vipvip/mv3c.git; ssh_command= ;;
  esac
  [[ "$(git ls-remote --get-url "$url")" == "$url" ]] || continue
  if HOME=/root GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$ssh_command" \
    timeout 110s git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 \
      -c http.lowSpeedTime=15 fetch --no-tags "$url" "${SPECS[@]}"; then
    fetched=1; break
  fi
done
[[ "$fetched" == 1 ]] || { echo "Trusted Git fetch failed"; exit 1; }
target="$(git rev-parse "refs/mv3c-release/tags/$VERSION^{commit}")"
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || exit 1
git merge-base --is-ancestor HEAD "$target" || { echo "Not a fast forward"; exit 1; }
git merge-base --is-ancestor "$target" refs/remotes/origin/main || exit 1
latest="$(git for-each-ref --format='%(refname:strip=3)' refs/mv3c-release/tags | sort -V | tail -1)"
[[ "$latest" == "$VERSION" ]] || { echo "Expected latest official Release: $latest"; exit 1; }

TMP="$(mktemp -d /root/mv3c-prebuilt-handoff.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT
chmod 700 "$TMP"
git show "$target:mv3c/updater/agent.py" > "$TMP/agent.py"
git show "$target:mv3c/updater/prebuilt.py" > "$TMP/prebuilt.py"
python3 -m py_compile "$TMP/agent.py" "$TMP/prebuilt.py"
grep -Fq 'prebuilt_only=True' "$TMP/agent.py" || { echo "Release agent not no-build"; exit 1; }
python3 - "$target" "$VERSION" "$TMP" <<'PY'
import importlib.util,pathlib,sys,subprocess,hashlib,stat
sha,version,folder=sys.argv[1:]
repo=pathlib.Path("/opt/mv3c")
def load(name):
    spec=importlib.util.spec_from_file_location(name,str(pathlib.Path(folder)/(name+".py")))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    return m
a=load("agent");p=load("prebuilt")
def git(repo,*args):
    return subprocess.check_output(["git",*args],cwd=repo,text=True).strip()
a.verify_release_proof(repo,version,sha)
proof=p.verified_image_proof(repo,version,sha,git)
artifact=p.INCOMING / p.filename(version,sha)
info=artifact.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=int(proof["archive_size"]):
    raise SystemExit("Prebuilt Release file is missing/incomplete; no deployment queued")
digest=hashlib.sha256()
with artifact.open("rb") as f:
    while chunk:=f.read(4*1024*1024): digest.update(chunk)
if digest.hexdigest()!=proof["archive_sha256"]:
    raise SystemExit("Archive SHA256 differs from official image proof")
print("Official Release proof, CI results, image proof and archive SHA256 all PASS")
PY
echo "Creating exactly one manual task via existing database queue"
timeout 60s docker compose exec -T mv3c node -e '
const mongoose=require("mongoose");
const updates=require("/app/api/server/services/Config/mv3cUpdater");
(async()=>{
 await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:8000});
 const s=await updates.getState();
 if(s.pendingJob||s.activeJob||s.config.autoDeployEnabled) throw Error("Update queue admission denied");
 const q=await updates.queueJob("one-time-prebuilt-bootstrap","manual");
 console.log("Canonical manual job queued:",q.job.id);
 await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exitCode=1;mongoose.disconnect().catch(()=>{})});
'
echo "Starting ONLY the verified canonical agent under its original exclusive lock"
python3 "$TMP/agent.py" --repo "$REPO"
[[ "$(git rev-parse HEAD)" == "$target" ]] || { echo "Deployment SHA mismatch"; exit 1; }
curl -fsS --max-time 15 http://127.0.0.1:3080/readyz >/dev/null
echo "New Release healthy. Reinstalling same service/timer from new checkout."
bash mv3c/updater/install.sh
echo "One-time no-build handoff succeeded: $VERSION"
