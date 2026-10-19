import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthContext } from '~/hooks';

type SiteSettings = {
  title: string;
  welcome: string;
  publicUrl: string;
  registrationEnabled: boolean;
};
type ProviderSettings = {
  enabled: boolean;
  baseURL: string;
  models: string[];
  fetchModels: boolean;
  apiKeyConfigured: boolean;
  configured: boolean;
};
type AdminSettings = {
  site: SiteSettings;
  chat2api: ProviderSettings;
  updatedAt: string | null;
};
type ManagedUser = {
  id: string;
  email: string;
  name?: string;
  role: string;
  createdAt?: string;
};
type UsersResponse = { total: number; users: ManagedUser[] };

async function adminRequest<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/admin/mv3c' + path, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || (response.status === 403
      ? '没有管理员权限' : '请求失败 (HTTP ' + response.status + ')'));
  }
  return body as T;
}

const fieldClass =
  'w-full rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-text-primary outline-none focus:border-blue-500';
const buttonClass =
  'rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const subtleButton =
  'rounded-lg border border-border-medium px-4 py-2 text-text-primary hover:bg-surface-secondary disabled:opacity-50';

export default function Mv3cAdmin() {
  const { token, isAuthenticated, user } = useAuthContext();
  const [tab, setTab] = useState<'provider' | 'site' | 'users'>('provider');
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [site, setSite] = useState<SiteSettings>({
    title: 'mv3c', welcome: '欢迎使用 mv3c', publicUrl: '', registrationEnabled: false,
  });
  const [provider, setProvider] = useState<ProviderSettings>({
    enabled: true, baseURL: '', models: [], fetchModels: true,
    apiKeyConfigured: false, configured: false,
  });
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [users, setUsers] = useState<UsersResponse | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [testModels, setTestModels] = useState<string[] | null>(null);

  const applySettings = useCallback((data: AdminSettings) => {
    setSettings(data);
    setSite(data.site);
    setProvider(data.chat2api);
    setModelsText(data.chat2api.models.join('\n'));
    setApiKey('');
  }, []);

  const loadSettings = useCallback(async () => {
    if (!token) return;
    try {
      const result = await adminRequest<AdminSettings>(token, '');
      applySettings(result);
      setAllowed(true);
      setError('');
    } catch (err) {
      const text = err instanceof Error ? err.message : '加载失败';
      if (text.includes('403') || text.includes('权限')) setAllowed(false);
      setError(text);
    }
  }, [token, applySettings]);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    try {
      setUsers(await adminRequest<UsersResponse>(token, '/users'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '用户列表加载失败');
    }
  }, [token]);

  useEffect(() => {
    if (token) void loadSettings();
  }, [token, loadSettings]);

  useEffect(() => {
    if (token && tab === 'users') void loadUsers();
  }, [token, tab, loadUsers]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = () => run(async () => {
    if (!token) return;
    const models = modelsText.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    const data = await adminRequest<AdminSettings>(token, '', {
      method: 'PUT',
      body: JSON.stringify({
        chat2api: {
          enabled: provider.enabled,
          baseURL: provider.baseURL,
          fetchModels: provider.fetchModels,
          models,
          ...(apiKey ? { apiKey } : {}),
        },
      }),
    });
    applySettings(data);
    setTestModels(null);
    setMessage('chat2api 配置已保存，新的聊天请求将使用更新后的配置。');
  });

  const saveSite = () => run(async () => {
    if (!token) return;
    const data = await adminRequest<AdminSettings>(token, '', {
      method: 'PUT',
      body: JSON.stringify({ site }),
    });
    applySettings(data);
    setMessage('站点配置已保存。刷新登录页即可看到最新设置。');
  });

  const testConnection = () => run(async () => {
    if (!token) return;
    const result = await adminRequest<{ ok: boolean; models: string[]; count: number }>(
      token, '/test', { method: 'POST' });
    setTestModels(result.models);
    setMessage('连接成功：从 chat2api 读取到 ' + result.count + ' 个模型。');
  });

  const syncModels = () => run(async () => {
    if (!token) return;
    const data = await adminRequest<AdminSettings & { syncedModels: string[] }>(
      token, '/models/sync', { method: 'POST' });
    applySettings(data);
    setMessage('模型已同步并保存：' + data.syncedModels.length + ' 个。');
  });

  const changeRole = (id: string, role: string) => run(async () => {
    if (!token) return;
    await adminRequest(token, '/users/' + encodeURIComponent(id) + '/role', {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    await loadUsers();
    setMessage('用户角色已更新。');
  });

  if (!isAuthenticated || !token) {
    return (
      <main className="mx-auto max-w-xl p-10 text-text-primary">
        <h1 className="mb-4 text-2xl font-semibold">mv3c 管理后台</h1>
        <p className="mb-4">请先登录管理员账号。</p>
        <Link className="text-blue-500 underline" to="/login">前往登录</Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-surface-primary text-text-primary">
      <header className="border-b border-border-medium bg-surface-secondary px-5 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">mv3c Admin</h1>
            <p className="text-sm text-text-secondary">统一管理站点、chat2api 和用户</p>
          </div>
          <Link to="/c/new" className={subtleButton}>返回聊天</Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-6">
        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-red-500 p-3 text-red-500">
            {error}
          </div>
        )}
        {message && (
          <div role="status" className="mb-4 rounded-lg border border-green-500 p-3 text-green-600">
            {message}
          </div>
        )}
        {!allowed ? (
          <section className="rounded-xl border border-border-medium p-6">
            此账号没有管理员权限。只有具备 ACCESS_ADMIN 权限的账号可以访问本页面。
          </section>
        ) : !settings ? (
          <p className="text-text-secondary">正在加载管理配置…</p>
        ) : (
          <>
            <nav aria-label="管理栏目" className="mb-6 flex flex-wrap gap-2">
              {([
                ['provider', 'AI 供应商与模型'],
                ['site', '站点与注册设置'],
                ['users', '用户管理'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setTab(key); setError(''); setMessage(''); }}
                  className={tab === key ? buttonClass : subtleButton}
                  aria-current={tab === key ? 'page' : undefined}
                >
                  {label}
                </button>
              ))}
            </nav>

            {tab === 'provider' && (
              <section className="space-y-5 rounded-xl border border-border-medium p-5">
                <div>
                  <h2 className="text-xl font-semibold">chat2api 连接配置</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    API Key 仅在服务端加密保存。留空表示保留已经保存的密钥。
                  </p>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={provider.enabled}
                    onChange={(e) => setProvider((p) => ({ ...p, enabled: e.target.checked }))}
                  />
                  启用 chat2api
                </label>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">API Base URL（以 /v1 结尾）</span>
                  <input
                    className={fieldClass}
                    value={provider.baseURL}
                    placeholder="https://api.example.com/v1"
                    onChange={(e) => setProvider((p) => ({ ...p, baseURL: e.target.value }))}
                    autoComplete="off"
                  />
                </label>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">API Key</span>
                  <input
                    className={fieldClass}
                    type="password"
                    value={apiKey}
                    placeholder={provider.apiKeyConfigured ? '已配置；留空不修改' : '请输入 chat2api API Key'}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="new-password"
                  />
                  <span className="block text-xs text-text-secondary">
                    {provider.apiKeyConfigured ? '密钥已保存（不可回显）' : '尚未保存密钥'}
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={provider.fetchModels}
                    onChange={(e) => setProvider((p) => ({ ...p, fetchModels: e.target.checked }))}
                  />
                  聊天界面自动从 /v1/models 获取模型
                </label>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">可选模型 ID（每行一个）</span>
                  <textarea
                    className={fieldClass}
                    rows={6}
                    value={modelsText}
                    onChange={(e) => setModelsText(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className={buttonClass} disabled={busy} onClick={() => void saveProvider()}>
                    保存配置
                  </button>
                  <button className={subtleButton} disabled={busy || !settings.chat2api.configured}
                    onClick={() => void testConnection()}>
                    测试已保存连接
                  </button>
                  <button className={subtleButton} disabled={busy || !settings.chat2api.configured}
                    onClick={() => void syncModels()}>
                    同步并保存模型
                  </button>
                </div>
                {testModels && (
                  <div className="rounded-lg bg-surface-secondary p-4 text-sm">
                    <strong>已发现模型：</strong> {testModels.join('、')}
                  </div>
                )}
                <p className="text-xs text-text-secondary">
                  所有 mv3c 用户共享此 chat2api API Key；Worker 和模型执行仍由 chat2api 管理。
                </p>
              </section>
            )}

            {tab === 'site' && (
              <section className="space-y-5 rounded-xl border border-border-medium p-5">
                <h2 className="text-xl font-semibold">站点设置</h2>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">网站名称</span>
                  <input className={fieldClass} value={site.title}
                    onChange={(e) => setSite((s) => ({ ...s, title: e.target.value }))} />
                </label>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">聊天欢迎语</span>
                  <input className={fieldClass} value={site.welcome}
                    onChange={(e) => setSite((s) => ({ ...s, welcome: e.target.value }))} />
                </label>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">网站公网地址（HTTPS）</span>
                  <input className={fieldClass} value={site.publicUrl}
                    placeholder="https://chat.example.com"
                    onChange={(e) => setSite((s) => ({ ...s, publicUrl: e.target.value }))} />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={site.registrationEnabled}
                    onChange={(e) => setSite((s) => ({
                      ...s, registrationEnabled: e.target.checked,
                    }))} />
                  允许新用户自行注册
                </label>
                <p className="text-sm text-text-secondary">
                  首次安装时仅允许创建第一个管理员账号，创建成功后默认关闭公开注册。
                </p>
                <button className={buttonClass} disabled={busy} onClick={() => void saveSite()}>
                  保存站点设置
                </button>
              </section>
            )}

            {tab === 'users' && (
              <section className="rounded-xl border border-border-medium p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-semibold">用户管理</h2>
                    <p className="text-sm text-text-secondary">
                      共 {users?.total ?? '…'} 位用户（最多显示最近 100 位）
                    </p>
                  </div>
                  <button className={subtleButton} onClick={() => void loadUsers()}>
                    刷新
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead><tr className="border-b border-border-medium">
                      <th className="p-2">邮箱</th><th className="p-2">名称</th>
                      <th className="p-2">角色</th>
                    </tr></thead>
                    <tbody>
                      {users?.users.map((item) => (
                        <tr key={item.id} className="border-b border-border-medium">
                          <td className="p-2">{item.email}</td>
                          <td className="p-2">{item.name || '—'}</td>
                          <td className="p-2">
                            {item.id === user?.id ? (
                              <span>ADMIN（当前账号）</span>
                            ) : (
                              <select className={fieldClass} value={item.role}
                                disabled={busy || !['ADMIN', 'USER'].includes(item.role)}
                                onChange={(e) => void changeRole(item.id, e.target.value)}>
                                <option value="USER">普通用户</option>
                                <option value="ADMIN">管理员</option>
                              </select>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
