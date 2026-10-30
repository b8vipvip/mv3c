import { filterPluginCatalog, findInstalledPreset, findConfiguredPluginServer } from './catalog';
import type { PluginPreset } from './catalog';

// Search/filter fixtures only. The actual catalogue is owned by the server.
const pluginCatalog: PluginPreset[] = [
  { id: 'github', name: 'GitHub', category: '开发工具',
    description: '仓库', url: 'https://example.com/github/',
    auth: 'oauth', transport: 'streamable-http', website: 'https://example.com' },
  { id: 'linear-readonly', name: 'Linear', category: '项目管理',
    description: '任务', url: 'https://example.com/linear/',
    auth: 'oauth', transport: 'streamable-http', website: 'https://example.com' },
  { id: 'deepwiki', name: 'DeepWiki', category: '知识检索',
    description: '中文知识', url: 'https://example.com/wiki/',
    auth: 'none', transport: 'streamable-http', website: 'https://example.com' },
];

describe('mv3c plugin marketplace catalog', () => {
  it('handles server-supplied HTTPS records', () => {
    expect(pluginCatalog.length).toBeGreaterThan(1);
    for (const preset of pluginCatalog) {
      expect(preset.transport).toBe('streamable-http');
      expect(new URL(preset.url).protocol).toBe('https:');
      expect(new URL(preset.website).protocol).toBe('https:');
    }
  });

  it('supports Chinese search and category filtering', () => {
    expect(filterPluginCatalog(pluginCatalog, '知识').map((item) => item.id)).toContain('deepwiki');
    expect(filterPluginCatalog(pluginCatalog, 'github').map((item) => item.id)).toEqual(['github']);
    expect(filterPluginCatalog(pluginCatalog, '', '项目管理').map((item) => item.id)).toEqual(['linear-readonly']);
    expect(filterPluginCatalog(pluginCatalog, 'nonexistent')).toEqual([]);
    expect(filterPluginCatalog([], 'github')).toEqual([]);
  });

  it('detects existing installs by normalized URL rather than display name', () => {
    const preset = pluginCatalog[0];
    expect(findInstalledPreset(preset, [{ config: { url: preset.url.slice(0, -1) } }])).toBe(true);
    expect(findInstalledPreset(preset, [{ config: { url: 'https://other.example/mcp' } }])).toBe(false);
  });
});

describe('operator managed GitHub OAuth binding', () => {
  const preset = pluginCatalog[0];
  const oauthServer = {
    serverName: 'github',
    config: { url: preset.url, oauth: { client_id: 'server-provisioned' } },
  };
  const impostor = {
    serverName: 'user-personal-pat',
    config: { url: preset.url, apiKey: { source: 'user' } },
  };

  it('requires the server-side readiness flag, fixed name and OAuth config', () => {
    expect(findConfiguredPluginServer(preset, [oauthServer], false)).toBeUndefined();
    expect(findConfiguredPluginServer(preset, [impostor], true)).toBeUndefined();
    expect(findConfiguredPluginServer(preset, [{
      serverName: 'github', config: { url: preset.url, apiKey: { source: 'user' } },
    }], true)).toBeUndefined();
    expect(findConfiguredPluginServer(preset, [impostor, oauthServer], true)).toEqual(oauthServer);
  });

  it('does not advertise a PAT-only preset as an account-connect flow', () => {
    const gitee: PluginPreset = {
      ...preset, id: 'gitee', auth: 'token',
    };
    expect(findConfiguredPluginServer(gitee, [{
      serverName: 'gitee', config: { url: gitee.url, apiKey: { source: 'user' } },
    }], true)).toBeUndefined();
  });
});
