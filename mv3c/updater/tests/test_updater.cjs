'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const updates = require('../../../api/server/services/Config/mv3cUpdater');

test('update configuration accepts only fixed channels and intervals', () => {
  assert.deepEqual(updates.validateConfig({
    autoEnabled: false, channel: 'release', intervalMinutes: 15,
  }), { autoEnabled: false, channel: 'release', intervalMinutes: 15 });
  assert.throws(() => updates.validateConfig({ repository: 'attacker/repo' }));
  assert.throws(() => updates.validateConfig({ intervalMinutes: 1 }));
  assert.throws(() => updates.validateConfig({ channel: '../../evil' }));
  assert.throws(() => updates.validateConfig({ channel: 'main' }));
  assert.equal(updates.DEFAULT_CONFIG.channel, 'release');
  assert.equal(updates.DEFAULT_CONFIG.autoDeployEnabled, false);
  assert.deepEqual(updates.validateConfig({ autoDeployEnabled: true }), { autoDeployEnabled: true });
  assert.throws(() => updates.validateConfig({ autoDeployEnabled: 'true' }));
});

test('host report validates SHA, URL and prevents arbitrary field updates', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(updates.validateReport({
    currentSha: sha, updateAvailable: true, status: 'checking',
  }), { currentSha: sha, updateAvailable: true, status: 'checking' });
  assert.throws(() => updates.validateReport({ currentSha: 'not-a-sha' }));
  assert.throws(() => updates.validateReport({ command: 'rm -rf /' }));
  assert.throws(() => updates.validateReport({ latestUrl: 'https://evil.example.com/' }));
  assert.deepEqual(updates.validateReport({ currentVersion: 'v0.1.0', latestVersion: 'v0.2.0' }),
    { currentVersion: 'v0.1.0', latestVersion: 'v0.2.0' });
  assert.throws(() => updates.validateReport({ latestVersion: 'latest' }));
  assert.throws(() => updates.validateReport({ status: 'success' }));
  assert.throws(() => updates.validateReport({ status: 'failed' }));
  assert.throws(() => updates.validateReport({ lastOutcome: 'success' }));
  assert.throws(() => updates.validateReport({ lastSuccessAt: new Date().toISOString() }));
});

test('admin update state never exposes secret keys and detects stale host agents', () => {
  const doc = {
    config: { autoEnabled: false, channel: 'main', intervalMinutes: 10 },
    agentHeartbeat: new Date('2020-01-01T00:00:00Z'),
    currentSha: 'a'.repeat(40),
    pendingJob: { id: 'job1', requestedBy: 'admin' },
    history: [{ jobId: 'job1', outcome: 'success' }],
  };
  const formatted = updates.format(doc);
  assert.equal(formatted.agentOnline, false);
  assert.equal(formatted.currentSha, doc.currentSha);
  assert.equal(formatted.pendingJob.id, 'job1');
  assert.equal(formatted.config.autoEnabled, false);
  assert.equal(formatted.config.autoDeployEnabled, false, 'legacy autoEnabled never opts in to building');
  assert.equal(updates.format({ config: { autoDeployEnabled: true } }).config.autoDeployEnabled, true);
  assert.equal(formatted.config.channel, 'release', 'legacy main policy is migrated on read');
  assert.equal(formatted.currentVersion, '');
  assert.equal(formatted.latestVersion, '');
});

test('manual GitHub check request timestamp remains visible separately from stale results', () => {
  const lastChecked = new Date('2026-10-28T05:44:07.000Z');
  const manualRequested = new Date('2026-10-29T01:21:59.000Z');
  const state = updates.format({
    checkedAt: lastChecked,
    checkRequestedAt: manualRequested,
    currentVersion: 'v0.1.45',
    latestVersion: 'v0.1.45',
    updateAvailable: false,
    status: 'success',
    config: { autoEnabled: false, autoDeployEnabled: false },
  });
  assert.equal(state.latestVersion, 'v0.1.45', 'previous result stays historical');
  assert.equal(state.checkRequestedAt, manualRequested);
  assert.equal(state.checkedAt, lastChecked);
  assert.ok(new Date(state.checkRequestedAt) > new Date(state.checkedAt),
    'clients can distinguish queued manual checks from completed checks');
  assert.equal(state.config.autoEnabled, false,
    'manual checks must not enable unattended periodic checking');
  assert.equal(state.config.autoDeployEnabled, false,
    'manual checks must not queue deployments');
});

test('progress accepts only bounded stages and safe fields', () => {
  const jobId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(updates.validateProgress({
    jobId, stage: 'building', percent: 50, message: 'Building image',
  }), { stage: 'building', percent: 50, message: 'Building image' });
  assert.throws(() => updates.validateProgress({
    jobId, stage: 'shell', percent: 50, message: 'bad',
  }));
  assert.throws(() => updates.validateProgress({
    jobId, stage: 'building', percent: 130, message: 'bad',
  }));
  assert.throws(() => updates.validateProgress({
    jobId, stage: 'building', percent: 50, message: 'bad', command: 'delete',
  }));
});

test('diagnostic report keeps validated result, timestamps, verification and log', () => {
  const jobId = '22222222-2222-4222-8222-222222222222';
  const at = new Date('2026-10-20T00:00:00Z');
  const report = updates.renderReport({
    jobId, mode: 'manual', requestedBy: 'admin', requestedAt: at, startedAt: at,
    finishedAt: at, durationMs: 3000, outcome: 'success', fromSha: 'a'.repeat(40),
    attemptedSha: 'b'.repeat(40), sha: 'b'.repeat(40),
    error: '', verification: 'Post-deploy validation PASSED',
    steps: [{ at, stage: 'building', percent: 50, message: 'Building' }],
    log: 'Docker compose output',
  });
  assert.match(report, /Post-deploy validation PASSED/);
  assert.match(report, /Official version:/);
  assert.match(report, /50% \| building \| Building/);
  assert.match(report, /Docker compose output/);
  assert.match(report, /3000/);
  assert.throws(() => updates.renderReport(null));
});
