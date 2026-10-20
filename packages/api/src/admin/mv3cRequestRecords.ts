import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '@librechat/data-schemas';
import type {
  Mv3cRequestRecord,
  Mv3cRequestRecordFilter,
  Mv3cRequestRecordStore,
} from '@librechat/data-schemas';

const MAX_PAGE = 100;
const MAX_OFFSET = 10_000;
const MAX_EXPORT = 500;
const REQUEST_ID_RE = /^[a-f0-9-]{36}$/i;
const SENSITIVE_SEGMENT_RE = /^(?:[a-f0-9]{16,}|[a-f0-9-]{32,}|[^/]*@[^/]*|[A-Za-z0-9_-]{42,})$/i;

function safePath(req: Request): string {
  const raw = String(req.originalUrl || req.path || '').split('?')[0].slice(0, 260);
  return raw.split('/').map((segment) =>
    SENSITIVE_SEGMENT_RE.test(segment) ? ':id' : segment.replace(/[^a-z0-9._:@-]/gi, '_').slice(0, 48),
  ).join('/').slice(0, 180);
}

function safeModel(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const nested = data.endpointOption;
  const value = typeof data.model === 'string' ? data.model
    : nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).model : null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/-]{1,80}$/.test(value)) return null;
  return value;
}

function safeUser(req: Request): string | null {
  const user = (req as Request & { user?: { id?: unknown; _id?: unknown } }).user;
  const value = user?.id ?? user?._id;
  const id = value == null ? '' : String(value);
  return /^[a-f0-9]{24}$/i.test(id) ? id : null;
}

function classify(path: string): Mv3cRequestRecord['category'] {
  return /^\/api\/(?:agents\/chat|ask|assistants\/chat|images\/generations|responses)(?:\/|$)/.test(path)
    ? 'AI' : 'API';
}

/** Observe the HTTP lifecycle once, including client disconnects and rejected requests.
 * HTTP 2xx does NOT prove model/tool success; this is transport-level evidence.
 */
export function createMv3cRequestRecorder(store: Mv3cRequestRecordStore):
  (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/admin/mv3c/requests')
        || req.method === 'OPTIONS' || req.method === 'HEAD') {
      next();
      return;
    }
    const id = randomUUID();
    const at = new Date();
    const started = performance.now();
    let terminal = false;
    res.setHeader('X-Mv3c-Request-Id', id);

    const record = (endedNormally: boolean) => {
      if (terminal) return;
      terminal = true;
      const elapsed = Math.max(0, Math.round(performance.now() - started));
      const rawBytes = Number(res.getHeader('content-length'));
      const responseBytes = Number.isFinite(rawBytes) && rawBytes >= 0 &&
        res.getHeader('content-length') != null ? rawBytes : null;
      const status: Mv3cRequestRecord['status'] = !endedNormally ? 'aborted'
        : res.statusCode >= 400 ? 'failed' : 'completed';
      const entry: Mv3cRequestRecord = {
        id,
        at,
        method: req.method.slice(0, 10),
        path: safePath(req),
        category: classify(req.path),
        model: safeModel(req.body),
        userId: safeUser(req),
        status,
        httpStatus: res.statusCode,
        durationMs: elapsed,
        responseBytes,
      };
      // Best effort: the diagnostic database cannot make user chat unavailable.
      void store.save(entry).catch(() => {
        logger.warn('[mv3c-request-records] Failed to persist request metadata');
      });
    };
    res.once('finish', () => record(true));
    res.once('close', () => record(false));
    next();
  };
}

function parsedInt(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError('无效的分页或导出数量');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) {
    throw new TypeError('请求数量超过上限');
  }
  return number;
}

