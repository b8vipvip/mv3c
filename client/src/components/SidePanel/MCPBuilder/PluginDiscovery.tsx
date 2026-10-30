import { useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { Plus, Search } from 'lucide-react';
import { filterPluginCatalog } from './catalog';
import type { PluginPreset } from './catalog';

interface PluginDiscoveryProps {
  items: readonly PluginPreset[];
  installed: readonly string[];
  busyId: string | null;
  onAdd: (id: string) => void;
}

/** Add-only catalog. The server has already checked that every displayed
 * service is published, operator-configured and permitted for this user.
 * Never expose arbitrary URL, PAT, MCP server editing or OAuth app settings.
 */
export default function PluginDiscovery({ items, installed, busyId, onAdd }: PluginDiscoveryProps) {
  const [query, setQuery] = useState('');
  const available = useMemo(() =>
    filterPluginCatalog(items.filter((item) => !installed.includes(item.id)), query),
    [items, installed, query],
  );

  return (
    <section aria-label="添加插件" className="space-y-3">
      {items.length > 0 && (
        <label className="border-border-medium flex items-center gap-2 rounded-xl border px-3 py-2">
          <Search className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
          <span className="sr-only">搜索插件</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索插件" className="text-text-primary w-full min-w-0 bg-transparent text-sm outline-none" />
        </label>
      )}
      {available.length === 0 && (
        <p className="text-text-secondary py-5 text-center text-sm">
          {query ? '没有匹配的插件' : '暂无可添加的插件'}
        </p>
      )}
      <div className="space-y-2">
        {available.map((item) => (
          <article key={item.id} data-testid={`plugin-store-${item.id}`}
            className="border-border-light bg-surface-primary rounded-xl border p-3">
            <div className="flex items-start gap-3">
              <div className="bg-surface-tertiary text-text-secondary flex size-9 shrink-0 items-center justify-center rounded-lg">
                <Plus className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-text-primary text-sm font-semibold">{item.name}</p>
                <p className="text-text-secondary mt-1 text-xs">{item.description}</p>
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button type="button" size="sm" disabled={busyId !== null}
                onClick={() => onAdd(item.id)}>
                {busyId === item.id ? '正在添加…' : '添加'}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
