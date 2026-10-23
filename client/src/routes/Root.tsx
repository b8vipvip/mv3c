import { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { useRecoilValue } from 'recoil';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from '@librechat/client';
import {
  useFileMap,
  useAgentsMap,
  useAuthContext,
  useReplyAlerts,
  useUnseenBadge,
  useReplyWatcher,
  useSearchEnabled,
  useCatalogWarmup,
  useMessagesRetention,
  useAssistantsMap,
  useUnseenConversations,
} from '~/hooks';
import {
  UnifiedSidebar,
  SIDEBAR_TRANSITION,
  MOBILE_DRAWER_WIDTH_VAR,
  MOBILE_DRAWER_STRIP_WIDTH,
  MOBILE_DRAWER_FULL_WIDTH,
  MOBILE_PANE_SHIFT,
} from '~/components/UnifiedSidebar';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
  MCPAppsPolicyProvider,
} from '~/Providers';
import {
  CodeHighlightThrottleContext,
  normalizeCodeHighlightThrottleMs,
} from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import KeyboardShortcutsDialog from '~/components/Nav/KeyboardShortcutsDialog';
import { SteerHostProvider, appSteerHost } from '~/Providers/SteerHostContext';
import KeyboardDeleteDialog from '~/components/Nav/KeyboardDeleteDialog';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { MobileDrawerScrim } from '~/components/UnifiedSidebar/mobile';
import AnalyticsConsent from '~/components/System/AnalyticsConsent';
import useKeyboardShortcuts from '~/hooks/useKeyboardShortcuts';
import useDrawerDismiss from '~/hooks/Nav/useDrawerDismiss';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import useSidebarState from '~/hooks/Nav/useSidebarState';
import { TermsAndConditionsModal } from '~/components/ui';
import useDrawerSwipe from '~/hooks/Nav/useDrawerSwipe';
import ChatSettingsProvider from './ChatSettings';
import { useHealthCheck } from '~/data-provider';
import Settings from '~/components/Nav/Settings';
import { Banner } from '~/components/Banners';
import store from '~/store';

/** Isolates the unseen-reply subscription so its updates re-render only this node, not `Root`. */
function ReplyNotifications() {
  const replyState = useUnseenConversations();
  useReplyWatcher();
  useUnseenBadge(replyState?.unseen.length ?? 0);
  useReplyAlerts(replyState);
  return null;
}

/** Isolates the route subscription that keeps the routed conversation's history cached. */
function MessagesRetention() {
  useMessagesRetention();
  return null;
}

/** Isolates keyboard shortcut listeners so they only mount after auth. */
function KeyboardShortcutsProvider() {
  useKeyboardShortcuts();
  return (
    <>
      <KeyboardShortcutsDialog />
      <KeyboardDeleteDialog />
    </>
  );
}

