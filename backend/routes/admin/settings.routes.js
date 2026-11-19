const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');
const { requireIntegrationSettingsAccess } = require('../../middlewares/integration-settings-access');
const { createIntegrationRouteLimit } = require('../../middlewares/integration-route-limits');
const config = require('../../../src/config');

function createAdminSettingsRoutes({ controllers, guards, frontendOrigin, integrationSecurity }) {
  const router = express.Router();
  const manage = (method, path) => guards.requirePermission(method, path);
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
  const verificationLimit = createIntegrationRouteLimit({
    limit: limits.testLimit,
    windowMs: limits.testWindowMs,
    bucketKey: (req) => `verification:${req.params.integrationId}`,
  });
  const restoreLimit = createIntegrationRouteLimit({
    limit: limits.restoreLimit,
    windowMs: limits.restoreWindowMs,
    bucketKey: 'restore-and-set-default',
  });
  router.get('/settings/access', manage('GET', '/admin/settings/access'), asyncRoute(controllers.admin.getAdminSettingsAccess));
  router.post('/settings/unlock', manage('POST', '/admin/settings/unlock'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsUnlock));
  router.post('/settings/lock', manage('POST', '/admin/settings/lock'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsLock));
  router.get('/settings', manage('GET', '/admin/settings'), unlocked, asyncRoute(controllers.admin.getAdminSettings));
  router.put('/settings', manage('PUT', '/admin/settings'), unlocked, saveLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.putAdminSettings));
  router.post('/settings/code/verify', manage('POST', '/admin/settings/code/verify'), unlocked, saveLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeVerify));
  router.post('/settings/code/resend', manage('POST', '/admin/settings/code/resend'), unlocked, saveLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeResend));
  router.post('/settings/code/cancel', manage('POST', '/admin/settings/code/cancel'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeCancel));
  router.post('/settings/:integrationId/verify', manage('POST', '/admin/settings/:integrationId/verify'), unlocked, verificationLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsVerify));
  router.post('/settings/:integrationId/default', manage('POST', '/admin/settings/:integrationId/default'), unlocked, restoreLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsDefault));
  router.post('/settings/:integrationId/restore-default', manage('POST', '/admin/settings/:integrationId/restore-default'), unlocked, restoreLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRestoreDefault));
  router.post('/settings/smtp/test', manage('POST', '/admin/settings/smtp/test'), unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsSmtpTest));
  router.post('/settings/google-auth/test', manage('POST', '/admin/settings/google-auth/test'), unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleAuthTest));
  router.post('/settings/recaptcha/test', manage('POST', '/admin/settings/recaptcha/test'), unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRecaptchaTest));
  router.post('/settings/google-calendar/test', manage('POST', '/admin/settings/google-calendar/test'), unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleCalendarTest));
  router.post('/settings/admin-mfa/test', manage('POST', '/admin/settings/admin-mfa/test'), unlocked, testLimit, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsAdminMfaTest));
  return router;
}

module.exports = { createAdminSettingsRoutes };
