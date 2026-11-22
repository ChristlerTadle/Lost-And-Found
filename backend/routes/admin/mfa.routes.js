const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');

function createAdminMfaRoutes({ controllers, guards, frontendOrigin, limit }) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', limit('admin_reads'), guards.requirePermission('GET', '/admin/mfa'), asyncRoute(controllers.admin.getAdminMfaStatus));
  const enrollmentLimit = limit('mfa_enrollment');
  router.post('/enrollment/start', enrollmentLimit, guards.requirePermission('POST', '/admin/mfa/enrollment/start'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminMfaEnrollmentStart));
  router.post('/enrollment/confirm', enrollmentLimit, guards.requirePermission('POST', '/admin/mfa/enrollment/confirm'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminMfaEnrollmentConfirm));
  router.post('/recovery/regenerate', enrollmentLimit, guards.requirePermission('POST', '/admin/mfa/recovery/regenerate'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminMfaRecoveryRegenerate));
  return router;
}

module.exports = { createAdminMfaRoutes };
