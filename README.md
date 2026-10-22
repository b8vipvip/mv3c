# mv3c

**mv3c** 是基于 LibreChat 的独立多用户聊天网站，通过 **chat2api** 调用 Linux/Windows Worker。提供内置 **mv3c Admin** 管理后台：站点设置、注册开关、chat2api API 地址和密钥、模型列表、模型同步以及用户角色，全部通过后台配置并持久保存在 MongoDB。

> 本项目保留 LibreChat 的内部依赖和 MIT 许可证；用户可见品牌为 mv3c。镜像由 GitHub Actions 从修改后的源码构建并验证，通过专用 SSH/SCP 上传通道发送至服务器；宿主机校验 SHA-256 与提交标识后导入，无需服务器本地构建。

## 1. 全新部署（无需 .env）

服务器需要 Docker Engine、Docker Compose v2、Git；应预留镜像下载与旧版回滚所需空间，不在服务器运行 npm/Docker 源码构建。

~~~bash
git clone git@github.com:b8vipvip/mv3c.git
cd mv3c
docker compose -f docker-compose.mv3c.yml config --quiet
# 先按 mv3c/updater/README.md 配置 Actions SSH/SCP 传输并等待当前提交的存档到达
SHA=$(git rev-parse HEAD)
sudo docker load --input "/var/lib/mv3c-prebuilt/incoming/mv3c-${SHA}.tar.gz"
sudo docker tag "mv3c:sha-${SHA}" mv3c:local
docker compose -f docker-compose.mv3c.yml up -d --no-build --pull never
docker compose -f docker-compose.mv3c.yml ps
curl -fsS http://127.0.0.1:3080/readyz
~~~

首次克隆如 SSH 不可用，可改用 `git clone https://github.com/b8vipvip/mv3c.git`；安装宿主机更新器后，后台自动与手动更新仍优先 SSH、失败回退 HTTPS。

**无需运行**旧版的 Python 初始化脚本，也无需创建 .env 或编辑 librechat.yaml。旧文件仅为兼容/参考保留，**mv3c 运行时不再从中读取 AI 供应商和站点配置**。

服务默认仅监听主机 127.0.0.1:3080。在宝塔 Nginx 反向代理中，将 HTTPS 域名转发到 http://127.0.0.1:3080；不要公开 MongoDB。**第一次注册管理员前，请先通过 SSH 隧道或仅自己可访问的域名进行初始化，不要直接向公网开放无人认领的首个管理员账号。**

Windows PowerShell 的本机 SSH 隧道示例：

~~~powershell
ssh -L 3080:127.0.0.1:3080 root@你的服务器IP
~~~

保持隧道连接，访问 http://localhost:3080。

## 2. 首次管理员初始化

1. 首次访问时注册一个 mv3c 用户。**单租户空数据库的第一个用户自动获得 ADMIN 角色**（LibreChat 现有机制）。
2. 注册成功后，默认关闭其他用户的自行注册权限；管理员可以在后台重新开启。
3. 登录后访问 **/admin**，例如 https://chat.example.com/admin。
4. 进入「AI 供应商与模型」，填写：
   - API Base URL：**https://你的chat2api域名/v1**
   - API Key：在 chat2api 管理端创建、具有 **models** 和 **chat** 权限的专用密钥
   - 模型列表：默认 gpt-6-sol、gpt-5.6-sol，或者同步实际可用模型
5. 点击**保存配置**，再点击**测试已保存连接**，确认模型接口返回数据；可点击「同步并保存模型」。
6. 在「站点与注册设置」填写网站名称、欢迎语、网站公网 HTTPS 地址，选择是否允许新用户注册。
7. 返回聊天页，选择 chat2api 端点和模型，测试单轮与多轮对话。

若 chat2api 与 mv3c 位于同一 Docker 主机，可填写 http://host.docker.internal:实际端口/v1，但 chat2api 必须监听 Docker 容器可访问的接口；公网地址必须使用 HTTPS。

## 3. 管理范围与数据所有权

| 项目 | 权威配置来源 |
| --- | --- |
| mv3c 名称、欢迎语、公开注册开关、网站公网地址 | mv3c Admin → MongoDB |
| chat2api URL、API Key、模型列表、启停与模型自动发现 | mv3c Admin → MongoDB |
| 用户、角色、聊天记录 | mv3c MongoDB |
| Worker、设备、窗口、模型执行 | chat2api 原有后台 |
| JWT/加密根密钥 | Docker 数据卷中的自动生成文件 |
| MongoDB 连接与容器监听端口 | Docker Compose 部署编排 |

