import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, PlugZap, ExternalLink } from 'lucide-react';
import MCPServerDialog from '~/components/SidePanel/MCPBuilder/MCPServerDialog';
import { AuthTypeEnum, AuthorizationTypeEnum } from '~/components/SidePanel/MCPBuilder/MCPServerDialog/hooks/useMCPServerForm';

type PluginPolicy = {
  appsEnabled: boolean;
  sandboxURL: string;
  catalogHidden: string[];
};
type CatalogItem = {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  auth: 'oauth' | 'token' | 'none';
  credentialUrl?: string;
  website: string;
  published: boolean;
};
type RegisteredServer = {
  id: string;
  serverName: string;
  title: string;
  author: string;
  authType: string;
  updatedAt: string | null;
  state: 'registered';
};
type PluginOverview = {
  policy: PluginPolicy;
  catalogue: CatalogItem[];
  pluginRegistrations?: { id: string; count: number }[];
  registrations: RegisteredServer[];
  registeredCount: number;
  registrationLimit: number;
  inventoryIsLive: false;
};
type BridgeCheck = {
  id: string;
  at: string;
  actor: string;
  model: string;
  supported: boolean;
  roundTripSupported: boolean;
  reason: string;
  elapsedMs: number | null;
};

const field =
  'w-full rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-text-primary outline-none focus:border-blue-500';
const primary =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const secondary =
  'rounded-lg border border-border-medium px-3 py-2 text-sm text-text-primary hover:bg-surface-secondary disabled:opacity-50';
const pane = 'space-y-3 rounded-xl border border-border-medium bg-surface-primary p-4 sm:p-5';

async function callApi<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch('/api/admin/mv3c/plugins' + path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...init.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || '插件管理请求失败（HTTP ' + response.status + '）');
  }
  return result as T;
}

function when(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN');
}

