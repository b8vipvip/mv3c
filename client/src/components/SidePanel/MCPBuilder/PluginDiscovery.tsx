import { useEffect, useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { ExternalLink, PlugZap, CheckCircle2, Search } from 'lucide-react';
import type { MCPServerDefinition } from '~/hooks';
import { useAuthContext } from '~/hooks';
import { filterPluginCatalog, findInstalledPreset } from './catalog';
import type { PluginPreset } from './catalog';

interface PluginDiscoveryProps {
  servers: MCPServerDefinition[];
  canInstall: boolean;
  onInstall: (preset: PluginPreset) => void;
}

const categories = ['全部', '开发工具', '项目管理', '知识检索'] as const;

/** This catalog installs only explicit provider-published HTTPS MCP endpoints.
 * User consent, credentials, and server creation remain owned by MCPServerDialog.
 */
export default function PluginDiscovery({ servers, canInstall, onInstall }: PluginDiscoveryProps) {
  const { token } = useAuthContext();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('全部');
  const [catalog, setCatalog] = useState<readonly PluginPreset[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setCatalog([]);
    if (!token) { setCatalogLoading(false); return () => controller.abort(); }
    setCatalogLoading(true);
    fetch('/api/mcp/store/catalog', {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + token },
    }).then(async (response) => {
      if (!response.ok) throw new Error('商店目录暂不可用');
      const result = await response.json() as { items?: PluginPreset[] };
      if (!Array.isArray(result.items)) throw new Error('商店目录数据无效');
      if (!controller.signal.aborted) { setCatalog(result.items); setCatalogError(''); }
    }).catch(() => {
      if (!controller.signal.aborted) { setCatalogError('插件目录加载失败，请重试'); setCatalog([]); }
    }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [token]);
  const items = useMemo(() => filterPluginCatalog(catalog, query, category), [query, category, catalog]);
  const installed = servers.map((server) => ({
    config: { url: 'url' in server.config ? server.config.url : undefined },
  }));

  return (
    <section aria-label="发现插件" className="space-y-3 px-3 pb-4">
      <p className="text-text-secondary text-xs">
        选择插件后查看地址与授权范围，再由你确认安装。连接第三方账号会跳转至相应服务商。
      </p>
      <label className="border-border-medium flex items-center gap-2 rounded-xl border px-3 py-2">
        <Search className="text-text-secondary h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">搜索插件</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索插件"
          className="text-text-primary w-full min-w-0 bg-transparent text-sm outline-none"
        />
      </label>
      <div className="flex flex-wrap gap-1.5" aria-label="插件分类">
        {categories.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === category}
            onClick={() => setCategory(item)}
            className={`rounded-full px-3 py-1.5 text-xs ${item === category
              ? 'bg-surface-active text-text-primary font-medium'
              : 'text-text-secondary hover:bg-surface-hover'}`}
          >
            {item}
          </button>
        ))}
      </div>
      {catalogLoading && <p role="status" className="text-text-secondary py-4 text-center text-sm">正在加载插件目录…</p>}
      {catalogError && <p role="alert" className="text-text-secondary py-4 text-center text-sm">{catalogError}</p>}
      {!catalogLoading && !catalogError && items.length === 0 && (
        <p className="text-text-secondary py-6 text-center text-sm">没有匹配的插件</p>
      )}
      <div className="grid gap-2">
        {items.map((preset) => {
          const added = findInstalledPreset(preset, installed);
          return (
            <article
              key={preset.id}
              className="border-border-light bg-surface-primary rounded-xl border p-3"
              data-testid={`plugin-store-${preset.id}`}
            >
              <div className="flex items-start gap-3">
                <div className="bg-surface-tertiary text-text-secondary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <PlugZap className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-text-primary text-sm font-semibold">{preset.name}</div>
                  <p className="text-text-secondary text-xs">{preset.description}</p>
                  <p className="text-text-tertiary text-xs">
                    {preset.category} · {preset.auth === 'oauth' ? '账号授权' : '无需登录'}
                  </p>
                  <a
                    href={preset.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-secondary inline-flex items-center gap-1 text-xs underline"
                  >
                    服务商文档 <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                {added ? (
                  <span className="text-text-secondary inline-flex items-center gap-1 text-xs">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> 已添加
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canInstall}
                    onClick={() => onInstall(preset)}
                  >
                    {canInstall ? '添加插件' : '需要安装权限'}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
