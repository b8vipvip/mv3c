# MV3C 本机缓存构建与自动部署

## 更新流程（与 chat2api 一致）

GitHub Actions 负责 **源码与 Docker 冒烟验证**，不向服务器上传 Docker 镜像，也不要求 GHCR、SCP 或额外的 Actions 上传 Secret。

服务器上的 `mv3c-updater.timer` 每分钟检查后台更新任务（自动检查间隔由后台配置）。任务只允许来自固定仓库 `b8vipvip/mv3c` 的 main 快进提交或正式 Release，且**目标提交的两项 Actions 必须均为成功**：

1. 通过 SSH 优先、HTTPS 备选的方式从 GitHub 拉取源码，验证目标提交及 CI。
2. 检查 Docker 数据目录空余容量（至少 **8 GiB**），不足时拒绝构建，当前容器不受影响；同时记录共享 BuildKit 缓存用量，并保留当前的 `mv3c:rollback` 镜像。
3. Git 快进到经过 CI 验证的提交，在宿主机执行 `docker build`，生成 `mv3c:sha-<commit>` 候选镜像。旧服务始终继续运行。
4. BuildKit 自动复用本机已存在的镜像层；Dockerfile 在拷贝源码前安装 workspace 依赖，`package-lock.json` 未变时重用 `npm ci` 整层。依赖变更时则复用持久化的 `mv3c-npm-cache` npm 下载缓存（`--prefer-offline`）。
5. 通过镜像 `org.opencontainers.image.revision` 标签核验精确 Git SHA；**仅成功后**将 `mv3c:local` 指向新镜像，并执行 `docker compose up -d --no-build --pull never --no-deps --force-recreate mv3c`。
6. 构建完成后至少保留 **2 GiB** 可用空间才允许切换；验证新容器 `healthy`、`/readyz`、`/api/config`；失败则恢复 Git、旧镜像及服务。
7. **只有在新版本健康验证通过并移除更新事务日志之后**，尝试移除旧的 `mv3c:sha-<40位提交>` 标签。已运行容器、停用容器、`mv3c:local`、`mv3c:rollback` 所引用的镜像始终受保护，每次最多处理 5 个标签。清理失败仅记录警告，不把已经成功运行的部署误判为失败或触发回滚。保留 MongoDB、上传文件、密钥和日志数据卷，不执行 `down -v`、`docker system prune`、`docker builder prune`。

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

## Python / MCP 工具下载源（项目独立配置）

MV3C 的主 Docker 构建使用 npm，并通过 Alpine `apk` 安装 `python3`、`py3-pip` 和 `uv`，**没有**执行 `pip install`。因此宿主机 `/etc/pip.conf` 不会改变 Docker 构建过程，也不会自动作用到容器中的 `uvx`。

针对 MV3C 运行时可能执行的 Python / MCP 工具下载，Compose 将以下变量传入 MV3C 容器：`UV_DEFAULT_INDEX`（uv / uvx）和 `PIP_INDEX_URL`（pip）。两者默认官方 `https://pypi.org/simple`，避免改变其他部署环境的行为。境内服务器如需改用清华镜像，在 **Git 不跟踪的** `/opt/mv3c/.env` 中追加：

```dotenv
MV3C_PYPI_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
```

修改后在维护窗口通过原有正式更新流程重新创建 MV3C 服务容器后才会生效；只重读文件不会动态修改正在运行进程的环境。请不要在运行期间执行全局 Docker 缓存清理，不要手动覆盖仓库中受 Git 管理的 Compose 文件。其他 Docker 服务不会受到这个选项影响。

这不是自动镜像站故障切换：`uvx` 在所选镜像站缺少包或镜像站不可用时仍可能失败。可以把配置改回 `https://pypi.org/simple`，再重建容器配置。不要全局同时添加官方 PyPI 作为 `extra-index-url`，以免引入依赖混淆风险。

## 运行镜像瘦身（多阶段 Dockerfile）

从本轮起，MV3C 使用共享 Node/Alpine `base`、完整依赖和前端编译 `build`、最小运行文件 `runtime` 三个 Docker 构建阶段：

- `build` 继续运行带 BuildKit `mv3c-npm-cache` 下载缓存的 `npm ci`、所有必需内部 workspace 的构建与前端构建，再执行 `npm prune --omit=dev`。
- `runtime` 从干净的 `base` 继承 Node、Python、uv、jemalloc，再 **COPY 构建完成后的 /app**。它不再继承此前完整开发依赖安装产生的历史镜像层；保持所有运行时目录、`mv3c/entrypoint.sh`、`/app/data` 和 Compose 卷路径不变。
- 不清理共享的 BuildKit 缓存，因此生产宿主机下次重新构建仍可复用 npm 包及稳定的依赖层。多阶段构建降低的是**最终镜像层体积与更新时同时保留两版镜像的成本**，不会保证 BuildKit 总缓存减少。
- GitHub Actions 对完整编译阶段和最终运行阶段分别度量 `docker image inspect --format '{{.Size}}'`，要求最终镜像更小；原有首次用户注册、管理员配置、更新器集成及 readyz 的冒烟测试照常在最终 `runtime` 镜像运行。
- 上线前仍使用 8 GiB 构建前检查与 2 GiB 切换前检查；须在多次服务器实机升级、磁盘峰值记录可信后，才重新评估阈值。不得仅凭 CI 的镜像大小推断宿主机的总 Docker 存储占用。

## 缓存、资源与故障排查

### 安全磁盘与共享缓存管理

