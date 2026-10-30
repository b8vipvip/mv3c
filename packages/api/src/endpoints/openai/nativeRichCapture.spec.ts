import { withNativeRichScope, wrapChat2apiNativeFetch } from './nativeRichCapture';

describe('chat2api native sidecar request correlation', () => {
  it('adds a fresh opaque request ID only inside trusted chat2api invocations', async () => {
    const seen: string[] = [];
    const transport: typeof fetch = jest.fn(async (_input, init) => {
      seen.push(new Headers(init?.headers).get('x-chat2api-request-id') || '');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const wrapped = wrapChat2apiNativeFetch(transport,'https://chat.example.com/v1');
    const bound: string[] = [];
    await withNativeRichScope({ bindRequestId: id => bound.push(id) }, async () => {
      await wrapped('https://chat.example.com/v1/chat/completions',{ method: 'POST' });
      await wrapped('https://chat.example.com/v1/chat/completions',{ method: 'POST' });
      await wrapped('https://another.example.com/v1/chat/completions',{ method: 'POST' });
    });
    expect(seen[0]).toMatch(/^req_[a-f0-9]{32}$/);
    expect(seen[1]).toMatch(/^req_[a-f0-9]{32}$/);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[2]).toBe('');
    expect(bound).toEqual(seen.slice(0, 2));
    await wrapped('https://chat.example.com/v1/chat/completions',{ method: 'POST' });
    expect(seen[3]).toBe('');
  });
  it('never binds an upstream request which returned a non-2xx response', async () => {
    const bindings: string[] = [];
    const transport: typeof fetch = jest.fn(async () =>
      new Response('bad', { status: 400 })) as unknown as typeof fetch;
    await withNativeRichScope({ bindRequestId: id => bindings.push(id) }, async () =>
      wrapChat2apiNativeFetch(transport,'https://chat.example.com/v1')(
        'https://chat.example.com/v1/chat/completions',{ method:'POST' }));
    expect(bindings).toHaveLength(0);
  });
  it('correlates fetch(Request) without an init object and preserves body/headers', async () => {
    const bindings: string[] = [];
    const body = JSON.stringify({ model: 'gpt-6', messages: [{ role: 'user', content: 'test' }] });
    const seen: Array<{ method: string; body: string; authorization: string; requestId: string }> = [];
    const transport: typeof fetch = jest.fn(async (input, init) => {
      const request = input as Request;
      const headers = new Headers(init?.headers ?? request.headers);
      seen.push({
        method: request.method,
        body: await request.clone().text(),
        authorization: headers.get('authorization') || '',
        requestId: headers.get('x-chat2api-request-id') || '',
      });
      return new Response('data: [DONE]\\n\\n', { status: 200 });
    }) as unknown as typeof fetch;
    const request = new Request('https://chat.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body,
    });
    const wrapped = wrapChat2apiNativeFetch(transport, 'https://chat.example.com/v1');
    await withNativeRichScope({ bindRequestId: id => bindings.push(id) }, async () => {
      await wrapped(request);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', body, authorization: 'Bearer secret' });
    expect(seen[0].requestId).toMatch(/^req_[a-f0-9]{32}$/);
    expect(bindings).toEqual([seen[0].requestId]);
  });

  it('ignores fetch(Request) GETs, other hosts and non-successful responses', async () => {
    const bindings: string[] = [];
    const seen: string[] = [];
    const transport: typeof fetch = jest.fn(async (input, init) => {
      seen.push(new Headers(init?.headers ?? (input as Request).headers)
        .get('x-chat2api-request-id') || '');
      return new Response('{}', { status: 502 });
    }) as unknown as typeof fetch;
    const wrapped = wrapChat2apiNativeFetch(transport, 'https://chat.example.com/v1');
    await withNativeRichScope({ bindRequestId: id => bindings.push(id) }, async () => {
      await wrapped(new Request('https://chat.example.com/v1/models'));
      await wrapped(new Request('https://other.example.com/v1/chat/completions', { method: 'POST' }));
      await wrapped(new Request('https://chat.example.com/v1/responses', { method: 'POST' }));
    });
    expect(seen[0]).toBe('');
    expect(seen[1]).toBe('');
    expect(seen[2]).toMatch(/^req_[a-f0-9]{32}$/);
    expect(bindings).toEqual([]);
  });

});
