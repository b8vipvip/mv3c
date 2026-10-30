import { useEffect, useId, useState } from 'react';
import { Plus, PlugZap, Trash2 } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import {
  Button, OGDialog, OGDialogContent, OGDialogTitle, OGDialogDescription,
} from '@librechat/client';
import { useMCPServerManager, useAuthContext, activateCatalog } from '~/hooks';
import { PanelHeader } from '~/components/ui';
import McpOAuthDialog from '~/components/MCP/McpOAuthDialog';
import PluginDiscovery from './PluginDiscovery';
import type { PluginPreset } from './catalog';
import store from '~/store';

type PluginStoreResponse = {
  items: PluginPreset[];
  installed: string[];
};

export default function MCPBuilderPanel() {
  const headingId = useId();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { token } = useAuthContext();
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const panelVisible = sidebarExpanded && !location.pathname.startsWith('/insights');
  useEffect(() => {
    if (panelVisible) activateCatalog('mcpServers');
  }, [panelVisible]);

  const {
    initializeServer, getOAuthUrl, isInitializing, connectionStatus,
  } = useMCPServerManager({ observeToolAuthorization: panelVisible });
  const [storefront, setStorefront] = useState<PluginStoreResponse>({ items: [], installed: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingOAuthServer, setPendingOAuthServer] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStorefront({ items: [], installed: [] });
    setError('');
    if (!token) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    fetch('/api/mcp/store/catalog', {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + token },
    }).then(async (response) => {
      if (!response.ok) throw new Error('插件列表加载失败');
      return response.json() as Promise<PluginStoreResponse>;
    }).then((data) => {
      if (!controller.signal.aborted) {
        setStorefront({
          items: Array.isArray(data.items) ? data.items : [],
          installed: Array.isArray(data.installed) ? data.installed : [],
        });
      }
    }).catch(() => {
      if (!controller.signal.aborted) setError('插件列表加载失败，请刷新后重试');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [token]);

  const changeInstallation = async (id: string, method: 'POST' | 'DELETE') => {
    if (!token || busyId) return;
    setBusyId(id);
    setError('');
    try {
      const response = await fetch('/api/mcp/store/' + encodeURIComponent(id), {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!response.ok) throw new Error('操作失败，请重试');
      const data = await response.json() as PluginStoreResponse;
      setStorefront({
        items: Array.isArray(data.items) ? data.items : [],
        installed: Array.isArray(data.installed) ? data.installed : [],
      });
      if (method === 'POST') setAddOpen(false);
      // Newly added/removed plugin tools are published only after the next
      // per-user catalogue refresh, never from the operator's global list.
      await Promise.all([
        queryClient.invalidateQueries([QueryKeys.mcpTools]),
        queryClient.invalidateQueries([QueryKeys.mcpConnectionStatus]),
      ]);
    } catch {
      setError('插件操作失败，请重试');
    } finally {
      setBusyId(null);
    }
  };
  const connect = async (serverName: string) => {
    const result = await initializeServer(serverName, false);
    if (result?.oauthRequired && result.oauthUrl) setPendingOAuthServer(serverName);
  };

  const myPlugins = storefront.items.filter((item) => storefront.installed.includes(item.id));
  const addable = storefront.items.filter((item) => !storefront.installed.includes(item.id));

  return (
    <div role="region" aria-labelledby={headingId}
      className="flex h-full w-full flex-col overflow-hidden pt-2">
      <PanelHeader title="我的插件" titleId={headingId}
        action={
          <Button type="button" size="sm" variant="outline"
            onClick={() => setAddOpen(true)} aria-label="添加插件">
            <Plus className="mr-1 size-4" aria-hidden="true" />添加插件
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {error && <p role="alert" className="text-text-destructive py-2 text-xs">{error}</p>}
        {loading && <p role="status" className="text-text-secondary py-3 text-sm">正在加载…</p>}
        {!loading && myPlugins.map((item) => {
          const serverName = item.serverName;
          const state = serverName ? connectionStatus?.[serverName] : undefined;
          const connected = state?.connectionState === 'connected' &&
            (item.auth !== 'oauth' || state.authorizationState === 'authorized');
          return (
            <div key={item.id} data-testid={`my-plugin-${item.id}`}
              className="border-border-light my-2 rounded-xl border p-3">
              <div className="flex items-start gap-2">
                <PlugZap className="text-text-secondary mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-text-primary text-sm font-semibold">{item.name}</p>
                  <p className="text-text-secondary mt-1 text-xs">{item.description}</p>
                  <p className="text-text-secondary mt-1 text-xs">{connected ? '已连接' : '未连接'}</p>
                </div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                {!connected && serverName && (
                  <Button type="button" size="sm" variant="outline"
                    disabled={isInitializing(serverName) || busyId !== null}
                    onClick={() => { void connect(serverName); }}>
                    {isInitializing(serverName) ? '连接中…' : '连接账号'}
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline"
                  disabled={busyId !== null}
                  onClick={() => { void changeInstallation(item.id, 'DELETE'); }}
                  aria-label={`移除${item.name}`}>
                  <Trash2 className="mr-1 size-4" aria-hidden="true" />移除
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <OGDialog open={addOpen} onOpenChange={setAddOpen}>
        <OGDialogContent className="w-11/12 max-w-lg overflow-y-auto rounded-2xl">
          <OGDialogTitle>添加插件</OGDialogTitle>
          <OGDialogDescription>
            选择插件添加到“我的插件”。需要登录的插件可在添加后连接自己的账号。
          </OGDialogDescription>
          <PluginDiscovery items={addable} installed={storefront.installed}
            busyId={busyId} onAdd={(id) => { void changeInstallation(id, 'POST'); }} />
        </OGDialogContent>
      </OGDialog>
      <McpOAuthDialog
        open={pendingOAuthServer !== null && getOAuthUrl(pendingOAuthServer ?? '') != null}
        onOpenChange={(open) => { if (!open) setPendingOAuthServer(null); }}
        serverName={pendingOAuthServer ?? ''}
        oauthUrl={getOAuthUrl(pendingOAuthServer ?? '') ?? ''}
      />
    </div>
  );
}
