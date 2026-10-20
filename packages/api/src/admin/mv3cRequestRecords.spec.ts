import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { Mv3cRequestRecord, Mv3cRequestRecordStore } from '@librechat/data-schemas';
import { createMv3cRequestRecorder, createMv3cRequestRecordHandlers } from './mv3cRequestRecords';

function memoryStore() {
  const rows: Mv3cRequestRecord[] = [];
  const store: Mv3cRequestRecordStore = {
    save: jest.fn(async (row) => { rows.push(row); }),
    list: jest.fn(async (filter, limit, offset) => {
      const selected = rows.filter((r) =>
        (!filter.status || filter.status === r.status) &&
        (!filter.category || filter.category === r.category));
      return { records: selected.slice(offset, offset + limit), total: selected.length };
    }),
    get: jest.fn(async (id) => rows.find((r) => r.id === id) ?? null),
  };
  return { store, rows };
}

function mockResponse() {
  const emitter = new EventEmitter();
  const headers = new Map<string, unknown>();
  const res = Object.assign(emitter, {
    statusCode: 200,
    setHeader: jest.fn((key: string, value: unknown) => { headers.set(key.toLowerCase(), value); }),
    getHeader: jest.fn((key: string) => headers.get(key.toLowerCase())),
    json: jest.fn(),
    send: jest.fn(),
    type: jest.fn().mockReturnThis(),
    status: jest.fn(function (this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    }),
  });
  return res;
}

describe('mv3c request diagnostics', () => {
  it('records HTTP completion once and never persists prompts, responses or secrets', async () => {
    const { store, rows } = memoryStore();
    const req = {
      path: '/api/agents/chat',
      originalUrl: '/api/agents/chat?api_key=secret',
      method: 'POST',
      body: {
        model: 'gpt-6', prompt: 'a private question', apiKey: 'secret',
        messages: [{ content: 'private' }],
      },
      headers: { authorization: 'Bearer hidden' },
      user: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    } as unknown as Request;
    const res = mockResponse();
    const next = jest.fn();
    createMv3cRequestRecorder(store)(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.emit('finish');
    res.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: '/api/agents/chat', method: 'POST', model: 'gpt-6',
      category: 'AI', status: 'completed', httpStatus: 200,
    });
    expect(String(res.getHeader('x-mv3c-request-id'))).toBe(rows[0].id);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toMatch(/secret|private|authorization|api_key|prompt/i);
  });

  it('marks early disconnect separately from status 200', async () => {
    const { store, rows } = memoryStore();
    const res = mockResponse();
    createMv3cRequestRecorder(store)(
      { method: 'POST', path: '/api/agents/chat', originalUrl: '/api/agents/chat' } as Request,
      res as unknown as Response,
      jest.fn(),
    );
    res.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    expect(rows[0].status).toBe('aborted');
  });

  it('skips diagnostics endpoints to avoid infinite self-recording', () => {
    const { store } = memoryStore();
    const res = mockResponse();
    createMv3cRequestRecorder(store)(
      { method: 'GET', path: '/api/admin/mv3c/requests',
        originalUrl: '/api/admin/mv3c/requests?limit=50' } as Request,
      res as unknown as Response,
      jest.fn(),
    );
    res.emit('finish');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('validates status filters and bounds bulk exports', async () => {
    const { store } = memoryStore();
    const handlers = createMv3cRequestRecordHandlers(store);
    const bad = mockResponse();
    await handlers.list({ query: { status: 'anything' } } as unknown as Request,
      bad as unknown as Response);
    expect(bad.status).toHaveBeenCalledWith(400);

    const excessive = mockResponse();
    await handlers.export({ query: { limit: '100000' } } as unknown as Request,
      excessive as unknown as Response);
    expect(excessive.status).toHaveBeenCalledWith(400);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('downloads a single bounded JSON report and refuses unknown request IDs', async () => {
    const { store, rows } = memoryStore();
    rows.push({
      id: 'abcdabcd-abcd-abcd-abcd-abcdabcdabcd',
      at: new Date('2026-10-20T00:00:00Z'),
      path: '/api/agents/chat', method: 'POST', category: 'AI',
      model: 'gpt-6', userId: null, status: 'failed',
      httpStatus: 500, durationMs: 1000, responseBytes: null,
    });
    const handlers = createMv3cRequestRecordHandlers(store);
    const res = mockResponse();
    await handlers.report(
      { params: { id: rows[0].id } } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((res.send as jest.Mock).mock.calls[0][0]).record.id).toBe(rows[0].id);
    const missing = mockResponse();
    await handlers.report(
      { params: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } } as unknown as Request,
      missing as unknown as Response,
    );
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});
