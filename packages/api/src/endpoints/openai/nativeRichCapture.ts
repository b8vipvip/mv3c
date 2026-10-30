import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Runs inside the authoritative MV3C AgentClient invocation. Never put user
 * identifiers into outbound model headers; only a random nonce leaves this app. */
export type NativeRichScope = { bindRequestId: (requestId: string) => void };
const scopes = new AsyncLocalStorage<NativeRichScope>();
export const withNativeRichScope = <T>(scope: NativeRichScope, run: () => Promise<T>): Promise<T> =>
  scopes.run(scope, run);

/**
 * Wrap only the operator-managed chat2api custom endpoint. This is a protocol
 * overlay on the existing SDK transport: retain HTTP timeout, proxy dispatcher,
 * retries (still disabled by site config), standard content and streaming.
 */
export function wrapChat2apiNativeFetch(
  transport: typeof fetch,
  trustedBaseURL: string,
): typeof fetch {
  const base = new URL(trustedBaseURL);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const scope = scopes.getStore();
    if (!scope || !init || init.method?.toUpperCase() !== 'POST') {
      return transport(input, init);
    }
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return transport(input, init);
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') ||
        !/\/(?:chat\/completions|responses)$/.test(url.pathname)) {
      return transport(input, init);
    }
    const requestId = 'req_' + randomUUID().replace(/-/g, '');
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-chat2api-request-id', requestId);
    const response = await transport(input, { ...init, headers });
    // Response headers are only observed after the upstream accepts the exact
    // request. Binding is async/non-owning and never delays the body stream.
    if (response.ok) {
      try { scope.bindRequestId(requestId); } catch { /* presentation-only */ }
    }
    return response;
  };
}
