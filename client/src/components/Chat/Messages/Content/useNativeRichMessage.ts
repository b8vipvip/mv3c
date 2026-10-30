import { useEffect, useState } from 'react';
import { SSE } from 'sse.js';
import { apiBaseUrl } from 'librechat-data-provider';
import { useOptionalAuthContext } from '~/hooks/AuthContext';
import { validateNativeContent } from './nativeRichContent';
import type { NativeDocument } from './nativeRichContent';

/**
 * Requests only an authenticated MV3C message endpoint. The server checks
 * conversation/message ownership and resolves the upstream request binding.
 * No upstream chat2api API key or request ID enters the browser.
 */
export default function useNativeRichMessage(
  conversationId: string | undefined,
  messageId: string | undefined,
  active: boolean,
  enabled: boolean,
): NativeDocument | null {
  const auth = useOptionalAuthContext();
  const token = auth?.token;
  const isAuthenticated = auth?.isAuthenticated === true;
  const [result, setResult] = useState<NativeDocument | null>(null);

  useEffect(() => {
    setResult(null);
    if (!enabled || !isAuthenticated || !token || !conversationId || !messageId ||
        conversationId === 'new' || conversationId.length > 150 || messageId.length > 150) return;
    const url = apiBaseUrl() + '/api/messages/' +
      encodeURIComponent(conversationId) + '/' + encodeURIComponent(messageId) + '/native-content';
    const headers = { Authorization: 'Bearer ' + token };
    let disposed = false;
    let finished = false;
    let stream: SSE | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const accept = (payload: unknown) => {
      const safe = validateNativeContent(payload);
      if (!safe || disposed) return;
      setResult(previous => previous && previous.revision >= safe.revision ? previous : safe);
    };
    const read = async () => {
      try {
        const response = await fetch(url, { headers, cache: 'no-store', redirect: 'error' });
        if (!disposed && response.ok) accept(await response.json());
      } catch { /* a missing optional sidecar never replaces Markdown */ }
    };
    void read();
    if (!active) return () => { disposed = true; };
    const connect = () => {
      if (disposed || finished) return;
      const next = new SSE(url + '/events', { method: 'GET', headers });
      stream = next;
      next.addEventListener('native.snapshot', (event: MessageEvent) => {
        if (disposed || stream !== next) return;
        try { accept(JSON.parse(event.data)); } catch { /* malformed frame */ }
      });
      next.addEventListener('native.end', () => {
        finished = true;
        next.close();
        if (stream === next) stream = undefined;
        void read();
      });
      next.addEventListener('error', () => {
        next.close();
        if (stream === next) stream = undefined;
        // The provider metadata binding might not exist until its first
        // authenticated model response. Retry only during an active turn.
        if (!disposed && !finished && attempts++ < 60) {
          retry = setTimeout(connect, 2000);
        }
      });
      next.stream();
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      stream?.close();
    };
  }, [conversationId, messageId, active, enabled, isAuthenticated, token]);
  return result;
}