- **构建前预检**：`/var/lib/docker` 所在分区不足 8 GiB 空闲时停止升级，旧容器照常服务，避免构建途中写满 40GB 根盘。构建成功后若剩余不足 2 GiB，也拒绝切换并恢复旧 Git 状态与服务。该阈值并非对构建磁盘使用量的硬性限制。
- **共享 BuildKit 软上限**：通过 `docker system df --format '{{json .}}'` 读取整机 Build Cache 使用量，超过 **4 GiB** 时写入诊断日志警告。**它是预警线，不是硬性容量配额，也不会自动清理缓存**，因为默认 Docker builder 同时服务 Chat2API、MV3C 等项目，无法安全按项目区分每一层的所有权。用户可以在发现持续增长后评估专用 builder / 独立磁盘，而不是允许 MV3C 擅自全局 prune。
- **项目专属镜像保留**：更新成功后只尝试清理过期的 `mv3c:sha-<40位SHA>` 候选镜像标签，并要求镜像修订标签与 SHA 一致；永远不会删除 `mv3c:local` 或 `mv3c:rollback`、其他仓库的镜像或运行/停止容器所引用的镜像。Docker 自身还有一层无需 `-f` 的引用保护；镜像层与 BuildKit 缓存若共用数据，删除标签后实际空间释放可能为零。
- **缓存复用**：不会运行 `docker builder prune -a`，不删除 BuildKit `mv3c-npm-cache` 下载缓存；正常情况下下一次构建继续复用已有层，依赖变更时继续利用 npm 缓存。
- **只读人工检查**：`df -h / && docker system df -v && docker buildx du`。当缓存超过软上限时，优先评估磁盘扩容、独立 BuildKit builder，再决定是否在维护窗口执行人工回收。不要自动删除业务 Docker 数据卷或其他项目的镜像。

- **缓存持久性**：同一 Docker daemon/BuildKit builder 中，正常 `docker build` 会复用未失效的分层缓存；Dockerfile 使用 `RUN --mount=type=cache,id=mv3c-npm-cache` 保存 npm 包。无需手动设置 `docker pull` 或重复下载全部 node_modules；当 lockfile 发生变化时依赖安装可能会重新执行，但已缓存 npm 包可重复使用。
- **不要清除构建缓存**：不要运行 `docker system prune -a`、`docker builder prune` 或 `docker build --no-cache`，除非明确诊断缓存损坏且有足够可用空间。
- **内存**：构建默认使用 `NODE_MAX_OLD_SPACE_SIZE=3072`（MiB），可通过 systemd 环境变量 `MV3C_BUILD_NODE_HEAP_MB=2048` 等按宿主机内存调整，范围 1024–8192。需要给 Docker/Node 构建留足内存与 swap，不能保证所有小内存 VPS 都能顺利构建。
- **磁盘**：构建前要求 Docker 数据目录至少 8 GiB 可用（并非构建一定只占 8 GiB），新旧镜像和构建缓存会暂时并存。先用 `df -h /var/lib/docker`、`docker system df` 检查，避免删除 MongoDB 或业务数据卷。
- **Git 获取**：默认优先非交互 SSH，失败回退固定 HTTPS 地址；必须保持 `main`、Git 工作区没有已跟踪文件修改，且通过固定来源的 CI。前端容器无 Docker socket 权限。
- **更新日志**：`sudo journalctl -u mv3c-updater.service -n 200 --no-pager`。后台更新记录可下载本次任务诊断报告。宿主机还会将最新一次 **完整 Docker 构建输出**保存在仅 root 可读的 `/var/log/mv3c-updater-build.log`，供 `sudo tail -n 120 /var/log/mv3c-updater-build.log` 检查（每次构建覆盖，不需要再次部署即可提取日志）。遇到错误会从完整输出中提取关键错误行，避免被 Docker 下载进度刷屏覆盖。
- **Alpine 软件源故障与超时（2026-10）**：此前 `RUN apk upgrade --no-cache` 在受限主机上反复请求 `dl-cdn.alpinelinux.org/alpine/v3.24`，会导致长时间阻塞并以 `apk exit 99` 回滚。现在从固定、已测试的 Node/Alpine 基础镜像出发，不再每次无条件进行系统全量 `apk upgrade`；仅安装必需的 `jemalloc/python3/py3-pip/uv`，按顺序尝试阿里云、清华大学以及 Alpine 官方三个 HTTPS 软件源，每个源最多等待 120 秒。包索引和包签名继续由 apk 校验，所有源均失败则停止构建且旧容器继续运行，**绝不**使用 `--force-missing-repositories`。这项更改降低默认源不可达的失败概率，但不能保证主机对所有三个源都可达。若再失败，查看 `/var/log/mv3c-updater-build.log` 中的 `MV3C APK package installation via ...` 和最终网络错误；先诊断 DNS/TLS/代理/路由，不要继续盲目重试或清空 Docker 缓存。
- **受限镜像仓库**：历史 Dockerfile 同时通过 `apk add uv` 安装 `uv`，又从 GHCR 外部镜像复制 `uv/uvx`，使服务器本机构建额外依赖 GHCR 的镜像层下载。现改为仅依赖 Alpine 包管理器安装的 `uv` 与 `uvx`，构建时检查两个命令。不能由旧的下载进度片段证明故障层一定来自 GHCR；如果仍卡在 `FROM node:...` 或 apk 下载，需要用新的完整构建日志定位。由于 Dockerfile 变化可能使后续层缓存失效，首次改版构建可能重新执行 npm ci，但会尽量复用 BuildKit 包缓存。
- **健康检查**：更新后必须核验运行镜像、容器健康及两个 HTTP 接口。数据库结构不可逆升级需要单独备份；镜像回滚并不等同于数据库数据回滚。

如需手动查看当前运行状态：

```bash
cd /opt/mv3c
sudo docker compose ps
sudo docker system df
sudo systemctl status mv3c-updater.timer --no-pager
sudo journalctl -u mv3c-updater.service -n 120 --no-pager
```
