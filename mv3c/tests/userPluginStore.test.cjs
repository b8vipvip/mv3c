'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isKnownPluginId, configuredCatalogEntries, visibleInstalledIds,
  filterUninstalledCatalogServers,
} = require('../userPluginStoreCore.cjs');

const github = {
  github: {
    source: 'config', url: 'https://api.githubcopilot.com/mcp/',
    oauth: { client_id: 'sample-app', client_secret: 'never-expose' },
  },
};
test('store dialog contains only administrator-configured published servers', () => {
  assert.deepEqual(configuredCatalogEntries({}, [], true), []);
  assert.deepEqual(configuredCatalogEntries(github, [], false), []);
  const entries = configuredCatalogEntries(github, [], true);
  assert.deepEqual(entries.map((item) => item.id), ['github']);
  assert.deepEqual(entries.map((item) => item.serverName), ['github']);
  assert.deepEqual(configuredCatalogEntries(github, ['github'], true), []);
  assert.equal(JSON.stringify(entries).includes('never-expose'), false);
});
test('bootstrap-loaded operator GitHub is available without weakening identity checks', () => {
  // initializeMCPs() puts the configured server in the startup YAML cache
  // with source='yaml'. The runtime registry preserves that source when
  // ensureConfigServers() sees the same config after a restart.
  const bootstrapped = { github: { ...github.github, source: 'yaml' } };
  const configuredLater = { github: { ...github.github, source: 'config' } };
  for (const configs of [bootstrapped, configuredLater]) {
    const cards = configuredCatalogEntries(configs, [], true);
    assert.deepEqual(cards.map((item) => item.id), ['github']);
    assert.equal(cards[0].serverName, 'github');
    const filtered = filterUninstalledCatalogServers(configs, [], cards);
    assert.deepEqual(Object.keys(filtered), []);
    assert.deepEqual(
      Object.keys(filterUninstalledCatalogServers(configs, ['github'], cards)),
      ['github'],
    );
  }
  assert.deepEqual(configuredCatalogEntries(bootstrapped, [], false), []);
  assert.deepEqual(configuredCatalogEntries(bootstrapped, ['github'], true), []);
  assert.deepEqual(configuredCatalogEntries({
    github: { ...github.github, source: 'user' },
  }, [], true), []);
  assert.deepEqual(configuredCatalogEntries({
    github: { ...github.github, source: 'plugin' },
  }, [], true), []);
  assert.deepEqual(configuredCatalogEntries({
    github: { ...github.github, source: 'yaml', url: 'https://example.org/mcp' },
  }, [], true), []);
  assert.deepEqual(configuredCatalogEntries({
    github: { ...github.github, source: 'yaml', oauth: null },
  }, [], true), []);
  assert.deepEqual(configuredCatalogEntries({
    alternative: { ...github.github, source: 'yaml' },
  }, [], true), []);
});

test('rejects user-tier shadow and PAT impostor, but allows operator OAuth', () => {
  for (const config of [
    { ...github.github, source: 'user' },
    { ...github.github, oauth: null, apiKey: { source: 'user' } },
    { ...github.github, url: 'https://evil.invalid/mcp' },
  ]) {
    assert.deepEqual(configuredCatalogEntries({ github: config }, [], true), []);
  }
  const untrusted = { github: { ...github.github, source: 'user' } };
  assert.deepEqual(configuredCatalogEntries(untrusted, [], true), []);
});
test('each user sees only own selected IDs and no default installs', () => {
  const available = configuredCatalogEntries(github, [], true);
  assert.deepEqual(visibleInstalledIds(undefined, available), []);
  assert.deepEqual(visibleInstalledIds(['github', 'deepwiki', 'evil'], available), ['github']);
  assert.equal(isKnownPluginId('__proto__'), false);
});
test('unselected operator plugins stay out of tool discovery', () => {
  const entries = configuredCatalogEntries(github, [], true);
  const userConfig = { other: { source: 'user' }, ...github };
  assert.deepEqual(Object.keys(filterUninstalledCatalogServers(userConfig, [], entries)), ['other']);
  assert.deepEqual(Object.keys(filterUninstalledCatalogServers(userConfig, ['github'], entries)),
    ['other', 'github']);
});
