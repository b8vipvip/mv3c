# 正式生产更新流程（2026-10-26 起生效）

**此段优先于下面保留的旧版服务器本地构建流程说明。** GitHub Actions 在正式 Release 发布后派发 mv3c-prebuilt.yml，按准确的 release SHA 和 vX.Y.Z 构建生产镜像，通过经过 known_hosts 校验的 SSH/SCP 传到 /var/lib/mv3c-prebuilt/incoming；完成传输后才发布同 SHA 注解 image proof (mv3c-image/vX.Y.Z)，其中记录 archive_sha256、archive_size、image_id、image_size 和 Actions run ID。服务器唯一 agent.py 校验正式 Release 的双 CI 证明、image proof、完整归档 SHA256、OCI 镜像身份和最少剩余磁盘空间，随后通过原有 MongoDB 单任务生命周期、Docker Compose 健康检查及回滚事务执行。**生产路径不调用 Docker build、npm ci、prune；任何交付缺失/不匹配直接失败，不回退本地构建。**

## 一次性配置

需为 GitHub Actions Secrets 配置：MV3C_SCP_HOST、MV3C_SCP_PORT、MV3C_SCP_USER、MV3C_SCP_PRIVATE_KEY、MV3C_SCP_KNOWN_HOSTS。known_hosts 内容必须带外校验 SSH 服务端指纹，不接受 StrictHostKeyChecking=no。当前生产服务端使用独立非特权用户 mv3c-transfer，账号不应有 Docker 权限、root sudo 权限。服务器目录初始化由 root 执行：

    sudo install -d -o root -g root -m 0755 /var/lib/mv3c-prebuilt
    sudo install -d -o mv3c-transfer -g mv3c-transfer -m 0700 /var/lib/mv3c-prebuilt/incoming
    sudo install -d -o root -g root -m 0700 /var/lib/mv3c-prebuilt/verified

压缩 tar 和解包镜像需要足够磁盘。更新器采用保守预检：可用空间至少 2 GiB + 正式镜像逻辑尺寸 + 512 MiB，且切换时仍必须有 2 GiB。绝不自动清除共用 BuildKit 缓存、数据库卷、旧健康容器。正式版归档在导入后先隔离到仅 root 可读的 verified 目录，只有新版本完成健康校验后才精确删除本次已消费的传输归档，释放磁盘；若更新失败则留存供审计与人工诊断，不触碰共用 BuildKit 缓存或数据库卷。

保护 GitHub refs/tags/v*、refs/tags/mv3c-verified/v* 和 refs/tags/mv3c-image/v*：通过 rulesets 限制创建、改写、删除。这些 Git CI 证明依赖仓库写权限控制，并不是独立加密签名。GitHub 默认 GITHUB_TOKEN 发布 Release 不会自动触发另一条 release published 工作流，因此本仓库正式发布步骤显式 workflow_dispatch 派发镜像交付工作流。

## v0.1.22 现有宿主机第一次无构建升级

当前 v0.1.22 updater 还不懂 Actions 正式镜像证明，因此不能直接点击旧后台的“立即更新并部署”，否则可能转入旧版服务器本地 Docker 构建。

在新正式版的 mv3c verified prebuilt image delivery Actions 工作流成功、压缩镜像到达服务器 incoming 后，保存服务器快照，并从**经过发布证明核验的同一个正式 Release 提交**取得 mv3c/updater/bootstrap-prebuilt.sh，检查脚本代码后上传至服务器 /root/bootstrap-prebuilt.sh。root 手动执行：

    sudo bash /root/bootstrap-prebuilt.sh vX.Y.Z

参数换成实际最新正式版本号。脚本会停止旧 timer、验证源 Git ref/CI proof/镜像 proof 和完整归档 SHA256、验证空闲唯一队列，再以旧后台既有 queueJob 创建单个任务。随后提取同一官方 Release SHA 的新 agent.py + prebuilt.py 到 root-only 临时目录，仅此代理运行原始 /run/lock/mv3c-updater.lock / MongoDB completeJob / Docker 回滚；成功并验证健康后只原位安装同名更新器 systemd 服务。失败则旧容器仍应运行、定时器保持暂停以备诊断，绝不增加第二套部署器。

