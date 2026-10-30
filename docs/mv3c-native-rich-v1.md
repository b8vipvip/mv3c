# MV3C native rich v1 安全渲染

## 已实现
- NativeRichContent 只渲染强类型受限元素树：原生图片组、文本、列表、表格、静态节点与计算后安全 CSS 值；拒绝 scripts、iframe、event handler、任意属性及 CSS url()。
- 图片只接受 chat2api 现有已归档 /api/media/{id}/{token} HTTPS URL；使用现有 ImagePreview 的缩略图/原图下载机制，不重复保存资源。
- 只在一条可信消息携带 nativeContent（或 metadata.nativeContent）时尝试渲染；版本、媒体索引、样式或结构不匹配时立即回退现有 Markdown。
- 无任意 HTML 注入、脚本执行或原始上游 DOM。

## 关键未完成的部署集成（不能误判为完成）
现有 MV3C 后端采用站点级 CHAT2API_API_KEY 对接 chat2api，用户浏览器绝不能直接携带它调用上游 /v1/native-content。必须在服务端将 chat2api 真实 request_id 与当前登录的 MV3C 用户 / conversation / message_id 可靠绑定，并在已授权的消息读取接口中附加已验证的 nativeContent；流式时通过现有会话通道转发 native.snapshot，历史刷新仍需安全持久化。没有这个可信桥接时当前 UI 仍会使用 Markdown，不会暴露别人的回复。

## 实机验收
1. 旧消息、Voice、常规 Markdown 与纯文本在没有副轨时渲染不变。
2. 经认证桥接的 3 图并排、复杂图文表格、代码、长列表在相同视口下视觉对比。
3. 禁用副轨、媒体少于 DOM 图片数量、非法 DOM 节点和跨用户消息均回退或拒绝。
4. 验收 chat2api 与 MV3C 的缓存/刷新和实际资源 URL 对应关系。