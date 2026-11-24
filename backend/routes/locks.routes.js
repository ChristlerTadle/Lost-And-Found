const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');
const { requireCsrf } = require('../middlewares/csrf');

function createLockRoutes({ controllers, guards, frontendOrigin, limit }) {
  const lockHeartbeat = limit('lock_heartbeat');
  const router = express.Router();
  router.post('/acquire', lockHeartbeat, requireCsrf(frontendOrigin), guards.requirePermission('POST', '/locks/acquire'), asyncRoute(controllers.locks.acquire));
  router.post('/renew', lockHeartbeat, requireCsrf(frontendOrigin), guards.requirePermission('POST', '/locks/renew'), asyncRoute(controllers.locks.renew));
  router.post('/release', lockHeartbeat, requireCsrf(frontendOrigin), guards.requirePermission('POST', '/locks/release'), asyncRoute(controllers.locks.release));
  router.use('/', guards.denyUnmapped);
  return router;
}

module.exports = { createLockRoutes };