之后正常手动更新仍由原后台排队。镜像缺失、SSH 不可达、缺失证明、SHA 不匹配或容量不足都直接拒绝部署；不会回到旧的本地构建路径。**下一次正式版号不一定是 v0.1.25，务必以真实最新 Release 为准。**

---

# MV3C GitHub 正式版发布与服务器缓存部署

## 更新流程（与 chat2api 一致）

GitHub Actions 负责 **源码和 Docker 冒烟验证**。main 提交的两项 CI 全部成功后，`mv3c official release` 工作流自动创建版本标签（首次 `v0.1.0`、之后逐次递增补丁版本）并发布非预发布的 GitHub Release。**只有已发布正式版才允许进入生产部署**，不会部署未经发布的 main 提交。不向服务器上传 Docker 镜像，也不依赖 GHCR、SCP 或额外的 Actions 上传 Secret。

服务器上的 `mv3c-updater.timer` 每分钟检查后台更新任务（自动检查间隔由后台配置）。**与 chat2api 一样，宿主机仅使用 Git Smart 协议，无需 GitHub REST API Token**：SSH 443 → SSH 22 → HTTPS（HTTP/1.1、每条链路有界超时）。GitHub Actions 仍在发布正式 Release **且两项 main CI 都成功后**才写入不可缺失的带 CI 运行 ID 的注释标签 `mv3c-verified/vX.Y.Z`。宿主机只部署同时具有普通版本标签和此 CI/Release 发布证明、且落在可信 main 历史中的 SHA；最新标签缺少证明时拒绝更新而不回退到旧版本。请使用 GitHub 仓库 ruleset 限制谁可以创建/改写/删除 `v*` 和 `mv3c-verified/v*` 标签，因为这里是仓库权限控制的**发布证据**，不是外部密码学签名。

1. 通过 SSH 443 → SSH 22 → HTTPS 有界容灾拉取 GitHub main、正式版本标签和发布证明标签；在本机按精确 Git SHA、双 CI 成功字段、两条成功运行 ID 校验发布证明，不调用 `api.github.com`。
2. **先检查目标 SHA 是否已有经过完整 Release 元数据校验的 Docker 候选镜像**。如果存在，跳过构建专用的 3 GiB 预检门槛，仍必须满足切换前的 **2 GiB** 保留空间要求；如果不存在而需要重新构建，Docker 数据目录必须至少有 **7 GiB** 可用空间（此前 3 GiB 在实际生产构建中被证明不足），不足时拒绝构建，且不清理其他项目缓存和数据卷。
3. Git 快进到经过 CI 验证的提交，**先严格检查本机是否已有同一正式 Release SHA 的完整候选镜像**（精确的 OCI revision/version/source、运行环境版本、镜像层及 Image ID）；通过校验则直接复用并跳过构建，候选镜像不存在才执行 `docker build` 生成 `mv3c:sha-<commit>`；现有标签若校验不通过则拒绝部署，不能静默覆盖。旧服务始终继续运行。
4. BuildKit 自动复用本机已存在的镜像层；Dockerfile 在拷贝源码前安装 workspace 依赖，`package-lock.json` 未变时重用 `npm ci` 整层。依赖变更时则复用持久化的 `mv3c-npm-cache` npm 下载缓存（`--prefer-offline`）。
5. 通过镜像 `org.opencontainers.image.revision` 标签核验精确 Git SHA；**仅成功后**将 `mv3c:local` 指向新镜像，并执行 `docker compose up -d --no-build --pull never --no-deps --force-recreate mv3c`。
6. 构建完成后至少保留 **2 GiB** 可用空间才允许切换；验证新容器 `healthy`、`/readyz`、`/api/config`；失败则恢复 Git、旧镜像及服务。
   - 若失败发生在切换镜像标签及容器之前，只复位 Git checkout、清理更新事务，不重启原有健康容器，也不依赖可能暂时失效的 MongoDB DNS 进行完整回滚检查。此时状态仍为失败，不能误报为成功部署或已执行回滚。
