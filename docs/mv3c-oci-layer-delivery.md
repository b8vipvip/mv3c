# MV3C 镜像按层传输：可选 GHCR OCI 分发（试运行方案）

## 背景与证据（2026-10-27）

- 正式版 v0.1.33 更新报告：259.325 秒；其中下载 482.7 MiB 至 100% 用约 164 秒，完整导入与校验随后还需约 64 秒，容器切换及健康检查约 25 秒。
- 原 GitHub Actions 每次 `docker save | gzip -1`，不管修改多少行均重新发布一份约 506 MB 的完整归档。运行服务器虽未执行 docker build，仍需下载完整包。
- Dockerfile 已将生产依赖 `prod-deps` 与源代码构建层分离，但 Actions 冷启动后的依赖层是否有稳定的**压缩 OCI 层摘要**，尚未通过对比两个正式版本证实。不能承诺「少量提交必然只需几 MB」。

## 新增方式（默认关闭）

这不是第二套更新器：仍然只由 `mv3c-updater.service` 读取 MongoDB 单一任务队列、持有原 flock 和唯一终态。原 Release 完整归档 **始终发布并保留**，其 SHA-256 与 Git tag 证明仍是权威。

1. 仓库管理员可以设置 Actions **repository variable** `MV3C_ENABLE_OCI_REGISTRY=enabled`。仅之后正式版的 GitHub Actions 预构建发布流程同时推送 `ghcr.io/b8vipvip/mv3c:sha-<40位SHA>`。未设置则完全保持整包机制。
2. 推送后从 Docker 得到不变的 OCI manifest `sha256`，与原 Release 归档 SHA、CI 图片 config ID 一起写进同一个 `mv3c-image/vX.Y.Z` 注释 Git tag。**不能信任可变的容器标签**；宿主机只认经过 Git 证明的 `@sha256:<digest>`。
3. GitHub 首次创建的 Container registry 包可能是私有；仓库所有者要在 GitHub Packages 设置中手动把它变为 **Public**，否则服务器的匿名拉取不会成功。**将包设为 Public 是可能无法逆转的公开操作，不可自动替用户执行。** 仅公开本来已经公开发布的运行时镜像，并确认镜像没有包含配置密钥。
4. 宿主机在单独确认 GHCR 公网可达且有足够磁盘后，才可在 root 600 的 `/etc/mv3c/updater-proxy.env` 中加入 `MV3C_OCI_LAYER_TRANSPORT=enabled`。本选项只改变现有更新器的传输来源，不改变端口、容器、Volume 或 MongoDB。
5. 更新器首先尝试验证同一 Git 证明绑定的 OCI manifest 并执行 `docker pull ghcr.io/b8vipvip/mv3c@sha256:...`；Docker 可能复用已保存的相同压缩层而不重复下载。成功后核对 repo digest、image config ID/manifest ID、版本与 SHA、RootFS；最后才赋予不可变本地 SHA 镜像 tag。
6. OCI 包未发布或公开 registry 不可达时仍可退回已验证的官方 GitHub Release `.tar.gz`。出现 registry digest 或元数据校验不匹配时**必须失败关闭**，不可静默回退。旧版从未带 OCI 证明，行为完全保持不变。

## 生产网络重要限制

**`MV3C_DOWNLOAD_PROXY` 只在宿主机 Python/curl 下载 Release 时有效。它不会自动影响 Docker daemon 发起的 GHCR 拉取。** 没有单独测试 Docker daemon 能访问 GHCR 及拉取速度之前，不要启用 `MV3C_OCI_LAYER_TRANSPORT`，也不要更改全局 dockerd 代理（可能影响 chat2api、千牛和其它业务）。

建议先在**非生产**或有足够空间的环境测量相邻版本两次 `docker pull` 的 `Downloaded`/`Already exists` 日志和实际接收字节，与 Release 整包作比较。Docker CLI 的同名层不等于压缩 Registry blob 一定复用；压缩 layer digest 才决定网络去重。若未减少至少明显比例，进一步采用固定依赖基础镜像及 Actions 共享远程构建缓存，而不是牺牲安全预检。

## GitHub Actions 层稳定性测量

预构建工作流新增 RootFS diffIDs 审计：报告目标镜像层总数、与此前官方 proof 的共同层与连续共同前缀，供决定是否调整 Dockerfile 和 CI 构建缓存。此指标仅为 **理论复用上限**，不能当成已省多少下载流量。

## 上线验收标准

- 所有原 V1 归档 proof、版本号、SHA、CI 检查、Docker 29 身份验证和生产回滚测试继续通过；不用 GHCR 时部署行为不变。
- OCI proof 格式缺失、私有或网络失败时，安全回到签名归档；任何 digest/镜像身份不一致都不赋本地新 SHA tag。
- 相邻两次已签名镜像在相同主机上实际测量 GHCR 已复用层、下载总字节、时间、磁盘峰值；有效低于原 506MB 才允许把新通道列为优先推荐。
- 不启用独立自动部署、不清理 `mv3c:rollback`、不更改 Docker daemon 全局配置、不引入第二个更新器服务。
