const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');

function createAdminMfaRoutes({ controllers, guards, frontendOrigin }) {
  const router = express.Router();
  const admin = guards.requireRole(['admin']);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', admin, asyncRoute(controllers.admin.getAdminMfaStatus));
  router.post('/enrollment/start', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminMfaEnrollmentStart));
  router.post('/enrollment/confirm', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminMfaEnrollmentConfirm));
  router.post('/recovery/regenerate', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminMfaRecoveryRegenerate));
  return router;
}

module.exports = { createAdminMfaRoutes };
