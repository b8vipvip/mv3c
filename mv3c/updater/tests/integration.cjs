'use strict';
// Integration smoke: run in a disposable mv3c Docker stack with MongoDB.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const updates = require('../../../api/server/services/Config/mv3cUpdater');

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const initial = await updates.getState();
  assert.equal(initial.config.channel, 'main');
  const configured = await updates.saveConfig({
    autoEnabled: false, channel: 'main', intervalMinutes: 15,
  }, 'ci-admin');
  assert.equal(configured.config.autoEnabled, false);
  await updates.requestCheck('ci-admin');
  const queued = await updates.queueJob('ci-admin');
  assert.equal(queued.state.pendingJob.id, queued.job.id);
  await assert.rejects(() => updates.queueJob('ci-admin'), (err) => err.status === 409);
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
  await mongoose.disconnect();
  console.log('mv3c update settings, exclusive queue, claims and history: OK');
}
main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
