import type { Connection } from 'mongoose';

/** Diagnostic metadata only; never persist prompts, replies, URL queries or headers. */
export type Mv3cRequestRecord = {
  id: string;
  at: Date;
  path: string;
  method: string;
  category: 'AI' | 'API';
  model: string | null;
  userId: string | null;
  status: 'completed' | 'failed' | 'aborted';
  httpStatus: number;
  durationMs: number;
  responseBytes: number | null;
};

export type Mv3cRequestRecordFilter = {
  status?: Mv3cRequestRecord['status'];
  category?: Mv3cRequestRecord['category'];
  from?: Date;
  to?: Date;
};

export type Mv3cRequestRecordStore = {
  save: (value: Mv3cRequestRecord) => Promise<void>;
  list: (filter: Mv3cRequestRecordFilter, limit: number, offset: number) =>
    Promise<{ total: number; records: Mv3cRequestRecord[] }>;
  get: (id: string) => Promise<Mv3cRequestRecord | null>;
};

const COLLECTION_NAME = 'mv3c_request_records';
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

export function createMv3cRequestRecordStore(connection: Connection): Mv3cRequestRecordStore {
  let ready: Promise<void> | undefined;
  const collection = () => {
    if (!connection.db) throw new Error('Request record database is not connected');
    return connection.db.collection<Mv3cRequestRecord>(COLLECTION_NAME);
  };
  const ensureIndexes = async () => {
    if (!ready) {
      ready = (async () => {
        const col = collection();
        await Promise.all([
          col.createIndex({ id: 1 }, { unique: true }),
          col.createIndex({ at: -1 }),
          col.createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_SECONDS }),
        ]);
      })().catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    }
    await ready;
  };
  return {
    save: async (value) => {
      await ensureIndexes();
      await collection().insertOne(value);
    },
    list: async (filter, limit, offset) => {
      const where: Record<string, unknown> = {};
      if (filter.status) where.status = filter.status;
      if (filter.category) where.category = filter.category;
      if (filter.from || filter.to) {
        where.at = {
          ...(filter.from ? { $gte: filter.from } : {}),
          ...(filter.to ? { $lte: filter.to } : {}),
        };
      }
      const col = collection();
      const [total, records] = await Promise.all([
        col.countDocuments(where),
        col.find(where, { projection: { _id: 0 } }).sort({ at: -1, id: -1 })
          .skip(offset).limit(limit).toArray(),
      ]);
      return { total, records };
    },
    get: async (id) =>
      collection().findOne({ id }, { projection: { _id: 0 } }),
  };
}
