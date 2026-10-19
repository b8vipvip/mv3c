'use strict';
const mongoose = require('mongoose');
const {
  validatePatch, encryptSecret, publicSettings, runtimeConfig,
} = require('../../../../mv3c/settingsCore.cjs');

const SETTINGS_ID = 'global';

function collection() {
  if (!mongoose.connection.db) throw new Error('MongoDB is not ready');
  return mongoose.connection.db.collection('mv3c_settings');
}
async function readSettings() {
  return collection().findOne({ _id: SETTINGS_ID });
}
async function countRegisteredUsers() {
  return mongoose.connection.db.collection('users').countDocuments({});
}
async function getPublicSettings() {
  const [doc, userCount] = await Promise.all([readSettings(), countRegisteredUsers()]);
  return publicSettings(doc, userCount);
}
async function getSiteSettings() {
  return (await getPublicSettings()).site;
}
async function buildRuntimeConfig() {
  const doc = await readSettings();
  return runtimeConfig(doc, process.env.CREDS_KEY);
}
async function writeAudit(actor, fields) {
  await mongoose.connection.db.collection('mv3c_settings_audit').insertOne({
    actor: String(actor || 'system'),
    changedFields: fields,
    at: new Date(),
  });
}
async function saveSettings(body, actor) {
  const patch = validatePatch(body);
  const fields = {};
  for (const [name, value] of Object.entries(patch.site ?? {})) {
    fields['site.' + name] = value;
  }
  for (const [name, value] of Object.entries(patch.chat2api ?? {})) {
    fields['chat2api.' + (name === 'apiKey' ? 'apiKeyCipher' : name)] =
      name === 'apiKey' ? encryptSecret(value, process.env.CREDS_KEY) : value;
  }
  if (!Object.keys(fields).length) throw new TypeError('No settings to update');
  fields.updatedAt = new Date();
  fields.updatedBy = String(actor || 'unknown');
  await collection().updateOne(
    { _id: SETTINGS_ID }, { $set: fields }, { upsert: true });
  // Never write secret contents to the audit collection.
  await writeAudit(actor, Object.keys(fields).filter((name) =>
    name !== 'updatedAt' && name !== 'updatedBy'));
  return getPublicSettings();
}
async function fetchModelsFromChat2api() {
  const doc = await readSettings();
  const config = publicSettings(doc).chat2api;
  if (!config.configured) throw new TypeError('Configure the chat2api URL and API Key first');
  const { decryptSecret } = require('../../../../mv3c/settingsCore.cjs');
  const apiKey = decryptSecret(doc.chat2api.apiKeyCipher, process.env.CREDS_KEY);
  const response = await fetch(config.baseURL + '/models', {
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('chat2api /models returned HTTP ' + response.status);
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error('chat2api returned an invalid model list');
  const models = [...new Set(json.data.map((m) => m?.id).filter((id) =>
    typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(id)))];
  if (!models.length) throw new Error('chat2api returned no valid model IDs');
  return models.slice(0, 40);
}
async function syncModels(actor) {
  const models = await fetchModelsFromChat2api();
  const result = await saveSettings({ chat2api: { models } }, actor);
  return { ...result, syncedModels: models };
}

module.exports = {
  readSettings, countRegisteredUsers, getPublicSettings, getSiteSettings,
  buildRuntimeConfig, saveSettings, fetchModelsFromChat2api, syncModels,
};