7. **只有在新版本健康验证通过并移除更新事务日志之后**，尝试移除旧的 `mv3c:sha-<40位提交>` 标签。已运行容器、停用容器、`mv3c:local`、`mv3c:rollback` 所引用的镜像始终受保护，每次最多处理 5 个标签。清理失败仅记录警告，不把已经成功运行的部署误判为失败或触发回滚。保留 MongoDB、上传文件、密钥和日志数据卷，不执行 `down -v`、`docker system prune`、`docker builder prune`。

构建失败**不会**停止或重启旧容器。构建中途异常退出时，下一次更新器执行将依据本地事务日志恢复 Git 和旧镜像，并核验运行状态，防止 Git/镜像版本不一致。**镜像完整构建后若因剩余空间不足 2 GiB 而回滚，成功导出的 `mv3c:sha-<commit>` 候选镜像会保留。下次针对相同 Release SHA 重试时先验证并复用此镜像，避免反复支付 BuildKit 导出和额外磁盘峰值；如果发布了新 SHA，旧候选不得冒充新版本，仍需构建新 SHA。**

## 已有生产站点：无并行更新器的原地升级

此前一次性 REST/SCP 迁移脚本和 bootstrap 独立成功写入接口已退役，不再支持运行 `migrate-git-only.sh`、`--bootstrap-local`、`npm run update:deployed` 或旧 LibreChat Docker 更新入口。**只有一个常驻宿主机 systemd 单元对**：`mv3c-updater.timer` 激活 `mv3c-updater.service`，其唯一执行程序为 `mv3c/updater/agent.py`。数据库 `completeJob()` 是唯一更新终态写入者。不能另开脚本同时执行部署。

在尚未切换到新版本的服务器上，执行**串行原地交接**，不要先 Git reset/pull 切换代码，也不要删除仍用于首次交接的旧 service 文件。

1. 创建快照、检查至少 3 GiB 磁盘空间；如涉及新的 Dockerfile 首次缓存迁移，建议额外预留空间并在维护时段操作。
2. `sudo systemctl disable --now mv3c-updater.timer`；确认 `sudo systemctl is-active mv3c-updater.service` 输出 `inactive`。
3. 在当前 MV3C 后台「版本更新」检查正式版，**手动点击部署**形成唯一待执行任务。
4. 只运行一次当前 canonical service：`sudo systemctl start mv3c-updater.service`。它仍使用现有 `agent.py`，但会按照**同一个事务与任务终态模块**部署受信任 Release。不得同时运行第二个迁移器或 Docker build。
5. `sudo journalctl -u mv3c-updater.service -n 160 --no-pager`，并检查 `curl -fsS http://127.0.0.1:3080/api/config/version`；若失败或发生回滚，定时器继续保持关闭。
6. 仅在新版本已通过健康和 SHA 校验之后，`cd /opt/mv3c && sudo bash mv3c/updater/install.sh`。安装脚本会拒绝同时运行的更新任务、未知的 MV3C 更新/部署 systemd 单元与外部 service drop-in，直接覆盖**同名**旧 canonical service/timer，最后移除确认为旧版的一次性迁移脚本。不会新建第二个更新器。
7. `sudo systemctl list-unit-files 'mv3c*' --no-pager` 检查全机 MV3C systemd 单元。若存在其他更新/部署单元，先分析其 `ExecStart` 和调度来源；不要凭文件名通配符盲删，尤其不能删除 Docker 数据卷和其他应用的服务。

从此 `autoEnabled` 仅控制周期检查；无人值守自动部署需要明确启用全新 `autoDeployEnabled`（默认 false）。历史数据库记录、MongoDB 卷、上传文件、回滚镜像、请求日志全部保留。

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

