# MV3C ↔ chat2api Native Rich v1：可信绑定与回退

## 完整路径
1. MV3C AgentClient.sendMessage 对管理员配置的 chat2api 端点建立 AsyncLocalStorage 请求作用域，内含仅服务端可见的用户、conversationId 和响应 messageId。
2. 在 @librechat/api 的 OpenAI 传输层，为同作用域内向受信任 chat2api 主机的 chat/completions 或 responses POST 生成独立随机 req_... 请求 ID，通过 x-chat2api-request-id 传递；保留 Undici 的代理、超时与原 SSE 流。
3. chat2api 现有请求记录/Worker 会用该 ID；MV3C 在收到 2xx 响应头后，将 ID 保存到 Mongo 的 user+conversationId+messageId 绑定中，TTL 90 天。用户输入、浏览器参数与模型输出文本均不允许写入绑定。
4. MV3C 已登录用户 GET /api/messages/{conversationId}/{messageId}/native-content 或 /events 时，服务端验证会话/助手消息所属权；回复尚未持久化时，只允许使用 GenerationJobManager 既有 user/tenant 归属规则、且 messageId 必须等于当前作业的 responseMessageId。
5. 服务端使用管理员配置的 chat2api API Key 请求 /v1/native-content/{request_id}，并仅向已授权的 MV3C 客户端交付快照或安全事件。客户端按 revision 更新，样式或媒体映射不合法时回退 Markdown。

## 强隔离约束
- 普通 OpenAI、Responses、图像和 Voice 标准内容/流/终态不受原生副轨支配；没有二次完成事件或绕过 Broker。
- 不提供任意 request_id 读取代理；浏览器没有 chat2api API Key、没有上游 request ID，也不允许自行写入绑定。
- 不允许跨用户、跨会话、跨消息读取；连接关闭时停止副轨流，并对上游副轨单次事件与响应大小设限。
- 紧急回滚可以撤销 MV3C 的侧轨绑定及组件，而无需修改 chat2api 主轨或原本模型接口。

## 验收限制
- chat2api 副轨 v1 仅支持受限静态 DOM 与布局样式，不能声称与 ChatGPT 私有 React 组件功能完全 1:1。
- 需实机跑含图片/文件/表格的 GameFlow，核对 Worker DOM 图片顺序与归档 media_index 是否一致。无对应映射则安全回退。
- 多轮工具/模型调用可能存在多个上游请求，当前映射最新被上游接受的请求；必须通过真实工具调用验证最终消息对应关系。
- 当前未改动服务器容器；主分支合并和生产部署、真实用户登录联调是独立门禁。