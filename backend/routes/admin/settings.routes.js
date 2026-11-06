const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');

function createAdminSettingsRoutes({ controllers, guards, frontendOrigin }) {
  const router = express.Router();
  router.get('/settings', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminSettings));
  router.put('/settings', guards.requireRole(['admin']), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.putAdminSettings));
  router.post('/settings/smtp/test', guards.requireRole(['admin']), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsSmtpTest));
  return router;
}

module.exports = { createAdminSettingsRoutes };
