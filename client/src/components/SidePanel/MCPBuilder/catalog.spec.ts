import { filterPluginCatalog, findInstalledPreset, pluginCatalog } from './catalog';

describe('mv3c plugin marketplace catalog', () => {
  it('contains only provider-published HTTPS endpoints', () => {
    expect(pluginCatalog.length).toBeGreaterThan(1);
    for (const preset of pluginCatalog) {
      expect(preset.transport).toBe('streamable-http');
      expect(new URL(preset.url).protocol).toBe('https:');
      expect(new URL(preset.website).protocol).toBe('https:');
      expect(preset.name).toBeTruthy();
    }
  });

  it('supports Chinese search and category filtering', () => {
    expect(filterPluginCatalog('知识').map((item) => item.id)).toContain('deepwiki');
    expect(filterPluginCatalog('github').map((item) => item.id)).toEqual(['github']);
    expect(filterPluginCatalog('', '项目管理').map((item) => item.id)).toEqual(['linear-readonly']);
    expect(filterPluginCatalog('nonexistent')).toEqual([]);
  });

  it('detects existing installs by normalized URL rather than display name', () => {
    const preset = pluginCatalog[0];
    expect(findInstalledPreset(preset, [{ config: { url: preset.url.slice(0, -1) } }])).toBe(true);
    expect(findInstalledPreset(preset, [{ config: { url: 'https://other.example/mcp' } }])).toBe(false);
  });
});
