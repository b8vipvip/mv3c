'use strict';
const crypto = require('node:crypto');

const DEFAULT_SITE = Object.freeze({
  title: 'mv3c',
  welcome: '欢迎使用 mv3c',
  registrationEnabled: false,
});
const DEFAULT_PROVIDER = Object.freeze({
  enabled: true,
  baseURL: '',
  models: ['gpt-6-sol', 'gpt-5.6-sol'],
  fetchModels: true,
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
  const allowed = new Set(['site', 'chat2api']);
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
  if (provider.enabled && provider.configured) {
    config.endpoints = { custom: [{
      name: 'chat2api',
      apiKey: decryptSecret(doc.chat2api.apiKeyCipher, keyHex),
      baseURL: provider.baseURL,
      iconURL: '/assets/logo.svg',
      models: { default: provider.models, fetch: provider.fetchModels },
      titleConvo: false,
      summarize: false,
      modelDisplayLabel: 'mv3c',
      addParams: { useResponsesApi: false, prompt_mode: 'full' },
      dropParams: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
    }] };
  }
  return config;
}

module.exports = {
  DEFAULT_SITE, DEFAULT_PROVIDER, validateBaseURL, validatePatch,
  encryptSecret, decryptSecret, publicSettings, runtimeConfig,
};
