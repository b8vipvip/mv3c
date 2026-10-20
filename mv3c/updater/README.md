# mv3c 版本更新与自动部署

## 架构与安全

- 管理员在 /admin →「版本更新」管理自动更新、通道、检查间隔，查看版本、任务、日志；数据保存在 MongoDB。
- Linux 宿主机 systemd timer 每分钟检查是否有管理员任务；按后台配置的 5–60 分钟间隔检查 GitHub。
- 网站容器不挂载 Docker Socket，不直接执行 Git、Docker 或任意 shell 命令。
- **GitHub Actions 负责构建**：`mv3c source Docker build` 使用 Buildx GitHub Actions 缓存，构建并集成测试通过后，将同一个镜像发布到 `ghcr.io/b8vipvip/mv3c:sha-<完整提交 SHA>`，并更新 `:main` 标签。PR 只构建和测试，不发布镜像。
- **服务器只负责部署预构建镜像**：自动更新与后台手动更新仍优先通过 SSH 拉取 Git 代码（SSH 失败回退固定 HTTPS），验证目标提交是快进后代并且 `mv3c validation` 与 `mv3c source Docker build` 两项 Actions 都成功，然后拉取与目标完整 SHA 对应的 GHCR 镜像、切换容器并验证健康状态。GitHub API 元数据查询仍通过 HTTPS。
- 失败时恢复更新前保存的本地镜像并重新验证；服务器部署过程不执行 `docker compose build`，也不在服务器重新安装 npm 依赖。
- 不删除 MongoDB、密钥和上传文件的数据卷；数据库 schema 迁移无法保证回滚，需单独备份。

## 一次性安装

在**实际运行 mv3c 的 Linux Docker 宿主机**执行。推荐将仓库放在 root 拥有的 /opt/mv3c，防止其他本机用户修改自动部署的代码。

~~~bash
sudo mkdir -p /opt
cd /opt
sudo -H git clone git@github.com:b8vipvip/mv3c.git
cd /opt/mv3c
sudo docker pull ghcr.io/b8vipvip/mv3c:main
sudo docker tag ghcr.io/b8vipvip/mv3c:main mv3c:local
sudo docker compose up -d --no-build

# 可选：验证 systemd 使用的 root 身份能否通过 SSH 访问 GitHub
sudo -H env GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15' \
  git ls-remote git@github.com:b8vipvip/mv3c.git HEAD

# 一次性安装宿主机更新服务
sudo bash mv3c/updater/install.sh

# 检查
sudo systemctl status mv3c-updater.timer
sudo journalctl -u mv3c-updater.service -n 100 --no-pager
~~~

首次克隆如果 SSH 不可用，可以改用 `sudo -H git clone https://github.com/b8vipvip/mv3c.git`；安装后更新器仍会优先尝试 SSH。

**GHCR 首次启用需要一次性设置**：首次 GitHub Actions 成功发布镜像后，打开 GitHub 账号 `b8vipvip` 的 Packages，进入 `mv3c` 容器包的 Package settings，将包可见性设为 **Public**。公开镜像可让服务器免密拉取。如果不希望公开镜像，则必须先以 root 身份配置具备 `read:packages` 权限的 GHCR 凭据。若自动更新在包仍为 Private 时失败，改为 Public 后在后台手动重新触发更新。

若已经安装旧版 mv3c，先升级仓库到包含此功能的版本并确认站点正常，再执行上述安装脚本。无需创建 .env，也无需将 Docker Socket 暴露给网站容器。

安装脚本会验证 Git origin、main 分支、仓库目录的 root 所有权以及已跟踪文件没有未提交修改；先测试 root 的 SSH 访问，失败时测试固定的 HTTPS 地址。SSH 成功则优先将 origin 设为 SSH；仅 HTTPS 成功时设为 HTTPS。两者都失败才中止安装。如果仓库不是 root 拥有，请确认是正确的仓库后修改所有权（例如在 /opt 目录执行 sudo chown -R root:root /opt/mv3c）。

