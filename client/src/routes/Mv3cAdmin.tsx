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
type AuditEvent = { id: string; actor: string; changedFields: string[]; at: string };
type UpdateConfig = { autoEnabled: boolean; channel: 'main' | 'release'; intervalMinutes: number };
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
  latestSha: string;
  latestLabel: string;
  latestUrl: string;
  updateAvailable: boolean;
  checkedAt: string | null;
  agentHeartbeat: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
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
  const [tab, setTab] = useState<'provider' | 'site' | 'users' | 'audit' | 'updates'>('provider');
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
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [updates, setUpdates] = useState<UpdateState | null>(null);
  const [updateConfigTouched, setUpdateConfigTouched] = useState(false);
  const [updateConfig, setUpdateConfig] = useState<UpdateConfig>({
    autoEnabled: true, channel: 'main', intervalMinutes: 10,
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [testModels, setTestModels] = useState<string[] | null>(null);
  const [downloadingReport, setDownloadingReport] = useState<string | null>(null);

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

  useEffect(() => {
    if (token && tab === 'audit') {
      void adminRequest<{ events: AuditEvent[] }>(token, '/audit')
        .then((data) => setEvents(data.events))
        .catch((err) => setError(err instanceof Error ? err.message : '审计记录加载失败'));
    }
  }, [token, tab]);

  const loadUpdates = useCallback(async () => {
    if (!token) return;
    try {
      const result = await adminRequest<UpdateState>(token, '/updates');
      setUpdates(result);
      if (!updateConfigTouched) setUpdateConfig(result.config);
      setError((previous) => previous.startsWith('更新服务短暂不可用：') ? '' : previous);
    } catch (err) {
      setError('更新服务短暂不可用：' +
        (err instanceof Error ? err.message : '更新状态加载失败') + '（将自动重试）');
    }
  }, [token, updateConfigTouched]);

  useEffect(() => {
    if (!token || tab !== 'updates') return;
    void loadUpdates();
    const interval = window.setInterval(() => { void loadUpdates(); }, 3000);
    return () => window.clearInterval(interval);
  }, [token, tab, loadUpdates]);

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
                ['audit', '操作审计'],
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
                    代码拉取：优先 GitHub SSH（git@github.com:b8vipvip/mv3c.git）；SSH 不可用时自动回退至固定的 GitHub HTTPS 地址。自动与手动更新策略一致，只部署 GitHub Actions 验证通过的提交。
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
                          {updates.currentSha ? updates.currentSha.slice(0, 12) : '等待更新服务上报'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-surface-secondary p-4">
                        <p className="text-xs text-text-secondary">GitHub 最新版本</p>
                        <p className="mt-1 font-mono text-lg">
                          {updates.latestLabel || '尚未检查'}
                        </p>
                        {updates.latestUrl && (
                          <a className="text-sm text-blue-500 underline"
                            href={updates.latestUrl} target="_blank" rel="noopener noreferrer">
                            查看 GitHub 提交
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1 text-sm">
                      <p>更新服务：<strong>{updates.agentOnline ? '已连接' : '未连接'}</strong></p>
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
                        GitHub 有新版本且 CI 通过时自动构建并部署
                      </label>
                      <label className="block space-y-2">
                        <span className="block text-sm font-medium">更新通道</span>
                        <select className={fieldClass} value={updateConfig.channel}
                          onChange={(e) => { setUpdateConfigTouched(true); setUpdateConfig((c) => ({
                            ...c, channel: e.target.value as 'main' | 'release',
                          })); }}>
                          <option value="main">main 分支（最新通过 CI 的提交）</option>
                          <option value="release">正式版（GitHub 最新 Release）</option>
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
