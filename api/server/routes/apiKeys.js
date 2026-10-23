const express = require('express');
const { generateCheckAccess, createApiKeyHandlers } = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getAgentApiKeyById,
  createAgentApiKey,
  deleteAgentApiKey,
  listAgentApiKeys,
  getRoleByName,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const handlers = createApiKeyHandlers({
  createAgentApiKey,
  listAgentApiKeys,
  deleteAgentApiKey,
  getAgentApiKeyById,
});

const checkRemoteAgentsUse = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});

// A guest must not mint a remote API key that bypasses the guest chat quota.
router.post('/', requireJwtAuth, (req, res, next) => {
  if (req.user?.provider === 'mv3c-guest') {
    return res.status(403).json({ code: 'MV3C_GUEST_ROUTE_RESTRICTED',
      message: '游客不可创建远程 API Key' });
  }
  return next();
}, checkRemoteAgentsUse, handlers.createApiKey);

router.get('/', requireJwtAuth, checkRemoteAgentsUse, handlers.listApiKeys);

router.get('/:id', requireJwtAuth, checkRemoteAgentsUse, handlers.getApiKey);

router.delete('/:id', requireJwtAuth, checkRemoteAgentsUse, handlers.deleteApiKey);

module.exports = router;
