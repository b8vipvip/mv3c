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
# The only authorized host updater is mv3c-updater.{service,timer}.
# Refuse to overwrite an executing updater or install alongside a second unit.
if systemctl is-active --quiet mv3c-updater.service; then
  echo "MV3C updater is still running; wait before replacement" >&2
  exit 1
fi
mapfile -t CONFLICTING_UNITS < <(
  systemctl list-unit-files --all --no-legend --no-pager |
  awk '$1 ~ /^mv3c[-_].*(updat|deploy).*\.(service|timer)$/ &&
       $1 != "mv3c-updater.service" && $1 != "mv3c-updater.timer" {print $1}'
)
if (( ${#CONFLICTING_UNITS[@]} )); then
  printf "Found competing MV3C updater/deployer units; refusing installation:\n" >&2
  printf "  %s\n" "${CONFLICTING_UNITS[@]}" >&2
  echo "Inspect and retire these exact units before enabling the canonical updater." >&2
  exit 1
fi
# Refuse inherited service drop-ins which could add alternate ExecStart.
for OVERRIDE_DIR in /etc/systemd/system/mv3c-updater.service.d /run/systemd/system/mv3c-updater.service.d /etc/systemd/system/mv3c-updater.timer.d /run/systemd/system/mv3c-updater.timer.d; do
  if [ -d "$OVERRIDE_DIR" ] && compgen -G "$OVERRIDE_DIR/*.conf" >/dev/null; then
    echo "Unexpected MV3C updater service drop-ins: $OVERRIDE_DIR" >&2
    exit 1
  fi
done
# Stop the previous canonical timer before replacing its exact systemd unit.
systemctl disable --now mv3c-updater.timer >/dev/null 2>&1 || true
SSH_ORIGIN="git@github.com:b8vipvip/mv3c.git"
HTTPS_ORIGIN="https://github.com/b8vipvip/mv3c.git"
ORIGIN="$(git -C "$REPO" config --local --get remote.origin.url)"
case "$ORIGIN" in
  "$SSH_ORIGIN"|"https://github.com/b8vipvip/mv3c.git"|"https://github.com/b8vipvip/mv3c") ;;
  *) echo "Git origin 不是受信任的 b8vipvip/mv3c 仓库" >&2; exit 1 ;;
esac
command -v timeout >/dev/null || { echo "缺少 timeout 命令" >&2; exit 1; }
# Official pinned GitHub Ed25519 host key, not an unauthenticated ssh-keyscan.
KNOWN_HOSTS="/run/mv3c-github-known-hosts"
[[ ! -L "$KNOWN_HOSTS" ]] || { echo "拒绝链接形式的 GitHub known_hosts" >&2; exit 1; }
umask 077
printf '%s\n' \
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  'ssh.github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  > "$KNOWN_HOSTS"
chmod 600 "$KNOWN_HOSTS"
SSH_COMMON="-o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519"
SSH_443="ssh $SSH_COMMON -o HostName=ssh.github.com -o Port=443 -o HostKeyAlias=ssh.github.com"
SSH_22="ssh $SSH_COMMON -o HostKeyAlias=github.com"
# Installer probes only fixed trusted origins, just like runtime. Every probe has a cap.
if [[ "$(git -C "$REPO" ls-remote --get-url "$SSH_ORIGIN")" == "$SSH_ORIGIN" ]] &&
    HOME=/root GIT_SSH_COMMAND="$SSH_443" GIT_TERMINAL_PROMPT=0 \
      timeout 35s git -C "$REPO" ls-remote "$SSH_ORIGIN" HEAD >/dev/null 2>&1; then
  SELECTED_ORIGIN="$SSH_ORIGIN"
  echo "GitHub SSH-443 连接成功"
elif [[ "$(git -C "$REPO" ls-remote --get-url "$SSH_ORIGIN")" == "$SSH_ORIGIN" ]] &&
    HOME=/root GIT_SSH_COMMAND="$SSH_22" GIT_TERMINAL_PROMPT=0 \
      timeout 35s git -C "$REPO" ls-remote "$SSH_ORIGIN" HEAD >/dev/null 2>&1; then
  SELECTED_ORIGIN="$SSH_ORIGIN"
  echo "GitHub SSH-22 连接成功"
elif [[ "$(git -C "$REPO" ls-remote --get-url "$HTTPS_ORIGIN")" == "$HTTPS_ORIGIN" ]] &&
    HOME=/root GIT_TERMINAL_PROMPT=0 \
      timeout 35s git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1024 \
        -c http.lowSpeedTime=12 -C "$REPO" ls-remote "$HTTPS_ORIGIN" HEAD >/dev/null 2>&1; then
  SELECTED_ORIGIN="$HTTPS_ORIGIN"
  echo "GitHub SSH 均不可用，HTTPS HTTP/1.1 回退成功"
else
  echo "GitHub SSH-443 / SSH-22 / HTTPS 均不可达，拒绝安装更新服务" >&2
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
# OnActiveSec schedules the first run after re-enabling the timer even if
# OnBootSec elapsed hours ago; OnUnitInactiveSec handles later cycles.
OnActiveSec=1min
OnUnitInactiveSec=1min
AccuracySec=15s
Unit=mv3c-updater.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
# The timer schedules the first run. Do not synchronously start the oneshot
# here: it can take up to 90 minutes and race with a one-time bootstrap.
systemctl enable --now mv3c-updater.timer
# Remove only positively identified obsolete one-shot migration entrypoints.
# They are not used by the canonical service and must not survive as
# independently callable deployment scripts on the host.
for OLD_SCRIPT in /root/mv3c-verified-git-bootstrap.py /root/mv3c-migrate-git-only.sh; do
  if [ -f "$OLD_SCRIPT" ] && [ ! -L "$OLD_SCRIPT" ]; then
    if grep -Eq "mv3c/updater/agent.py|migrate-git-only|Host-only mv3c updater|Bootstrap fetch:" "$OLD_SCRIPT"; then
      rm -- "$OLD_SCRIPT"
      echo "已清理旧一次性部署入口：$OLD_SCRIPT"
    else
      echo "历史文件内容不符合预期，未删除：$OLD_SCRIPT" >&2
    fi
  fi
done
echo
echo "mv3c 宿主机更新服务已启用："
systemctl --no-pager status mv3c-updater.timer || true
echo "日志: journalctl -u mv3c-updater.service -n 100 --no-pager"
echo "后台: /admin -> 版本更新"
