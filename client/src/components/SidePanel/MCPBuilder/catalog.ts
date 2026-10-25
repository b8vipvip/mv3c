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
// Published items are returned by /api/mcp/store/catalog; no second client catalogue.

export function findInstalledPreset(
  preset: PluginPreset,
  servers: ReadonlyArray<{ config?: { url?: string } }>,
): boolean {
  const expected = preset.url.replace(/\/+$/, '');
  return servers.some((server) => server.config?.url?.replace(/\/+$/, '') === expected);
}

export function filterPluginCatalog(items: readonly PluginPreset[], query: string, category: string = '全部'): PluginPreset[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((preset) =>
    (category === '全部' || preset.category === category) &&
    [preset.name, preset.description, preset.category].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  );
}