function parseFilter(query: Request['query']): Mv3cRequestRecordFilter {
  const filter: Mv3cRequestRecordFilter = {};
  if (query.status !== undefined) {
    if (query.status !== 'completed' && query.status !== 'failed' && query.status !== 'aborted') {
      throw new TypeError('无效的请求状态');
    }
    filter.status = query.status;
  }
  if (query.category !== undefined) {
    if (query.category !== 'AI' && query.category !== 'API') {
      throw new TypeError('无效的请求类别');
    }
    filter.category = query.category;
  }
  for (const key of ['from', 'to'] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
      throw new TypeError('时间必须是 UTC ISO 格式');
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('无效的时间范围');
    filter[key] = parsed;
  }
  if (filter.from && filter.to && filter.from > filter.to) {
    throw new TypeError('开始时间不能晚于结束时间');
  }
  return filter;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof TypeError) {
    res.status(400).json({ error: error.message });
    return;
  }
  logger.warn('[mv3c-request-records] Failed to load request records');
  res.status(503).json({ error: '请求记录暂时不可用' });
}

function csvCell(input: string | number | null): string {
  const value = String(input ?? '');
  // RFC 4180 escaping + formula-injection guard for spreadsheet applications.
  const protectedValue = /^[=+@\-\t\r]/.test(value) ? "'" + value : value;
  return '"' + protectedValue.replace(/"/g, '""') + '"';
}

function csvExport(records: Mv3cRequestRecord[]): string {
  const cols: (keyof Mv3cRequestRecord)[] = [
    'id', 'at', 'category', 'method', 'path', 'model',
    'userId', 'status', 'httpStatus', 'durationMs', 'responseBytes',
  ];
  const header = cols.join(',');
  const rows = records.map((record) =>
    cols.map((key) => csvCell(record[key] instanceof Date
      ? (record[key] as Date).toISOString() : record[key] as string | number | null)).join(','),
  );
  return '\uFEFF' + [header, ...rows].join('\r\n') + '\r\n';
}

type RequestRecordHandlers = {
  list: (req: Request, res: Response) => Promise<void>;
  detail: (req: Request, res: Response) => Promise<void>;
  report: (req: Request, res: Response) => Promise<void>;
  export: (req: Request, res: Response) => Promise<void>;
};

export function createMv3cRequestRecordHandlers(
  store: Mv3cRequestRecordStore,
): RequestRecordHandlers {
  return {
    list: async (req: Request, res: Response) => {
      try {
        const limit = Math.max(1, parsedInt(req.query.limit, 50, MAX_PAGE));
        const offset = parsedInt(req.query.offset, 0, MAX_OFFSET);
        const filter = parseFilter(req.query);
        res.setHeader('Cache-Control', 'no-store');
        res.json(await store.list(filter, limit, offset));
      } catch (error) {
        sendError(res, error);
      }
    },
    detail: async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id || '');
        if (!REQUEST_ID_RE.test(id)) throw new TypeError('无效的请求 ID');
        const record = await store.get(id);
        res.setHeader('Cache-Control', 'no-store');
        if (!record) { res.status(404).json({ error: '请求记录不存在或已过期' }); return; }
        res.json({ record, note: 'HTTP 完成状态不等于上游 AI 任务成功；不保存提示词、回复或身份凭证。' });
      } catch (error) {
        sendError(res, error);
      }
    },
    report: async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id || '');
        if (!REQUEST_ID_RE.test(id)) throw new TypeError('无效的请求 ID');
        const record = await store.get(id);
        if (!record) { res.status(404).json({ error: '请求记录不存在或已过期' }); return; }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'attachment; filename="mv3c-request-' + id + '.json"');
        res.type('application/json').send(JSON.stringify({
          reportVersion: 1,
          generatedAt: new Date().toISOString(),
          scope: 'mv3c HTTP request metadata; no prompts, responses or credentials',
          caveat: 'HTTP 2xx means the transport finished, not that a model task succeeded.',
          record,
        }, null, 2));
      } catch (error) {
        sendError(res, error);
      }
    },
    export: async (req: Request, res: Response) => {
      try {
        const limit = Math.max(1, parsedInt(req.query.limit, 100, MAX_EXPORT));
        const filter = parseFilter(req.query);
        const { records } = await store.list(filter, limit, 0);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'attachment; filename="mv3c-requests-' +
          new Date().toISOString().slice(0, 10) + '.csv"');
        res.type('text/csv; charset=utf-8').send(csvExport(records));
      } catch (error) {
        sendError(res, error);
      }
    },
  };
}
