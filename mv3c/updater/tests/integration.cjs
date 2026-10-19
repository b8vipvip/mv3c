'use strict';
// Integration smoke: run in a disposable mv3c Docker stack with MongoDB.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const updates = require('../../../api/server/services/Config/mv3cUpdater');

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const api = 'http://127.0.0.1:3080/api/admin/mv3c/updates';
  const unauthorized = await fetch(api);
  assert.equal(unauthorized.status, 401);
  const login = await fetch('http://127.0.0.1:3080/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ email: 'smoke@example.test', password: 'SmokePassword123!' }),
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  assert.ok(auth.token);
  const headers = {
    Authorization: 'Bearer ' + auth.token,
    'Content-Type': 'application/json',
  };
  const initial = await fetch(api, { headers });
  assert.equal(initial.status, 200);
  const configResponse = await fetch(api + '/settings', {
    method: 'PUT', headers,
    body: JSON.stringify({ autoEnabled: false, channel: 'main', intervalMinutes: 15 }),
  });
  assert.equal(configResponse.status, 200);
  const configured = await configResponse.json();
  assert.equal(configured.config.autoEnabled, false);
  const check = await fetch(api + '/check', { method: 'POST', headers });
  assert.equal(check.status, 200);
  const queuedResponse = await fetch(api + '/deploy', { method: 'POST', headers });
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.ok(queued.job.id);
  const duplicate = await fetch(api + '/deploy', { method: 'POST', headers });
  assert.equal(duplicate.status, 409);
  const job = await updates.claimJob();
  assert.equal(job.id, queued.job.id);
  await updates.report({
    currentSha: 'a'.repeat(40), latestSha: 'a'.repeat(40),
    checkedAt: new Date().toISOString(), updateAvailable: false,
  });
  await updates.completeJob({
    jobId: job.id, outcome: 'skipped', sha: 'a'.repeat(40),
    log: 'CI simulated updater bridge lifecycle', error: '',
  });
  const done = await updates.getState();
  assert.equal(done.pendingJob, null);
  assert.equal(done.activeJob, null);
  assert.equal(done.history[0].outcome, 'skipped');
  assert.equal(done.agentOnline, true);
  const second = await updates.queueJob('ci-admin');
  await updates.claimJob();
  await updates.completeJob({
    jobId: second.job.id, outcome: 'rolled_back',
    sha: 'a'.repeat(40), attemptedSha: 'b'.repeat(40),
    error: 'CI simulated failure', log: 'Previous image restored',
  });
  assert.equal((await updates.getState()).blockedSha, 'b'.repeat(40));
  const third = await updates.queueJob('ci-admin');
  await updates.claimJob();
  await updates.completeJob({
    jobId: third.job.id, outcome: 'success',
    sha: 'b'.repeat(40), attemptedSha: 'b'.repeat(40),
    error: '', log: 'CI simulated recovery',
  });
  const recovered = await updates.getState();
  assert.equal(recovered.blockedSha, '');
  assert.equal(recovered.currentSha, 'b'.repeat(40));
  await mongoose.disconnect();
  console.log('mv3c update settings, exclusive queue, claims and history: OK');
}
main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
