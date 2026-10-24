# MV3C GitHub 正式版发布与服务器缓存部署

## 更新流程（与 chat2api 一致）

GitHub Actions 负责 **源码和 Docker 冒烟验证**。main 提交的两项 CI 全部成功后，`mv3c official release` 工作流自动创建版本标签（首次 `v0.1.0`、之后逐次递增补丁版本）并发布非预发布的 GitHub Release。**只有已发布正式版才允许进入生产部署**，不会部署未经发布的 main 提交。不向服务器上传 Docker 镜像，也不依赖 GHCR、SCP 或额外的 Actions 上传 Secret。

服务器上的 `mv3c-updater.timer` 每分钟检查后台更新任务（自动检查间隔由后台配置）。**与 chat2api 一样，宿主机仅使用 Git Smart 协议，无需 GitHub REST API Token**：SSH 443 → SSH 22 → HTTPS（HTTP/1.1、每条链路有界超时）。GitHub Actions 仍在发布正式 Release **且两项 main CI 都成功后**才写入不可缺失的带 CI 运行 ID 的注释标签 `mv3c-verified/vX.Y.Z`。宿主机只部署同时具有普通版本标签和此 CI/Release 发布证明、且落在可信 main 历史中的 SHA；最新标签缺少证明时拒绝更新而不回退到旧版本。请使用 GitHub 仓库 ruleset 限制谁可以创建/改写/删除 `v*` 和 `mv3c-verified/v*` 标签，因为这里是仓库权限控制的**发布证据**，不是外部密码学签名。

1. 通过 SSH 443 → SSH 22 → HTTPS 有界容灾拉取 GitHub main、正式版本标签和发布证明标签；在本机按精确 Git SHA、双 CI 成功字段、两条成功运行 ID 校验发布证明，不调用 `api.github.com`。
2. 检查 Docker 数据目录空余容量（至少 **3 GiB**），不足时拒绝构建，当前容器不受影响；同时记录共享 BuildKit 缓存用量，并保留当前的 `mv3c:rollback` 镜像。
3. Git 快进到经过 CI 验证的提交，**先严格检查本机是否已有同一正式 Release SHA 的完整候选镜像**（精确的 OCI revision/version/source、运行环境版本、镜像层及 Image ID）；通过校验则直接复用并跳过构建，候选镜像不存在才执行 `docker build` 生成 `mv3c:sha-<commit>`；现有标签若校验不通过则拒绝部署，不能静默覆盖。旧服务始终继续运行。
4. BuildKit 自动复用本机已存在的镜像层；Dockerfile 在拷贝源码前安装 workspace 依赖，`package-lock.json` 未变时重用 `npm ci` 整层。依赖变更时则复用持久化的 `mv3c-npm-cache` npm 下载缓存（`--prefer-offline`）。
5. 通过镜像 `org.opencontainers.image.revision` 标签核验精确 Git SHA；**仅成功后**将 `mv3c:local` 指向新镜像，并执行 `docker compose up -d --no-build --pull never --no-deps --force-recreate mv3c`。
6. 构建完成后至少保留 **2 GiB** 可用空间才允许切换；验证新容器 `healthy`、`/readyz`、`/api/config`；失败则恢复 Git、旧镜像及服务。
7. **只有在新版本健康验证通过并移除更新事务日志之后**，尝试移除旧的 `mv3c:sha-<40位提交>` 标签。已运行容器、停用容器、`mv3c:local`、`mv3c:rollback` 所引用的镜像始终受保护，每次最多处理 5 个标签。清理失败仅记录警告，不把已经成功运行的部署误判为失败或触发回滚。保留 MongoDB、上传文件、密钥和日志数据卷，不执行 `down -v`、`docker system prune`、`docker builder prune`。

构建失败**不会**停止或重启旧容器。构建中途异常退出时，下一次更新器执行将依据本地事务日志恢复 Git 和旧镜像，并核验运行状态，防止 Git/镜像版本不一致。**镜像完整构建后若因剩余空间不足 2 GiB 而回滚，成功导出的 `mv3c:sha-<commit>` 候选镜像会保留。下次针对相同 Release SHA 重试时先验证并复用此镜像，避免反复支付 BuildKit 导出和额外磁盘峰值；如果发布了新 SHA，旧候选不得冒充新版本，仍需构建新 SHA。**

## 从 REST API 更新器迁移（已有站点仅执行一次）

