'use strict';
/** One server-owned registry for the curated mv3c plugin storefront. */
const catalog = Object.freeze([
  Object.freeze({
    id: 'github', name: 'GitHub', category: '开发工具',
    description: '浏览仓库、议题与 Pull Request；授权账号决定访问范围。',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http', auth: 'oauth',
    website: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
  }),
  Object.freeze({
    id: 'gitee', name: 'Gitee（码云）', category: '开发工具',
    description: '使用每位用户自己的 Gitee 访问令牌读取仓库、Issue 和 Pull Request；写操作需确认。',
    url: 'https://api.gitee.com/mcp',
    transport: 'streamable-http', auth: 'token',
    credentialUrl: 'https://gitee.com/profile/personal_access_tokens',
    website: 'https://blog.gitee.com/2026/01/26/gitee-mcp-support-remote-access-no-local-deployment-ai-assistant-plug-and-play/',
  }),
  Object.freeze({
    id: 'linear-readonly', name: 'Linear（只读）', category: '项目管理',
    description: '读取项目、任务和评论。',
    url: 'https://mcp.linear.app/mcp/readonly',
    transport: 'streamable-http', auth: 'oauth',
    website: 'https://linear.app/docs/mcp',
  }),
  Object.freeze({
    id: 'deepwiki', name: 'DeepWiki', category: '知识检索',
    description: '查询公开代码仓库知识。',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'streamable-http', auth: 'none',
    website: 'https://mcp.deepwiki.com/',
  }),
]);
const allowedIds = Object.freeze(catalog.map((item) => item.id));
function listCatalog(hiddenIds = [], includeHidden = false) {
  const hidden = new Set(Array.isArray(hiddenIds) ? hiddenIds : []);
  return catalog.filter((item) => includeHidden || !hidden.has(item.id)).map((item) => ({
    ...item, published: !hidden.has(item.id),
  }));
}
function validateHiddenCatalogIds(ids) {
  if (!Array.isArray(ids) || ids.length > allowedIds.length || new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !allowedIds.includes(id))) {
    throw new TypeError('plugins.catalogHidden must contain unique known plugin IDs');
  }
  return [...ids];
}
/** Never expose config objects or OAuth / user API secrets through admin inventory. */
function summarizeServer(record) {
  const config = record?.config ?? {};
  return {
    id: String(record?._id ?? ''),
    serverName: String(record?.serverName ?? '').slice(0, 128),
    title: typeof config.title === 'string' ? config.title.slice(0, 128) : '',
    author: String(record?.author ?? ''),
    authType: config.obo ? 'obo' : config.oauth ? 'oauth' : config.apiKey ? 'api-key' : 'none',
    createdAt: record?.createdAt ?? null,
    updatedAt: record?.updatedAt ?? null,
    // Registration is not a heartbeat/connection probe.
    state: 'registered',
  };
}
module.exports = { catalog, allowedIds, listCatalog, validateHiddenCatalogIds, summarizeServer };
