'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const ID = 'global';
const DEFAULT_CONFIG = Object.freeze({
  autoEnabled: true,
  // Only automatic GitHub release discovery is supported. Deployments are manual.
  channel: 'release',
  intervalMinutes: 10,
});
const SHA = /^[0-9a-f]{40}$/i;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFICIAL_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const STAGE_SET = new Set([
  'queued', 'checking', 'fetching', 'strategy', 'ci', 'backup', 'merging',
  'building', 'restarting', 'verifying', 'rollback', 'complete',
]);

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
  // Retire legacy opt-in data, including previously saved true, so no later
  // version can accidentally reactivate unattended deployment.
  await collection().updateOne(
    { _id: ID, 'config.autoDeployEnabled': { $exists: true } },
    { $unset: { 'config.autoDeployEnabled': '' } },
  );
  // An old automatic job must not survive the migration and later be claimed
  // as if an administrator had clicked Deploy. Do not touch active operations.
  await collection().updateOne({
    _id: ID, 'pendingJob.mode': 'auto', activeJob: { $exists: false },
  }, {
    $unset: { pendingJob: '' },
    $set: {
      status: 'idle',
      lastError: '已取消旧版无人值守自动部署排队任务；后续部署仅可由管理员手动触发',
    },
  });
}
function format(doc) {
  // Previously saved main mode is migrated at read time; deployment is release-only.
  // Explicit allow-list also hides any stale legacy field from old DB rows.
  const config = {
    autoEnabled: doc?.config?.autoEnabled !== false,
    channel: 'release',
    intervalMinutes: [5, 10, 15, 30, 60].includes(doc?.config?.intervalMinutes)
      ? doc.config.intervalMinutes : DEFAULT_CONFIG.intervalMinutes,
  };
  const heartbeat = doc?.agentHeartbeat ? new Date(doc.agentHeartbeat) : null;
  const agentOnline = heartbeat && Number.isFinite(heartbeat.getTime()) &&
    Date.now() - heartbeat.getTime() < 180000;
  return {
    config,
    agentOnline: Boolean(agentOnline),
    status: doc?.status || 'idle',
    currentSha: doc?.currentSha || '',
    // Read the running image's trusted build metadata when the updater DB lags a restart.
    currentVersion: /^v\d+\.\d+\.\d+$/.test(process.env.MV3C_VERSION || '')
      ? process.env.MV3C_VERSION : (doc?.currentVersion || ''),
    latestSha: doc?.latestSha || '',
    latestVersion: doc?.latestVersion || '',
    latestLabel: doc?.latestLabel || '',
    latestUrl: doc?.latestUrl || '',
    updateAvailable: Boolean(doc?.updateAvailable),
    checkedAt: doc?.checkedAt || null,
    checkRequestedAt: doc?.checkRequestedAt || null,
    agentHeartbeat: doc?.agentHeartbeat || null,
    lastAttemptAt: doc?.lastAttemptAt || null,
    lastSuccessAt: doc?.lastSuccessAt || null,
    lastError: doc?.lastError || '',
    ciMessage: doc?.ciMessage || '',
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
  return format(await collection().findOne({ _id: ID }, { projection: { 'history.log': 0 } }));
}
function validateConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Update configuration must be an object');
  }
  const result = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'autoEnabled' && typeof value === 'boolean') result[key] = value;
    else if (key === 'channel' && value === 'release') result[key] = value;
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
async function queueJob(actor, mode = 'manual', options = {}) {
  if (mode !== 'manual') throw new TypeError('Only administrator-initiated manual deployment is allowed');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid deployment selection');
  }
  const keys = Object.keys(options);
  if (keys.some((key) => !['targetVersion', 'reuseOnly'].includes(key))) {
    throw new TypeError('Unknown deployment selection field');
  }
  const selected = options.targetVersion;
  if (selected !== undefined && !OFFICIAL_TAG.test(selected)) {
    throw new TypeError('Pinned Release must be a valid official version in a manual job');
  }
  if (options.reuseOnly !== undefined && options.reuseOnly !== true) {
    throw new TypeError('reuseOnly can only be true when provided');
  }
  if ((selected !== undefined) !== (options.reuseOnly === true)) {
    throw new TypeError('Pinned Release requires reuseOnly=true; never build a missing pinned image');
  }
  await initialize();
  const job = {
    id: crypto.randomUUID(),
    requestedAt: new Date(),
    requestedBy: String(actor),
    mode,
    ...(selected ? { targetVersion: selected, reuseOnly: true } : {}),
    progress: { stage: 'queued', percent: 0, message: '等待宿主机执行', updatedAt: new Date(), steps: [] },
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
    _id: ID, 'pendingJob.mode': 'manual', activeJob: { $exists: false },
  }, [{
    $set: { activeJob: '$pendingJob', status: 'updating', lastAttemptAt: '$$NOW' },
  }, {
    $unset: 'pendingJob',
  }], { returnDocument: 'after' });
  return result?.activeJob || null;
}
function validateProgress(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !JOB_ID.test(payload.jobId || '') || !STAGE_SET.has(payload.stage) ||
      !Number.isInteger(payload.percent) || payload.percent < 0 || payload.percent > 100 ||
      typeof payload.message !== 'string' || payload.message.length > 300 ||
      (payload.fromSha !== undefined && !SHA.test(payload.fromSha)) ||
      (payload.targetSha !== undefined && !SHA.test(payload.targetSha)) ||
      Object.keys(payload).some((key) => ![
        'jobId', 'stage', 'percent', 'message', 'fromSha', 'targetSha',
      ].includes(key))) {
    throw new TypeError('Invalid update progress');
  }
  return { stage: payload.stage, percent: payload.percent, message: payload.message };
}
/** Liveness only; no progress or terminal state is changed. */
async function heartbeatJob(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !JOB_ID.test(payload.jobId || '') || Object.keys(payload).some(key => key !== 'jobId')) {
    throw new TypeError('Invalid updater heartbeat');
  }
  await initialize();
  const result = await collection().updateOne(
    { _id: ID, 'activeJob.id': payload.jobId },
    { $set: { agentHeartbeat: new Date() } },
  );
  return { accepted: result.matchedCount === 1 };
}