chat2api API Key 使用 **AES-256-GCM** 加密存入 MongoDB，管理员网页不回显密钥。根密钥位于持久化数据卷 mv3c-data 的 mv3c-bootstrap.env，首次启动自动生成，后续重启复用，**不要删除或重新生成**。Docker Compose 中 MongoDB 连接地址是内部服务发现地址，不是普通业务配置。

**当前 mv3c Admin 覆盖的是上表所列核心应用配置。** LibreChat 上游的高级功能（SMTP、OIDC/SSO、MCP、工具、联网搜索等）尚未全部移植为后台表单，不能声称所有上游可选配置都已支持后台管理。

所有 mv3c 用户当前共用一个 chat2api API Key，chat2api 不会自动按 mv3c 用户分别计费。

## 3.1 聊天用户界面

用户端采用 ChatGPT 风格的聊天布局：桌面端左侧优先显示新聊天、搜索与对话历史，其他高级功能集中在侧栏下部；聊天区采用简洁的模型选择、居中欢迎页与圆角输入框。侧栏仍可折叠，移动端保留滑出导航。**仍由 mv3c 提供服务，并非 OpenAI 官方 ChatGPT 网站**。

界面调整只涉及视觉和布局，保留原有的用户登录、消息保存、会话搜索、附件上传、模型选择、SSE 流式回复和 mv3c 管理后台；要启用实际聊天，请在 `/admin` 配置 chat2api 并同步模型。刷新浏览器可加载更新后的前端资源。

## 4. 运维

~~~bash
# 查看日志
docker compose -f docker-compose.mv3c.yml logs --tail=150 mv3c

# 重启
docker compose -f docker-compose.mv3c.yml restart mv3c

# 后续更新：使用“版本更新”后台触发（先校验 CI，拉取镜像并验证）
# 不要再在服务器使用 docker compose build 或 --build
~~~

不要运行 docker compose down -v，否则可能删除 MongoDB 用户数据和自动生成的根密钥。备份时必须**同时备份** mv3c-mongodb 和 mv3c-data 两个卷，缺少后者将无法解密已保存的 chat2api API Key。

## 4.1 版本更新（自动 + 手动）

后台新增「**版本更新**」页面，显示当前版本、GitHub 最新版本、CI 验证状态、自动更新开关、手动更新、部署进度与日志。后台更新优先 SSH，失败自动回退 HTTPS；终端里单独执行的 git pull 不具备此自动回退逻辑。

**首次需要在 Docker 宿主机安装更新服务（一次性操作）：**

~~~bash
cd /opt/mv3c
sudo bash mv3c/updater/install.sh
sudo systemctl status mv3c-updater.timer
~~~

建议将 Git 仓库放在 **root 所有的 /opt/mv3c**；安装脚本会检查来源仓库、分支和工作区是否干净。后台自动和手动更新都**优先 SSH，失败时自动回退到固定的 GitHub HTTPS 地址**；安装脚本会测试两种方式，SSH 成功则优先设置 SSH origin，仅 HTTPS 成功则使用 HTTPS。安装后，管理员在 /admin →「版本更新」管理策略，无需在 .env 中设置版本更新选项。

默认启用自动更新、每 10 分钟检查 GitHub main 分支；只有 mv3c validation 和 mv3c source Docker build 两项 GitHub Actions **均成功**、SCP 存档完整且镜像 SHA 校验通过，才会导入镜像、重启应用。也可切换到 GitHub Release 通道（仓库必须先发布 Release），或关闭自动更新并手动触发。部署失败时会尝试回滚代码和镜像，**不会回滚数据库迁移**。

**网页容器没有 Docker Socket 权限**；更新实际由宿主机 systemd 服务执行。详细安装、排错与回滚说明：[版本更新文档](mv3c/updater/README.md)。

## 4.2 Docker 依赖缓存与运行日志

