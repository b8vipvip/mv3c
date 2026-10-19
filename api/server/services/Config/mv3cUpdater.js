'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const ID = 'global';
const DEFAULT_CONFIG = Object.freeze({
  autoEnabled: true,
  channel: 'main',
  intervalMinutes: 10,
});
const SHA = /^[0-9a-f]{40}$/i;

function collection() {
  if (!mongoose.connection.db) throw new Error('MongoDB is not ready');
  return mongoose.connection.db.collection('mv3c_update_state');
}
async function initialize() {
  await collection().updateOne({ _id: ID }, {
    $setOnInsert: {
      config: DEFAULT_CONFIG,
      status: 'idle',
      updateAvailable: false,
      createdAt: new Date(),
    },
  }, { upsert: true });
}
function format(doc) {
  const config = { ...DEFAULT_CONFIG, ...(doc?.config || {}) };
  const heartbeat = doc?.agentHeartbeat ? new Date(doc.agentHeartbeat) : null;
  const agentOnline = heartbeat && Number.isFinite(heartbeat.getTime()) &&
    Date.now() - heartbeat.getTime() < 180000;
  return {
    config,
    agentOnline: Boolean(agentOnline),
    status: doc?.status || 'idle',
    currentSha: doc?.currentSha || '',
    latestSha: doc?.latestSha || '',
    latestLabel: doc?.latestLabel || '',
    latestUrl: doc?.latestUrl || '',
    updateAvailable: Boolean(doc?.updateAvailable),
    checkedAt: doc?.checkedAt || null,
    checkRequestedAt: doc?.checkRequestedAt || null,
    agentHeartbeat: doc?.agentHeartbeat || null,
    lastAttemptAt: doc?.lastAttemptAt || null,
    lastSuccessAt: doc?.lastSuccessAt || null,
    lastError: doc?.lastError || '',
    lastLog: doc?.lastLog || '',
    lastOutcome: doc?.lastOutcome || '',
    blockedSha: doc?.blockedSha || '',
    pendingJob: doc?.pendingJob || null,
    activeJob: doc?.activeJob || null,
    history: (doc?.history || []).slice(-15).reverse(),
  };
}
async function getState() {
  await initialize();
  return format(await collection().findOne({ _id: ID }));
}
function validateConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Update configuration must be an object');
  }
  const result = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'autoEnabled' && typeof value === 'boolean') result[key] = value;
    else if (key === 'channel' && ['main', 'release'].includes(value)) result[key] = value;
    else if (key === 'intervalMinutes' && [5, 10, 15, 30, 60].includes(value)) {
      result[key] = value;
    } else throw new TypeError('Invalid update setting: ' + key);
  }
  if (!Object.keys(result).length) throw new TypeError('No update settings supplied');
  return result;
}
async function saveConfig(body, actor) {
  const patch = validateConfig(body);
  await initialize();
  const fields = Object.fromEntries(Object.entries(patch).map(([k, v]) => ['config.' + k, v]));
  await collection().updateOne({ _id: ID }, {
    $set: { ...fields, configUpdatedAt: new Date(), configUpdatedBy: String(actor) },
  });
  return getState();
}
async function requestCheck(actor) {
  await initialize();
  await collection().updateOne({ _id: ID }, {
    $set: { checkRequestedAt: new Date(), checkRequestedBy: String(actor) },
  });
  return getState();
}
async function queueJob(actor, mode = 'manual') {
  if (!['manual', 'auto'].includes(mode)) throw new TypeError('Invalid update mode');
  await initialize();
  const job = {
    id: crypto.randomUUID(),
    requestedAt: new Date(),
    requestedBy: String(actor),
    mode,
  };
  const result = await collection().findOneAndUpdate({
    _id: ID,
    pendingJob: { $exists: false },
    activeJob: { $exists: false },
  }, {
    $set: { pendingJob: job, status: 'queued', lastError: '' },
  }, { returnDocument: 'after' });
  if (!result) {
    const error = new Error('An update is already queued or running');
    error.status = 409;
    throw error;
  }
  return { job, state: format(result) };
}
async function claimJob() {
  await initialize();
  const result = await collection().findOneAndUpdate({
    _id: ID, pendingJob: { $exists: true }, activeJob: { $exists: false },
  }, [{
    $set: { activeJob: '$pendingJob', status: 'updating', lastAttemptAt: '$$NOW' },
  }, {
    $unset: 'pendingJob',
  }], { returnDocument: 'after' });
  return result?.activeJob || null;
}
function validateReport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Invalid updater report');
  }
  const allowed = {
    currentSha: (v) => typeof v === 'string' && (!v || SHA.test(v)),
    latestSha: (v) => typeof v === 'string' && (!v || SHA.test(v)),
    latestLabel: (v) => typeof v === 'string' && v.length <= 128,
    latestUrl: (v) => typeof v === 'string' && v.length <= 500 &&
      (!v || v.startsWith('https://github.com/b8vipvip/mv3c/')),
    updateAvailable: (v) => typeof v === 'boolean',
    status: (v) => ['idle', 'checking', 'queued', 'updating', 'blocked', 'success', 'failed', 'rolled_back'].includes(v),
    lastError: (v) => typeof v === 'string' && v.length <= 2000,
    lastLog: (v) => typeof v === 'string' && v.length <= 12000,
    lastOutcome: (v) => typeof v === 'string' && v.length <= 100,
    checkedAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
    lastSuccessAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  };
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed[key] || !allowed[key](value)) {
      throw new TypeError('Invalid updater report field: ' + key);
    }
    result[key] = key.endsWith('At') ? new Date(value) : value;
  }
  return result;
}
async function report(payload) {
  const fields = validateReport(payload);
  fields.agentHeartbeat = new Date();
  await initialize();
  await collection().updateOne({ _id: ID }, { $set: fields });
  return true;
}
async function completeJob(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !['success', 'failed', 'rolled_back', 'skipped'].includes(payload.outcome) ||
      typeof payload.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.jobId)) {
    throw new TypeError('Invalid job completion');
  }
  const log = String(payload.log || '').slice(-12000);
  const error = String(payload.error || '').slice(0, 2000);
  const sha = String(payload.sha || '');
  const attemptedSha = String(payload.attemptedSha || '');
  if ((sha && !SHA.test(sha)) || (attemptedSha && !SHA.test(attemptedSha))) {
    throw new TypeError('Invalid commit SHA');
  }
  const now = new Date();
  const result = await collection().updateOne({
    _id: ID, 'activeJob.id': payload.jobId,
  }, {
    $set: {
      status: payload.outcome === 'skipped' ? 'idle' : payload.outcome,
      lastOutcome: payload.outcome,
      lastError: error,
      lastLog: log,
      agentHeartbeat: now,
      ...(payload.outcome === 'success' ? { currentSha: sha, lastSuccessAt: now,
        updateAvailable: false } : {}),
      ...(['failed', 'rolled_back'].includes(payload.outcome) && attemptedSha
        ? { blockedSha: attemptedSha } : {}),
    },
    $unset: { activeJob: '', ...(payload.outcome === 'success' ? { blockedSha: '' } : {}) },
    $push: {
      history: {
        $each: [{ jobId: payload.jobId, outcome: payload.outcome,
          sha, error, finishedAt: now }],
        $slice: -20,
      },
    },
  });
  if (!result.matchedCount) throw new Error('No matching active update job');
  return true;
}

module.exports = {
  DEFAULT_CONFIG, format, validateConfig, validateReport,
  getState, saveConfig, requestCheck, queueJob, claimJob, report, completeJob,
};
