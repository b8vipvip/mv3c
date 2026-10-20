'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logs = require('../../../api/server/services/Config/mv3cRuntimeLogs');

test('time range must come from the fixed allowlist', () => {
  assert.equal(logs.validateRange('1h'), 60);
  assert.equal(logs.validateRange('7d'), 10080);
  for (const bad of ['all', '../../etc/passwd', '12h', '', null]) {
    assert.throws(() => logs.validateRange(bad), /Invalid log time range/);
  }
});
test('export includes only matching timestamped entries without secrets or traversal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3c-runtime-'));
  try {
    const now = Date.parse('2026-10-20T10:00:00Z');
    const events = [
      { timestamp: new Date(now - 20_000).toISOString(), level: 'info', message: 'recent event' },
      { timestamp: new Date(now - 180_000).toISOString(), level: 'warn', message: 'old event' },
      { timestamp: new Date(now - 10_000).toISOString(), level: 'error',
        message: 'request Authorization: Bearer abc123 password leak sk-secretvalue' },
    ];
    fs.writeFileSync(path.join(dir, logs.FILE_NAME),
      events.map((event) => JSON.stringify(event)).join('\n') + '\ninvalid json\n');
    fs.writeFileSync(path.join(dir, 'mv3c-runtime1.log'),
      JSON.stringify({ timestamp: new Date(now - 30_000).toISOString(),
        level: 'info', message: 'archive event' }) + '\n');
    fs.writeFileSync(path.join(dir, 'private.key'), 'do not export');
    const data = logs.getRecentLogText('15m', dir, now);
    assert.match(data, /recent event/);
    assert.match(data, /old event/); // Last 3 minutes is inside 15m.
    assert.match(data, /archive event/);
    assert.doesNotMatch(data, /private.key|do not export|abc123|sk-secretvalue/);
    assert.match(data, /\[REDACTED\]/);
    const stats = logs.getStats(dir);
    assert.equal(stats.fileCount, 2);
    assert.ok(stats.usedBytes > 0 && stats.maxBytes === 10 * 1024 * 1024);
    const oneMinute = logs.getRecentLogText('15m', dir, now - 180_000);
    assert.doesNotMatch(oneMinute, /recent event/);
    assert.throws(() => logs.getRecentLogText('../../../root', dir), /Invalid log time range/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
