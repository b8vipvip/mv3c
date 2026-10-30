#!/usr/bin/env bash
# One-time recovery for a *running older* mv3c bridge rejecting stage=strategy.
# Run on the canonical MV3C Docker host after the failed update has stopped.
# No Git reset, no image rebuild, no container restart, no MongoDB mutation,
# no alternate updater, and no automatic deployment.
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo "Must run as root" >&2; exit 1; }
REPO=/opt/mv3c
[[ -f "$REPO/docker-compose.yml" && -d "$REPO/.git" ]] ||
  { echo "Expected /opt/mv3c host checkout" >&2; exit 1; }
if systemctl is-active --quiet mv3c-updater.service; then
  echo "Canonical updater is running; refuse live repair" >&2
  exit 1
fi
cd "$REPO"
[[ -n "$(docker compose ps -q mv3c)" ]] ||
  { echo "MV3C application container missing" >&2; exit 1; }
docker compose exec -T --user 0 mv3c node - <<'JS'
'use strict';
const fs = require('node:fs');
const file = '/app/api/server/services/Config/mv3cUpdater.js';
const source = fs.readFileSync(file, 'utf8');
const oldStages = "'queued', 'checking', 'fetching', 'ci', 'backup', 'merging',";
const newStages = "'queued', 'checking', 'fetching', 'strategy', 'ci', 'backup', 'merging',";
if (source.includes(newStages)) {
  console.log('MV3C updater bridge already accepts the strategy stage');
  process.exit(0);
}
if (source.split(oldStages).length !== 2) {
  throw Error('Unknown bridge schema; refused to modify running container');
}
const backup = file + '.progress-compat.backup';
fs.writeFileSync(backup, source, {mode: 0o600, flag: 'wx'});
try {
  fs.writeFileSync(file, source.replace(oldStages, newStages));
  const updater = require(file);
  const accepted = updater.validateProgress({
    jobId: '448267d9-9ea0-436a-a52d-cdd82a392a3a',
    stage: 'strategy', percent: 23,
    message: 'GPTAuto verified strategy; continuing official Release check',
  });
  if (accepted.stage !== 'strategy') throw Error('Unexpected progress validation');
  console.log('Temporary running-container progress protocol repaired and tested');
} catch (error) {
  fs.writeFileSync(file, source);
  console.error('Reverted compatibility patch:', error.message);
  throw error;
}
JS
echo "Repair applied to current container only; no production image or Git checkout modified."
echo "Return to MV3C admin and manually select 检查并智能更新."
echo "After the verified update finishes, the new official container has the permanent fix."
