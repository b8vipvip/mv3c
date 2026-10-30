'use strict';
const mongoose = require('mongoose');
const { getTenantId } = require('@librechat/data-schemas');
const { getPublicSettings } = require('./Config/mv3cSettings');
const { resolveAllMcpConfigs } = require('./MCP');
const {
  isKnownPluginId, configuredCatalogEntries, visibleInstalledIds,
} = require('../../../mv3c/userPluginStoreCore.cjs');

function userKey(userId) {
  if (!userId || typeof userId !== 'string') throw new TypeError('User is required');
  return JSON.stringify([String(getTenantId() || ''), userId]);
}
function collection() {
  if (!mongoose.connection.db) throw new Error('Database is unavailable');
  return mongoose.connection.db.collection('mv3c_user_plugin_installations');
}
async function getInstalledIds(userId) {
  const record = await collection().findOne({ _id: userKey(userId) }, { projection: { ids: 1 } });
  return Array.isArray(record?.ids) ? record.ids.filter(isKnownPluginId) : [];
}
async function getAvailableEntries(user) {
  const [settings, configs] = await Promise.all([
    getPublicSettings(),
    resolveAllMcpConfigs(user.id, user),
  ]);
  return configuredCatalogEntries(configs, settings.plugins.catalogHidden, settings.plugins.githubOAuthReady);
}
async function getStorefront(user) {
  const [available, ids] = await Promise.all([
    getAvailableEntries(user), getInstalledIds(user.id),
  ]);
  return { items: available, installed: visibleInstalledIds(ids, available) };
}
async function install(user, id) {
  if (!isKnownPluginId(id)) throw new TypeError('Unknown plugin');
  const available = await getAvailableEntries(user);
  if (!available.some((entry) => entry.id === id)) {
    const error = new Error('Plugin is not published or configured by the administrator');
    error.status = 409;
    throw error;
  }
  await collection().updateOne(
    { _id: userKey(user.id) },
    {
      $addToSet: { ids: id },
      $set: { updatedAt: new Date() },
      $setOnInsert: { userId: user.id, tenantId: String(getTenantId() || '') },
    }, { upsert: true },
  );
  return getStorefront(user);
}
async function uninstall(user, id) {
  if (!isKnownPluginId(id)) throw new TypeError('Unknown plugin');
  await collection().updateOne(
    { _id: userKey(user.id) },
    { $pull: { ids: id }, $set: { updatedAt: new Date() } },
  );
  // Removal hides the plugin and its catalogue tools; credential revocation
  // is a separate explicit account-authorization action.
  return getStorefront(user);
}
module.exports = { getInstalledIds, getAvailableEntries, getStorefront, install, uninstall };