如果 SSH Key 配在 ubuntu 用户而不是 root 用户，宿主机更新服务会自动尝试 HTTPS 回退；若希望优先 SSH 成功，请为 root 配置独立的只读 GitHub Deploy Key（或确保 root 可使用现有已授权 SSH 身份），并提前核验 github.com 的主机密钥。不要禁用 StrictHostKeyChecking，也不要将私钥存进网页后台或 .env。私有仓库的 HTTPS 回退需要可用凭据；公开仓库通常无需凭据。

## 后台使用

管理员登录后进入 /admin →「版本更新」：

1. 查看当前已部署 Git SHA、GitHub 最新 SHA、检查时间、更新服务在线状态。
2. 开启或关闭自动更新，选择 **main**（默认，main 分支最新通过 CI 的提交）或 **Release**（最新 GitHub Release；仓库必须先发布 Release），选择检查间隔并保存。
3. 「立即检查 GitHub」提交检查请求；宿主机通常在下一次约 1 分钟的定时运行时处理。
4. 「立即更新并部署」提交手动任务；关闭自动更新也能手动执行，但不会绕过 GitHub CI 门禁。
5. 查看状态、最近任务、部署日志。更新期间网站可能短暂重启。

默认自动更新开启，每 10 分钟检查 GitHub。**必须先在宿主机安装并启用更新服务**，否则后台只能保存请求，无法执行部署。

## 更新进度、自动验证和下载报告

- 后台「版本更新」每 3 秒刷新进度；阶段依次覆盖 GitHub 拉取/CI、旧镜像备份、Git 快进、从 GHCR 拉取已验证镜像、容器重启和验证。服务器不会本地构建；镜像传输耗时取决于镜像大小和网络。
- 部署成功必须确认目标 Git SHA、容器 `healthy` 状态、本机 `http://127.0.0.1:3080/readyz` 和 `/api/config` 两项 HTTP 200。验证失败触发旧版应用回滚及再次验证。
- 每次任务的结果、阶段时间线、SHA、耗时、验证结果与限长日志保存至 MongoDB。管理员可在「最近更新记录」下载该任务的 `.log` 诊断报告，最多保留最近 20 次；下载接口要求管理员 Bearer Token。
- 更新器意外中断时，下一次运行先核对当前 Git 版本与网站健康状况：只有部署目标实际匹配且验证通过才认定成功，否则标记失败并保留诊断，绝不因进度到 100% 就判定成功。
- **首次从旧版更新器升级到新版**时，执行升级的旧版宿主机脚本不会产生新的阶段事件。首次升级后下一次更新才会完整显示进度。现有 systemd 服务直接使用仓库内 Python 脚本，无需重新安装。
- 报告包含阶段记录和一定长度的构建/部署输出摘要；完整的 systemd 运行日志仍可在宿主机使用 `journalctl -u mv3c-updater.service -n 300 --no-pager` 查询。

## 运维与排错

~~~bash
sudo systemctl status mv3c-updater.timer
sudo journalctl -u mv3c-updater.service -n 150 --no-pager
sudo systemctl start mv3c-updater.service
cd /opt/mv3c
sudo docker compose logs --tail=200 mv3c
~~~

- 更新服务未连接：确认 timer 已启用、Docker Compose 可运行、网站容器和数据库正常。
- SSH 拉取失败：自动尝试 HTTPS；若两种方式均失败，后台展示组合错误。版本标签和 main 分支均适用，最新版本标签会标注 SSH 或 HTTPS 回退。
- 等待 CI / 镜像发布：GitHub 最新目标提交的两项 Actions 尚未成功并发布镜像，自动/手动更新都会被阻止。
- GHCR 拉取被拒绝：检查 `ghcr.io/b8vipvip/mv3c` 是否已设为 Public，或为 root 配置 `read:packages` 凭据。
- 本地文件有修改：先提交或撤销 Git 已跟踪文件的本地更改。
- 已回滚上一版本：新版本部署失败并尝试恢复旧应用。失败的提交会暂停自动重试，直到 GitHub 出现新的提交或管理员主动手动重试。**数据库迁移不回滚**。
- GitHub Release 不存在：选择 main 通道，或在 GitHub 先发布正式 Release。

宿主机更新服务具有 Docker 部署权限，以 root 运行；只能从固定仓库更新并执行固定的 Compose 命令，不能接受管理员提交的任意命令、仓库地址或 Git SHA。
