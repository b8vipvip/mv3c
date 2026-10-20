import { memo, useCallback, Suspense } from 'react';
import { SquarePen } from 'lucide-react';
import SidePanelNav from '~/components/SidePanel/Nav';
import { useLocation } from 'react-router-dom';
import { Skeleton, Sidebar, Button, TooltipAnchor } from '@librechat/client';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import AgentMarketplaceButton from '~/components/Nav/AgentMarketplaceButton';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import useNewChat from '~/hooks/Conversations/useNewChat';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useLocalize } from '~/hooks';

const AccountSettings = lazyWithRecovery(() => import('~/components/Nav/AccountSettings'));

const NewChatButton = memo(function NewChatButton({
  setActive,
  switchToHistory,
  expanded = false,
}: {
  setActive: (id: string) => void;
  switchToHistory: boolean;
  expanded?: boolean;
}) {
  const localize = useLocalize();
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  const handlePanelSwitch = useCallback(() => {
    if (switchToHistory) {
      setActive(DEFAULT_PANEL);
    }
  }, [switchToHistory, setActive]);

  const { handleNewChatClick } = useNewChat({ onNewChat: handlePanelSwitch });

  return (
    <TooltipAnchor
      side="right"
      description={tooltipDescription}
      render={
        <a
          href="/c/new"
          data-testid="new-chat-button"
          aria-label={localize('com_ui_new_chat')}
          aria-keyshortcuts={ariaKey}
          className={expanded
            ? 'hover:bg-surface-nav-hover flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors'
            : 'hover:bg-surface-nav-hover flex h-9 w-9 items-center justify-center rounded-lg transition-colors'}
          onClick={handleNewChatClick}
        >
          <SquarePen className="text-text-primary h-5 w-5 shrink-0" />
          {expanded && <span>{localize('com_ui_new_chat')}</span>}
        </a>
      }
    />
  );
});

const NavIconButton = memo(function NavIconButton({
  link,
  isActive,
  expanded,
  setActive,
  onExpand,
  onCollapse,
  onNavigate,
  onLeaveInsights,
}: {
  link: NavLink;
  isActive: boolean;
  expanded: boolean;
  setActive: (id: string) => void;
  onExpand?: () => void;
  onCollapse?: () => void;
  onNavigate?: () => void;
  onLeaveInsights?: () => void;
}) {
  const localize = useLocalize();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (link.onClick) {
        link.onClick(e);
        onNavigate?.();
        return;
      }
      if (isActive && expanded) {
        onCollapse?.();
        return;
      }
      if (!isActive) {
        setActive(link.id);
      }
      if (!expanded) {
        onExpand?.();
      } else {
        onLeaveInsights?.();
      }
    },
    [link, isActive, setActive, expanded, onExpand, onCollapse, onNavigate, onLeaveInsights],
  );

  return (
    <TooltipAnchor
      description={localize(link.title)}
      side="right"
      render={
        <Button
          size="icon"
          variant="nav"
          aria-label={localize(link.title)}
          aria-pressed={isActive}
          disabled={link.disabled}
          data-testid={`nav-panel-${link.id}`}
          className="h-9 w-9 rounded-lg"
          onClick={handleClick}
        >
          <link.icon className="h-5 w-5" aria-hidden="true" />
        </Button>
      }
    />
  );
});

function ExpandedPanel({
  links,
  expanded = true,
  onCollapse,
  onExpand,
  onNavigate,
  onLeaveInsights,
  switchToHistory,
}: {
  links: NavLink[];
  expanded?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
  onNavigate?: () => void;
  onLeaveInsights?: () => void;
  switchToHistory: boolean;
}) {
  const localize = useLocalize();
  const location = useLocation();
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  const isInsightsRoute = location.pathname.startsWith('/insights');

  const toggleLabel = expanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar';
  const toggleClick = expanded ? onCollapse : onExpand;
  const toggleSidebarHint = useShortcutHint('toggleSidebar', localize(toggleLabel));
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');

  const toggleControl = (
    <TooltipAnchor
      side="right"
      description={toggleSidebarHint}
      render={
        <Button
          id={expanded ? CLOSE_SIDEBAR_ID : undefined}
          data-testid={expanded ? 'close-sidebar-button' : 'open-sidebar-button'}
          size="icon"
          variant="nav"
          aria-label={localize(toggleLabel)}
          aria-expanded={expanded}
          aria-keyshortcuts={toggleSidebarAriaKey}
          className="hover:bg-surface-nav-hover h-9 w-9 shrink-0 rounded-lg"
          onClick={toggleClick}
        >
          <Sidebar aria-hidden="true" className="text-text-primary h-5 w-5" />
        </Button>
      }
    />
  );

  const panelButtons = links.map((link) => (
    <NavIconButton
      key={link.id}
      link={link}
      isActive={
        link.id === 'insights' ? isInsightsRoute : !isInsightsRoute && link.id === effectiveActive
      }
      expanded={expanded}
      setActive={setActive}
      onExpand={onExpand}
      onCollapse={onCollapse}
      onNavigate={onNavigate}
      onLeaveInsights={isInsightsRoute ? onLeaveInsights : undefined}
    />
  ));

  // On a wide screen the full-width sidebar is one surface, like ChatGPT:
  // primary creation/search/history above, secondary workspace tools below.
  // The existing panel controls stay mounted so no functionality disappears.
  if (expanded) {
    return (
      <div data-mv3c-sidebar="expanded" className="border-border-light bg-surface-sidebar flex h-full min-h-0 w-full flex-col border-r">
        <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-4">
          <span className="text-text-primary px-2 text-[18px] font-semibold tracking-tight">mv3c</span>
          {toggleControl}
        </div>
        <div className="px-3 pb-2">
          <NewChatButton setActive={setActive} switchToHistory={switchToHistory} expanded />
        </div>
        <nav className="min-h-0 flex-1 overflow-hidden" aria-label={localize('com_ui_chat_history')}>
          <SidePanelNav links={links} />
        </nav>
        <div className="border-border-light shrink-0 border-t px-3 py-2">
          <p className="text-text-secondary px-2 pb-2 text-xs">其他功能</p>
          <div className="flex max-h-[7.5rem] flex-wrap items-center gap-1 overflow-y-auto">
            {panelButtons}
          </div>
        </div>
        <div className="border-border-light shrink-0 border-t px-2 py-2">
          <Suspense fallback={<Skeleton className="h-10 rounded-xl" />}>
            <AccountSettings />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div data-mv3c-sidebar="collapsed" className="border-border-light bg-surface-sidebar flex h-full w-full shrink-0 flex-col items-center gap-2 border-r px-1 py-3">
      {toggleControl}
      <NewChatButton setActive={setActive} switchToHistory={switchToHistory} />
      <div className="border-border-light mx-1 w-7 border-t" />
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {panelButtons}
      </div>
      <div className="mt-auto">
        <Suspense fallback={<Skeleton className="h-9 w-9 rounded-lg" />}>
          <AccountSettings collapsed />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(ExpandedPanel);
