'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const origin = 'http://127.0.0.1:3080';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const { token } = JSON.parse(await fs.readFile('/tmp/mv3c-login.json', 'utf8'));
  assert.equal(typeof token, 'string');
  const bearer = { Authorization: 'Bearer ' + token };

  const denied = await fetch(origin + '/api/admin/mv3c/requests');
  assert.equal(denied.status, 401, 'request history requires admin authentication');

  const probe = await fetch(origin + '/api/insights?record_smoke_check=1');
  assert.ok(probe.status >= 400, 'unauthenticated API probe must fail');

  let item;
  for (let retry = 0; retry < 20; retry += 1) {
    const response = await fetch(origin + '/api/admin/mv3c/requests?limit=100', {
      headers: bearer,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(Array.isArray(result.records));
    item = result.records.find((row) => row.path === '/api/insights' &&
      row.httpStatus === probe.status);
    if (item) break;
    await pause(350);
  }
  assert.ok(item, 'the API request should be persisted and listed');
  assert.equal(item.status, 'failed');

  const reportResponse = await fetch(
    origin + '/api/admin/mv3c/requests/' + encodeURIComponent(item.id) + '/report',
    { headers: bearer },
  );
  assert.equal(reportResponse.status, 200);
  assert.match(reportResponse.headers.get('content-disposition') || '', /attachment/);
  const report = await reportResponse.json();
  assert.equal(report.record.id, item.id);
  assert.equal(report.record.path, '/api/insights');
  assert.equal(report.record.httpStatus, probe.status);

  const csvResponse = await fetch(origin + '/api/admin/mv3c/requests/export?limit=50', {
    headers: bearer,
  });
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.match(csv, /httpStatus/);
  assert.ok(csv.includes('/api/insights'));
  assert.ok(!csv.includes('record_smoke_check'));
  assert.ok(!csv.includes(token), 'export must never expose the bearer token');
  console.log('mv3c request records: authentication, persistence, detail and CSV export verified');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
