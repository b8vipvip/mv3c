'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { SystemCapabilities, logger } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { findUsers, updateUser, countUsers } = require('~/models');
const { invalidateConfigCaches } = require('~/server/services/Config/app');
const settings = require('~/server/services/Config/mv3cSettings');

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
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return res.status(400).json({ error: error.message });
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
