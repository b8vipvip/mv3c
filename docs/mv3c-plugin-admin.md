# mv3c 管理后台「插件管理」

管理员登录 mv3c 后台后，左侧/顶部管理栏目新增独立的 **插件管理**。与「AI 供应商与模型」配置分离，避免多入口冲突。

## 管理项目

- **商店上架/下架**：由服务端 `mv3c/pluginCatalog.cjs` 维护唯一推荐目录，后台保存 `plugins.catalogHidden`。用户端 `/api/mcp/store/catalog` 只返回已上架项目；失败时拒绝回退本地旧目录。
- **MCP Apps 沙箱**：设置是否启用与独立 HTTPS `/api/mcp/sandbox` URL。仅保存配置，不负责 DNS、证书、代理部署与安全验收。默认关闭。
- **MCP 服务器登记概览**：从租户隔离的 MongoDB MCPServer 模型读取最多 100 条最新登记，显示名称、认证方式和更新时间。**已登记不代表连接在线**；管理员无法通过概览绕过原有资源 ACL/OAuth 管理。
- **工具协议诊断**：复用 `/api/admin/mv3c/plugins/compatibility` 的无副作用两轮探针，查询最近 50 条诊断和导出最多 500 条 CSV。历史信息不包含请求提示词、凭据、工具调用参数或 OAuth token。

## 管理 API

所有 `/api/admin/mv3c/plugins/*` 接口继承管理员 JWT Bearer 和 `ACCESS_ADMIN` 权限：

| 方法 | 地址 | 功能 |
|---|---|---|
| GET | /plugins/overview | 安全的目录+登记+策略概览 |
| PUT | /plugins/settings | 保存 `{ "plugins": { "catalogHidden": [...], "appsEnabled": false, "sandboxURL": "" }}` |
| POST | /plugins/compatibility | 进行无副作用的工具协议检测 |
| GET | /plugins/checks?limit=50 | 最近的工具协议记录 |
| GET | /plugins/checks/export | CSV 导出，带公式注入防护 |

用户端：`GET /api/mcp/store/catalog` 继承登录认证和 MCP 使用权限。

## 重要边界

“从商店下架”仅代表不再公开推荐安装，**不是全局禁用服务器**；既有会话/已安装服务器不会被删除或被静默撤销授权。真实禁用或撤销需要走原有的 MCP 连接和资源权限机制。后台概览不会冒充实时在线，也不会新增第二条工具执行或授权通道。

## 验收

1. 后台「AI 供应商与模型」页不再出现插件设置和诊断；「插件管理」可保存配置并刷新回显。
2. 将 GitHub 下架后，持有 MCP 使用权限的普通用户刷新商店只看到其余项目；重新上架后恢复。
3. 服务端返回的已登记服务器概览不包含 URL 中的 token、配置密钥、headers 或 OAuth client_secret。
4. 管理员能够查看历史诊断并导出 CSV；普通用户/无 Bearer 请求无法访问管理接口。
5. 独立沙箱未部署时保持默认关闭，不在主站渲染未经确认的第三方交互页面。
6. 测试仅验证协议探针，不代表真实 GitHub/Linear OAuth 和 MCP 多轮执行已成功。


## GitHub 与 Gitee 的管理员配置流程

服务端唯一内置目录新增 `Gitee（码云）`，使用 Gitee 官方远程 Streamable HTTP MCP：

- **Gitee URL:** `https://api.gitee.com/mcp`；PAT 创建：<https://gitee.com/profile/personal_access_tokens>。
- **GitHub URL:** `https://api.githubcopilot.com/mcp/`；细粒度 PAT 创建：<https://github.com/settings/personal-access-tokens>。
- 官方说明：<https://blog.gitee.com/2026/01/26/gitee-mcp-support-remote-access-no-local-deployment-ai-assistant-plug-and-play/>；<https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md>。

**管理后台 → 插件管理 → 插件服务与商店配置 → GitHub/Gitee →「配置连接」** 会打开原有 MCPServerDialog，默认：
1. Streamable HTTP + 上述官方 URL；
2. 认证类型 **API Key**，来源 **用户自行提供（User）**；
3. 标准 `Authorization: Bearer <user PAT>`（表单中只选 Bearer，不写入 token 到公共目录）；
4. 手动确认目标服务器可信并提交，由原有 MCP 注册处理器保存。

**区分三种状态**：已上架（商店可见）、已登记（MCP 服务器已经创建）、某用户实际连通（已授权、具备 MCP USE、密钥正确、工具发现成功）。前两者都不能代表第三者。管理员创建的服务器需要通过用户端「我的插件」的现有资源共享操作授予用户使用权；下架不影响已共享连接，也不负责全局强制禁用。

**用户端**：用户登录后打开「插件 → 我的插件」，找到获得共享权限的 GitHub/Gitee，按 UI 提示输入**个人**访问令牌；再在聊天输入框选择 `@GitHub`/`@Gitee` 或 `+` 工具菜单。令牌权限应遵循最小化原则，尤其不应授予多余的删除或修改私有仓库的权限。真实 Chat2API Worker 工具调用是否成功仍需从插件执行日志及输出验证，不可仅凭模型的协议探针证明。

若服务器配置为管理员共享单个令牌，会导致所有获授权用户共享该令牌身份，不建议此默认方式。OAuth 需要独立供应商应用和 OAuth 参数，不在未知 Client ID / Secret 的情况下伪造一键登录。

## 后台布局

管理后台改为支持深浅色的响应式左右分栏：桌面端固定分组侧栏（平台配置 / 运营数据 / 系统维护）和顶部页面标题栏；窄屏端使用横向导航、独立的可滚动管理内容区。保留原有管理员认证、设置 API、请求记录、日志与更新器的单一执行/终态权，不另建权限体系。
