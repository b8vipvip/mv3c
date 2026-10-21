# mv3c 版本更新与自动部署

## 架构与安全

- 管理员在 /admin →「版本更新」管理自动更新、通道、检查间隔，查看版本、任务、日志；数据保存在 MongoDB。
- Linux 宿主机 systemd timer 每分钟检查是否有管理员任务；按后台配置的 5–60 分钟间隔检查 GitHub。
- 网站容器不挂载 Docker Socket，不直接执行 Git、Docker 或任意 shell 命令。
- **自动更新与后台手动更新均优先通过 SSH 拉取 Git 代码**：首先使用 git@github.com:b8vipvip/mv3c.git；若 SSH 连接失败或超时，自动回退至 https://github.com/b8vipvip/mv3c.git。两种协议都失败才报错；禁止重定向到其他 Git 仓库。目标提交必须是已部署版本的快进后代，且 GitHub Actions 中 mv3c validation 和 mv3c source Docker build 两项都成功。GitHub API 的版本/CI 元数据查询仍通过 HTTPS 完成。
- 部署：在 GitHub Actions 上完成构建与验证，经 SSH/SCP 向宿主机发送固定提交 SHA 的压缩镜像文件；宿主机核对 SHA-256 与镜像提交标签 → Git 快进 → 本地镜像标签更新 → `docker compose up --no-build --pull never` → 健康检查；失败直接恢复旧提交与旧镜像，**不在服务器执行构建**。
- 不删除 MongoDB、密钥和上传文件的数据卷；数据库 schema 迁移无法保证回滚，需单独备份。

## 一次性安装

在**实际运行 mv3c 的 Linux Docker 宿主机**执行。推荐将仓库放在 root 拥有的 /opt/mv3c，防止其他本机用户修改自动部署的代码。

~~~bash
sudo mkdir -p /opt
cd /opt
sudo -H git clone git@github.com:b8vipvip/mv3c.git
cd /opt/mv3c
sudo docker compose up -d --build

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

- 后台「版本更新」每 3 秒刷新进度；阶段依次覆盖 GitHub 拉取/CI、旧镜像备份、Git 快进、SSH/SCP 镜像存档校验与导入、容器重启和验证。百分比只表示已到达的真实阶段，构建阶段可停留数分钟。
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
- 等待 CI 通过：GitHub 最新目标提交的两项 Actions 尚未成功，自动/手动更新都会被阻止。
- 本地文件有修改：先提交或撤销 Git 已跟踪文件的本地更改。
- 已回滚上一版本：新版本部署失败并尝试恢复旧应用。失败的提交会暂停自动重试，直到 GitHub 出现新的提交或管理员主动手动重试。**数据库迁移不回滚**。
- GitHub Release 不存在：选择 main 通道，或在 GitHub 先发布正式 Release。

宿主机更新服务具有 Docker 部署权限，以 root 运行；只能从固定仓库更新并执行固定的 Compose 命令，不能接受管理员提交的任意命令、仓库地址或 Git SHA。

## GitHub Actions → SSH/SCP → mv3c 部署（当前方案）

GitHub Actions 在完成前端/后端 Docker 构建与真实健康测试后执行：

1. `docker tag mv3c:ci mv3c:sha-<40位提交SHA>`，`docker save`，`gzip -1` 生成压缩存档。
2. 计算原始压缩文件 SHA-256；**通过 GitHub Actions 中配置的 SSH 私钥**将存档和校验和通过 SCP 传到 Ubuntu。
3. 宿主机更新器只在目标 Commit 的两项 GitHub CI 均通过时尝试部署；先验证文件存在、checksum、大小及 `docker load` 后镜像 `org.opencontainers.image.revision` 完整匹配。
4. 按现有的 `docker compose up -d --no-build --pull never --no-deps --force-recreate mv3c` 切换，验证健康及 HTTP；失败恢复之前的 `mv3c:rollback` 和旧 SHA。

**服务器不再执行 `docker pull ghcr.io`、`docker compose build`、`npm ci`。** 用户数据卷与 MongoDB 不改变。没有成功上传的归档时更新器直接阻断，不触发容器重启。镜像仍然很大；SCP 并不保证在所有线路上比 GHCR 快，但能够使用 Actions 主机到 Ubuntu 的另一条网络路径。

### 1. 宿主机配置独立的上传账户（一次）

推荐使用一个**不能 sudo、不能访问 Docker Socket、不能写入 mv3c Git 源码**的 Linux 上传账号。本方案默认文件收件地址固定为 `/var/lib/mv3c-prebuilt/incoming`，请在 Ubuntu 宿主机由管理员执行：

