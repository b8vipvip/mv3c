'use strict';
const { listCatalog, allowedIds } = require('./pluginCatalog.cjs');
const idSet = new Set(allowedIds);
const normalized = (url) => typeof url === 'string' ? url.replace(/\/+$/, '') : '';
function isKnownPluginId(id) {
  return typeof id === 'string' && idSet.has(id);
}
/**
 * Only an administrator-owned, actually configured MCP service can appear in
 * the add-plugin dialog. Merely being on the public recommendation list does
 * not make a server available, and a same-URL user server never qualifies.
 */
function configuredCatalogEntries(configs, hiddenIds = [], githubOAuthReady = false, includeHidden = false) {
  const entries = listCatalog(hiddenIds, includeHidden);
  return entries.flatMap((entry) => {
    const match = Object.entries(configs || {}).find(([serverName, config]) => {
      if (!config || !['config', 'yaml'].includes(config.source) ||
          normalized(config.url) !== normalized(entry.url)) return false;
      if (entry.id === 'github') {
        return githubOAuthReady === true && serverName === 'github' &&
          config.source === 'config' && config.oauth != null &&
          typeof config.oauth === 'object';
      }
      if (entry.auth === 'oauth') return config.oauth != null || config.requiresOAuth === true;
      if (entry.auth === 'token') {
        // Never ask a consumer for a PAT. Only operator-supplied credentials.
        return config.apiKey?.source === 'admin';
      }
      return !config.oauth && !config.apiKey && config.requiresOAuth !== true;
    });
    return match ? [{ ...entry, serverName: match[0] }] : [];
  });
}
function visibleInstalledIds(rawIds, available) {
  const availableIds = new Set(available.map((entry) => entry.id));
  return Array.isArray(rawIds) ? rawIds.filter((id) => availableIds.has(id)) : [];
}
/** Keep previously configured non-store MCP servers untouched; filter only the
 * curated administrator-managed store servers until the user explicitly adds them.
 */
function filterUninstalledCatalogServers(configs, installedIds, allConfiguredEntries) {
  const ids = new Set(installedIds);
  const excludedNames = new Set(allConfiguredEntries
    .filter((entry) => !ids.has(entry.id)).map((entry) => entry.serverName));
  return Object.fromEntries(Object.entries(configs || {})
    .filter(([name]) => !excludedNames.has(name)));
}
module.exports = {
  isKnownPluginId, configuredCatalogEntries, visibleInstalledIds,
  filterUninstalledCatalogServers,
};