async function progressJob(payload) {
  const progress = validateProgress(payload);
  const now = new Date();
  const result = await collection().updateOne({
    _id: ID, 'activeJob.id': payload.jobId,
    $or: [
      { 'activeJob.progress.percent': { $lte: progress.percent } },
      { 'activeJob.progress.percent': { $exists: false } },
    ],
  }, {
    $set: {
      'activeJob.progress.stage': progress.stage,
      'activeJob.progress.percent': progress.percent,
      'activeJob.progress.message': progress.message,
      'activeJob.progress.updatedAt': now, agentHeartbeat: now,
      ...(payload.fromSha ? { 'activeJob.fromSha': payload.fromSha } : {}),
      ...(payload.targetSha ? { 'activeJob.targetSha': payload.targetSha } : {}),
    },
    $push: { 'activeJob.progress.steps': {
      $each: [{ stage: progress.stage, percent: progress.percent,
        message: progress.message, at: now }], $slice: -32,
    } },
  });
  if (!result.matchedCount) throw new Error('Update job not active or progress regressed');
  return true;
}
function renderReport(entry) {
  if (!entry) throw new Error('Update report not found');
  const lines = [
    'mv3c deployment diagnostic report',
    '================================',
    'Job ID: ' + entry.jobId,
    'Mode: ' + (entry.mode || 'unknown'),
    'Pinned Release: ' + (entry.targetVersion || '-'),
    'Reuse only: ' + (entry.reuseOnly === true ? 'yes' : 'no'),
    'Requested by: ' + (entry.requestedBy || 'unknown'),
    'Requested at: ' + (entry.requestedAt ? new Date(entry.requestedAt).toISOString() : '-'),
    'Started at: ' + (entry.startedAt ? new Date(entry.startedAt).toISOString() : '-'),
    'Finished at: ' + new Date(entry.finishedAt).toISOString(),
    'Duration (ms): ' + (entry.durationMs ?? '-'),
    'Result: ' + entry.outcome,
    'Old SHA: ' + (entry.fromSha || '-'),
    'Target SHA: ' + (entry.attemptedSha || '-'),
    'Installed SHA: ' + (entry.sha || '-'),
    'Official version: ' + (entry.version || '-'),
    'Verification: ' + (entry.verification || '-'),
    'Error: ' + (entry.error || '-'),
    '',
    'Progress timeline', '-----------------',
    ...(entry.steps || []).map((step) =>
      new Date(step.at).toISOString() + ' | ' + step.percent + '% | ' +
      step.stage + ' | ' + step.message),
    '', 'Deployment log', '--------------', entry.log || '(no log)', '',
  ];
  return lines.join('\n');
}
async function getReport(jobId) {
  if (!JOB_ID.test(jobId || '')) throw new TypeError('Invalid update job ID');
  await initialize();
  const doc = await collection().findOne(
    { _id: ID, 'history.jobId': jobId }, { projection: { history: 1 } },
  );
  const entry = (doc?.history || []).find((row) => row.jobId === jobId);
  if (!entry) {
    const error = new Error('Update report not found or no longer retained');
    error.status = 404;
    throw error;
  }
  return renderReport(entry);
}

