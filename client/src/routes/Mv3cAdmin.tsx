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
type GuestSettings = { enabled: boolean; tokenLimit: number };
type AdminSettings = {
  guest: GuestSettings;
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
type AuditEvent = { id: string; actor: string; changedFields: string[]; at: string };
type LogRange = '15m' | '1h' | '6h' | '24h' | '3d' | '7d';
type RequestStatus = '' | 'completed' | 'failed' | 'aborted';
type RequestCategory = '' | 'AI' | 'API';
type RequestRecord = {
  id: string; at: string; path: string; method: string;
  category: 'AI' | 'API'; model: string | null; userId: string | null;
  status: 'completed' | 'failed' | 'aborted';
  httpStatus: number; durationMs: number; responseBytes: number | null;
};
type RequestPage = { total: number; records: RequestRecord[] };
const requestStatusNames: Record<RequestRecord['status'], string> = {
  completed: 'HTTP 完成', failed: 'HTTP 失败', aborted: '连接中断',
};
type RuntimeLogStats = {
  usedBytes: number; maxBytes: number; fileCount: number; ranges: LogRange[];
  capture: string;
};
type UpdateConfig = { autoEnabled: boolean; channel: 'release'; intervalMinutes: number };
type UpdateProgress = {
  stage: string; percent: number; message: string; updatedAt: string;
  steps: { stage: string; percent: number; message: string; at: string }[];
};
type UpdateJob = {
  id: string; mode: string; requestedAt: string; requestedBy: string;
  progress?: UpdateProgress;
};
type UpdateHistory = {
  jobId: string; outcome: string; sha: string; error: string; finishedAt: string;
  requestedAt?: string; startedAt?: string; durationMs?: number;
  fromSha?: string; attemptedSha?: string; verification?: string;
  steps?: UpdateProgress['steps'];
};
type UpdateState = {
  config: UpdateConfig;
  agentOnline: boolean;
  status: string;
  currentSha: string;
  currentVersion: string;
  latestVersion: string;
  latestSha: string;
  latestLabel: string;
  latestUrl: string;
  updateAvailable: boolean;
  checkedAt: string | null;
  agentHeartbeat: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
  ciMessage?: string;
  lastLog: string;
  lastOutcome: string;
  blockedSha: string;
  pendingJob: UpdateJob | null;
  activeJob: UpdateJob | null;
  history: UpdateHistory[];
};
const updateStatusLabel: Record<string, string> = {
  idle: '空闲', checking: '正在检查', queued: '等待执行',
  updating: '正在更新部署', blocked: '等待 CI 通过',
  success: '更新成功', failed: '更新失败', rolled_back: '已回滚上一版本',
};

class AdminApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AdminApiError';
  }
}

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
    throw new AdminApiError(response.status,
      response.status === 401 ? '管理员登录凭证已失效，请重新登录。' :
      body.error || (response.status === 403
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
  const { token, isAuthenticated, user, logout } = useAuthContext();
  const [tab, setTab] = useState<'provider' | 'site' | 'guest' | 'users' | 'audit' | 'updates' | 'logs' | 'requests'>('provider');
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [site, setSite] = useState<SiteSettings>({
    title: 'mv3c', welcome: '欢迎使用 mv3c', publicUrl: '', registrationEnabled: false,
  });
  const [guest, setGuest] = useState<GuestSettings>({ enabled: true, tokenLimit: 100000 });
  const [provider, setProvider] = useState<ProviderSettings>({
    enabled: true, baseURL: '', models: [], fetchModels: true,
    apiKeyConfigured: false, configured: false,
  });
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [users, setUsers] = useState<UsersResponse | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [logRange, setLogRange] = useState<LogRange>('1h');
  const [logStats, setLogStats] = useState<RuntimeLogStats | null>(null);
  const [logDownloading, setLogDownloading] = useState(false);
  const [requestPage, setRequestPage] = useState<RequestPage | null>(null);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>('');
  const [requestCategory, setRequestCategory] = useState<RequestCategory>('');
  const [requestOffset, setRequestOffset] = useState(0);
  const [requestDetail, setRequestDetail] = useState<RequestRecord | null>(null);
  const [requestNote, setRequestNote] = useState('');
  const [requestLoading, setRequestLoading] = useState(false);
  const [requestDownloading, setRequestDownloading] = useState(false);
  const [requestExportCount, setRequestExportCount] = useState(100);
  const [updates, setUpdates] = useState<UpdateState | null>(null);
  const [updateConfigTouched, setUpdateConfigTouched] = useState(false);
  const [updateConfig, setUpdateConfig] = useState<UpdateConfig>({
    autoEnabled: true, channel: 'release', intervalMinutes: 10,
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [adminAuthExpired, setAdminAuthExpired] = useState(false);
  useEffect(() => setAdminAuthExpired(false), [token]);
  const [testModels, setTestModels] = useState<string[] | null>(null);
  const [downloadingReport, setDownloadingReport] = useState<string | null>(null);

  const applySettings = useCallback((data: AdminSettings) => {
    setSettings(data);
    setSite(data.site);
    setGuest(data.guest);
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
      if (err instanceof AdminApiError && err.status === 401) setAdminAuthExpired(true);
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

  useEffect(() => {
    if (token && tab === 'audit') {
      void adminRequest<{ events: AuditEvent[] }>(token, '/audit')
        .then((data) => setEvents(data.events))
        .catch((err) => setError(err instanceof Error ? err.message : '审计记录加载失败'));
    }
  }, [token, tab]);

  const loadRuntimeLogs = useCallback(async () => {
    if (!token) return;
    try {
      setLogStats(await adminRequest<RuntimeLogStats>(token, '/runtime-logs'));
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) setAdminAuthExpired(true);
      setError(err instanceof Error ? err.message : '日志信息加载失败');
    }
  }, [token]);

  useEffect(() => {
    if (token && tab === 'logs') void loadRuntimeLogs();
  }, [token, tab, loadRuntimeLogs]);

  const downloadRuntimeLogs = async () => {
    if (!token || logDownloading) return;
    setLogDownloading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/mv3c/runtime-logs/export?range=' + logRange, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || '下载运行日志失败（HTTP ' + response.status + '）');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mv3c-runtime-' + logRange + '-' +
        new Date().toISOString().replace(/[:.]/g, '-') + '.log';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      await loadRuntimeLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '运行日志下载失败');
    } finally {
      setLogDownloading(false);
    }
  };

  const requestFilters = useCallback(() => {
    const query = new URLSearchParams();
    if (requestStatus) query.set('status', requestStatus);
    if (requestCategory) query.set('category', requestCategory);
    return query;
  }, [requestStatus, requestCategory]);

  const loadRequests = useCallback(async () => {
    if (!token || adminAuthExpired) return;
    setRequestLoading(true);
    try {
      const query = requestFilters();
      query.set('limit', '50');
      query.set('offset', String(requestOffset));
      const data = await adminRequest<RequestPage>(token, '/requests?' + query.toString());
      setRequestPage(data);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) setAdminAuthExpired(true);
      setError(err instanceof Error ? err.message : '请求记录加载失败');
    } finally {
      setRequestLoading(false);
    }
  }, [token, adminAuthExpired, requestFilters, requestOffset]);

  useEffect(() => {
    if (tab === 'requests') void loadRequests();
  }, [tab, loadRequests]);

  const showRequest = async (id: string) => {
    if (!token) return;
    setError('');
    try {
      const data = await adminRequest<{ record: RequestRecord; note: string }>(
        token, '/requests/' + encodeURIComponent(id));
      setRequestDetail(data.record);
      setRequestNote(data.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求详情加载失败');
    }
  };

  const downloadRequests = async (path: string, filename: string) => {
    if (!token || requestDownloading) return;
    setRequestDownloading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/mv3c' + path, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (response.status === 401) setAdminAuthExpired(true);
        throw new Error(result.error || '报告下载失败（HTTP ' + response.status + '）');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载请求报告失败');
    } finally {
      setRequestDownloading(false);
    }
  };

  const loadUpdates = useCallback(async () => {
    if (!token || adminAuthExpired) return;
    try {
      const result = await adminRequest<UpdateState>(token, '/updates');
      setUpdates(result);
      if (!updateConfigTouched) setUpdateConfig(result.config);
      setError((previous) => previous.startsWith('更新服务短暂不可用：') ? '' : previous);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        setAdminAuthExpired(true);
        setError(err.message);
        return;
      }
      setError('更新服务短暂不可用：' +
        (err instanceof Error ? err.message : '更新状态加载失败') + '（将自动重试）');
    }
  }, [token, updateConfigTouched, adminAuthExpired]);

  useEffect(() => {
    if (!token || tab !== 'updates' || adminAuthExpired) return;
    void loadUpdates();
    const interval = window.setInterval(() => { void loadUpdates(); }, 3000);
    return () => window.clearInterval(interval);
  }, [token, tab, loadUpdates, adminAuthExpired]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) setAdminAuthExpired(true);
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

  const saveGuest = () => run(async () => {
    if (!token) return;
    const data = await adminRequest<AdminSettings>(token, '', {
      method: 'PUT', body: JSON.stringify({ guest }),
    });
    applySettings(data);
    setMessage('游客体验设置已保存，新请求立即生效。');
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

  const saveUpdateSettings = () => run(async () => {
    if (!token) return;
    const result = await adminRequest<UpdateState>(token, '/updates/settings', {
      method: 'PUT', body: JSON.stringify(updateConfig),
    });
    setUpdates(result);
    setUpdateConfig(result.config);
    setUpdateConfigTouched(false);
    setMessage('版本更新策略已保存。自动检查由宿主机更新服务执行。');
  });

  const requestUpdateCheck = () => run(async () => {
    if (!token) return;
    await adminRequest<UpdateState>(token, '/updates/check', { method: 'POST' });
    await loadUpdates();
    setMessage('已请求检查 GitHub，新结果将在宿主机更新服务下一次运行后显示。');
  });

  const requestDeployment = () => {
    if (!window.confirm('确定要执行更新吗？将先检查 GitHub CI，然后构建新镜像并重启 mv3c，期间服务可能短暂不可用。')) return;
    void run(async () => {
      if (!token) return;
      await adminRequest(token, '/updates/deploy', { method: 'POST' });
      await loadUpdates();
      setMessage('已加入更新队列。宿主机更新服务将在约 1 分钟内开始处理。');
    });
  };

  const downloadUpdateReport = async (jobId: string) => {
    if (!token || downloadingReport) return;
    setDownloadingReport(jobId);
    setError('');
    try {
      const response = await fetch(
        '/api/admin/mv3c/updates/reports/' + encodeURIComponent(jobId), {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Authorization: 'Bearer ' + token },
        },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || '下载诊断报告失败（HTTP ' + response.status + '）');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mv3c-update-' + jobId + '.log';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载报告失败');
    } finally {
      setDownloadingReport(null);
    }
  };

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
            {adminAuthExpired && (
              <button type="button" className={subtleButton + ' ml-3'}
                onClick={() => logout('/login?redirect_to=%2Fadmin')}>
                退出并重新登录
              </button>
            )}
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
                ['guest', '游客体验限制'],
                ['users', '用户管理'],
                ['audit', '操作审计'],
                ['logs', '运行日志'],
                ['requests', '请求记录'],
                ['updates', '版本更新'],
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

            {tab === 'guest' && (
              <section className="space-y-5 rounded-xl border border-border-medium p-5">
                <h2 className="text-xl font-semibold">游客体验限制</h2>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={guest.enabled}
                    onChange={(e) => setGuest((s) => ({ ...s, enabled: e.target.checked }))} />
                  允许游客免注册体验
                </label>
                <label className="block space-y-2">
                  <span className="block text-sm font-medium">游客累计 Token 上限（每个游客）</span>
                  <input className={fieldClass} type="number" min="1000" max="10000000" step="1000"
                    value={guest.tokenLimit}
                    onChange={(e) => setGuest((s) => ({ ...s, tokenLimit: Number(e.target.value) }))} />
                </label>
                <p className="text-sm text-text-secondary">默认 100000 Token。额度由服务端累计，超限后禁止游客继续发起生成，并提示注册或登录。调整额度对已有游客立即生效。</p>
                <button className={buttonClass} disabled={busy} onClick={() => void saveGuest()}>保存游客体验设置</button>
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

            {tab === 'updates' && (
              <section className="space-y-6 rounded-xl border border-border-medium p-5">
                <div>
                  <h2 className="text-xl font-semibold">版本更新与自动部署</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    代码拉取：优先 GitHub SSH（git@github.com:b8vipvip/mv3c.git）；SSH 不可用时自动回退至固定的 GitHub HTTPS 地址。自动与手动更新策略一致，只部署已在 GitHub 发布且两项 CI 均验证通过的正式版；部署使用服务器缓存。
                  </p>
                </div>
                {!updates ? (
                  <p>正在读取更新状态…</p>
                ) : (
                  <>
                    {!updates.agentOnline && (
                      <div role="alert" className="rounded-lg border border-amber-500 p-3 text-sm">
                        宿主机更新服务未连接。需要在部署 mv3c 的服务器执行一次
                        <code className="mx-1">sudo bash mv3c/updater/install.sh</code>
                        才能自动检查和部署。网站容器不直接拥有 Docker 权限。
                      </div>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="rounded-lg bg-surface-secondary p-4">
                        <p className="text-xs text-text-secondary">当前已部署版本</p>
                        <p className="mt-1 font-mono text-lg">
                          {updates.currentVersion || '尚未部署正式版'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-surface-secondary p-4">
                        <p className="text-xs text-text-secondary">GitHub 最新正式版</p>
                        <p className="mt-1 font-mono text-lg">
                          {updates.latestVersion || '尚未发布'}
                        </p>
                        {updates.latestUrl && (
                          <a className="text-sm text-blue-500 underline"
                            href={updates.latestUrl} target="_blank" rel="noopener noreferrer">
                            查看 GitHub Release
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1 text-sm">
                      <p>更新服务：<strong>{updates.agentOnline ? '已连接' : '未连接'}</strong></p>
                      {updates.ciMessage && (
                        <p role="status" className="text-sm text-amber-600">
                          {updates.ciMessage}（等待下一次自动检查）
                        </p>
                      )}
                      <p>状态：<strong>{updateStatusLabel[updates.status] || updates.status}</strong></p>
                      <p>新版本：<strong>{updates.updateAvailable ? '已发现' : '暂无或尚未检查'}</strong></p>
                      <p>上次检查：{updates.checkedAt
                        ? new Date(updates.checkedAt).toLocaleString() : '尚未检查'}</p>
                      <p>最近成功更新：{updates.lastSuccessAt
                        ? new Date(updates.lastSuccessAt).toLocaleString() : '暂无'}</p>
                      {updates.blockedSha && (
                        <p className="text-amber-600">自动重试已暂停的提交：{updates.blockedSha.slice(0, 12)}</p>
                      )}
                      {updates.pendingJob && <p>排队任务：{updates.pendingJob.id}</p>}
                      {updates.activeJob && <p>正在执行：{updates.activeJob.id}</p>}
                    </div>
                    {(updates.pendingJob || updates.activeJob) && (() => {
                      const job = updates.activeJob || updates.pendingJob!;
                      const progress = job.progress;
                      const percent = updates.pendingJob ? 0 : Math.max(0, Math.min(100,
                        progress?.percent ?? 0));
                      return (
                        <div className="space-y-3 rounded-lg border border-border-medium p-4"
                          role="region" aria-label="更新任务进度">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="font-semibold">
                              {updates.pendingJob ? '任务排队中' : '正在更新与验证'}
                            </h3>
                            <span className="font-mono text-sm tabular-nums">{percent}%</span>
                          </div>
                          <div role="progressbar" aria-label="版本更新阶段进度"
                            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
                            aria-valuetext={progress?.message || '等待宿主机更新服务'}
                            className="h-3 w-full overflow-hidden rounded-full bg-surface-secondary">
                            <div className="h-full rounded-full bg-blue-600 transition-[width] duration-500"
                              style={{ width: percent + '%' }} />
                          </div>
                          <p role="status" className="text-sm text-text-secondary">
                            {progress?.message || '更新任务已提交，等待宿主机服务接收'}
                          </p>
                          <p className="break-all font-mono text-xs text-text-secondary">
                            任务 ID：{job.id}
                          </p>
                          {progress?.steps?.length ? (
                            <details>
                              <summary className="cursor-pointer text-sm">查看实时更新阶段记录</summary>
                              <ol className="mt-2 max-h-48 space-y-1 overflow-auto text-xs text-text-secondary">
                                {progress.steps.map((step, index) => (
                                  <li key={index}>
                                    {new Date(step.at).toLocaleTimeString()} ·
                                    {' '}{step.percent}% · {step.message}
                                  </li>
                                ))}
                              </ol>
                            </details>
                          ) : null}
                          <p className="text-xs text-text-secondary">
                            百分比表示当前进入的部署阶段，不是按时间估算。Docker 镜像构建期间可能停留在同一百分比。
                          </p>
                        </div>
                      );
                    })()}
                    {!updates.activeJob && !updates.pendingJob && updates.history.length > 0 && (
                      <div role="status" className="rounded-lg border border-border-medium p-4 text-sm">
                        <p className="font-semibold">
                          最新任务结果：{({
                            success: '部署成功且自动验证通过', skipped: '无需更新',
                            rolled_back: '部署失败，已验证并恢复旧版本',
                            failed: '更新失败',
                          } as Record<string, string>)[updates.history[0].outcome] ||
                            updates.history[0].outcome}
                        </p>
                        <p className="mt-1 text-text-secondary">
                          {updates.history[0].verification || '本次更新无额外验证说明'}
                        </p>
                        {updates.history[0].error && (
                          <p className="mt-1 text-red-500">{updates.history[0].error}</p>
                        )}
                        <button className={subtleButton + ' mt-3'}
                          disabled={downloadingReport !== null}
                          onClick={() => void downloadUpdateReport(updates.history[0].jobId)}>
                          下载本次更新报告 (.log)
                        </button>
                      </div>
                    )}
                    {updates.lastError && (
                      <div role="alert" className="rounded-lg border border-red-500 p-3 text-sm text-red-500">
                        {updates.lastError}
                      </div>
                    )}
                    <div className="space-y-4 border-t border-border-medium pt-5">
                      <h3 className="font-semibold">自动更新策略</h3>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={updateConfig.autoEnabled}
                          onChange={(e) => { setUpdateConfigTouched(true); setUpdateConfig((c) => ({
                            ...c, autoEnabled: e.target.checked,
                          })); }} />
                        GitHub 发布新的正式版且 CI 通过时自动构建并部署
                      </label>
                      <label className="block space-y-2">
                        <span className="block text-sm font-medium">更新通道</span>
                        <select className={fieldClass} value={updateConfig.channel}
                          onChange={(e) => { setUpdateConfigTouched(true); setUpdateConfig((c) => ({
                            ...c, channel: e.target.value as 'release',
                          })); }}>
                          
                          <option value="release">仅正式版（GitHub Release）</option>
                        </select>
                      </label>
                      <label className="block space-y-2">
                        <span className="block text-sm font-medium">自动检查间隔</span>
                        <select className={fieldClass} value={updateConfig.intervalMinutes}
                          onChange={(e) => { setUpdateConfigTouched(true); setUpdateConfig((c) => ({
                            ...c, intervalMinutes: Number(e.target.value),
                          })); }}>
                          {[5, 10, 15, 30, 60].map((n) => (
                            <option key={n} value={n}>每 {n} 分钟</option>
                          ))}
                        </select>
                      </label>
                      <button className={buttonClass} disabled={busy}
                        onClick={() => void saveUpdateSettings()}>
                        保存更新策略
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2 border-t border-border-medium pt-5">
                      <button className={subtleButton} disabled={busy}
                        onClick={() => void requestUpdateCheck()}>
                        立即检查 GitHub
                      </button>
                      <button className={buttonClass}
                        disabled={busy || !updates.agentOnline ||
                          Boolean(updates.pendingJob || updates.activeJob)}
                        onClick={requestDeployment}>
                        立即更新并部署
                      </button>
                      <button className={subtleButton} disabled={busy}
                        onClick={() => void loadUpdates()}>
                        刷新状态
                      </button>
                    </div>
                    <p className="text-xs text-text-secondary">
                      更新会保留 MongoDB 与持久化数据卷。部署失败时尝试回滚应用代码和镜像；
                      数据库迁移不保证可逆，请另行备份数据库。
                    </p>
                    <div className="border-t border-border-medium pt-5">
                      <h3 className="mb-3 font-semibold">最近更新记录</h3>
                      {updates.history.length === 0 ? (
                        <p className="text-sm text-text-secondary">暂无更新记录</p>
                      ) : (
                        <div className="space-y-2 text-sm">
                          {updates.history.map((entry) => (
                            <div key={entry.jobId} className="rounded-lg bg-surface-secondary p-3">
                              <p>{new Date(entry.finishedAt).toLocaleString()} ·
                                {' '}{entry.outcome} · {entry.sha?.slice(0, 12)}</p>
                              {entry.verification && (
                                <p className="mt-1 text-text-secondary">{entry.verification}</p>
                              )}
                              {typeof entry.durationMs === 'number' && (
                                <p className="mt-1 text-xs text-text-secondary">
                                  耗时：{Math.round(entry.durationMs / 1000)} 秒
                                </p>
                              )}
                              {entry.error && <p className="text-red-500">{entry.error}</p>}
                              <button className={subtleButton + ' mt-2 text-xs'}
                                disabled={downloadingReport !== null}
                                onClick={() => void downloadUpdateReport(entry.jobId)}>
                                {downloadingReport === entry.jobId ? '正在生成下载…' : '下载诊断报告'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {updates.lastLog && (
                        <details className="mt-4">
                          <summary className="cursor-pointer text-sm">查看最近一次部署日志</summary>
                          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all
                            rounded-lg bg-surface-secondary p-3 text-xs">{updates.lastLog}</pre>
                        </details>
                      )}
                    </div>
                  </>
                )}
              </section>
            )}

            {tab === 'requests' && (
              <section className="space-y-5 rounded-xl border border-border-medium p-5">
                <div>
                  <h2 className="text-xl font-semibold">服务端请求记录与诊断报告</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    记录 API 的 HTTP 请求结果、耗时和模型信息，保留最近 30 天。
                    不保存提示词正文、AI 回复内容、API Key 或身份凭证。
                    HTTP 完成不等于上游 AI 任务成功。
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="space-y-1 text-sm">
                    <span className="block">请求类型</span>
                    <select aria-label="请求类型" className={fieldClass} value={requestCategory}
                      onChange={(e) => { setRequestCategory(e.target.value as RequestCategory); setRequestOffset(0); }}>
                      <option value="">全部类型</option>
                      <option value="AI">AI 请求</option>
                      <option value="API">其他 API 请求</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block">请求状态</span>
                    <select aria-label="请求状态" className={fieldClass} value={requestStatus}
                      onChange={(e) => { setRequestStatus(e.target.value as RequestStatus); setRequestOffset(0); }}>
                      <option value="">全部状态</option>
                      <option value="completed">HTTP 完成</option>
                      <option value="failed">HTTP 失败</option>
                      <option value="aborted">连接中断</option>
                    </select>
                  </label>
                  <button type="button" className={subtleButton} disabled={requestLoading}
                    onClick={() => void loadRequests()}>
                    {requestLoading ? '加载中…' : '刷新记录'}
                  </button>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="space-y-1 text-sm">
                    <span className="block">批量导出数量（最近记录）</span>
                    <select aria-label="导出记录数量" className={fieldClass}
                      value={requestExportCount}
                      onChange={(e) => setRequestExportCount(Number(e.target.value))}>
                      {[50, 100, 200, 500].map((n) =>
                        <option key={n} value={n}>{n} 条</option>)}
                    </select>
                  </label>
                  <button type="button" className={buttonClass} disabled={requestDownloading}
                    onClick={() => {
                      const q = requestFilters();
                      q.set('limit', String(requestExportCount));
                      void downloadRequests('/requests/export?' + q.toString(),
                        'mv3c-requests-' + new Date().toISOString().slice(0, 10) + '.csv');
                    }}>
                    {requestDownloading ? '正在导出…' : '下载筛选报告 (.csv)'}
                  </button>
                  <span className="text-sm text-text-secondary">
                    共 {requestPage?.total ?? '…'} 条匹配记录
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border-medium">
                        <th className="p-2">时间</th>
                        <th className="p-2">类别</th>
                        <th className="p-2">HTTP</th>
                        <th className="p-2">状态</th>
                        <th className="p-2">模型</th>
                        <th className="p-2">耗时</th>
                        <th className="p-2">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requestPage?.records.map((item) => (
                        <tr key={item.id} className="border-b border-border-medium">
                          <td className="whitespace-nowrap p-2">{new Date(item.at).toLocaleString()}</td>
                          <td className="p-2">{item.category}</td>
                          <td className="p-2">{item.httpStatus}</td>
                          <td className="whitespace-nowrap p-2">{requestStatusNames[item.status]}</td>
                          <td className="max-w-36 truncate p-2" title={item.model || undefined}>
                            {item.model || '—'}
                          </td>
                          <td className="whitespace-nowrap p-2">{(item.durationMs / 1000).toFixed(2)} 秒</td>
                          <td className="whitespace-nowrap p-2">
                            <button type="button" className={subtleButton + ' mr-2'}
                              onClick={() => void showRequest(item.id)}>详情</button>
                            <button type="button" className={subtleButton}
                              disabled={requestDownloading}
                              onClick={() => void downloadRequests(
                                '/requests/' + encodeURIComponent(item.id) + '/report',
                                'mv3c-request-' + item.id + '.json')}>
                              下载报告
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {requestPage?.records.length === 0 && (
                    <p className="py-5 text-center text-sm text-text-secondary">当前筛选条件下没有请求记录</p>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span>第 {requestPage?.total ? Math.floor(requestOffset / 50) + 1 : 0} 页</span>
                  <div className="flex gap-2">
                    <button type="button" className={subtleButton}
                      disabled={requestLoading || requestOffset === 0}
                      onClick={() => setRequestOffset((n) => Math.max(0, n - 50))}>上一页</button>
                    <button type="button" className={subtleButton}
                      disabled={requestLoading || requestOffset + 50 >= (requestPage?.total ?? 0) ||
                        requestOffset + 50 > 10000}
                      onClick={() => setRequestOffset((n) => n + 50)}>下一页</button>
                  </div>
                </div>
                {requestDetail && (
                  <div role="region" aria-label="请求详情" className="rounded-lg border border-border-medium p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="font-semibold">请求详情</h3>
                      <button type="button" className={subtleButton}
                        onClick={() => setRequestDetail(null)}>关闭</button>
                    </div>
                    <p className="mb-2 text-sm text-text-secondary">{requestNote}</p>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all bg-surface-secondary p-3 text-xs">
                      {JSON.stringify(requestDetail, null, 2)}
                    </pre>
                  </div>
                )}
              </section>
            )}

            {tab === 'logs' && (
              <section className="space-y-5 rounded-xl border border-border-medium p-5">
                <div>
                  <h2 className="text-xl font-semibold">服务端运行日志</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    保存应用运行信息、警告、错误及 API 请求摘要，不包含请求或回复正文。
                    日志轮转时优先淘汰最早记录，受容量限制的历史不能恢复。
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-surface-secondary p-4">
                    <p className="text-xs text-text-secondary">当前日志占用</p>
                    <p className="mt-1 font-mono font-semibold">
                      {logStats ? (logStats.usedBytes / 1024 / 1024).toFixed(2) + ' MB' : '读取中…'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-secondary p-4">
                    <p className="text-xs text-text-secondary">容量上限</p>
                    <p className="mt-1 font-mono font-semibold">
                      {logStats ? (logStats.maxBytes / 1024 / 1024).toFixed(0) + ' MB' : '10 MB'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-secondary p-4">
                    <p className="text-xs text-text-secondary">日志分片数量</p>
                    <p className="mt-1 font-mono font-semibold">{logStats?.fileCount ?? '…'}</p>
                  </div>
                </div>
                <label className="block max-w-sm space-y-2">
                  <span className="block text-sm font-medium">导出最近时间段</span>
                  <select className={fieldClass} value={logRange}
                    onChange={(event) => setLogRange(event.target.value as LogRange)}>
                    <option value="15m">最近 15 分钟</option>
                    <option value="1h">最近 1 小时</option>
                    <option value="6h">最近 6 小时</option>
                    <option value="24h">最近 24 小时</option>
                    <option value="3d">最近 3 天</option>
                    <option value="7d">最近 7 天</option>
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className={buttonClass} disabled={logDownloading}
                    onClick={() => void downloadRuntimeLogs()}>
                    {logDownloading ? '正在导出…' : '导出运行日志 (.log)'}
                  </button>
                  <button className={subtleButton} disabled={logDownloading}
                    onClick={() => void loadRuntimeLogs()}>
                    刷新日志统计
                  </button>
                </div>
                <p className="text-xs text-text-secondary">
                  仅管理员可导出，文件总容量上限 10 MB。选择的时间范围内如果没有记录，
                  会下载包含范围说明的空报告；日志被轮转删除后不再可导出。
                  Docker 自身的标准输出日志另设单容器 10 MB 轮转限制。
                </p>
              </section>
            )}

            {tab === 'audit' && (
              <section className="rounded-xl border border-border-medium p-5">
                <h2 className="mb-4 text-xl font-semibold">最近 100 条管理操作</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead><tr className="border-b border-border-medium">
                      <th className="p-2">时间</th><th className="p-2">管理员 ID</th>
                      <th className="p-2">修改字段</th>
                    </tr></thead>
                    <tbody>{events.map((event) => (
                      <tr key={event.id} className="border-b border-border-medium">
                        <td className="p-2">{new Date(event.at).toLocaleString()}</td>
                        <td className="p-2">{event.actor}</td>
                        <td className="p-2">{event.changedFields.join('、')}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
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
