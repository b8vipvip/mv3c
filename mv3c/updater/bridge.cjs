#!/usr/bin/env node
'use strict';
// This CLI runs INSIDE the mv3c application container.
// The host-side systemd updater invokes it through "docker compose exec".
// It never accepts shell commands or arbitrary database collection names.
const mongoose = require('mongoose');
const updates = require('../../api/server/services/Config/mv3cUpdater');

async function main() {
  const command = process.argv[2];
  if (!['state', 'claim', 'report', 'progress', 'complete', 'bootstrap-complete', 'queue-auto'].includes(command)) {
    throw new Error('Unknown updater bridge command');
  }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  let payload = {};
  if (['report', 'progress', 'complete', 'bootstrap-complete'].includes(command)) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 45000) throw new Error('Updater payload too large');
    }
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  let result;
  switch (command) {
    case 'state':
      result = await updates.getState();
      break;
    case 'claim':
      result = await updates.claimJob();
      break;
    case 'report':
      result = await updates.report(payload);
      break;
    case 'progress':
      result = await updates.progressJob(payload);
      break;
    case 'complete':
      result = await updates.completeJob(payload);
      break;
    case 'bootstrap-complete':
      result = await updates.recordVerifiedBootstrap(payload);
      break;
    case 'queue-auto': {
      const state = await updates.getState();
      if (!state.config.autoEnabled || !state.updateAvailable ||
          state.pendingJob || state.activeJob) {
        result = null;
        break;
      }
      try {
        result = await updates.queueJob('automatic-updater', 'auto');
      } catch (error) {
        if (error.status === 409) result = null;
        else throw error;
      }
      break;
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  await mongoose.disconnect();
}
main().catch((error) => {
  process.stderr.write('mv3c updater bridge: ' + String(error.message).slice(0, 250) + '\n');
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
