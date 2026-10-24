'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../settingsCore.cjs');
const bootstrap = require('../bootstrap.cjs');

const KEY = crypto.randomBytes(32).toString('hex');

test('API URLs must use HTTPS outside the Docker/private network', () => {
  assert.equal(core.validateBaseURL('https://api.example.com/v1/'),
    'https://api.example.com/v1');
  assert.equal(core.validateBaseURL('http://host.docker.internal:8000/v1'),
    'http://host.docker.internal:8000/v1');
  for (const url of ['http://example.com/v1', 'https://example.com/api',
    'https://user:password@example.com/v1', 'https://example.com/v1?key=x']) {
    assert.throws(() => core.validateBaseURL(url));
  }
});

test('validatePatch rejects unknown fields, invalid keys and invalid models', () => {
  assert.deepEqual(core.validatePatch({ site: { title: 'mv3c', registrationEnabled: false } }),
    { site: { title: 'mv3c', registrationEnabled: false } });
  assert.throws(() => core.validatePatch({ secret: 'injection' }));
  assert.throws(() => core.validatePatch({ chat2api: { apiKey: 'a\nb' } }));
  assert.throws(() => core.validatePatch({ chat2api: { models: ['x', 'x'] } }));
  assert.throws(() => core.validatePatch({ chat2api: { models: [] } }));
});

test('guest defaults and admin validation are bounded', () => {
  assert.deepEqual(core.publicSettings(null).guest, { enabled: true, tokenLimit: 100000 });
  assert.deepEqual(core.validatePatch({ guest: { enabled: false, tokenLimit: 120000 } }),
    { guest: { enabled: false, tokenLimit: 120000 } });
  for (const value of [-1, 0, 999, 10000001, 1.2, '100000', null]) {
    assert.throws(() => core.validatePatch({ guest: { tokenLimit: value } }));
  }
  assert.throws(() => core.validatePatch({ guest: { unknown: true } }));
});

test('provider key is encrypted, authenticated, and never in admin payload', () => {
  const ciphertext = core.encryptSecret('sk-test-secret', KEY);
  assert.ok(!ciphertext.includes('sk-test-secret'));
  assert.equal(core.decryptSecret(ciphertext, KEY), 'sk-test-secret');
  assert.throws(() => core.decryptSecret(ciphertext, crypto.randomBytes(32).toString('hex')));
  const doc = { chat2api: {
    baseURL: 'https://api.example.com/v1',
    apiKeyCipher: ciphertext,
    models: ['gpt-6-sol'],
  }};
  const publicValue = core.publicSettings(doc);
  assert.equal(publicValue.chat2api.apiKeyConfigured, true);
  assert.equal(JSON.stringify(publicValue).includes('sk-test-secret'), false);
  assert.equal(JSON.stringify(publicValue).includes(ciphertext), false);
  const runtime = core.runtimeConfig(doc, KEY);
  assert.equal(runtime.endpoints.custom[0].apiKey, 'sk-test-secret');
  assert.equal(runtime.endpoints.custom[0].addParams.prompt_mode, 'full');
  assert.equal(runtime.endpoints.custom[0].addParams.useResponsesApi, false);
  // TX03 file/long-context runs may take 600s. mv3c must not end them at 300s.
  assert.equal(runtime.endpoints.custom[0].addParams.timeout, 660000);
  assert.equal(runtime.endpoints.custom[0].addParams.maxRetries, 0);
  assert.equal(runtime.endpoints.custom[0].titleConvo, true);
  assert.equal(runtime.endpoints.custom[0].titleModel, 'gpt-6-sol');
});

test('unconfigured provider is not exposed as a chat endpoint', () => {
  const runtime = core.runtimeConfig(null, KEY);
  assert.equal(runtime.endpoints, undefined);
  assert.equal(core.publicSettings(null, 0).site.registrationEnabled, true);
  assert.equal(core.publicSettings(null, 1).site.registrationEnabled, false);
});

test('interactive MCP Apps require an explicit isolated HTTPS sandbox', () => {
  const safe = 'https://mcp-sandbox.example.net/api/mcp/sandbox';
  assert.deepEqual(core.publicSettings(null).plugins,
    { appsEnabled: false, sandboxURL: '' });
  for (const url of [
    'http://sandbox.example.net/api/mcp/sandbox',
    'https://sandbox.example.net/other',
    'https://evil:secret@sandbox.example.net/api/mcp/sandbox',
    'https://sandbox.example.net/api/mcp/sandbox?token=x',
  ]) {
    assert.throws(() => core.validatePatch({ plugins: { appsEnabled: true, sandboxURL: url } }));
  }
  assert.throws(() => core.validatePatch({ plugins: { appsEnabled: true } }));
  const enabled = core.validatePatch({ plugins: { appsEnabled: true, sandboxURL: safe } });
  assert.equal(enabled.plugins.sandboxURL, safe);
  const cfg = core.runtimeConfig({
    site: { publicUrl: 'https://chat.example.org' },
    plugins: enabled.plugins,
  }, KEY);
  assert.equal(cfg.mcpSettings.apps, true);
  assert.equal(cfg.mcpAppSandbox.url, safe);
  const sameOrigin = core.runtimeConfig({
    site: { publicUrl: 'https://sandbox.example.net' },
    plugins: enabled.plugins,
  }, KEY);
  assert.equal(sameOrigin.mcpSettings, undefined);
});

test('bootstrap keys persist across restarts and are owner-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3c-'));
  try {
    const target = path.join(dir, 'bootstrap.env');
    bootstrap.makeBootstrapFile(target);
    assert.equal(bootstrap.validateBootstrapFile(target), true);
    const first = fs.readFileSync(target, 'utf8');
    bootstrap.makeBootstrapFile(target);
    assert.equal(fs.readFileSync(target, 'utf8'), first);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