- 依赖安装、前端编译和镜像构建全部在 GitHub Actions 执行。服务器通过 SCP 收取经过验证的压缩镜像；**自动更新与后台手动更新都不会运行 npm、Docker BuildKit 构建或拉取 GHCR 镜像**。服务器仅校验文件、导入镜像并切换容器。
- 管理后台新增「**运行日志**」：实时写入脱敏应用日志和 API 请求摘要（不保存请求/响应正文），最多约 10 MiB；采用小文件轮转，超过阈值先淘汰最旧的内容，保存在已有 `mv3c-logs` Docker 数据卷。
- 后台选择 **最近 15 分钟 / 1 小时 / 6 小时 / 24 小时 / 3 天 / 7 天** 下载 `.log`，仅管理员能操作。由于总量受限，日志轮转后可能不足所选择的时间段。
- 为避免 Docker 自身标准输出日志无限增长，`mv3c` 与 `mongodb` 的 Docker `local` 日志驱动各自按 2 MB × 5 文件轮转。它们与后台导出的应用运行日志**属于不同的日志集合**。升级前已保存的旧 LibreChat 日志不会被自动删除或合并进新报告。
- 如需检查 Docker 构建缓存使用情况：`docker builder du`。不要使用 `docker builder prune -a` 或 `docker system prune -a` 清除缓存，否则后续升级可能需要重新下载依赖。

## 5. 从旧版 .env 部署升级

如果你**已经**用旧版 Python 初始化脚本创建 .env 并在生产环境使用了 mv3c，请不要直接无备份地切换新 Compose：旧版 JWT/CREDS 密钥在 .env 中，新版默认会自动生成新密钥，导致现有会话失效、旧加密数据不可解密。

升级前先备份原 .env、MongoDB、上传文件和全部数据卷，再迁移旧的 JWT_SECRET、JWT_REFRESH_SECRET、CREDS_KEY、CREDS_IV 到新的持久化 bootstrap 文件，并将旧 chat2api 配置通过后台重新保存。需要升级现有生产环境时应先完成密钥迁移和回滚验证。

## 6. 测试与兼容性

~~~bash
python3 -m unittest discover -s mv3c/tests -v
node --test mv3c/tests/settings.test.cjs
python3 mv3c/apply_branding.py --check
docker compose -f docker-compose.mv3c.yml config --quiet
~~~

- 已实现数据库配置、加密密钥、管理 API、管理页面和模型发现。
- chat2api 通过 /v1/chat/completions 执行文本请求，传递 prompt_mode: full，禁用 Responses API。
- 真实 Worker 的 SSE 流式输出、取消、长推理、图片与文件仍需部署后联调，不应视为已经实机验证。

## 7. 开源许可

本项目保留 LibreChat 原始 [MIT LICENSE](LICENSE) 及 [上游说明](mv3c/UPSTREAM_README.md)。后端项目：[chat2api](https://github.com/b8vipvip/chat2api)。

## 预构建镜像更新机制（2026-10）

每次推送 main 后，GitHub Actions 构建、启动并验证生产 Docker 镜像，然后导出 gzip 压缩 tar 与 SHA-256 校验和；配置独立上传账户和四项 GitHub Actions SSH Secrets 后，自动通过 SSH/SCP 传到 `/var/lib/mv3c-prebuilt/incoming/`。

服务器更新器要求两项 Actions 验证都通过，并再次核验压缩包的 SHA-256、镜像自带提交 SHA，才执行 `docker load`、`docker compose up --no-build` 和健康检查。传输失败不会触发本地编译，更不会重启已有健康容器。仍应保留足够磁盘空间容纳新旧镜像与回滚所需数据。

**现有宿主机如仍安装的是本地构建版或 GHCR 下载版更新器，需要首次引导迁移。** 详见 [SSH/SCP 专用部署步骤](mv3c/updater/README.md#github-actions--sshscp--mv3c-部署当前方案)。Actions 使用的服务器登录私钥必须与服务器拉取 GitHub 的 Deploy Key 分开配置。


最新镜像传输采用 SHA-256 校验的 16MiB 分段 SCP，并通过 GitHub Actions Cache 复用同一压缩包。单次传输失败时，在 Actions 内运行 `mv3c SCP transfer retry`，输入原 Docker Build 运行 ID，即可不重新构建、从已完整上传的分段续传。此前 #94 的旧整包上传无法直接复用，详见 [更新器文档](mv3c/updater/README.md#大镜像上传超时与断点续传2026-10-22)。本机制仍依赖实际 SSH 网络带宽，不保证比 GHCR 或其他线路更快。
