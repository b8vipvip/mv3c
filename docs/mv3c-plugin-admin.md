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


## GitHub OAuth：管理员配置一次，用户仅授权自己的账号

新的 GitHub 插件不使用用户 PAT。它接入现有**唯一** MCP OAuth 流程：
服务器发现工具、用户授权、令牌隔离、回调 CSRF/state 校验、撤销及工具调用
均由 LibreChat/MV3C 的现有 MCP 系统实现，不增加自建工具执行器。

管理员在「插件管理 → GitHub 统一账号授权」中：

1. 先在后台「站点与注册」保存网站公开 HTTPS 地址，如 `https://chat.mv3.cn`。
   若未配置公开 HTTPS Origin，GitHub 托管连接将保持不可用（fail closed）。
2. 从 [GitHub OAuth Apps](https://github.com/settings/developers) 创建**本站专属** OAuth App；
3. 配置回调 URL：`https://chat.mv3.cn/api/mcp/github/oauth/callback`（必须与保存的站点公开域名一致；不依据浏览器 Host 猜测）；
4. 在管理员后台设置 Client ID、Client Secret，并启用 GitHub OAuth；
5. 保存后，统一的 GitHub MCP URL `https://api.githubcopilot.com/mcp/`、
   OAuth 授权端点和令牌交换端点由服务端自动配置；
6. Client Secret 通过现有 AES-256-GCM 密钥加密存储。公共设置、商店目录、
   普通用户页面、审计记录均不返回明文或加密后的密钥。

用户只需在「插件 → 发现插件」点击「连接 GitHub」，由 GitHub 自身
弹出登录和授权同意；无需访问 GitHub 的 PAT 管理页、复制个人 Token、
安装 MCP Server 或填写 URL。工具授权身份按 MV3C 用户分开存储，不共享 PAT。
普通用户不能经插件商店创建/修改服务器；高级 MCP 创建权限是另一条独立权限边界。

**安全边界：**

- 应用请求 `read:user repo` 权限。GitHub 的 `repo` 权限包含私有仓库
  访问，请站点运营者严格评估需要的范围，并让用户在 GitHub 页面自行决定
  是否同意；写操作仍应遵循原有工具批准与审计规则。
- GitHub OAuth 应用必须由管理员自行创建。没有真实 Client ID 和 Secret
  时不能伪造一键登录；未启用时用户端显示「等待管理员启用」。
- 商城中「连接 GitHub」只有在服务端验证真实 MCP 配置为管理员 config 层、
  官方服务器 URL/名称匹配且 OAuth 实际启用时才允许出现；名称相同、
  URL 相同的历史用户级 PAT/OAuth 服务器均不能冒充托管插件。
  普通用户的 MCP 列表会出于权限保护隐藏服务器 URL；商城必须使用服务端
  认证的 readiness 结果，而非要求浏览器读取被脱敏的 URL。
- Github Enterprise、自定义授权服务、跨租户策略需要单独适配。
- 自动连接成功必须以**实际 GitHub OAuth 回调、MCP 工具发现及一次
  用户授权下的真实调用**验收；本地单元测试不能证明外部授权已完成。
- Gitee、Linear 等其他服务可以由管理员进行独立接入，但目前不为
  未经 OAuth 验证的服务伪造一键账号授权按钮。

## 后台布局

管理后台改为支持深浅色的响应式左右分栏：桌面端固定分组侧栏（平台配置 / 运营数据 / 系统维护）和顶部页面标题栏；窄屏端使用横向导航、独立的可滚动管理内容区。保留原有管理员认证、设置 API、请求记录、日志与更新器的单一执行/终态权，不另建权限体系。