~~~bash
sudo useradd --create-home --shell /bin/bash mv3c-transfer
sudo install -d -o mv3c-transfer -g mv3c-transfer -m 0700 /var/lib/mv3c-prebuilt/incoming
sudo install -d -o mv3c-transfer -g mv3c-transfer -m 0700 /home/mv3c-transfer/.ssh
# 先在你自己信任的电脑上生成独立 SSH ED25519 密钥对；仅在服务器
# 的 /home/mv3c-transfer/.ssh/authorized_keys 添加 PUBLIC key。
# authorized_keys 文件权限 0600，目录 0700，owner mv3c-transfer。
~~~

如果 `mv3c-transfer` 已存在，不要重复 `useradd`，只检查账号所属组无 sudo/docker 权限。使用现有普通 SSH 用户也可以，但不能让 Actions 直接使用 root 密码或 root 私钥。

端口 22 只是默认；如用自定义端口，应确认防火墙仅开放必要连接。**此账号只用于上传存档，不要加入 docker 或 sudo 组**。系统已经使用 SSH Key 的 GitHub `git fetch` 功能，不能自动授予 GitHub Actions 反向登录服务器的权限。

### 2. 配置仓库 GitHub Actions Secrets

进入 `b8vipvip/mv3c` → Settings → Secrets and variables → Actions → Repository secrets：

| Secret | 用途 |
|---|---|
| `MV3C_SCP_HOST` | Ubuntu SSH 对外 IP 或域名，**不要**填 `http://` 或端口 |
| `MV3C_SCP_USER` | `mv3c-transfer` 或另一个普通上传账户 |
| `MV3C_SCP_PRIVATE_KEY` | 独立 ED25519 私钥全文，仅存于 GitHub Actions Secrets |
| `MV3C_SCP_KNOWN_HOSTS` | 固定 SSH 主机公钥对应的完整 known_hosts 记录，必须先验证指纹 |
| `MV3C_SCP_PORT`（可选） | SSH 端口，默认 22 |

主机指纹应通过宿主机控制台上的 `/etc/ssh/ssh_host_ed25519_key.pub`，与另一侧 `ssh-keyscan -p <port> <host>` 获取的值比对后再固定，**不得**用 `StrictHostKeyChecking=no` 绕过验证。已存在的 GitHub 仓库读取 Deploy Key **不能**直接当作 GitHub Actions 登录这台服务器的上传私钥。

当 Secret 缺失时，Actions 仍会运行 CI，但会明确提示 `SCP delivery skipped`；缺少压缩镜像存档时宿主机更新器会拒绝更新，不会恢复服务器本地编译作为回退路径。添加凭据后可在 GitHub Actions → `mv3c source Docker build` → Run workflow（main）重新构建并发送镜像。

### 3. 检查存档并首次升级旧更新器

Action 成功上传后，在 **Ubuntu 服务器本机**检查：

~~~bash
sudo ls -lh /var/lib/mv3c-prebuilt/incoming/
df -h /
# 目标 main HEAD 和归档 SHA 必须匹配完整 40 位。
~~~

已有 mv3c 宿主机还在运行**旧的本地构建版更新器**。在验证新提交两项 GitHub CI 均通过、对应存档已经完整传输、当前业务可用之后，使用新 agent 的临时副本首次引导。以下仓库路径 `/opt/mv3c` 只是示例，应先确认实际安装目录：

~~~bash
sudo systemctl stop mv3c-updater.timer
cd /opt/mv3c
sudo git fetch https://github.com/b8vipvip/mv3c.git main:refs/remotes/origin/main
sudo sh -c 'git -C /opt/mv3c show refs/remotes/origin/main:mv3c/updater/agent.py > /root/mv3c-scp-bootstrap.py'
sudo python3 /root/mv3c-scp-bootstrap.py --repo /opt/mv3c --bootstrap-prebuilt
# 只有前一步成功，才执行：
sudo bash /opt/mv3c/mv3c/updater/install.sh
sudo systemctl start mv3c-updater.timer
~~~

如果有任何异常，停止操作并查看日志；没有确认新容器 healthy 前，不要手动删除旧版 `mv3c:local`、`mv3c:rollback` 镜像，也不要执行 `docker compose down -v` / `docker volume prune`。

### 4. 容量和账户安全

- 建议在发送大压缩包之前预留不少于 6GB 可用磁盘空间（实际按镜像大小变化）；`docker load --input ...tar.gz` 直接解压读取，无需落地未压缩 tar，但新旧 Docker 镜像必须在短期内共存以便回滚。
- SCP 的上传账户和 SSH key 应严格分离于 Git 仓库的只读 Deploy Key，不使用 root 身份上传。
- SHA-256 主要保证文件传输完整性；结合固定来源的 SSH Key、GitHub CI 和镜像提交标识完成多步验证。若 SSH 私钥被泄露，必须撤销授权。
- 新版保留更新失败后的旧镜像回滚；数据库 schema 的不可逆迁移仍应单独备份。

