#!/usr/bin/env bash
# Run ONCE on the Docker host: sudo bash mv3c/updater/install.sh
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "请使用 sudo/root 安装宿主机更新服务" >&2
  exit 1
fi
for command in git docker python3 systemctl; do
  command -v "$command" >/dev/null || { echo "缺少依赖: $command" >&2; exit 1; }
done
docker compose version >/dev/null
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
# Paths are inserted into a systemd unit; reject special characters.
if [[ ! "$REPO" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "请把 mv3c 仓库放在不含空格或特殊字符的目录，例如 /opt/mv3c" >&2
  exit 1
fi
if [[ "$(stat -c %u "$REPO")" != "0" ]]; then
  echo "出于安全考虑，mv3c 代码目录必须由 root 拥有；请先把仓库移至 /opt/mv3c 并设置 root 所有权" >&2
  exit 1
fi
SSH_ORIGIN="git@github.com:b8vipvip/mv3c.git"
SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15"
ORIGIN="$(git -C "$REPO" config --local --get remote.origin.url)"
case "$ORIGIN" in
  "$SSH_ORIGIN"|"https://github.com/b8vipvip/mv3c.git"|"https://github.com/b8vipvip/mv3c")
    ;;
  *)
    echo "Git origin 不是受信任的 b8vipvip/mv3c 仓库" >&2
    exit 1
    ;;
esac
if [[ "$(git -C "$REPO" branch --show-current)" != "main" ]]; then
  echo "请先切换到 mv3c main 分支" >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]]; then
  echo "工作区存在已跟踪文件修改；请先处理，避免自动更新覆盖更改" >&2
  exit 1
fi
# systemd runs as root. Prefer root's SSH identity; if unavailable,
# allow the same trusted public repository over HTTPS without credentials.
# Never disable SSH host-key verification or allow interactive prompts.
HTTPS_ORIGIN="https://github.com/b8vipvip/mv3c.git"
if [[ "$(git -C "$REPO" ls-remote --get-url "$SSH_ORIGIN")" == "$SSH_ORIGIN" ]] &&
   HOME=/root GIT_SSH_COMMAND="$SSH_COMMAND" GIT_TERMINAL_PROMPT=0 \
     git -C "$REPO" ls-remote "$SSH_ORIGIN" HEAD >/dev/null 2>&1; then
  SELECTED_ORIGIN="$SSH_ORIGIN"
  echo "GitHub SSH 连接成功，优先使用 SSH"
elif [[ "$(git -C "$REPO" ls-remote --get-url "$HTTPS_ORIGIN")" == "$HTTPS_ORIGIN" ]] &&
     HOME=/root GIT_TERMINAL_PROMPT=0 \
       git -C "$REPO" ls-remote "$HTTPS_ORIGIN" HEAD >/dev/null 2>&1; then
  SELECTED_ORIGIN="$HTTPS_ORIGIN"
  echo "GitHub SSH 不可用，已验证 HTTPS 可拉取；运行时仍会先重试 SSH"
else
  echo "GitHub SSH 和 HTTPS 均不可用，或 Git URL rewrite 指向非预期地址；无法安装更新服务" >&2
  exit 1
fi
if [[ "$ORIGIN" != "$SELECTED_ORIGIN" ]]; then
  git -C "$REPO" remote set-url origin "$SELECTED_ORIGIN"
  echo "已更新 Git origin: $SELECTED_ORIGIN"
fi
if [[ "$(git -C "$REPO" remote get-url origin)" != "$SELECTED_ORIGIN" ]]; then
  echo "Git URL rewrite 导致实际远端不是预期地址；拒绝安装" >&2
  exit 1
fi

# Fresh installations use the prebuilt public GHCR image; never build on the host.
if ! docker compose --project-directory "$REPO" -f "$REPO/docker-compose.yml" -p mv3c ps --status running --services 2>/dev/null | grep -qx mv3c; then
  if ! docker image inspect mv3c:local >/dev/null 2>&1; then
    echo "本地没有 mv3c 镜像，拉取 GitHub Actions 构建的镜像..."
    docker pull ghcr.io/b8vipvip/mv3c:main
    docker image tag ghcr.io/b8vipvip/mv3c:main mv3c:local
  fi
  docker compose --project-directory "$REPO" -f "$REPO/docker-compose.yml" -p mv3c up -d --no-build
fi
cat >/etc/systemd/system/mv3c-updater.service <<UNIT
[Unit]
Description=mv3c verified GitHub deployment updater
Wants=docker.service
After=docker.service network-online.target
[Service]
Type=oneshot
User=root
Environment=HOME=/root
WorkingDirectory=$REPO
ExecStart=/usr/bin/python3 $REPO/mv3c/updater/agent.py --repo $REPO
TimeoutStartSec=90min
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal
UNIT
cat >/etc/systemd/system/mv3c-updater.timer <<'UNIT'
[Unit]
Description=Check mv3c updates and manual deployment requests every minute
[Timer]
OnBootSec=1min
OnUnitInactiveSec=1min
AccuracySec=15s
Persistent=true
Unit=mv3c-updater.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now mv3c-updater.timer
systemctl start mv3c-updater.service
echo
echo "mv3c 宿主机更新服务已启用："
systemctl --no-pager status mv3c-updater.timer || true
echo "日志: journalctl -u mv3c-updater.service -n 100 --no-pager"
echo "后台: /admin -> 版本更新"
