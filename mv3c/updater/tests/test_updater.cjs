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
  assert.equal(Object.hasOwn(updates.DEFAULT_CONFIG, 'autoDeployEnabled'), false);
  assert.throws(() => updates.validateConfig({ autoDeployEnabled: true }));
  assert.throws(() => updates.validateConfig({ autoDeployEnabled: false }));
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
  assert.equal(Object.hasOwn(formatted.config, 'autoDeployEnabled'), false,
    'legacy auto deploy must never appear in the admin response');
  assert.equal(Object.hasOwn(
    updates.format({ config: { autoDeployEnabled: true } }).config, 'autoDeployEnabled'),
    false, 'even persisted true is ignored');
  assert.equal(formatted.config.channel, 'release', 'legacy main policy is migrated on read');
  assert.equal(formatted.currentVersion, '');
  assert.equal(formatted.latestVersion, '');
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

test('only explicit manual update jobs are admitted; no hidden automatic route', async () => {
  const before = updates.queueJob('legacy-agent', 'auto');
  await assert.rejects(before, /Only administrator-initiated manual deployment/);
  await assert.rejects(updates.queueJob('legacy-agent', 'auto', {
    targetVersion: 'v0.1.47', reuseOnly: true,
  }), /Only administrator-initiated manual deployment/);
});

test('old and new host updater progress stages remain interoperable', () => {
  const jobId = '448267d9-9ea0-436a-a52d-cdd82a392a3a';
  for (const stage of ['checking', 'fetching', 'strategy', 'ci']) {
    assert.deepEqual(updates.validateProgress({
      jobId, stage, percent: stage === 'strategy' ? 23 : 16,
      message: 'GPTAuto strategy and GitHub Release verification',
    }), {
      stage, percent: stage === 'strategy' ? 23 : 16,
      message: 'GPTAuto strategy and GitHub Release verification',
    });
  }
  assert.throws(() => updates.validateProgress({
    jobId, stage: 'fake_deploy', percent: 23, message: 'untrusted',
  }), /Invalid update progress/);
});