后台登录后前往「版本更新」，仍统一以正式版 Release 为唯一更新通道；宿主机通过 Git 拉取 Release/CI 发布证据，不使用匿名 API 请求配额。可启用／关闭自动检查，或者手动检查、部署并下载诊断日志。版本号写入 Docker 镜像环境变量 `MV3C_VERSION` 和 OCI `org.opencontainers.image.version` 标签，后台显示当前和最新版本；部署后会校验运行中的 `/api/config/version` 与 Git SHA、版本号一致。


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
- 上线前使用 7 GiB 新构建预检与 2 GiB 切换前检查（仅放宽构建启动门槛，切换前保留空间的校验不变）；7 GiB 仍不能对任意依赖变更保证绝对成功，尤其在旧镜像与缓存都必须保留时，应记录磁盘峰值和实际失败原因。不得仅凭 CI 的镜像大小推断宿主机的总 Docker 存储占用。

## 缓存、资源与故障排查

### 安全磁盘与共享缓存管理

- **构建前预检**：`/var/lib/docker` 所在分区不足 3 GiB 空闲时停止升级，旧容器照常服务。3 GiB 只是允许尝试构建的门槛，不是本次构建实际需要的容量；如果构建时磁盘空间耗尽，构建仍可能失败，旧镜像与业务卷不得清理。构建成功后若剩余不足 2 GiB，也拒绝切换并恢复旧 Git 状态与服务。该阈值并非对构建磁盘使用量的硬性限制。
- **共享 BuildKit 软上限**：通过 `docker system df --format '{{json .}}'` 读取整机 Build Cache 使用量，超过 **4 GiB** 时写入诊断日志警告。**它是预警线，不是硬性容量配额，也不会自动清理缓存**，因为默认 Docker builder 同时服务 Chat2API、MV3C 等项目，无法安全按项目区分每一层的所有权。用户可以在发现持续增长后评估专用 builder / 独立磁盘，而不是允许 MV3C 擅自全局 prune。
- **项目专属镜像保留**：仅在不存在本轮 Release 候选镜像时，构建前先尝试清理最多五个过期 MV3C SHA 标签；成功部署后也进行同样的受限清理。只尝试清理过期的 `mv3c:sha-<40位SHA>` 候选镜像标签，并要求镜像修订标签与 SHA 一致；永远不会删除 `mv3c:local` 或 `mv3c:rollback`、其他仓库的镜像或运行/停止容器所引用的镜像。Docker 自身还有一层无需 `-f` 的引用保护；镜像层与 BuildKit 缓存若共用数据，删除标签后实际空间释放可能为零。
- **缓存复用**：不会运行 `docker builder prune -a`，不删除 BuildKit `mv3c-npm-cache` 下载缓存；正常情况下下一次构建继续复用已有层，依赖变更时继续利用 npm 缓存。
- **只读人工检查**：`df -h / && docker system df -v && docker buildx du`。当缓存超过软上限时，优先评估磁盘扩容、独立 BuildKit builder，再决定是否在维护窗口执行人工回收。不要自动删除业务 Docker 数据卷或其他项目的镜像。

- **缓存持久性**：同一 Docker daemon/BuildKit builder 中，正常 `docker build` 会复用未失效的分层缓存；Dockerfile 使用 `RUN --mount=type=cache,id=mv3c-npm-cache` 保存 npm 包。无需手动设置 `docker pull` 或重复下载全部 node_modules；当 lockfile 发生变化时依赖安装可能会重新执行，但已缓存 npm 包可重复使用。
- **不要清除构建缓存**：不要运行 `docker system prune -a`、`docker builder prune` 或 `docker build --no-cache`，除非明确诊断缓存损坏且有足够可用空间。
- **内存**：构建默认使用 `NODE_MAX_OLD_SPACE_SIZE=3072`（MiB），可通过 systemd 环境变量 `MV3C_BUILD_NODE_HEAP_MB=2048` 等按宿主机内存调整，范围 1024–8192。需要给 Docker/Node 构建留足内存与 swap，不能保证所有小内存 VPS 都能顺利构建。
- **磁盘**：构建前要求 Docker 数据目录至少 3 GiB 可用（3 GiB 只是启动门槛，并不代表构建仅需 3 GiB），新旧镜像和构建缓存会暂时并存。先用 `df -h /var/lib/docker`、`docker system df` 检查，避免删除 MongoDB 或业务数据卷。
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


