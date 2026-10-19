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
});

test('host report validates SHA, URL and prevents arbitrary field updates', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(updates.validateReport({
    currentSha: sha, updateAvailable: true, status: 'checking',
  }), { currentSha: sha, updateAvailable: true, status: 'checking' });
  assert.throws(() => updates.validateReport({ currentSha: 'not-a-sha' }));
  assert.throws(() => updates.validateReport({ command: 'rm -rf /' }));
  assert.throws(() => updates.validateReport({ latestUrl: 'https://evil.example.com/' }));
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
});
