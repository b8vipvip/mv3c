import { useEffect, useRef } from 'react';
import { apiBaseUrl } from 'librechat-data-provider';
import { useOptionalAuthContext } from '~/hooks/AuthContext';

type Snapshot = {
  conversationId?: string; messageId?: string; enabled: boolean;
  mode: string; reason: string; canonicalChars: number;
  nativeAssets: number; nativeFiles: number; nativeRevision: number;
};

/**
 * A bounded diagnostic of what the browser ACTUALLY committed to the page.
 * It reports only counts and a fixed reason enum, never message bodies,
 * HTML, image URLs, auth tokens, private user data or full DOM snapshots.
 */
export default function useNativeRenderDiagnostics({
  conversationId, messageId, enabled, mode, reason, canonicalChars,
  nativeAssets, nativeFiles, nativeRevision,
}: Snapshot) {
  const auth = useOptionalAuthContext();
  const ref = useRef<HTMLDivElement>(null);
  const sent = useRef('');
  const token = auth?.token;
  const authenticated = auth?.isAuthenticated === true;

  useEffect(() => {
    if (!enabled || !authenticated || !token || !conversationId || !messageId ||
        conversationId === 'new' || conversationId.length > 150 ||
        messageId.length > 150) return;
    const key = JSON.stringify([conversationId, messageId, mode, reason,
      nativeRevision, nativeAssets, nativeFiles, canonicalChars]);
    if (sent.current === key) return;
    // Wait for React commit and the first wave of image load/error events.
    // A subsequent revision or ready-file state gets its own observation.
    const delay = window.setTimeout(() => {
      const root = ref.current;
      if (!root || sent.current === key) return;
      const imgs = Array.from(root.querySelectorAll('img'));
      // Geometry-independent comparison signals. The original Worker captures
      // grids/flex groups and row structure, while the browser reports what
      // was actually committed to MV3C (not the source React model).
      const elements = Array.from(root.querySelectorAll('*')).slice(0, 1400);
      let renderedGridContainers = 0;
      let renderedFlexContainers = 0;
      for (const element of elements) {
        const style = getComputedStyle(element);
        if (style.display === 'grid' || style.display === 'inline-grid') renderedGridContainers++;
        else if (style.display === 'flex' || style.display === 'inline-flex') renderedFlexContainers++;
      }
      const imageTops = imgs.map(img => img.getBoundingClientRect().top)
        .filter(top => Number.isFinite(top)).sort((a,b) => a-b);
      let renderedImageRows = 0;
      let lastTop: number | null = null;
      for (const top of imageTops) {
        if (lastTop === null || Math.abs(top-lastTop) > 20) renderedImageRows++;
        lastTop = top;
      }
      const metrics = {
        mode, reason, canonicalChars,
        renderedGridContainers, renderedFlexContainers, renderedImageRows,
        renderedChars: (root.textContent || '').length,
        headings: root.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        tables: root.querySelectorAll('table').length,
        codeBlocks: root.querySelectorAll('pre').length,
        images: imgs.length,
        imagesLoaded: imgs.filter(img => img.complete && img.naturalWidth > 0).length,
        imagesFailed: imgs.filter(img => img.complete && img.naturalWidth === 0).length,
        mixedContentImages: imgs.filter(img =>
          (img.getAttribute('src') || '').toLowerCase().startsWith('http://')).length,
        nativeAssets, nativeFiles, nativeRevision,
      };
      sent.current = key;
      void fetch(apiBaseUrl() + '/api/messages/' +
        encodeURIComponent(conversationId) + '/' + encodeURIComponent(messageId) +
        '/native-diagnostics', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(metrics),
          keepalive: false,
        }).catch(() => {
          // Diagnostics cannot change delivery or completion state.
        });
    }, 1200);
    return () => window.clearTimeout(delay);
  }, [conversationId, messageId, enabled, authenticated, token, mode, reason,
    canonicalChars, nativeAssets, nativeFiles, nativeRevision]);

  return ref;
}