## 2026-10-24: build safety and P0-P2 optimizations

**P0 — explicit unattended deployment approval.** Existing \`autoEnabled\`
means periodic **check only** from this Release onward. The independent
\`autoDeployEnabled\` is **false by default**, including for users who previously
enabled automatic deployments. An administrator must explicitly enable it
before the database layer admits the \`queue-auto\` path; manual updates
continue to use the same Git/SHA/Release-proof verification and rollback.

**Upgrade warning:** The OLD running host updater uses the original
\`autoEnabled\` behavior until the new Release has been deployed. Following
a host freeze, first disable automatic deployment on the currently running
version (or temporarily stop its timer) before publishing/rolling out the
Release that changes this policy. A PR merge by itself cannot disable a
legacy running timer on a separate host.

**P1 — eliminate source-change npm pruning.** Runtime dependencies are now
installed once in a dedicated cacheable \`prod-deps\` stage, keyed only by
package manifests. The full build stage retains development dependencies
for workspace builds. The runtime stage copies production-only modules and
mounts the completed source build read-only to extract other runtime files,
explicitly excluding node_modules. The install and dev compilation caches
remain local to Docker/BuildKit and must not be globally purged.

After this Dockerfile restructure, the **first build** necessarily needs new
cache records; it can temporarily consume MORE disk and may take longer. A
3 GiB preflight threshold is a minimum safety gate, not sufficient proof
that a fresh build will fit. For an undersized 40 GiB root disk with multiple
running services, take a snapshot and inspect \`df -h /var/lib/docker\`,
\`docker system df -v\`, and the image sizes before manual deployment.
Keep the rollback image and all MongoDB volumes.

**P0/P1 diagnostics.** Each host build appends a \`MV3C BUILD DIAGNOSTICS\`
summary to \`/var/log/mv3c-updater-build.log\` with actual wall time, largest
BuildKit steps, cache hit count, and sampled host MemAvailable, swap, free
Docker disk and full I/O PSI. The summary is also included in the admin
deployment report. These samples are signals, **not evidence of the exact
process performing I/O**, and do not auto-delete data or kill containers.

**P2 — optional external-build comparison, safe by default.** The
\`mv3c source Docker build\` GitHub Actions workflow now measures actual CI
build time, \`docker save\` + gzip packaging size/time and theoretical download
times at 5/20/50/100 Mbps, reporting them in the workflow summary. This is
a **benchmark** only: the CI candidate has \`BUILD_VERSION=unreleased\`, so
loading it directly on production would defeat exact Release-version
attestation. Production therefore keeps verified local SHA builds until a
fully attested Release-specific OCI artifact path and import/rollback tests
exist. Transfer timing excludes network overhead, Docker load/import time,
Actions queue delay and attestation cost.

Before enabling unattended deployments again, check at least two subsequent
releases for correct health, readiness, version attestation and actual peak
disk/I/O pressure under the new Dockerfile. Never run an unbounded prune or
force-remove Docker volumes in response to a build-space warning.


## 2026-10-25 更新中断的宿主机取证与内存保护

当管理员下载的部署报告只包含 `Updater interrupted before completing target deployment`、而不包含 `docker build failed (...)` 原始错误时，说明下一轮宿主机更新器发现了遗留事务或 activeJob，**不能据此认定**是普通构建超时、MongoDB 故障或 OOM。

新版在每次宿主机 Docker 构建时持续写入仅 root 可读的 `/var/log/mv3c-updater-build-state.json`（SHA、开始时间、最近采样、可用内存谷值、Swap 峰值、磁盘余量谷值、退出码、预警）；它不含令牌或会话内容。进程被系统杀死时状态可能保留为 `running`，并不是 Docker 仍在运行的证明。恢复阶段仅对完全相同目标 SHA 附加诊断到任务下载报告，保留原来的 `completeJob` 唯一终态控制和严格的 Git/镜像校验。

在开始构建前，根据当时主机的 `MemAvailable` 将 Node.js 构建堆最大值限制为 `min(默认 2560 MiB, MemAvailable - 1024 MiB)`；可用内存少于 2 GiB 则拒绝发起新构建，以优先保护运行中的 MongoDB 和 MV3C。完整且通过官方 SHA/Release 校验的候选镜像仍可直接复用，不需要新的本地构建。这个调整不能保证在所有资源紧张的服务器上完成构建，必要时应增加 RAM 或通过受验证的预构建镜像交付。

如果旧部署的更新器进程被外部终止，新增取证文件不会追溯过去的终止原因。排查本次事件需要读取宿主机的 **systemd journal、内核 OOM 日志、Docker daemon 日志以及原有 BuildKit 输出**，不要清理现存镜像/缓存和 MongoDB 数据卷。可在宿主机只读执行：

```bash
sudo journalctl -u mv3c-updater.service --since '2026-10-25 18:10:00' --until '2026-10-25 18:30:00' --no-pager
sudo journalctl -k --since '2026-10-25 18:10:00' --until '2026-10-25 18:30:00' --no-pager | grep -Ei 'oom|out of memory|killed process|memory cgroup' || true
sudo journalctl -u docker --since '2026-10-25 18:10:00' --until '2026-10-25 18:30:00' --no-pager | tail -n 120
sudo tail -n 100 /var/log/mv3c-updater-build.log
sudo docker inspect mv3c-mongodb-1 --format 'Status={{.State.Status}} OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}} ExitCode={{.State.ExitCode}}'
```

本地时间按宿主机时区解释；此示例基于事发当时服务器记录的北京时间。

## 小硬盘服务器的重复更新失败处理（v0.1.22 事故）

生产日志明确出现两种不同错误：(1) 构建中磁盘耗尽 `No space left on device`；(2) 完成了目标 SHA 的候选镜像，但构建后的磁盘余量小于 2 GiB，因此拒绝切换。这两种情况都不能通过增加超时或继续反复重建来解决。

- **首次优先复用候选**：当前 GitHub Release SHA 如果与本地 `mv3c:sha-<完整40位SHA>` 的 OCI revision/version/source、运行环境 BUILD_COMMIT/MV3C_VERSION 和镜像层一致，且磁盘至少 2 GiB，则直接切换，跳过 7 GiB 新构建门槛，绝不再次支付 Docker 导出峰值。
- **缺少候选，才允许新构建**：自动跳过其他项目，只清理最多 5 个符合身份校验、未被任何运行/停止容器或 `mv3c:local`/`mv3c:rollback` 引用的旧 MV3C SHA 标签；若余量仍小于 7 GiB，则明确报错并保持线上容器不变。可能无法释放 BuildKit 共享缓存空间。
- **禁止跨项目强制清理**：不能用 `docker system prune -a`、`docker builder prune`、`docker volume prune` 或删除 MongoDB 数据卷来绕过保护。
- **长期解决方案**：把完整的大型 Docker 构建移到有足够资源的独立构建环境，并通过有完整 SHA/Release/摘要绑定及回滚验证的预构建镜像交付生产服务器；或者扩容 Docker 所在磁盘及宿主机内存。7 GiB 是保护性最低门槛，不是无限保证。

若需要先部署已存在且与当前最新 Release 完全一致的候选镜像，先确认宿主机 `systemctl is-active mv3c-updater.service` 为 inactive、更新状态没有 activeJob/pendingJob、`docker image inspect mv3c:sha-<SHA>` 返回完整内容，以及 `df -h /var/lib/docker` 剩余至少 2 GiB。之后通过**现有唯一的后台更新任务**进行一次部署；不得额外手动运行独立脚本覆盖 `mv3c:local`。


## 指定已验证正式版：只复用本地镜像，不触发 BuildKit

**适用场景：** 生产 Docker 构建成功（包括镜像完成导出），但构建后可用磁盘不足 2 GiB，更新器拒绝切换。人工释放磁盘到至少 2 GiB 之后，应该先复用相同正式 Release SHA 的候选镜像。最新正式版可能已经向前发布了多个补丁，因此不能将候选 v0.1.22 冒充 v0.1.23/v0.1.24。

- 管理后台「版本更新」增加「指定正式版 · 只复用不构建」：管理员填入精确版本号，例如 `v0.1.22`，再次确认后 POST `/api/admin/mv3c/updates/deploy` JSON `{"targetVersion":"v0.1.22","reuseOnly":true}`。这仍进入**同一个** `pendingJob -> claimJob -> completeJob` 生命周期；不新增并行更新器。
- 宿主机唯一 `agent.py` 会提取此任务请求，通过固定 Git 远端拉取正式标签和 CI 发布证明、强制验证目标版本和 SHA 在受信任 main 历史上且是当前部署的快进后代。**任何镜像不存在、身份校验失败或剩余空间小于 2 GiB 时立即失败，并且不会执行 `docker build`、不会清理缓存或更改运行容器。**
- 恢复成功仍校验 Docker 镜像 ID、健康、Git、`/readyz` 和公共配置接口；后续更新页面继续显示真实最新正式版本而不是历史指定版本。历史恢复不触发发布或创建新标签。
- **版本升级过渡风险：** 旧版本 Web 管理后台与宿主机更新器不能理解新字段。绝不能只更新后台请求就交给旧宿主机更新器执行，否则旧更新器可能无视指定版本并直接重新构建最新正式版。正常升级成功安装新版宿主机 agent 后方可使用这个入口。

### 旧版宿主机的一次性恢复过渡（仍只用原更新器）

如果宿主机当前仍是旧版、恰好已有 v0.1.22 的 SHA 镜像，但新 v0.1.24 正式版已发布：先停止原 `mv3c-updater.timer`，确认原 `mv3c-updater.service` 为 inactive、没有 active/pending 任务，确认候选镜像 OCI 标签及 Build Commit、最小 2 GiB 空闲，并完成正常生产快照。

新版 `agent.py` 支持一次性的 `--recover-cached-release v0.1.22`。过渡使用时，**通过 Git 拉取新的官方 Release SHA 与双 CI 发布证明，且必须验证该证明，再从此准确提交提取新版 agent 源码到 root-only 临时位置**（不能先重置正在运行的 Git checkout）；管理员在当前旧版后台只创建**一次普通手动待执行任务**，而宿主机仍暂停 timer。由具有相同 `/run/lock/mv3c-updater.lock` 排他锁的新版 `agent.py` 处理该唯一任务，显式要求 `--recover-cached-release v0.1.22`，强制无 Docker 构建。这不是第二套进程或独立的终态模块，仍通过原 MongoDB `completeJob` 写入结果。

执行前必须再次确认新的原始脚本**已通过 Git Release 发布证明核验**，而不是从任意未验证 URL 直接下载脚本执行。若任一检查失败，保持旧容器运行、停止操作并保留快照。一次性部署完毕且验证成功后，执行当前仓库的 `mv3c/updater/install.sh` 原位更新**同一** systemd service/timer，移除临时代码，恢复原来调度。不能安装第二个 updater.service，也不能手动更改 `mv3c:local` 标签。

### 下一阶段：避免本机重构建

长期仍建议将正式运行镜像的全量 `npm ci`、前端构建、Docker 多层输出迁出生产宿主机。任何预构建交付需要在独立 Runner 生成**最终正式 Release SHA+版本**绑定的 OCI manifest/digest 和可验证的发布证明，生产仅允许通过同一个 agent 校验该来源后再切换；源代码 SHA 相同而版本/构建标签不同的 CI 临时镜像不能冒充正式版。由于你服务器当前使用的是共享 Docker builder，不能为了释放 MV3C 空间全局清理 BuildKit 的 npm 缓存。

