'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  catalog, allowedIds, listCatalog, validateHiddenCatalogIds, summarizeServer,
} = require('../pluginCatalog.cjs');

test('curated catalogue is single source of published state', () => {
  assert.equal(catalog.length, 3);
  assert.deepEqual(allowedIds, ['github', 'linear-readonly', 'deepwiki']);
  assert.equal(listCatalog(['github']).length, 2);
  assert.equal(listCatalog(['github'], true).find((item) => item.id === 'github').published, false);
  assert.equal(listCatalog().find((item) => item.id === 'github').published, true);
  assert.deepEqual(validateHiddenCatalogIds(['deepwiki']), ['deepwiki']);
});
test('arbitrary ids, duplicates and invalid catalogue updates fail closed', () => {
  for (const value of [['evil'], ['github', 'github'], {}, 'github', null, ['__proto__']]) {
    assert.throws(() => validateHiddenCatalogIds(value));
  }
});
test('admin inventory projection redacts all credentials and never asserts online status', () => {
  const record = {
    _id: 'mcp-1',
    serverName: 'private-service',
    author: 'owner-1',
    updatedAt: '2026-10-25T00:00:00.000Z',
    config: {
      title: 'Private MCP',
      url: 'https://service.invalid/mcp?token=secret',
      apiKey: { key: 'sk-NEVER-LEAK' },
      oauth: { client_secret: 'NEVER-SHOW-OAUTH' },
      headers: { Authorization: 'Bearer NEVER-SHOW-HEADER' },
    },
  };
  const safe = summarizeServer(record);
  assert.equal(safe.state, 'registered');
  assert.equal(safe.authType, 'oauth');
  assert.equal(safe.serverName, 'private-service');
  const json = JSON.stringify(safe);
  for (const secret of ['sk-NEVER-LEAK', 'NEVER-SHOW-OAUTH', 'NEVER-SHOW-HEADER', 'secret']) {
    assert.ok(!json.includes(secret));
  }
  assert.ok(!Object.hasOwn(safe, 'config'));
  assert.ok(!Object.hasOwn(safe, 'url'));
});
