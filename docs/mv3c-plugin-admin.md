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