function RootLayout() {
  const [showTerms, setShowTerms] = useState(false);
  const [guestLimitReached, setGuestLimitReached] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  /** Shared with the drawer so the two agree on the breakpoint-transition frame. */
  const {
    isSmallScreen,
    expanded: sidebarExpanded,
    setExpanded: setSidebarExpanded,
  } = useSidebarState();
  /** The one path drawer mutations take: it kicks the slide imperatively and
   *  defers the Recoil flip, so a large conversation cannot stall first motion. */
  const { setSidebarOpen } = useSidebarToggle();
  /** The drawer and pane snap under reduced motion (see kickDrawerAnimation),
   *  so the scrim must not keep fading on its own. */
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  /** Off by default, matching the drawer that covers the screen and closes by
   *  swipe. Opting in narrows it and gives the strip a dismiss target. */
  const drawerStrip = useRecoilValue(store.mobileDrawerStrip);
  const newChatSwitchToHistory = useRecoilValue(store.newChatSwitchToHistory);
  const paneRef = useRef<HTMLDivElement>(null);
  /** Keyed off the committed state rather than the scrim's own click, because
   *  the header button, Escape, conversation selection and the bottom bar all
   *  close the drawer too. */
  const { isSliding, onScrimClick } = useDrawerDismiss({
    expanded: sidebarExpanded,
    isSmallScreen,
    prefersReducedMotion,
    paneRef,
    setOpen: setSidebarOpen,
  });
  /** Focus handoff lives in the drawer header's own expanded-effect — the
   * commit drives it, so every opener (button, swipe) is covered without a
   * timer racing the deferred state flip. */
  const handleDrawerOpenChange = useCallback(
    (next: boolean) => {
      startTransition(() => {
        setSidebarExpanded(next);
      });
    },
    [setSidebarExpanded],
  );
  const { isAuthenticated, logout, user, token } = useAuthContext();
  const isGuest = (user as (typeof user & { provider?: string }) | undefined)?.provider === 'mv3c-guest';
  useEffect(() => {
    if (!isGuest || !token) { setGuestLimitReached(false); return; }
    let live = true;
    const refresh = async () => {
      try {
        const result = await fetch('/api/auth/guest/status', {
          headers: { Authorization: `Bearer ${token}` }, credentials: 'same-origin',
        });
        if (result.ok) {
          const data = await result.json();
          if (live) setGuestLimitReached(Boolean(data.limitReached || !data.enabled));
        }
      } catch { /* A temporary network failure must not mark a guest exhausted. */ }
    };
    const onLimit = () => setGuestLimitReached(true);
    window.addEventListener('mv3c:guest-limit', onLimit);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('mv3c:guest-limit', onLimit); };
  }, [isGuest, token]);
  /** Releases feature-catalog queries after first paint on browser idle. */
  useCatalogWarmup(isAuthenticated);

  useDrawerSwipe({
    paneRef,
    /** Auth gates the whole tree below (`return null`), so the swipe surfaces
     * only exist once authenticated — enabling earlier would attach to
     * nothing and never re-run when they mount. */
    enabled: isSmallScreen && isAuthenticated,
    open: sidebarExpanded,
    onOpenChange: handleDrawerOpenChange,
  });

  useHealthCheck(isAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const agentsMap = useAgentsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });

  const { data: config, isSuccess: isConfigReady, error: configError } = useGetStartupConfig();
  const { data: termsData } = useUserTermsQuery({
    enabled: isAuthenticated && config?.interface?.termsOfService?.modalAcceptance === true,
  });
  const highlightThrottleMs = normalizeCodeHighlightThrottleMs(
    config?.interface?.codeHighlightThrottleMs,
  );

  useSearchEnabled(isAuthenticated);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  /** The overscroll guard in style.css keys off this attribute: drawer mode is decided
   *  against the scaled root font size, which a media query cannot read. */
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-drawer-nav', isSmallScreen);
    return () => root.removeAttribute('data-drawer-nav');
  }, [isSmallScreen]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <CodeHighlightThrottleContext.Provider value={highlightThrottleMs}>
      <SetConvoProvider>
        <FileMapContext.Provider value={fileMap}>
          <AssistantsMapContext.Provider value={assistantsMap}>
            <AgentsMapContext.Provider value={agentsMap}>
              <PromptGroupsProvider>
                <Banner onHeightChange={setBannerHeight} />
                <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px)` }}>
                  <div
                    className="relative z-0 flex h-full w-full overflow-hidden"
                    /** The drawer and the pane both read this, so their travel
                     *  cannot disagree about how far the drawer opens. */
                    style={
                      {
                        [MOBILE_DRAWER_WIDTH_VAR]: drawerStrip
                          ? MOBILE_DRAWER_STRIP_WIDTH
                          : MOBILE_DRAWER_FULL_WIDTH,
                      } as React.CSSProperties
                    }
                  >
                    {/* The drawer stops being painted once it is closed and
                        settled, so it needs the same travel window the scrim and
                        the pane's `inert` read. */}
                    <UnifiedSidebar
                      isSliding={isSliding}
                      switchToHistory={newChatSwitchToHistory}
                    />
                    <div
                      ref={paneRef}
                      /** Focus target of last resort when the drawer closes on a
                       *  route that renders no opener. Not in the tab order. */
                      tabIndex={-1}
                      className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden focus:outline-hidden"
                      style={{
                        /** A percentage of the pane's own width, so it tracks the
                         *  drawer without a literal and survives rotation. */
                        transform: isSmallScreen && sidebarExpanded ? MOBILE_PANE_SHIFT : 'none',
                        transition: prefersReducedMotion ? undefined : SIDEBAR_TRANSITION,
                      }}
                      /** Recoil's flip is deferred past the opening frames and
                       *  the closing transition outlives it at the other end, so
                       *  `isSliding` covers the travel `sidebarExpanded` brackets
                       *  too late and drops too early. */
                      inert={isSmallScreen && (sidebarExpanded || isSliding) ? '' : undefined}
                    >
                      <MCPAppsPolicyProvider
                        startupConfig={config}
                        ready={isConfigReady && configError == null}
                        userId={user?.id}
                      >
                        <Outlet />
                      </MCPAppsPolicyProvider>
                    </div>
                    {/* Without the strip the scrim exists only for the travel:
                      through a close that began while the strip was still on
                      (disabling it unmounts the scrim at once, but the drawer
                      needs the whole transition to widen), and through an open
                      the deferred flip has not committed yet. Once expanded
                      lands, a full-width drawer covers it, so keeping it
                      mounted would only expose a duplicate dismiss control. */}
                    {isSmallScreen && (drawerStrip || (isSliding && !sidebarExpanded)) && (
                      <MobileDrawerScrim
                        expanded={sidebarExpanded}
                        isSliding={isSliding}
                        prefersReducedMotion={prefersReducedMotion}
                        onClick={onScrimClick}
                      />
                    )}
                  </div>
                </div>
              </PromptGroupsProvider>
              <Settings />
              <KeyboardShortcutsProvider />
              <ReplyNotifications />
              <MessagesRetention />
              <AnalyticsConsent gtmId={config?.analyticsGtmId} />
            </AgentsMapContext.Provider>
            {isGuest && guestLimitReached && (
              <div role="dialog" aria-modal="true" aria-labelledby="guest-limit-title"
                className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
                <div className="w-full max-w-md rounded-2xl bg-surface-primary p-6 text-text-primary shadow-xl">
                  <h2 id="guest-limit-title" className="text-xl font-semibold">游客体验额度已用完</h2>
                  <p className="mt-3 text-sm text-text-secondary">您已达到游客体验 Token 额度，注册或登录后即可继续使用。</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <button className="rounded-lg bg-blue-600 px-5 py-2 font-medium text-white" onClick={() => logout('/register')}>注册账号</button>
                    <button className="rounded-lg border border-border-medium px-5 py-2" onClick={() => logout('/login?redirect=false')}>登录账号</button>
                  </div>
                </div>
              </div>
            )}
            {config?.interface?.termsOfService?.modalAcceptance === true && (
              <TermsAndConditionsModal
                open={showTerms}
                onOpenChange={setShowTerms}
                onAccept={handleAcceptTerms}
                onDecline={handleDeclineTerms}
                title={config.interface.termsOfService.modalTitle}
                modalContent={config.interface.termsOfService.modalContent}
              />
            )}
          </AssistantsMapContext.Provider>
        </FileMapContext.Provider>
      </SetConvoProvider>
    </CodeHighlightThrottleContext.Provider>
  );
}

export default function Root() {
  return (
    <ChatSettingsProvider>
      <SteerHostProvider host={appSteerHost}>
        <RootLayout />
      </SteerHostProvider>
    </ChatSettingsProvider>
  );
}
