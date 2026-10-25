'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { SystemCapabilities, logger, createMv3cRequestRecordStore } = require('@librechat/data-schemas');
const { createMv3cRequestRecordHandlers } = require('@librechat/api');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { findUsers, updateUser, countUsers } = require('~/models');
const { invalidateConfigCaches } = require('~/server/services/Config/app');
const settings = require('~/server/services/Config/mv3cSettings');
const updater = require('~/server/services/Config/mv3cUpdater');
const runtimeLogs = require('~/server/services/Config/mv3cRuntimeLogs');
const { probeToolBridge } = require('../../../../mv3c/toolBridge.cjs');

const router = express.Router();
// Require a JWT bearer header even when another authentication strategy is configured.
// A cookie alone must never authorize changing server-side API credentials.
router.use((req, res, next) => {
  if (!/^Bearer\s+\S+$/i.test(req.get('authorization') || '')) {
    return res.status(401).json({ error: 'Bearer authentication required' });
  }
  return next();
});
router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));

function failure(res, error) {
  if (error?.status === 409 || error?.status === 404) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return res.status(400).json({ error: error.message });
  }
  if (/^chat2api \/models returned HTTP [0-9]{3}$/.test(error?.message || '')) {
    return res.status(502).json({ error: error.message });
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return res.status(504).json({ error: 'chat2api connection timed out' });
  }
  logger.error('[mv3c-admin] Operation failed', { type: error?.name });
  return res.status(502).json({ error: 'Operation failed; check the server logs' });
}
function actorId(req) {
  return String(req.user?.id || req.user?._id || 'unknown');
}

router.get('/', async (req, res) => {
  try {
    return res.json(await settings.getPublicSettings());
  } catch (error) {
    return failure(res, error);
  }
});
router.put('/', async (req, res) => {
  try {
    const value = await settings.saveSettings(req.body, actorId(req));
    await invalidateConfigCaches();
    return res.json(value);
  } catch (error) {
    // Ensure a partially applied DB write never leaves a stale active config.
    await invalidateConfigCaches();
    return failure(res, error);
  }
});
router.post('/test', async (req, res) => {
  try {
    const models = await settings.fetchModelsFromChat2api();
    return res.json({ ok: true, models, count: models.length });
  } catch (error) {
    return failure(res, error);
  }
});
const { listCatalog, summarizeServer } = require('../../../../mv3c/pluginCatalog.cjs');

/** This is inventory and audit only: OAuth credentials and tool execution stay
 * with the existing MCP permission-aware endpoints. */
async function readPluginOverview() {
  const [settingsValue, registrations, total] = await Promise.all([
    settings.getPublicSettings(),
    mongoose.models.MCPServer
      ? mongoose.models.MCPServer.find({})
        .select('serverName config author createdAt updatedAt').sort({ updatedAt: -1 })
        .limit(100).lean()
      : Promise.resolve([]),
    mongoose.models.MCPServer
      ? mongoose.models.MCPServer.countDocuments({})
      : Promise.resolve(0),
  ]);
  return {
    policy: settingsValue.plugins,
    catalogue: listCatalog(settingsValue.plugins.catalogHidden, true),
    registrations: registrations.map(summarizeServer),
    // Counts are registration hints only; neither OAuth connection nor sharing
    // status can be inferred from a server document.
    pluginRegistrations: listCatalog(settingsValue.plugins.catalogHidden, true).map((plugin) => ({
      id: plugin.id,
      count: registrations.filter((entry) => {
        const registeredURL = String(entry?.config?.url || '').replace(/\/+$/, '');
        return registeredURL === plugin.url.replace(/\/+$/, '');
      }).length,
    })),
    registeredCount: total,
    registrationLimit: 100,
    // MongoDB registration is not live connection/health status.
    inventoryIsLive: false,
  };
}
function safePluginCheck(row) {
  return {
    id: String(row._id), at: row.at,
    actor: String(row.actor || ''), model: String(row.model || '').slice(0, 128),
    supported: row.supported === true,
    roundTripSupported: row.roundTripSupported === true,
    reason: String(row.reason || '').slice(0, 128),
    elapsedMs: Number.isFinite(row.elapsedMs) ? row.elapsedMs : null,
  };
}
function csvCell(value) {
  const text = String(value ?? '');
  // Prevent spreadsheet formula execution and quote/line-break injection.
  const escaped = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return '"' + escaped.replace(/"/g, '""') + '"';
}

router.get('/plugins/overview', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await readPluginOverview());
  } catch (error) {
    return failure(res, error);
  }
});
router.put('/plugins/settings', async (req, res) => {
  try {
    // Admin route already requires a JWT bearer token and ACCESS_ADMIN.
    const policy = req.body?.plugins;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new TypeError('plugins settings object required');
    }
    await settings.saveSettings({ plugins: policy }, actorId(req));
    await invalidateConfigCaches();
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await readPluginOverview());
  } catch (error) {
    await invalidateConfigCaches();
    return failure(res, error);
  }
});
router.get('/plugins/checks', async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('limit must be 1 to 100');
    }
    const rows = await mongoose.connection.db.collection('mv3c_plugin_bridge_checks')
      .find({}, { projection: {
        actor: 1, at: 1, model: 1, supported: 1, roundTripSupported: 1,
        reason: 1, elapsedMs: 1,
      } }).sort({ at: -1 }).limit(limit).toArray();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ rows: rows.map(safePluginCheck) });
  } catch (error) {
    return failure(res, error);
  }
});
router.get('/plugins/checks/export', async (req, res) => {
  try {
    const rows = await mongoose.connection.db.collection('mv3c_plugin_bridge_checks')
      .find({}, { projection: {
        actor: 1, at: 1, model: 1, supported: 1, roundTripSupported: 1,
        reason: 1, elapsedMs: 1,
      } }).sort({ at: -1 }).limit(500).toArray();
    const keys = ['id', 'at', 'actor', 'model', 'supported', 'roundTripSupported', 'reason', 'elapsedMs'];
    const csv = [keys.join(','), ...rows.map((doc) => {
      const safe = safePluginCheck(doc);
      return keys.map((key) => csvCell(safe[key])).join(',');
    })].join('\r\n') + '\r\n';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment; filename="mv3c-plugin-checks.csv"');
    return res.send('\uFEFF' + csv);
  } catch (error) {
    return failure(res, error);
  }
});