export default function PluginAdminPanel({ token }: { token: string | null }) {
  const [overview, setOverview] = useState<PluginOverview | null>(null);
  const [draft, setDraft] = useState<PluginPolicy | null>(null);
  const [checks, setChecks] = useState<BridgeCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [configuring, setConfiguring] = useState<CatalogItem | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<string>('github');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [next, history] = await Promise.all([
        callApi<PluginOverview>(token, '/overview'),
        callApi<{ rows: BridgeCheck[] }>(token, '/checks?limit=50'),
      ]);
      setOverview(next);
      setDraft({ ...next.policy, catalogHidden: [...next.policy.catalogHidden] });
      setChecks(history.rows);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '插件设置加载失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!token || !draft || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await callApi<PluginOverview>(token, '/settings', {
        method: 'PUT',
        body: JSON.stringify({ plugins: draft }),
      });
      setOverview(next);
      setDraft({ ...next.policy, catalogHidden: [...next.policy.catalogHidden] });
      setMessage('插件设置已保存。商店上架状态由服务端控制；MCP Apps 仍需独立沙箱部署。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '插件设置保存失败');
    } finally {
      setBusy(false);
    }
  };

  const checkBridge = async () => {
    if (!token || checking) return;
    setChecking(true);
    setError('');
    setMessage('');
    try {
      const result = await callApi<{
        supported: boolean; roundTripSupported?: boolean; reason: string;
      }>(token, '/compatibility', { method: 'POST' });
      setMessage(result.supported && result.roundTripSupported
        ? '模型结构化工具调用及模拟结果续传已通过，真实 MCP 执行仍需单独测试。'
        : '工具协议检测未全部通过：' + result.reason);
      const history = await callApi<{ rows: BridgeCheck[] }>(token, '/checks?limit=50');
      setChecks(history.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : '协议检测失败');
    } finally {
      setChecking(false);
    }
  };

  const exportChecks = async () => {
    if (!token || exporting) return;
    setExporting(true);
    setError('');
    try {
      const response = await fetch('/api/admin/mv3c/plugins/checks/export', {
        credentials: 'same-origin', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!response.ok) throw new Error('导出失败（HTTP ' + response.status + '）');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mv3c-plugin-checks.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const presetInitial = useMemo(() => configuring ? ({
    title: configuring.name,
    description: configuring.description,
    type: 'streamable-http' as const,
    url: configuring.url,
    auth: configuring.auth === 'token' ? {
      auth_type: AuthTypeEnum.ServiceHttp,
      api_key_source: 'user' as const,
      api_key_authorization_type: AuthorizationTypeEnum.Bearer,
    } : undefined,
  }) : null, [configuring]);

  if (loading && !overview) return <p role="status" className="text-text-secondary">正在加载插件管理数据…</p>;
  if (!overview || !draft) {
    return <section className={pane}>
      <p role="alert" className="text-text-secondary">{error || '插件管理暂不可用'}</p>
      <button type="button" className={secondary} onClick={() => void load()}>重新加载</button>
    </section>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.policy);
  const configured = overview.catalogue.find((item) => item.id === detailPlugin);
  return (
    <div className="space-y-5" data-testid="mv3c-admin-plugins">
      <section className={pane}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">插件管理</h2>
            <p className="text-text-secondary mt-1 text-sm">
              统一配置插件商店、MCP Apps、安全策略和工具调用诊断。
              MCP 服务器的创建、OAuth 和调用权限仍由原有 MCP 系统管理。
            </p>
          </div>
          <button type="button" className={secondary} disabled={loading} onClick={() => void load()}>
            刷新数据
          </button>
        </div>
        {message && <p role="status" className="rounded-lg bg-surface-secondary p-3 text-sm">{message}</p>}
        {error && <p role="alert" className="text-red-600 text-sm">{error}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-surface-secondary p-3">
            <p className="text-text-secondary text-xs">商店上架插件</p>
            <p className="text-2xl font-semibold">
              {overview.catalogue.length - draft.catalogHidden.length}
              <span className="text-text-secondary ml-1 text-sm">/ {overview.catalogue.length}</span>
            </p>
          </div>
          <div className="rounded-lg bg-surface-secondary p-3">
            <p className="text-text-secondary text-xs">已登记 MCP 服务器</p>
            <p className="text-2xl font-semibold">{overview.registeredCount}</p>
          </div>
          <div className="rounded-lg bg-surface-secondary p-3">
            <p className="text-text-secondary text-xs">交互式 MCP Apps</p>
            <p className="text-lg font-semibold">{overview.policy.appsEnabled ? '已配置启用' : '未启用'}</p>
          </div>
        </div>
      </section>

      <section className={pane} aria-labelledby="plugin-store-heading">
        <h3 id="plugin-store-heading" className="text-lg font-semibold">插件服务与商店配置</h3>
        <p className="text-text-secondary text-sm">
          下架仅隐藏内置商店的推荐卡片，不会删除用户已安装的 MCP 服务器，也不能替代 MCP 权限管理。
        </p>
        <div className="divide-y divide-border-medium rounded-lg border border-border-medium">
          {overview.catalogue.map((plugin) => {
            const published = !draft.catalogHidden.includes(plugin.id);
            return <div className="flex flex-wrap items-center justify-between gap-3 p-3" key={plugin.id}>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{plugin.name} <span className="text-text-secondary text-xs">{plugin.category}</span></p>
                <p className="text-text-secondary text-xs">{plugin.description}</p>
                <p className="text-text-secondary mt-1 text-xs">MCP: <code className="break-all">{plugin.url}</code> · {plugin.auth === 'token' ? '每位用户独立提供访问令牌' : plugin.auth === 'oauth' ? 'OAuth' : '无需登录'}</p>
                <p className="text-text-secondary mt-1 text-xs">登记记录：{overview.pluginRegistrations?.find((item) => item.id === plugin.id)?.count ?? 0}（不代表已连接或已共享）</p>
                <a className="text-text-secondary text-xs underline" href={plugin.website}
                  target="_blank" rel="noopener noreferrer">服务商说明</a>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button type="button" className={secondary} onClick={() => { setDetailPlugin(plugin.id); setConfiguring(plugin); }}>
                  配置连接
                </button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={plugin.name + ' 上架'}
                  checked={published}
                  onChange={() => setDraft((prev) => {
                    if (!prev) return prev;
                    const hidden = new Set(prev.catalogHidden);
                    if (hidden.has(plugin.id)) hidden.delete(plugin.id);
                    else hidden.add(plugin.id);
                    return { ...prev, catalogHidden: overview.catalogue
                      .map((item) => item.id).filter((id) => hidden.has(id)) };
                  })}
                /> 上架
              </label>
              </div>
            </div>;
          })}
        </div>
      </section>

      <section className={pane} aria-labelledby="plugin-guide-heading">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="plugin-guide-heading" className="text-lg font-semibold">GitHub / Gitee 接入向导</h3>
            <p className="text-text-secondary mt-1 text-sm">配置是两步：管理员创建并授权共享 MCP 服务器，用户在聊天端使用自己的令牌连接。仅上架商店不会自动连接。</p>
          </div>
          <PlugZap className="h-5 w-5 shrink-0 text-text-secondary" />
        </div>
        <div className="flex flex-wrap gap-2">
          {overview.catalogue.filter((item) => item.id === 'github' || item.id === 'gitee').map((item) => (
            <button type="button" key={item.id} aria-pressed={detailPlugin === item.id}
              className={detailPlugin === item.id ? primary : secondary} onClick={() => setDetailPlugin(item.id)}>
              {item.id === 'github' ? 'GitHub' : 'Gitee'}
            </button>
          ))}
        </div>
        {configured && (configured.id === 'github' || configured.id === 'gitee') && (
          <div className="grid gap-4 rounded-xl bg-surface-secondary p-4 lg:grid-cols-2">
            <div className="space-y-3 text-sm">
              <h4 className="font-semibold">管理员配置</h4>
              <p><strong>1.</strong> 点击「配置连接」，核对官方 MCP 地址。</p>
              <p><strong>2.</strong> 认证选择「API Key」，勾选「用户自行提供」，请求头选择 Bearer。不要在管理员表单填入可访问全部私人仓库的共享令牌。</p>
              <p><strong>3.</strong> 完成 MCP 创建后，在用户端「我的插件」找到该服务器，使用原有「共享」功能授予目标用户 MCP 权限。</p>
              <button type="button" className={primary} onClick={() => setConfiguring(configured)}>
                <KeyRound className="mr-2 inline h-4 w-4" />配置 {configured.name}
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <h4 className="font-semibold">用户端连接</h4>
              <p><strong>1.</strong> 用户从服务商页面创建最小权限个人访问令牌（PAT），仅授予所需仓库和读写范围。</p>
              <p><strong>2.</strong> 进入「插件 → 我的插件」，选择已共享服务，输入自己的密钥并连接；确认工具可用。</p>
              <p><strong>3.</strong> 在聊天框输入「@{configured.name}」或点击「+」选择工具。写入、提交、合并等操作需要按工具的授权/确认流程执行。</p>
              <div className="flex flex-wrap gap-3">
                {configured.credentialUrl && <a href={configured.credentialUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 underline">
                  申请个人令牌 <ExternalLink className="h-3 w-3" />
                </a>}
                <Link to="/c/new" className="text-blue-600 underline">前往用户端</Link>
              </div>
            </div>
          </div>
        )}
        <p className="text-text-secondary text-xs">提示：在此添加的 MCP 服务器默认属于创建者。仅「上架」不自动授予全站用户调用权；已登记也不等于已授权。若普通用户无 MCP USE 权限，需在现有管理员 MCP 权限设置中开启。</p>
      </section>
      <MCPServerDialog open={configuring !== null}
        onOpenChange={(open) => { if (!open) { setConfiguring(null); void load(); } }}
        initial={presetInitial} />

      <section className={pane} aria-labelledby="plugin-sandbox-heading">
        <h3 id="plugin-sandbox-heading" className="text-lg font-semibold">交互式插件与沙箱</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.appsEnabled}
            onChange={(e) => setDraft((prev) => prev && ({ ...prev, appsEnabled: e.target.checked }))} />
          启用 MCP Apps 交互式界面
        </label>
        <label className="block space-y-2 text-sm">
          <span>独立 HTTPS 沙箱地址</span>
          <input type="url" className={field} value={draft.sandboxURL}
            placeholder="https://mcp-sandbox.example.com/api/mcp/sandbox"
            onChange={(e) => setDraft((prev) => prev && ({ ...prev, sandboxURL: e.target.value }))} />
        </label>
        <p className="text-text-secondary text-xs">
          必须先准备与主站不同源的 HTTPS 沙箱、反向代理和 CSP。填写地址不代表沙箱部署成功。
          对于会修改数据的工具，继续使用原有的用户授权和调用确认机制。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primary} disabled={busy || !dirty}
            onClick={() => void save()}>{busy ? '正在保存…' : '保存插件设置'}</button>
          <button type="button" className={secondary} disabled={!dirty || busy}
            onClick={() => setDraft({ ...overview.policy, catalogHidden: [...overview.policy.catalogHidden] })}>
            放弃修改
          </button>
          {dirty && <span className="text-text-secondary text-xs">有尚未保存的修改</span>}
        </div>
      </section>

      <section className={pane} aria-labelledby="plugin-inventory-heading">
        <h3 id="plugin-inventory-heading" className="text-lg font-semibold">MCP 服务器登记概览</h3>
        <p className="text-text-secondary text-sm">
          显示最近登记或更新的最多 {overview.registrationLimit} 项；登记不代表服务器在线、已授权或可执行。
          创建、编辑、授权、撤销请使用用户端「插件与连接」的原有权限保护流程。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead><tr className="border-b border-border-medium">
              <th className="px-2 py-2">服务器</th>
              <th className="px-2 py-2">授权类型</th>
              <th className="px-2 py-2">记录状态</th>
              <th className="px-2 py-2">更新时间</th>
            </tr></thead>
            <tbody>{overview.registrations.map((server) => (
              <tr key={server.id} className="border-b border-border-light">
                <td className="px-2 py-2">{server.title || server.serverName}</td>
                <td className="px-2 py-2">{server.authType}</td>
                <td className="px-2 py-2">已登记（非在线状态）</td>
                <td className="px-2 py-2">{when(server.updatedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
          {overview.registrations.length === 0 &&
            <p className="text-text-secondary py-4 text-sm">尚无数据库登记的 MCP 服务器</p>}
        </div>
      </section>

      <section className={pane} aria-labelledby="plugin-diagnostics-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="plugin-diagnostics-heading" className="text-lg font-semibold">chat2api 工具协议诊断</h3>
            <p className="text-text-secondary text-sm">
              检查标准函数调用和模拟结果续传；不执行外部 MCP 工具，不能证明真实插件调用成功。
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={secondary} disabled={exporting}
              onClick={() => void exportChecks()}>{exporting ? '导出中…' : '导出记录 CSV'}</button>
            <button type="button" className={primary} disabled={checking}
              onClick={() => void checkBridge()}>{checking ? '检测中…' : '运行诊断'}</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead><tr className="border-b border-border-medium">
              <th className="px-2 py-2">时间</th><th className="px-2 py-2">模型</th>
              <th className="px-2 py-2">函数调用</th><th className="px-2 py-2">结果续传</th>
              <th className="px-2 py-2">诊断原因</th><th className="px-2 py-2">耗时</th>
            </tr></thead>
            <tbody>{checks.map((entry) => <tr key={entry.id} className="border-b border-border-light">
              <td className="px-2 py-2">{when(entry.at)}</td>
              <td className="px-2 py-2">{entry.model}</td>
              <td className="px-2 py-2">{entry.supported ? '通过' : '失败'}</td>
              <td className="px-2 py-2">{entry.roundTripSupported ? '通过' : '未通过'}</td>
              <td className="px-2 py-2">{entry.reason}</td>
              <td className="px-2 py-2">{entry.elapsedMs ?? '—'} ms</td>
            </tr>)}</tbody>
          </table>
          {checks.length === 0 && <p className="text-text-secondary py-4 text-sm">尚无工具协议诊断记录</p>}
        </div>
      </section>
    </div>
  );
}
