/** Curated remote MCP servers with provider-published HTTPS endpoints.
 * Installation still goes through the existing MCP form (no silent consent).
 */
export type PluginCategory = '开发工具' | '项目管理' | '知识检索';
export type PluginPreset = Readonly<{
  id: string;
  name: string;
  description: string;
  category: PluginCategory;
  url: string;
  transport: 'streamable-http';
  auth: 'oauth' | 'none';
  website: string;
}>;
export const pluginCatalog: readonly PluginPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: '浏览仓库、议题与 Pull Request；操作范围由授权账号控制。',
    category: '开发工具',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    auth: 'oauth',
    website: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
  },
  {
    id: 'linear-readonly',
    name: 'Linear（只读）',
    description: '读取项目、任务和评论。使用官方只读 MCP 端点。',
    category: '项目管理',
    url: 'https://mcp.linear.app/mcp/readonly',
    transport: 'streamable-http',
    auth: 'oauth',
    website: 'https://linear.app/docs/mcp',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: '查询公开代码仓库的架构、说明与相关知识。',
    category: '知识检索',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'streamable-http',
    auth: 'none',
    website: 'https://mcp.deepwiki.com/',
  },
] as const;

export function findInstalledPreset(
  preset: PluginPreset,
  servers: ReadonlyArray<{ config?: { url?: string } }>,
): boolean {
  const expected = preset.url.replace(/\/+$/, '');
  return servers.some((server) => server.config?.url?.replace(/\/+$/, '') === expected);
}

export function filterPluginCatalog(query: string, category: string = '全部', items: readonly PluginPreset[] = pluginCatalog): PluginPreset[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((preset) =>
    (category === '全部' || preset.category === category) &&
    [preset.name, preset.description, preset.category].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  );
}
