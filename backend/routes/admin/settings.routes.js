const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');
const { requireIntegrationSettingsAccess } = require('../../middlewares/integration-settings-access');
const { integrations } = require('../../../src/config/integrations');

function createAdminSettingsRoutes({ controllers, guards, frontendOrigin, integrationSecurity, limit, rateLimits }) {
  const router = express.Router();
  const manage = (method, path) => guards.requirePermission(method, path);
  const unlocked = requireIntegrationSettingsAccess(integrationSecurity);
  const withSettingsGroup = (group, options) => rateLimits.limitTogether([
    'settings_overall',
    options ? { group, ...options } : group,
  ]);
  const settingsRead = withSettingsGroup('settings_read');
  const settingsSave = withSettingsGroup('settings_save');
  const settingsTests = withSettingsGroup('settings_tests');
  const settingsDefault = withSettingsGroup('settings_default');
  const settingsVerify = withSettingsGroup('settings_verify', {
    identifier: (req) => req.params.integrationId,
  });
  const validateIntegrationId = (req, _res, next) => {
    if (Object.hasOwn(integrations, req.params.integrationId)) return next();
    const error = new Error('Integration was not found.');
    error.status = 404;
    return next(error);
  };
  const settingsOverall = limit('settings_overall');
  router.get('/settings/access', settingsRead, manage('GET', '/admin/settings/access'), asyncRoute(controllers.admin.getAdminSettingsAccess));
  router.post('/settings/unlock', settingsOverall, manage('POST', '/admin/settings/unlock'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsUnlock));
  router.post('/settings/lock', settingsOverall, manage('POST', '/admin/settings/lock'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsLock));
  router.get('/settings', settingsRead, manage('GET', '/admin/settings'), unlocked, asyncRoute(controllers.admin.getAdminSettings));
  router.put('/settings', settingsSave, manage('PUT', '/admin/settings'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.putAdminSettings));
  router.post('/settings/code/verify', settingsSave, manage('POST', '/admin/settings/code/verify'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeVerify));
  router.post('/settings/code/resend', settingsSave, manage('POST', '/admin/settings/code/resend'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeResend));
  router.post('/settings/code/cancel', settingsSave, manage('POST', '/admin/settings/code/cancel'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsCodeCancel));
  router.post('/settings/verification-email/test', settingsTests, manage('POST', '/admin/settings/verification-email/test'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsVerificationEmailTest));
  router.post('/settings/:integrationId/verify', validateIntegrationId, settingsVerify, manage('POST', '/admin/settings/:integrationId/verify'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsVerify));
  router.post('/settings/:integrationId/default', settingsDefault, manage('POST', '/admin/settings/:integrationId/default'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsDefault));
  router.post('/settings/:integrationId/restore-default', settingsDefault, manage('POST', '/admin/settings/:integrationId/restore-default'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRestoreDefault));
  router.post('/settings/smtp/test', settingsTests, manage('POST', '/admin/settings/smtp/test'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsSmtpTest));
  router.post('/settings/google-auth/test', settingsTests, manage('POST', '/admin/settings/google-auth/test'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleAuthTest));
  router.post('/settings/recaptcha/test', settingsTests, manage('POST', '/admin/settings/recaptcha/test'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsRecaptchaTest));
  router.post('/settings/google-calendar/test', settingsTests, manage('POST', '/admin/settings/google-calendar/test'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsGoogleCalendarTest));
  router.post('/settings/admin-mfa/test', settingsTests, manage('POST', '/admin/settings/admin-mfa/test'), unlocked, requireCsrf(frontendOrigin), asyncRoute(controllers.admin.postAdminSettingsAdminMfaTest));
  return router;
}

module.exports = { createAdminSettingsRoutes };
