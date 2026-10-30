import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Bot, Boxes, ChevronRight, ClipboardList, FileClock,
  Globe2, RefreshCw, ScrollText, ShieldCheck, Users, Wrench,
} from 'lucide-react';

export type AdminTab =
  | 'provider' | 'plugins' | 'site' | 'guest' | 'users' | 'audit' | 'updates' | 'logs' | 'requests';

type AdminNavItem = { id: AdminTab; title: string; description: string; icon: typeof Bot };
const sections: { label: string; items: AdminNavItem[] }[] = [
  { label: '平台配置', items: [
    { id: 'provider', title: 'AI 供应商与模型', description: '连接与可用模型', icon: Bot },
    { id: 'plugins', title: '插件管理', description: '商店与账号连接', icon: Boxes },
    { id: 'site', title: '站点与注册', description: '品牌及访问权限', icon: Globe2 },
    { id: 'guest', title: '游客体验', description: '试用配额与策略', icon: ShieldCheck },
  ] },
  { label: '运营数据', items: [
    { id: 'users', title: '用户管理', description: '账号与角色', icon: Users },
    { id: 'requests', title: '请求记录', description: '调用与报告', icon: ClipboardList },
    { id: 'logs', title: '运行日志', description: '服务日志与导出', icon: FileClock },
    { id: 'audit', title: '操作审计', description: '后台修改记录', icon: ScrollText },
  ] },
  { label: '系统维护', items: [
    { id: 'updates', title: '版本更新', description: 'GPTAuto 智能更新与验证', icon: RefreshCw },
  ] },
];

const byId = sections.flatMap((section) => section.items);
export const adminNavigation = byId.map((item) => ({ id: item.id, title: item.title }));

function NavigationItem({
  item, active, onNavigate,
}: { item: AdminNavItem; active: AdminTab; onNavigate: (tab: AdminTab) => void }) {
  const Icon = item.icon;
  const selected = active === item.id;
  return (
    <button type="button" key={item.id}
      onClick={() => onNavigate(item.id)}
      aria-current={selected ? 'page' : undefined}
      className={`group flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${selected
        ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20'
        : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}>
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <span className={`block truncate text-[11px] ${selected ? 'text-blue-100' : 'text-text-tertiary'}`}>
          {item.description}
        </span>
      </span>
      {selected && <ChevronRight className="h-4 w-4 shrink-0 opacity-75" aria-hidden="true" />}
    </button>
  );
}

export default function AdminShell({
  active, onNavigate, children, version,
}: {
  active: AdminTab;
  onNavigate: (tab: AdminTab) => void;
  children: ReactNode;
  version?: string;
}) {
  const chosen = byId.find((item) => item.id === active) ?? byId[0];
  const ChosenIcon = chosen.icon;
  return (
    <main className="min-h-screen bg-surface-secondary text-text-primary">
      <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col lg:flex-row">
        <aside className="border-border-medium bg-surface-primary shrink-0 border-b lg:sticky lg:top-0 lg:h-screen lg:w-[256px] lg:border-b-0 lg:border-r" aria-label="管理后台侧栏">
          <div className="border-border-light flex items-center justify-between border-b px-5 py-5 lg:min-h-[106px]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
                <Wrench className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <div className="text-lg font-bold tracking-tight">mv3c <span className="font-medium text-blue-600">Admin</span></div>
                <div className="text-text-tertiary text-xs">平台管理控制台</div>
              </div>
            </div>
            <Link to="/c/new" className="rounded-lg p-2 text-text-secondary hover:bg-surface-hover lg:hidden" aria-label="返回聊天">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </div>
          <nav className="flex gap-2 overflow-x-auto px-3 py-3 lg:h-[calc(100vh-180px)] lg:flex-col lg:gap-5 lg:overflow-y-auto lg:px-3 lg:py-5"
            aria-label="管理栏目">
            {sections.map((section) => (
              <div key={section.label} className="flex shrink-0 gap-1 lg:block lg:space-y-1">
                <div className="text-text-tertiary hidden px-3 pb-2 text-[11px] font-semibold tracking-widest lg:block">
                  {section.label}
                </div>
                {section.items.map((item) => (
                  <div key={item.id} className="min-w-[145px] lg:min-w-0">
                    <NavigationItem item={item} active={active} onNavigate={onNavigate} />
                  </div>
                ))}
              </div>
            ))}
          </nav>
          <div className="border-border-light hidden border-t px-5 py-4 lg:block">
            <p className="text-text-secondary text-xs">运行中的版本</p>
            <p className="mt-1 truncate font-mono text-xs font-medium">{version || '以版本更新页为准'}</p>
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="border-border-medium bg-surface-primary/95 sticky top-0 z-10 border-b px-4 py-4 backdrop-blur sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="bg-surface-secondary border-border-light flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
                  <ChosenIcon className="h-5 w-5 text-blue-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-text-tertiary text-xs">工作台 / {sections.find(s => s.items.some(i => i.id === active))?.label}</p>
                  <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{chosen.title}</h1>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-text-secondary hidden rounded-full border border-border-medium px-3 py-1.5 text-xs sm:inline-flex">管理后台</span>
                <Link to="/c/new" className="border-border-medium hover:bg-surface-hover hidden items-center gap-2 rounded-lg border px-3 py-2 text-sm sm:inline-flex">
                  <ArrowLeft className="h-4 w-4" /> 返回聊天
                </Link>
              </div>
            </div>
          </header>
          <div className="mx-auto w-full max-w-[1340px] space-y-5 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