/** Admin-only diagnostic. The probe uses the already configured provider;
 * no arbitrary host URL, token, tool name or shell command comes from the request.
 * It never executes the function suggested by the model.
 */
router.post('/plugins/compatibility', async (req, res) => {
  try {
    const config = await settings.buildRuntimeConfig();
    const provider = config?.endpoints?.custom?.find((entry) => entry.name === 'chat2api');
    if (!provider) throw new TypeError('chat2api is not configured');
    const record = await probeToolBridge({
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      models: provider.models?.default,
    });
    await mongoose.connection.db.collection('mv3c_plugin_bridge_checks').insertOne({
      actor: actorId(req),
      at: new Date(),
      model: record.model,
      supported: record.supported,
      roundTripSupported: record.roundTripSupported === true,
      reason: record.reason,
      elapsedMs: record.elapsedMs,
    });
    await settings.writeAudit(actorId(req), ['plugins.compatibility']);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ...record, limitation: '模型函数调用结构诊断；不代表 MCP 工具执行已经成功' });
  } catch (error) {
    return failure(res, error);
  }
});
router.post('/models/sync', async (req, res) => {
  try {
    const value = await settings.syncModels(actorId(req));
    await invalidateConfigCaches();
    return res.json(value);
  } catch (error) {
    await invalidateConfigCaches();
    return failure(res, error);
  }
});
router.get('/audit', async (req, res) => {
  try {
    const rows = await mongoose.connection.db.collection('mv3c_settings_audit')
      .find({}, { projection: { actor: 1, changedFields: 1, at: 1 } })
      .sort({ at: -1 }).limit(100).toArray();
    return res.json({ events: rows.map((row) => ({
      id: String(row._id),
      actor: row.actor,
      changedFields: row.changedFields,
      at: row.at,
    })) });
  } catch (error) {
    return failure(res, error);
  }
});
// Dedicated server-side runtime log access: admin bearer token + capability
// checks from this router, fixed allowed time windows, no arbitrary file paths.
router.get('/runtime-logs', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(runtimeLogs.getStats());
  } catch (error) {
    return failure(res, error);
  }
});
router.get('/runtime-logs/export', async (req, res) => {
  try {
    const range = req.query.range || '1h';
    const data = runtimeLogs.getRecentLogText(range);
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="mv3c-runtime-' + range + '-' + date + '.log"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(data);
  } catch (error) {
    return failure(res, error);
  }
});

// Administrator-only request diagnostics; specific exports before the dynamic :id.
const requestRecords = createMv3cRequestRecordHandlers(
  createMv3cRequestRecordStore(mongoose.connection),
);
router.get('/requests', requestRecords.list);
router.get('/requests/export', requestRecords.export);
router.get('/requests/:id/report', requestRecords.report);
router.get('/requests/:id', requestRecords.detail);

router.get('/updates', async (req, res) => {
  try {
    return res.json(await updater.getState());
  } catch (error) {
    return failure(res, error);
  }
});
router.get('/updates/reports/:jobId', async (req, res) => {
  try {
    const report = await updater.getReport(req.params.jobId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="mv3c-update-' + req.params.jobId + '.log"');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(report);
  } catch (error) {
    return failure(res, error);
  }
});
router.put('/updates/settings', async (req, res) => {
  try {
    const result = await updater.saveConfig(req.body, actorId(req));
    await settings.writeAudit(actorId(req), ['updates.settings']);
    return res.json(result);
  } catch (error) {
    return failure(res, error);
  }
});
router.post('/updates/check', async (req, res) => {
  try {
    return res.json(await updater.requestCheck(actorId(req)));
  } catch (error) {
    return failure(res, error);
  }
});
router.post('/updates/deploy', async (req, res) => {
  try {
    const selection = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    const result = await updater.queueJob(actorId(req), 'manual', selection);
    await settings.writeAudit(actorId(req), ['updates.manual_deploy']);
    return res.status(202).json(result);
  } catch (error) {
    return failure(res, error);
  }
});
router.get('/users', async (req, res) => {
  try {
    const [users, total] = await Promise.all([
      findUsers({}, '_id email name username role createdAt', {
        limit: 100, sort: { createdAt: -1 },
      }),
      countUsers(),
    ]);
    return res.json({
      total,
      users: users.map((user) => ({
        id: String(user._id),
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
      })),
    });
  } catch (error) {
    return failure(res, error);
  }
});
router.patch('/users/:id/role', async (req, res) => {
  try {
    const id = req.params.id;
    const role = req.body?.role;
    if (!/^[a-f0-9]{24}$/i.test(id) || !['ADMIN', 'USER'].includes(role)) {
      throw new TypeError('Invalid user ID or role');
    }
    if (id === actorId(req)) {
      throw new TypeError('You cannot change your own administrator role');
    }
    const user = await updateUser(id, { role }, {});
    if (!user) return res.status(404).json({ error: 'User not found' });
    await settings.writeAudit(actorId(req), ['users.role']);
    return res.json({ id, role: user.role });
  } catch (error) {
    return failure(res, error);
  }
});
module.exports = router;
