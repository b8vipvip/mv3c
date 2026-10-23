'use strict';
const { admit, deny, PROVIDER } = require('~/server/services/Config/mv3cGuest');
module.exports = async function enforceGuestQuota(req, res, next) {
  if (req.method !== 'POST' || req.user?.provider !== PROVIDER) return next();
  try {
    const stats = await admit(String(req.user.id || req.user._id), req.body);
    if (stats.limitReached) return deny(res, stats);
    return next();
  } catch {
    return res.status(503).json({
      code: 'MV3C_GUEST_USAGE_UNAVAILABLE',
      message: '游客额度服务暂不可用，请稍后再试',
    });
  }
};
