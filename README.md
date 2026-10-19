# mv3c

**mv3c** 是一个基于 [LibreChat](https://github.com/LibreChat-AI/LibreChat) 的独立多用户 ChatGPT 风格网页端，使用 [chat2api](https://github.com/b8vipvip/chat2api) 作为唯一的 AI 文本生成来源。

- **独立用户体系**：mv3c 自行管理注册、登录、密码和会话历史，数据保存在专用 MongoDB 中，不同步 chat2api 用户或余额。
- **统一生成后端**：所有已配置的聊天模型通过 chat2api 的 OpenAI 兼容 `/v1/chat/completions` 接口调用，由 chat2api 继续调度 Linux/Windows Worker。
- **完整源码**：本仓库引入固定版本的 LibreChat 上游源码并对界面、应用名称、PWA 名称及图标进行 mv3c 品牌修改。使用本仓库的 `Dockerfile` 构建，**不是直接运行未经改名的上游镜像**。
- **模型自动发现**：配置 `models.fetch: true`，由 chat2api 的 `/v1/models` 提供可选模型；静态列表只是网络异常时的回退候选，不保证每个模型都有可用 Worker。
- **完整对话提示**：在自定义端点请求中传入 `prompt_mode: full`，避免 chat2api 默认的 `last_user` 模式丢失多轮历史。

## 1. 安装

需要 Linux 服务器、Docker Engine、Docker Compose v2、Python 3。首次本地构建 LibreChat 源码会下载大量 Node 依赖，建议预留充足的内存和磁盘空间。

```bash
git clone https://github.com/b8vipvip/mv3c.git
cd mv3c

# chat2api 必须已有可用的 API Key。运行时会交互式隐藏输入 Key。
python3 mv3c/setup.py \
  --base-url 'https://你的-chat2api-域名/v1' \
  --domain 'https://你的-mv3c-域名'

# 检查编排文件
docker compose -f docker-compose.mv3c.yml config --quiet

# 从本仓库的已修改源码构建并启动
docker compose -f docker-compose.mv3c.yml up -d --build
```

如果 chat2api 运行在同一台 Docker 主机，可将 `--base-url` 改为 `http://host.docker.internal:你的-chat2api-端口/v1`，但 chat2api 必须监听 Docker 容器可访问的主机接口，而非仅监听 `127.0.0.1`。外部连接应使用 HTTPS。

默认只绑定本机 `127.0.0.1:3080`。公网部署时请在 Nginx、Caddy 或宝塔反向代理中把你的 HTTPS 域名指向 `http://127.0.0.1:3080`，不要直接开放 MongoDB 端口。若你先在本机测试，请把 `--domain` 设为 `http://localhost:3080`。

查看运行状态：

```bash
docker compose -f docker-compose.mv3c.yml ps
docker compose -f docker-compose.mv3c.yml logs -f mv3c
curl -fsS http://127.0.0.1:3080/readyz
```

> `.env` 包含 chat2api API Key、JWT 密钥、加密密钥。由 `mv3c/setup.py` 随机生成并设为仅所有者可读；**绝不可提交到 GitHub**。密钥生成后请备份，不要在已有用户数据的情况下随意重新生成。脚本不会覆盖已存在的 `.env`。

## 2. 用户与模型

mv3c 的登录和用户记录**不依赖** chat2api 的账号体系。默认允许邮箱注册（`ALLOW_REGISTRATION=true`）；如果你希望只允许受邀用户注册，可在部署前将 `.env` 中此项改为 `false`。用户聊天记录由 mv3c 的 MongoDB 持久保存。

配置文件 [librechat.yaml](../librechat.yaml) 只启用 `chat2api` 自定义端点，统一通过服务端 `CHAT2API_API_KEY` 认证。API Key 不会由浏览器直接提交给 chat2api；**但所有 mv3c 用户共用此 Key，因此 chat2api 端看到的是统一调用身份，不具备按 mv3c 用户单独结算的能力**。

模型来自 `/v1/models`，静态候选 `gpt-6-sol`、`gpt-5.6-sol` 仅用于初始回退；实际可用性由 chat2api 的模型路由、Worker 状态和账号权限决定。可以在 `librechat.yaml` 中调整候选列表。

## 3. 兼容性与已知限制

| 功能 | 当前实现 |
| --- | --- |
| 独立账号、登录、聊天记录 | 继承 LibreChat 实现，专用 MongoDB |
| chat2api OpenAI 兼容接口 | 自定义端点，服务端持有 API Key |
| 模型列表 | `/v1/models` 动态获取，静态回退 |
| 多轮上下文 | `prompt_mode: full`；需联调上下文去重 |
| SSE 流式文本 | 协议路径已接通配置；需真实 Worker 验证 |
| 取消生成、超时、错误终态 | 需真实 Worker 联调 |
| 图片、文件、语音、工具、联网搜索 | **未验证**；不应视为已兼容 |
| mv3c 用户单独在 chat2api 计费 | **不支持**；共享后端 API Key |

chat2api 的 `prompt_mode: full` 会把当前历史消息拼接为一段文本送给 Worker，**不等于**原生 ChatGPT 的逐条角色消息协议；在长对话、图片和重试场景下需要单独测试。

## 4. 开发、更新与测试

```bash
python3 -m unittest discover -s mv3c/tests -v
python3 mv3c/apply_branding.py --check
docker compose -f docker-compose.mv3c.yml config --quiet
```

上游版本固定在 [`.mv3c-upstream-imported`](../.mv3c-upstream-imported) 指定的提交。更新上游时应在新分支审查变更、重新执行 `mv3c/apply_branding.py` 和测试，**不要自动把上游 main 覆盖到 mv3c 的 main**。

源码的部分内部包名、环境变量和协议仍保留 `LibreChat`/`@librechat/*`，这是为了兼容原有模块，不代表用户端仍以 LibreChat 为品牌。管理后台商业镜像不包含在本部署中。

## 5. 开源来源与许可证

本项目基于 **LibreChat**，原作者及版权归属见 [LICENSE](../LICENSE) 和 [mv3c/UPSTREAM_README.md](UPSTREAM_README.md)。原有 MIT 许可证及版权声明完整保留。mv3c 的名称、配置、图标及与 chat2api 的集成属于本仓库的定制内容。

上游仓库：https://github.com/LibreChat-AI/LibreChat  
生成后端：https://github.com/b8vipvip/chat2api
