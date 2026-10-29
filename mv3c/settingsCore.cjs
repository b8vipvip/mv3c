'use strict';
const crypto = require('node:crypto');
const { validateHiddenCatalogIds } = require('./pluginCatalog.cjs');

const DEFAULT_SITE = Object.freeze({
  title: 'mv3c',
  welcome: '欢迎使用 mv3c',
  publicUrl: '',
  registrationEnabled: false,
});
const DEFAULT_PROVIDER = Object.freeze({
  enabled: true,
  baseURL: '',
  models: ['gpt-6-sol', 'gpt-5.6-sol'],
  fetchModels: true,
});
const DEFAULT_GUEST = Object.freeze({ enabled: true, tokenLimit: 100000 });
// Interactive MCP Apps are opt-in until a dedicated sandbox origin is deployed.
const DEFAULT_PLUGINS = Object.freeze({
  appsEnabled: false, sandboxURL: '', catalogHidden: [],
  githubOAuthEnabled: false, githubOAuthClientId: '', githubOAuthConfigured: false,
});
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/;

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(name + ' must be an object');
  }
}

function validateBaseURL(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new TypeError('API Base URL must be a string of at most 2048 characters');
  }
  if (!value.trim()) return '';
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || !url.hostname ||
      url.pathname.replace(/\/+$/, '').split('/').pop() !== 'v1') {
    throw new TypeError('API Base URL must end in /v1 and contain no credentials, query or fragment');
  }
  const host = url.hostname.toLowerCase();
  const internal = host === 'host.docker.internal' || host === 'chat2api' ||
    host === 'localhost' || host === '127.0.0.1' ||
    host === '[::1]' || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && internal)) {
    throw new TypeError('Public API URLs must use HTTPS; HTTP is allowed for local Docker/private addresses');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function validatePatch(body) {
  assertPlainObject(body, 'settings');
  const allowed = new Set(['site', 'chat2api', 'guest', 'plugins']);
  for (const name of Object.keys(body)) {
    if (!allowed.has(name)) throw new TypeError('Unknown settings section: ' + name);
  }
  const result = {};
  if (body.site !== undefined) {
    assertPlainObject(body.site, 'site');
    const site = {};
    for (const [name, value] of Object.entries(body.site)) {
      if (name === 'title' || name === 'welcome') {
        const max = name === 'title' ? 64 : 200;
        if (typeof value !== 'string' || !value.trim() || value.length > max) {
          throw new TypeError(name + ' must be a nonempty string up to ' + max + ' characters');
        }
        site[name] = value.trim();
      } else if (name === 'publicUrl') {
        if (typeof value !== 'string' || value.length > 2048) {
          throw new TypeError('publicUrl must be a string');
        }
        if (value) {
          const url = new URL(value);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
              url.search || url.hash || url.pathname !== '/' ||
              (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
            throw new TypeError('publicUrl must be an HTTPS origin (or local HTTP origin)');
          }
          site.publicUrl = url.origin;
        } else {
          site.publicUrl = '';
        }
      } else if (name === 'registrationEnabled') {
        if (typeof value !== 'boolean') throw new TypeError(name + ' must be boolean');
        site[name] = value;
      } else {
        throw new TypeError('Unknown site setting: ' + name);
      }
    }
    result.site = site;
  }
  if (body.chat2api !== undefined) {
    assertPlainObject(body.chat2api, 'chat2api');
    const provider = {};
    for (const [name, value] of Object.entries(body.chat2api)) {
      if (name === 'baseURL') {
        provider.baseURL = validateBaseURL(value);
      } else if (name === 'apiKey') {
        if (typeof value !== 'string' || value.length > 4096 ||
            /[\r\n\u0000-\u001f]/.test(value)) {
          throw new TypeError('Invalid API key');
        }
        if (value !== '') provider.apiKey = value;
      } else if (name === 'enabled' || name === 'fetchModels') {
        if (typeof value !== 'boolean') throw new TypeError(name + ' must be boolean');
        provider[name] = value;
      } else if (name === 'models') {
        if (!Array.isArray(value) || value.length < 1 || value.length > 40 ||
            value.some((model) => typeof model !== 'string' || !MODEL_ID.test(model)) ||
            new Set(value).size !== value.length) {
          throw new TypeError('models must be 1-40 distinct model IDs');
        }
        provider.models = value;
      } else {
        throw new TypeError('Unknown chat2api setting: ' + name);
      }
    }
    result.chat2api = provider;
  }
  if (body.guest !== undefined) {
    assertPlainObject(body.guest, 'guest');
    const guest = {};
    for (const [name, value] of Object.entries(body.guest)) {
      if (name === 'enabled') {
        if (typeof value !== 'boolean') throw new TypeError('guest.enabled must be boolean');
        guest.enabled = value;
      } else if (name === 'tokenLimit') {
        if (!Number.isSafeInteger(value) || value < 1000 || value > 10000000) {
          throw new TypeError('guest.tokenLimit must be an integer between 1000 and 10000000');
        }
        guest.tokenLimit = value;
      } else {
        throw new TypeError('Unknown guest setting: ' + name);
      }
    }
    result.guest = guest;
  }
  if (body.plugins !== undefined) {
    assertPlainObject(body.plugins, 'plugins');
    const plugins = {};
    for (const [name, value] of Object.entries(body.plugins)) {
      if (name === 'appsEnabled') {
        if (typeof value !== 'boolean') throw new TypeError('plugins.appsEnabled must be boolean');
        plugins.appsEnabled = value;
      } else if (name === 'catalogHidden') {
        plugins.catalogHidden = validateHiddenCatalogIds(value);
      } else if (name === 'sandboxURL') {
        if (typeof value !== 'string' || value.length > 2048) {
          throw new TypeError('plugins.sandboxURL must be a URL');
        }
        if (value === '') {
          plugins.sandboxURL = '';
          continue;
        }
        const u = new URL(value);
        if (u.protocol !== 'https:' || !u.hostname || u.username || u.password ||
            u.search || u.hash || u.pathname !== '/api/mcp/sandbox' ||
            u.port || !/^[a-z0-9.-]+$/i.test(u.hostname)) {
          throw new TypeError('MCP sandbox must use a dedicated HTTPS origin and /api/mcp/sandbox');
        }
        plugins.sandboxURL = u.href;
      } else if (name === 'githubOAuthEnabled') {
        if (typeof value !== 'boolean') throw new TypeError('plugins.githubOAuthEnabled must be boolean');
        plugins.githubOAuthEnabled = value;
      } else if (name === 'githubOAuthClientId') {
        if (typeof value !== 'string' || (value !== '' &&
            !/^[a-zA-Z0-9_-]{8,128}$/.test(value))) {
          throw new TypeError('plugins.githubOAuthClientId must be a valid GitHub app Client ID');
        }
        plugins.githubOAuthClientId = value;
      } else if (name === 'githubOAuthClientSecret') {
        if (typeof value !== 'string' || (value !== '' &&
            (value.length < 12 || value.length > 512 || /[\r\n\u0000-\u001f]/.test(value)))) {
          throw new TypeError('Invalid GitHub OAuth client secret');
        }
        if (value) plugins.githubOAuthClientSecret = value;
      } else {
        throw new TypeError('Unknown plugins setting: ' + name);
      }
    }
    if (plugins.appsEnabled && !plugins.sandboxURL) {
      throw new TypeError('Enable interactive apps together with a dedicated sandbox URL');
    }
    result.plugins = plugins;
  }
  return result;
}

function keyBuffer(hex) {
  if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error('Persistent CREDS_KEY must be a 64-character hexadecimal secret');
  }
  return Buffer.from(hex, 'hex');
}
function encryptSecret(plaintext, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(keyHex), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'),
    data.toString('base64')].join(':');
}
function decryptSecret(ciphertext, keyHex) {
  const parts = String(ciphertext).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid secret format');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', keyBuffer(keyHex), Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64')), decipher.final(),
  ]).toString('utf8');
}
function publicSettings(doc, userCount = 1) {
  const site = { ...DEFAULT_SITE, ...(doc?.site ?? {}) };
  const provider = { ...DEFAULT_PROVIDER, ...(doc?.chat2api ?? {}) };
  return {
    site: { ...site, registrationEnabled:
      doc?.site?.registrationEnabled ?? userCount === 0 },
    guest: { ...DEFAULT_GUEST, ...(doc?.guest ?? {}) },
    // Allowlist prevents encrypted OAuth credentials and future private keys
    // from ever escaping through the admin/public settings response.
    plugins: {
      ...DEFAULT_PLUGINS,
      appsEnabled: doc?.plugins?.appsEnabled === true,
      sandboxURL: doc?.plugins?.sandboxURL || '',
      catalogHidden: Array.isArray(doc?.plugins?.catalogHidden)
        ? [...doc.plugins.catalogHidden] : [],
      githubOAuthEnabled: doc?.plugins?.githubOAuthEnabled === true,
      githubOAuthClientId: doc?.plugins?.githubOAuthClientId || '',
      githubOAuthConfigured: Boolean(
        doc?.plugins?.githubOAuthClientId && doc?.plugins?.githubOAuthClientSecretCipher
      ),
    },
    chat2api: {
      enabled: provider.enabled,
      baseURL: provider.baseURL,
      models: provider.models,
      fetchModels: provider.fetchModels,
      apiKeyConfigured: Boolean(provider.apiKeyCipher),
      configured: Boolean(provider.baseURL && provider.apiKeyCipher),
    },
    updatedAt: doc?.updatedAt ?? null,
  };
}
function runtimeConfig(doc, keyHex) {
  const publicValue = publicSettings(doc);
  const site = publicValue.site;
  const provider = publicValue.chat2api;
  const plugins = publicValue.plugins;
  const config = {
    version: '1.3.17',
    cache: true,
    interface: {
      customWelcome: site.welcome,
      landingHeading: 'greeting',
      modelSelect: true,
      endpointsMenu: true,
      parameters: false,
      fileSearch: false,
    },
  };
  // The sandbox must be deliberately provisioned and isolated from the main app.
  if (plugins.appsEnabled && plugins.sandboxURL) {
    const sandbox = new URL(plugins.sandboxURL);
    const siteHost = site.publicUrl ? new URL(site.publicUrl).hostname : '';
    if (sandbox.hostname !== siteHost) {
      config.mcpSettings = { apps: true };
      config.mcpAppSandbox = { url: plugins.sandboxURL, maxActiveViews: 3 };
    }
  }
  // The operator configures one GitHub OAuth application for the whole
  // deployment. Each MV3C user then grants their own identity/scopes through
  // the *existing* per-user MCP OAuth flow; no shared PAT or proxy execution.
  if (plugins.githubOAuthEnabled && plugins.githubOAuthConfigured) {
    const clientSecret = decryptSecret(doc.plugins.githubOAuthClientSecretCipher, keyHex);
    // AppService converts the supported mcpServers YAML field into its
    // internal appConfig.mcpConfig used by the existing MCP registry.
    config.mcpServers = {
      github: {
        type: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp/',
        title: 'GitHub',
        description: '连接 GitHub 账号后访问你授权的仓库、议题和 Pull Request',
        oauth: {
          client_id: plugins.githubOAuthClientId,
          client_secret: clientSecret,
          authorization_url: 'https://github.com/login/oauth/authorize',
          token_url: 'https://github.com/login/oauth/access_token',
          // GitHub exchanges codes with client credentials in POST form data.
          // Without this explicit mode the generic SDK may choose Basic Auth.
          token_exchange_method: 'default_post',
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          ...(site.publicUrl ? {
            redirect_uri: site.publicUrl + '/api/mcp/github/oauth/callback',
          } : {}),
          scope: 'read:user repo',
        },
      },
    };
  }
  if (provider.enabled && provider.configured) {
    config.endpoints = { custom: [{
      name: 'chat2api',
      apiKey: decryptSecret(doc.chat2api.apiKeyCipher, keyHex),
      baseURL: provider.baseURL,
      iconURL: '/assets/logo.svg',
      models: { default: provider.models, fetch: provider.fetchModels },
      // Generate conversation names with a model this chat2api instance advertises.
      titleConvo: true,
      titleModel: provider.models[0],
      summarize: false,
      modelDisplayLabel: 'mv3c',
      // chat2api permits 600s Worker tasks; LangChain's shorter default
      // request timeout would abort the upstream at exactly 300s. Give the
      // sole server Worker deadline a 60s transport margin, never retry a
      // possibly still-running generation behind its authority.
      addParams: { useResponsesApi: false, prompt_mode: 'full', timeout: 660000, maxRetries: 0 },
      dropParams: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
    }] };
  }
  return config;
}

module.exports = {
  DEFAULT_SITE, DEFAULT_PROVIDER, DEFAULT_GUEST, DEFAULT_PLUGINS, validateBaseURL, validatePatch,
  encryptSecret, decryptSecret, publicSettings, runtimeConfig,
};
