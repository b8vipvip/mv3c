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
  auth: 'oauth' | 'token' | 'none';
  credentialUrl?: string;
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

/**
 * The GitHub account-connect card must resolve only to the operator-owned
 * OAuth config server, never to a user-created PAT server with the same URL.
 * The server still makes the authoritative permission / OAuth decisions.
 */
export function findConfiguredPluginServer<T extends { serverName: string; config: unknown }>(
  preset: PluginPreset,
  servers: readonly T[],
  managedGithubReady: boolean,
): T | undefined {
  if (preset.id === 'github' && !managedGithubReady) return undefined;
  const expected = preset.url.replace(/\/+$/, '');
  return servers.find((server) => {
    const config = server.config as {
      url?: unknown; oauth?: unknown; source?: unknown;
    } | null;
    if (!config) return false;
    if (preset.id === 'github') {
      // /store/catalog already verified this user's effective server URL,
      // operator source, and OAuth configuration before issuing the readiness
      // flag. /mcp/servers intentionally REDACTS the URL for ordinary users.
      // Never make a one-click connection depend on that hidden field.
      // If the URL is visible (e.g. admin), still reject any mismatch.
      return server.serverName === 'github' &&
        config.source === 'config' &&
        config.oauth !== null && typeof config.oauth === 'object' &&
        (config.url === undefined ||
          (typeof config.url === 'string' &&
            config.url.replace(/\/+$/, '') === expected));
    }
    if (typeof config.url !== 'string' ||
        config.url.replace(/\/+$/, '') !== expected) return false;
    // User-supplied PATs are deliberately not a one-click catalog connection.
    // Such providers require an operator-managed OAuth integration first.
    if (preset.auth === 'token') return false;
    return true;
  });
}