function validateReport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Invalid updater report');
  }
  const allowed = {
    currentSha: (v) => typeof v === 'string' && (!v || SHA.test(v)),
    latestSha: (v) => typeof v === 'string' && (!v || SHA.test(v)),
    currentVersion: (v) => typeof v === 'string' && (!v || /^v\d+\.\d+\.\d+$/.test(v)),
    latestVersion: (v) => typeof v === 'string' && (!v || /^v\d+\.\d+\.\d+$/.test(v)),
    latestLabel: (v) => typeof v === 'string' && v.length <= 128,
    latestUrl: (v) => typeof v === 'string' && v.length <= 500 &&
      (!v || v.startsWith('https://github.com/b8vipvip/mv3c/')),
    updateAvailable: (v) => typeof v === 'boolean',
    // Only completeJob owns success/failure/rollback terminal states.
    status: (v) => ['idle', 'checking', 'blocked'].includes(v),
    lastError: (v) => typeof v === 'string' && v.length <= 2000,
    ciMessage: (v) => typeof v === 'string' && v.length <= 300,
    checkedAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
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
      typeof payload.jobId !== 'string' || !JOB_ID.test(payload.jobId)) {
    throw new TypeError('Invalid job completion');
  }
  const log = String(payload.log || '').slice(-24000);
  const verification = String(payload.verification || '').slice(0, 1200);
  const fromSha = String(payload.fromSha || '');
  const error = String(payload.error || '').slice(0, 2000);
  const sha = String(payload.sha || '');
  const attemptedSha = String(payload.attemptedSha || '');
  const version = String(payload.version || '');
  if (version && !/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new TypeError('Invalid official release version');
  }
  if ((sha && !SHA.test(sha)) || (attemptedSha && !SHA.test(attemptedSha)) ||
      (fromSha && !SHA.test(fromSha))) {
    throw new TypeError('Invalid commit SHA');
  }
  const now = new Date();
  const record = await collection().findOne(
    { _id: ID, 'activeJob.id': payload.jobId },
    { projection: { activeJob: 1, latestSha: 1 } },
  );
  if (!record?.activeJob) throw new Error('No matching active update job');
  const active = record.activeJob;
  const startedAt = active.progress?.steps?.[0]?.at || active.requestedAt || now;
  const durationMs = Math.max(0, now.getTime() - new Date(startedAt).getTime());
  const result = await collection().updateOne({
    _id: ID, 'activeJob.id': payload.jobId,
  }, {
    $set: {
      status: payload.outcome === 'skipped' ? 'idle' : payload.outcome,
      lastOutcome: payload.outcome,
      lastError: error,
      lastLog: log,
      agentHeartbeat: now,
      ...(payload.outcome === 'success' ? { currentSha: sha, currentVersion: version,
        lastSuccessAt: now,
        updateAvailable: Boolean(record.latestSha && record.latestSha !== sha) } : {}),
      ...(['failed', 'rolled_back'].includes(payload.outcome) && attemptedSha
        ? { blockedSha: attemptedSha } : {}),
    },
    $unset: { activeJob: '', ...(payload.outcome === 'success' ? { blockedSha: '' } : {}) },
    $push: {
      history: {
        $each: [{
          jobId: payload.jobId, outcome: payload.outcome,
          mode: active.mode, targetVersion: active.targetVersion || '',
          reuseOnly: active.reuseOnly === true,
          requestedBy: active.requestedBy,
          requestedAt: active.requestedAt, startedAt, finishedAt: now, durationMs,
          fromSha, attemptedSha, sha, version, error, verification, log,
          steps: active.progress?.steps || [],
        }],
        $slice: -20,
      },
    },
  });
  if (!result.matchedCount) throw new Error('No matching active update job');
  return true;
}


module.exports = {
  DEFAULT_CONFIG, format, validateConfig, validateReport, validateProgress, renderReport,
  getState, saveConfig, requestCheck, queueJob, claimJob, report, heartbeatJob, progressJob, completeJob,
  getReport,
};