**已有旧版本站点不要运行「首次部署」里的 `git clone` 或 `docker compose up -d --build`**；它们可能覆盖原来具备版本号的运行镜像。迁移前请在 [GitHub Releases](https://github.com/b8vipvip/mv3c/releases) 确认新的正式版及 `mv3c-verified/vX.Y.Z` 发布证明标签已产生。

在宝塔 root 终端执行独立命令，**不要把各步骤散落在多个不检查退出码的粘贴块里**：

```bash
set -e
sudo systemctl stop mv3c-updater.timer
# 仅用于取到带完整 SSH443/22/HTTPS 回退的迁移入口；默认先走 TLS HTTPS。
# 若 HTTPS 无法访问，则尝试已有 SSH22；迁移脚本运行时优先 SSH443。
sudo -H git -C /opt/mv3c -c http.version=HTTP/1.1 \
  fetch https://github.com/b8vipvip/mv3c.git \
    refs/heads/main:refs/remotes/origin/main || \
sudo -H git -C /opt/mv3c \
  fetch git@github.com:b8vipvip/mv3c.git \
    refs/heads/main:refs/remotes/origin/main
sudo sh -c 'git -C /opt/mv3c show refs/remotes/origin/main:mv3c/updater/migrate-git-only.sh > /root/mv3c-migrate-git-only.sh'
sudo bash /root/mv3c-migrate-git-only.sh
```

专用脚本以固定 GitHub Ed25519 主机密钥优先 SSH 443，再试 SSH 22，最后回退 HTTPS；自动等待已启动的 oneshot 更新任务释放锁、提取最新版 Git-only 更新器、严格校验发布证明、执行 Docker 缓存构建、验证上线镜像后才重新安装 systemd 更新器。**完成健康、运行镜像及 Release 版本验证后，宿主机经现有受限更新桥将一次性迁移作为 `bootstrap` 成功事件写入原有 MongoDB 更新状态/历史，并提供下载报告；历史失败记录保留，不把旧 403 误当当前故障。相同 SHA 的成功记录不重复写入，写入暂时失败时下次定时检查可在再次严格验证后补记，不需要重建镜像。****失败时不会安装旧更新器、不清空 Docker 缓存或卷、也不自动开始下一次更新。** 若遇到构建失败，先确认服务器至少有 3 GiB 空间，且 **不得再运行首次部署 `docker compose up -d --build` 覆盖回滚镜像**。从下面日志查明是 npm 网络、依赖、OOM 还是磁盘错误后再重试迁移。请获取宿主机日志：
`sudo grep -Ei 'npm (error|ERR)|EAI_AGAIN|ECONN|ETIMEDOUT|ERROR:|failed|No space' /var/log/mv3c-updater-build.log | tail -n 60`，再查看 `sudo tail -n 100 /var/log/mv3c-updater-build.log`。Git 获取失败的诊断保留在 `/var/log/mv3c-migration-fetch.log`（仅 root 可读）。

回滚验证会严格检查已备份的旧镜像 ID 与当前健康容器是否一致。若旧镜像由人工 `docker compose build` 构建，缺少 Release 元数据，可以在回滚时恢复为**健康的旧服务**并报告 `legacy unversioned` 警告；这种恢复不会被当作新版本部署成功。新候选镜像仍必须通过全部正式版 SHA、镜像和 API 验证。


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
- 上线前使用 3 GiB 构建前检查与 2 GiB 切换前检查（仅放宽构建启动门槛，切换前保留空间的校验不变）；3 GiB 无法保证 npm/BuildKit 构建成功，尤其在旧镜像与缓存都必须保留时，应记录磁盘峰值和实际失败原因。不得仅凭 CI 的镜像大小推断宿主机的总 Docker 存储占用。

## 缓存、资源与故障排查

### 安全磁盘与共享缓存管理

- **构建前预检**：`/var/lib/docker` 所在分区不足 3 GiB 空闲时停止升级，旧容器照常服务。3 GiB 只是允许尝试构建的门槛，不是本次构建实际需要的容量；如果构建时磁盘空间耗尽，构建仍可能失败，旧镜像与业务卷不得清理。构建成功后若剩余不足 2 GiB，也拒绝切换并恢复旧 Git 状态与服务。该阈值并非对构建磁盘使用量的硬性限制。
- **共享 BuildKit 软上限**：通过 `docker system df --format '{{json .}}'` 读取整机 Build Cache 使用量，超过 **4 GiB** 时写入诊断日志警告。**它是预警线，不是硬性容量配额，也不会自动清理缓存**，因为默认 Docker builder 同时服务 Chat2API、MV3C 等项目，无法安全按项目区分每一层的所有权。用户可以在发现持续增长后评估专用 builder / 独立磁盘，而不是允许 MV3C 擅自全局 prune。
- **项目专属镜像保留**：更新成功后只尝试清理过期的 `mv3c:sha-<40位SHA>` 候选镜像标签，并要求镜像修订标签与 SHA 一致；永远不会删除 `mv3c:local` 或 `mv3c:rollback`、其他仓库的镜像或运行/停止容器所引用的镜像。Docker 自身还有一层无需 `-f` 的引用保护；镜像层与 BuildKit 缓存若共用数据，删除标签后实际空间释放可能为零。
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
