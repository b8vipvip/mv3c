const express = require('express');
const { uaParser, checkBan, requireJwtAuth, configMiddleware } = require('~/server/middleware');
const router = express.Router();

const { v1 } = require('./v1');
const chatV1 = require('./chatV1');
const v2 = require('./v2');
const chatV2 = require('./chatV2');

router.use(requireJwtAuth);
// Guest access is limited to metered mv3c chat. Other inference routes must not bypass quota.
router.use((req, res, next) => {
  if (req.method === 'POST' && req.user?.provider === 'mv3c-guest' &&
      req.path !== '/v1/chat/abort' && req.path !== '/v2/chat/abort') {
    return res.status(403).json({ code: 'MV3C_GUEST_ROUTE_RESTRICTED',
      message: '游客请使用 mv3c 聊天体验' });
  }
  return next();
});
router.use(checkBan);
router.use(uaParser);
router.use(configMiddleware);
router.use('/v1/', v1);
router.use('/v1/chat', chatV1);
router.use('/v2/', v2);
router.use('/v2/chat', chatV2);

module.exports = router;
