# MV3C 本机缓存构建与自动部署

## 更新流程（与 chat2api 一致）

GitHub Actions 负责 **源码与 Docker 冒烟验证**，不向服务器上传 Docker 镜像，也不要求 GHCR、SCP 或额外的 Actions 上传 Secret。

服务器上的 `mv3c-updater.timer` 每分钟检查后台更新任务（自动检查间隔由后台配置）。任务只允许来自固定仓库 `b8vipvip/mv3c` 的 main 快进提交或正式 Release，且**目标提交的两项 Actions 必须均为成功**：

1. 通过 SSH 优先、HTTPS 备选的方式从 GitHub 拉取源码，验证目标提交及 CI。
2. 检查 Docker 数据目录空余容量（至少 3 GiB）并保留当前的 `mv3c:rollback` 镜像。
3. Git 快进到经过 CI 验证的提交，在宿主机执行 `docker build`，生成 `mv3c:sha-<commit>` 候选镜像。旧服务始终继续运行。
4. BuildKit 自动复用本机已存在的镜像层；Dockerfile 在拷贝源码前安装 workspace 依赖，`package-lock.json` 未变时重用 `npm ci` 整层。依赖变更时则复用持久化的 `mv3c-npm-cache` npm 下载缓存（`--prefer-offline`）。
5. 通过镜像 `org.opencontainers.image.revision` 标签核验精确 Git SHA；**仅成功后**将 `mv3c:local` 指向新镜像，并执行 `docker compose up -d --no-build --pull never --no-deps --force-recreate mv3c`。
6. 验证新容器 `healthy`、`/readyz`、`/api/config`；失败则恢复 Git、旧镜像及服务。保留 MongoDB、上传文件、密钥和日志数据卷，不执行 `down -v`、`docker system prune`、`docker builder prune`。

构建失败**不会**停止或重启旧容器。构建中途异常退出时，下一次更新器执行将依据本地事务日志恢复 Git 和旧镜像，并核验运行状态，防止 Git/镜像版本不一致。

## 首次部署

在实际运行 MV3C 的 Ubuntu Docker 宿主机执行：

```bash
sudo mkdir -p /opt
cd /opt
sudo -H git clone https://github.com/b8vipvip/mv3c.git
cd /opt/mv3c

# 首次启动，在服务器构建（之后会复用缓存）
sudo DOCKER_BUILDKIT=1 docker compose up -d --build
sudo bash mv3c/updater/install.sh
sudo systemctl status mv3c-updater.timer --no-pager
```

仓库应由 root 拥有（`/opt/mv3c` 为推荐路径），服务端需安装 Docker Compose v2、启用 BuildKit，并可访问 GitHub 源码和首次依赖下载所需的 npm、Alpine 等软件源。

后台登录后前往「版本更新」，可选择 main / Release、自动更新或手动部署、查看阶段和下载任务日志。

## 从旧的 SCP / 预构建镜像更新器迁移（仅执行一次）

**以下命令在实际 MV3C 服务器运行，不能直接在 GitHub Actions 内运行。** 先在 GitHub 确认新提交的 `mv3c validation` 和 `mv3c source Docker build` 均通过。确认实际安装路径；若不是 `/opt/mv3c`，请替换所有对应路径。

```bash
# 防止旧版定时任务并发触发
sudo systemctl stop mv3c-updater.timer

# 从可信仓库取得新提交，不修改当前运行容器
sudo git -C /opt/mv3c fetch https://github.com/b8vipvip/mv3c.git \
  main:refs/remotes/origin/main

# 从已拉取的 main 提交提取新更新器（不需先把旧 Git checkout 重置）
sudo sh -c 'git -C /opt/mv3c show refs/remotes/origin/main:mv3c/updater/agent.py > /root/mv3c-local-bootstrap.py'

# 使用新代码一次性升级；要求 GitHub CI 已通过，利用本机缓存构建并验收
sudo python3 /root/mv3c-local-bootstrap.py --repo /opt/mv3c --bootstrap-local

# 只有确认 bootstrap 成功、站点健康后，重新安装/启用正式更新器
sudo bash /opt/mv3c/mv3c/updater/install.sh
sudo systemctl start mv3c-updater.timer
sudo journalctl -u mv3c-updater.service -n 100 --no-pager
```

