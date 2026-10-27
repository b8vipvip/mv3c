# MV3C 正式镜像生产依赖层稳定化与跨发布缓存

## 真实证据（v0.1.32 → v0.1.33）

- 两个正式镜像的 RootFS 各 10 层，按位置**第 1–4、6、8 层相同**，第 5、7、9、10 层不同。由于第 6、8 层是重复 digest，对集合求交得出的是 5 个去重后 digest；按实际位置应为 6 个位置相同、4 个不同。
- `docker history` 显示发生变化的 **第 5 层**是约 85.2 MB 的 Alpine `apk add jemalloc python3 py3-pip uv`，**第 7 层**是约 16.4 KB 的运行目录初始化层，**第 9 层**是约 1.69 GB 的生产依赖 `COPY --from=prod-deps /app/ /app/`，**第 10 层**是约 184 MB 的构建产物。
- 两版 `Dockerfile`、`package-lock.json`、`package.json`、客户端及 API 的 package manifests 指纹完全一致。因此第 9 层**理应**有复用机会，但跨 GitHub Actions 冷启动构建仍然不同；单凭这个结果不能确认具体原因一定是 npm 下载时间戳或 APK 包版本变化。
- 最近 CI 还报告 `/app/node_modules` 约 1.4 GB（解压后）、`/app/client` 129.4 MB、`/app/packages` 139.2 MB。Release `docker save | gzip` 仍约 506 MB。这里的层历史大小是未压缩大小，不等于 Registry 压缩 blob 大小。

## 可选修复（首次代码集成时默认关闭）

在正式镜像发布工作流中，增加 GitHub Actions Buildx `type=gha` 远程缓存；标识为 **`scope=mv3c-prod-deps`**。存储的构建目标仅为已有 Dockerfile 的 `prod-deps` 阶段，使用 `mode=min`，不导出完整数 GB 的 dev/build 阶段缓存。

- GitHub Actions 仓库变量 `MV3C_ENABLE_PROD_DEPS_CACHE=enabled` 才启用该功能；不设置时完全使用原来的 Docker Build 工作流及正式归档证明。
- 每次正式发布在同一 GitHub Actions runner 内，先恢复/构建 `prod-deps`，再用同一个 Buildx builder 构建整张正式镜像，以保证恢复的生产依赖层可以直接参与最终 runtime 镜像。
- 远程缓存上传错误配置 `ignore-error=true`，避免 CI cache 上传故障中断官方构建；如果缓存未命中，Buildx 必须真正运行 npm ci，不允许将缺失构建产物当成成功。
- 之后的 smoke、GitHub CI 证明、SHA/OCI 身份验证、完整 GitHub Release 归档和宿主机回滚**全部保持不变**，不在生产机器构建 Docker 镜像。

## 如何验收是否真的减少升级流量

1. 第一版启用时为冷缓存。检查正式版 GitHub Actions 的 `Materialize source-invariant production dependencies` 与后续 `Build version-bound runtime` 日志成功，记录第 9 层的实际 diffID、层大小及 upload 时间。
2. 第二版只改客户端代码、不改 manifests。确认日志中的 `prod-deps` 显示 `CACHED`，且两个版本 RootFS **第 9 层 diffID 绝对一致**。若不同，则继续排查 APK `RUN` 的上游版本、构建平台与缓存淘汰情况，不以发布成功推定缓存生效。
3. 未来若正式启用 GHCR 分层拉取（另见 `docs/mv3c-oci-layer-delivery.md`），必须比较**压缩 OCI layer digest**及主机真实下载字节/时间；只有两边共同生效才会真正减少服务器流量。
4. 若缓存频繁被挤掉，先考虑固定版本/内容摘要的依赖基础镜像及明确的安全升级机制，而不是强制关闭 APK 更新或牺牲依赖漏洞修复。

## 生产安全边界

当前生产 v0.1.33 保持健康；本功能默认关闭且不自动升级。不要删除 `mv3c:rollback`、`mv3c:local`，不要在 40GB 宿主机运行 `docker system prune`，不要擅自为 dockerd 设置全局代理。内置 OCI 传输仍默认关闭，GHCR package 的 Public 可见性需要所有者明确决定。
