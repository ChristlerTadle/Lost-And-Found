const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');
const { requireIntegrationSettingsAccess } = require('../../middlewares/integration-settings-access');

function createAdminSettingsRoutes({ controllers, guards, frontendOrigin, integrationSecurity }) {
  const router = express.Router();
  const admin = guards.requireRole(['admin']);
  const unlocked = requireIntegrationSettingsAccess(integrationSecurity);
  router.get('/settings/access', admin, asyncRoute(controllers.admin.getAdminSettingsAccess));
  router.post('/settings/unlock', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsUnlock));
  router.post('/settings/lock', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsLock));
  router.get('/settings', admin, unlocked, asyncRoute(controllers.admin.getAdminSettings));
  router.put('/settings', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.putAdminSettings));
  router.post('/settings/code/verify', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeVerify));
  router.post('/settings/code/resend', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeResend));
  router.post('/settings/code/cancel', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeCancel));
  router.post('/settings/:integrationId/default', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsDefault));
  router.post('/settings/:integrationId/restore-default', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRestoreDefault));
  router.post('/settings/smtp/test', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsSmtpTest));
  router.post('/settings/google-calendar/test', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleCalendarTest));
  return router;
}

module.exports = { createAdminSettingsRoutes };
