import { useEffect, useState } from 'react';
import { SSE } from 'sse.js';
import { apiBaseUrl } from 'librechat-data-provider';
import { useOptionalAuthContext } from '~/hooks/AuthContext';
import {
  validateNativeContent, shouldApplyNativeSnapshot, nativeMessageScopeKey,
  canRetryNativePendingFile,
} from './nativeRichContent';
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
  // React may reuse a message component when the conversation or account
  // changes. Never render an old message's sidecar for the new identity even
  // for the single render before useEffect cleanup executes.
  const scope = nativeMessageScopeKey(token, conversationId, messageId);
  const [result, setResult] = useState<{ scope: string; value: NativeDocument } | null>(null);

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
    let fileRetry: ReturnType<typeof setTimeout> | undefined;
    let fileAttempts = 0;
    let hasProcessingFile = false;
    let firstProcessingAt: number | null = null;
    let latestSnapshot: NativeDocument | null = null;
    let attempts = 0;
    // The OpenAI request can be terminal long before an async file reaches
    // the durable archive. Poll *only* while this mounted message contains a
    // processing file, with an absolute bound so historical pages do not
    // create unbounded background requests.
    const scheduleFileRead = () => {
      if (firstProcessingAt === null) firstProcessingAt = Date.now();
      if (disposed || !hasProcessingFile || fileRetry ||
          !canRetryNativePendingFile(firstProcessingAt, Date.now())) return;
      const delay = Math.min(15000, Math.round(2500 * Math.pow(1.4, Math.min(6, fileAttempts++))));
      fileRetry = setTimeout(() => {
        fileRetry = undefined;
        if (!disposed) void read();
      }, delay);
    };
    // Worker admission, long-form generation and media archival can exceed
    // two minutes. Only an active turn retries; never run background polling.
    const retryDeadline = Date.now() + 16 * 60 * 1000;
    const accept = (payload: unknown) => {
      const safe = validateNativeContent(payload);
      if (!safe || disposed) return;
      // Do not allow a late initial GET or an out-of-order SSE frame to
      // override a more recent same-revision ready/failed file state.
      if (!shouldApplyNativeSnapshot(latestSnapshot, safe)) return;
      latestSnapshot = safe;
      setResult({ scope, value: safe });
      hasProcessingFile = safe.files?.some(file => file.status === 'processing') === true;
      if (hasProcessingFile) {
        scheduleFileRead();
      } else if (fileRetry) {
        clearTimeout(fileRetry);
        fileRetry = undefined;
        fileAttempts = 0;
        firstProcessingAt = null;
      }
      attempts = 0;
    };
    const read = async () => {
      try {
        const response = await fetch(url, { headers, cache: 'no-store', redirect: 'error' });
        if (!disposed && response.ok) accept(await response.json());
        else if (!disposed && hasProcessingFile) scheduleFileRead();
      } catch {
        // A single failed poll must not leave a processing card frozen.
        if (hasProcessingFile) scheduleFileRead();
      }
    };
    void read();
    if (!active) return () => {
      disposed = true;
      if (fileRetry) clearTimeout(fileRetry);
    };
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
        if (!disposed && !finished && Date.now() < retryDeadline) {
          const intervalMs = Math.min(15000, Math.round(2000 * Math.pow(1.4, attempts++)));
          retry = setTimeout(connect, intervalMs);
        }
      });
      next.stream();
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (fileRetry) clearTimeout(fileRetry);
      stream?.close();
    };
  }, [conversationId, messageId, active, enabled, isAuthenticated, token]);
  return enabled && isAuthenticated && result?.scope === scope ? result.value : null;
}
