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
ORIGIN="$(git -C "$REPO" remote get-url origin)"
if [[ "$ORIGIN" != "https://github.com/b8vipvip/mv3c.git" &&
      "$ORIGIN" != "git@github.com:b8vipvip/mv3c.git" &&
      "$ORIGIN" != "https://github.com/b8vipvip/mv3c" ]]; then
  echo "Git origin 不是受信任的 b8vipvip/mv3c 仓库" >&2
  exit 1
fi
if [[ "$(git -C "$REPO" branch --show-current)" != "main" ]]; then
  echo "请先切换到 mv3c main 分支" >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]]; then
  echo "工作区存在已跟踪文件修改；请先处理，避免自动更新覆盖更改" >&2
  exit 1
fi
cat >/etc/systemd/system/mv3c-updater.service <<UNIT
[Unit]
Description=mv3c verified GitHub deployment updater
Wants=docker.service
After=docker.service network-online.target
[Service]
Type=oneshot
User=root
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
