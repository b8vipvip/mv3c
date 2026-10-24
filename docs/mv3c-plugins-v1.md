# mv3c 插件商店 / MCP 连接与协议验证

此功能以原有 LibreChat/MCP 服务器注册、授权、执行及确认流程为唯一执行通道，不再建立第二个工具执行器。

## 插件商店

左侧“插件”中可切换“发现插件”及“我的插件”。发现页预置官方文档可确认的远程 MCP 服务：

- GitHub（https://api.githubcopilot.com/mcp/）
- Linear 只读（https://mcp.linear.app/mcp/readonly）
- DeepWiki（https://mcp.deepwiki.com/mcp）

“添加插件”**并不会自动授权或连接**，而是打开预填了公开信息的原始 MCPServerDialog。使用者要自行确认服务器地址、信任、凭证和 OAuth 连接。创建、权限检查、撤销、删除和工具发现与旧 MCP 通道一致。未授予 MCPSERVER.CREATE 时按钮不可用。

## 对话调用

在有 MCP 使用权限的普通聊天输入框键入 `@`，可在模型选择和已有智能体条目之外选中“插件：...”。它复用同一 BadgeRowProvider / mcpValues 状态，避免切换重复选择或新增隐藏决策器。

选中尚未连接的插件会发起现有初始化/账号授权流程。模型发起的实际 MCP 工具执行，依赖项目已有 ephemeral agent / MCP 运行路径；并非看到“已添加”就代表工具执行成功。用户通过输入框 `+` 也可切换工具。

## chat2api 工具协议

管理员后台 chat2api 区域的“检测工具调用协议”会向已经保存的 chat2api 服务发起两次无副作用的 OpenAI Chat Completions 请求：

1. 请求模型产生名为 `mv3c_tool_capability_probe` 的结构化函数调用；
2. 若调用结构有效，提交带 `tool_call_id` 的**模拟工具结果**，检查模型是否继续输出该结果。

两次请求均不执行插件操作，不允许传入任意外部 URL 或工具代码，也不会在返回值、日志、数据库中记录 API Key。仅管理员可以触发；耗时、模型名和结果会保留为审计证据。**通过不等于真实 MCP 工具调用已完成**，尤其不证明有副作用工具的执行权限、用户确认、多轮状态以及 chat2api 全量 Worker 兼容。

## MCP Apps 交互式 UI

原有 MCP Apps 的沙箱渲染、调用确认、资源请求和速率限制组件已存在，但 mv3c 默认为 `appsEnabled: false`。

只有运营人员明确部署独立 HTTPS 源，确保 `/api/mcp/sandbox` 路由可用，且经过 CSP/代理和 Cookie 隔离检查后，才能在管理后台提交：

```json
{
  "plugins": {
    "appsEnabled": true,
    "sandboxURL": "https://mcp-sandbox.example.net/api/mcp/sandbox"
  }
}
```

不允许以 HTTP、带查询令牌的 URL 或主站相同域名启用。未部署独立源时**请保持关闭**。配置保存不包含自动购买 DNS、下发 TLS 证书或设置反向代理。

## 最低验收流程

1. 无 MCP 创建权限用户打开商店：只能查看，不能安装。
2. 管理员添加 DeepWiki，确认真实 URL，查看已安装列表并连接。切换聊天 `+` 或 `@` 条目，确认所选工具进入 ephemeral agent。
3. OAuth 服务必须在服务商授权后才进入已连接状态；撤销后不能继续调用。
4. 在管理员后台点击工具协议检查，检查第一步及结果回传分别是否通过（可能因 chat2api/Worker 版本不兼容而失败）。
5. 为有副作用的工具配置人工批准，测试拒绝、批准、异常、超时、审计日志。
6. 单独在可用独立沙箱上验证 MCP Apps，确认与主站不同源、CSP 生效、授权确认可拒绝；否则保持关闭。

当前 CI 能验证本地配置、类型编译和模拟协议；**外部 OAuth 授权、真实 MCP 读写和 chat2api 多 Worker 跨服务执行必须在实际部署环境补做**。
