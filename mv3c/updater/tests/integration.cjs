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
  const logApi = 'http://127.0.0.1:3080/api/admin/mv3c/runtime-logs';
  assert.equal((await fetch(logApi)).status, 401);
  const statsResponse = await fetch(logApi, { headers });
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  assert.equal(stats.maxBytes, 10 * 1024 * 1024);
  assert.ok(stats.usedBytes >= 0);
  const exported = await fetch(logApi + '/export?range=1h', { headers });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const runtimeReport = await exported.text();
  assert.match(runtimeReport, /mv3c server runtime log export/);
  assert.equal((await fetch(logApi + '/export?range=1h')).status, 401);
  assert.equal((await fetch(logApi + '/export?range=everything', { headers })).status, 400);

  const initial = await fetch(api, { headers });
  assert.equal(initial.status, 200);
  const configResponse = await fetch(api + '/settings', {
    method: 'PUT', headers,
    body: JSON.stringify({ autoEnabled: false, channel: 'release', intervalMinutes: 15 }),
  });
  assert.equal(configResponse.status, 200);
  const configured = await configResponse.json();
  assert.equal(configured.config.autoEnabled, false);
  assert.equal(configured.config.channel, 'release');
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
  await updates.progressJob({
    jobId: job.id, stage: 'checking', percent: 8, message: 'Checking GitHub',
  });
  await updates.progressJob({
    jobId: job.id, stage: 'building', percent: 50, message: 'Building Docker',
  });
  const working = await updates.getState();
  assert.equal(working.activeJob.progress.percent, 50);
  assert.equal(working.activeJob.progress.steps.length, 2);
  await assert.rejects(updates.progressJob({
    jobId: job.id, stage: 'checking', percent: 10, message: 'Regressed',
  }), /regressed/);
  await updates.report({
    currentSha: 'a'.repeat(40), latestSha: 'a'.repeat(40),
    checkedAt: new Date().toISOString(), updateAvailable: false,
  });
  await updates.completeJob({
    jobId: job.id, outcome: 'skipped', sha: 'a'.repeat(40),
    log: 'CI simulated updater bridge lifecycle', error: '',
    fromSha: 'a'.repeat(40), attemptedSha: 'a'.repeat(40),
    verification: 'No update necessary',
  });
  const done = await updates.getState();
  assert.equal(done.pendingJob, null);
  assert.equal(done.activeJob, null);
  assert.equal(done.history[0].outcome, 'skipped');
  assert.equal(done.history[0].verification, 'No update necessary');
  assert.equal(done.history[0].steps.length, 2);
  assert.equal(done.history[0].log, undefined, 'polling API must omit full reports');
  const reportResponse = await fetch(api + '/reports/' + job.id, { headers });
  assert.equal(reportResponse.status, 200);
  assert.match(reportResponse.headers.get('content-disposition'), /attachment/);
  const reportText = await reportResponse.text();
  assert.match(reportText, /No update necessary/);
  assert.match(reportText, /50% \| building/);
  assert.match(reportText, /CI simulated updater bridge lifecycle/);
  assert.equal((await fetch(api + '/reports/' + job.id)).status, 401);
  assert.equal((await fetch(api + '/reports/invalid', { headers })).status, 400);
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

  // A one-time verified host bootstrap is not a queued admin update.
  // It must record success without rewriting/removing any earlier failure.
  const oldCommitEnv = process.env.BUILD_COMMIT;
  const oldVersionEnv = process.env.MV3C_VERSION;
  const bootstrapSha = 'c'.repeat(40);
  const bootstrapVersion = 'v0.1.12';
  const evidence = 'Post-deploy validation PASSED: git SHA=' +
    bootstrapSha.slice(0, 12) + '; container healthy; live version attested';
  try {
    process.env.BUILD_COMMIT = bootstrapSha;
    process.env.MV3C_VERSION = bootstrapVersion;
    await assert.rejects(updates.recordVerifiedBootstrap({
      sha: 'd'.repeat(40), version: bootstrapVersion, verification: evidence,
    }), /Invalid verified bootstrap evidence/);
    await assert.rejects(updates.recordVerifiedBootstrap({
      sha: bootstrapSha, version: bootstrapVersion,
      verification: 'Pre-deployment verification FAILED',
    }), /Invalid verified bootstrap evidence/);

    await updates.report({
      status: 'blocked', lastError: 'Historical GitHub API HTTP 403',
      currentSha: 'b'.repeat(40), currentVersion: 'v0.1.5',
    });
    const prior = await updates.getState();
    const originalLength = prior.history.length;
    const first = await updates.recordVerifiedBootstrap({
      sha: bootstrapSha, version: bootstrapVersion, verification: evidence,
    });
    assert.equal(first.recorded, true);
    const corrected = await updates.getState();
    assert.equal(corrected.currentSha, bootstrapSha);
    assert.equal(corrected.currentVersion, bootstrapVersion);
    assert.equal(corrected.status, 'success');
    assert.equal(corrected.lastOutcome, 'success');
    assert.equal(corrected.lastError, '');
    assert.equal(corrected.latestVersion, bootstrapVersion);
    assert.equal(corrected.updateAvailable, false);
    assert.ok(corrected.lastSuccessAt);
    assert.equal(corrected.history[0].mode, 'bootstrap');
    assert.equal(corrected.history[0].sha, bootstrapSha);
    assert.equal(corrected.history.length, originalLength + 1);
    assert.equal(corrected.history[1].outcome, 'success');
    const bootstrapReport = await updates.getReport(first.jobId);
    assert.match(bootstrapReport, /verified one-time host bootstrap/);
    assert.match(bootstrapReport, /Post-deploy validation PASSED/);
    const again = await updates.recordVerifiedBootstrap({
      sha: bootstrapSha, version: bootstrapVersion, verification: evidence,
    });
    assert.equal(again.recorded, false);
    assert.equal((await updates.getState()).history.length, originalLength + 1);

    const pending = await updates.queueJob('ci-admin');
    process.env.BUILD_COMMIT = 'd'.repeat(40);
    await assert.rejects(updates.recordVerifiedBootstrap({
      sha: 'd'.repeat(40), version: bootstrapVersion,
      verification: 'Post-deploy validation PASSED: git SHA=dddddddddddd',
    }), /queued or active/);
    assert.equal((await updates.getState()).pendingJob.id, pending.job.id);
  } finally {
    if (oldCommitEnv === undefined) delete process.env.BUILD_COMMIT;
    else process.env.BUILD_COMMIT = oldCommitEnv;
    if (oldVersionEnv === undefined) delete process.env.MV3C_VERSION;
    else process.env.MV3C_VERSION = oldVersionEnv;
  }

  await mongoose.disconnect();
  console.log('mv3c update settings, exclusive queue, claims and history: OK');
}
main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