若 bootstrap 失败：**保留旧容器、Docker 镜像与数据卷**，不要手动删除镜像或强行 Git reset。查看错误日志，必要时按实际结果恢复更新器 timer。更新器自身在构建失败时负责 Git 回滚；若宿主机异常重启则会在下次执行恢复事务日志。

**迁移锁与回滚排查：** 若看到 `Another mv3c update check is already running`，说明其他更新任务持有锁，首次 bootstrap 尚未启动，不得将其视为迁移成功。先停止 timer，确认已有 `mv3c-updater.service` 执行结束，再重新运行 bootstrap；无需删除锁文件。新的 bootstrap 遇到锁冲突会返回非零退出码，阻止部署脚本错误地继续安装。安装脚本只启用 timer，不再同步等待可能耗时很长的 oneshot 更新器。若看到 `mv3c update: rolled_back`，表示部署失败后已恢复旧版本，**不是**新版本部署成功。到管理后台「版本更新」→「最近更新记录」下载该次部署诊断报告，其 `error` / `Deployment log` 才是定位构建、网络或镜像失败的关键证据；宿主机 `journalctl -u mv3c-updater.service` 也会输出简短失败原因。

之前添加的 `MV3C_SCP_*` Actions Secrets 不再参与部署；可以在验证迁移后手动撤销上传密钥并删除对应 Secrets。专用的 `mv3c-transfer` 用户如果已存在，不建议在未检查其它用途前直接删除。

## 缓存、资源与故障排查

- **缓存持久性**：同一 Docker daemon/BuildKit builder 中，正常 `docker build` 会复用未失效的分层缓存；Dockerfile 使用 `RUN --mount=type=cache,id=mv3c-npm-cache` 保存 npm 包。无需手动设置 `docker pull` 或重复下载全部 node_modules；当 lockfile 发生变化时依赖安装可能会重新执行，但已缓存 npm 包可重复使用。
- **不要清除构建缓存**：不要运行 `docker system prune -a`、`docker builder prune` 或 `docker build --no-cache`，除非明确诊断缓存损坏且有足够可用空间。
- **内存**：构建默认使用 `NODE_MAX_OLD_SPACE_SIZE=3072`（MiB），可通过 systemd 环境变量 `MV3C_BUILD_NODE_HEAP_MB=2048` 等按宿主机内存调整，范围 1024–8192。需要给 Docker/Node 构建留足内存与 swap，不能保证所有小内存 VPS 都能顺利构建。
- **磁盘**：构建前要求 Docker 数据目录至少 3 GiB 可用（并非构建一定只占 3 GiB），新旧镜像和构建缓存会暂时并存。先用 `df -h /var/lib/docker`、`docker system df` 检查，避免删除 MongoDB 或业务数据卷。
- **Git 获取**：默认优先非交互 SSH，失败回退固定 HTTPS 地址；必须保持 `main`、Git 工作区没有已跟踪文件修改，且通过固定来源的 CI。前端容器无 Docker socket 权限。
- **更新日志**：`sudo journalctl -u mv3c-updater.service -n 200 --no-pager`。后台更新记录可下载本次任务诊断报告，包含阶段、错误原因和验收结果。
- **健康检查**：更新后必须核验运行镜像、容器健康及两个 HTTP 接口。数据库结构不可逆升级需要单独备份；镜像回滚并不等同于数据库数据回滚。

如需手动查看当前运行状态：

```bash
cd /opt/mv3c
sudo docker compose ps
sudo docker system df
sudo systemctl status mv3c-updater.timer --no-pager
sudo journalctl -u mv3c-updater.service -n 120 --no-pager
```
