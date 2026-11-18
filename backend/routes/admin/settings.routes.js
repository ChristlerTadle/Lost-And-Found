const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');
const { requireIntegrationSettingsAccess } = require('../../middlewares/integration-settings-access');
const { createIntegrationRouteLimit } = require('../../middlewares/integration-route-limits');
const config = require('../../../src/config');

function createAdminSettingsRoutes({ controllers, guards, frontendOrigin, integrationSecurity }) {
  const router = express.Router();
  const admin = guards.requireRole(['admin']);
  const unlocked = requireIntegrationSettingsAccess(integrationSecurity);
  const limits = config.integrationRouteLimits;
  const overall = createIntegrationRouteLimit({ limit: limits.adminSettingsLimit, windowMs: limits.adminSettingsWindowMs, overall: true });
  const saveLimit = createIntegrationRouteLimit({
    limit: limits.saveValidationLimit,
    windowMs: limits.saveValidationWindowMs,
    bucketKey: 'save-and-validate',
  });
  const testLimit = createIntegrationRouteLimit({
    limit: limits.testLimit,
    windowMs: limits.testWindowMs,
    bucketKey: 'test-connection',
  });
  const restoreLimit = createIntegrationRouteLimit({
    limit: limits.restoreLimit,
    windowMs: limits.restoreWindowMs,
    bucketKey: 'restore-and-set-default',
  });
  router.get('/settings/access', admin, asyncRoute(controllers.admin.getAdminSettingsAccess));
  router.post('/settings/unlock', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsUnlock));
  router.post('/settings/lock', admin, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsLock));
  router.use('/settings', admin, unlocked, overall);
  router.get('/settings', admin, unlocked, asyncRoute(controllers.admin.getAdminSettings));
  router.put('/settings', admin, unlocked, saveLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.putAdminSettings));
  router.post('/settings/code/verify', admin, unlocked, saveLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeVerify));
  router.post('/settings/code/resend', admin, unlocked, saveLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeResend));
  router.post('/settings/code/cancel', admin, unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeCancel));
  router.post('/settings/:integrationId/default', admin, unlocked, restoreLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsDefault));
  router.post('/settings/:integrationId/restore-default', admin, unlocked, restoreLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRestoreDefault));
  router.post('/settings/smtp/test', admin, unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsSmtpTest));
  router.post('/settings/google-auth/test', admin, unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleAuthTest));
  router.post('/settings/recaptcha/test', admin, unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRecaptchaTest));
  router.post('/settings/google-calendar/test', admin, unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleCalendarTest));
  router.post('/settings/admin-mfa/test', admin, unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsAdminMfaTest));
  return router;
}

module.exports = { createAdminSettingsRoutes };
