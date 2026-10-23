'use strict';
const { admit, deny, PROVIDER } = require('~/server/services/Config/mv3cGuest');
module.exports = async function enforceGuestQuota(req, res, next) {
  // Control-only requests must remain available so an exhausted guest can abort work.
  const controlOnly = new Set(['/abort', '/steer/cancel', '/steer/arm', '/steer/deliver']);
  if (req.method !== 'POST' || controlOnly.has(req.path) || req.user?.provider !== PROVIDER) {
    return next();
  }
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
