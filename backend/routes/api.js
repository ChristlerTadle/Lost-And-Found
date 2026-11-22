const express = require('express');
const config = require('../../src/config');
const { createRateLimitService } = require('../../src/services/rate-limits');
const { createAuthGuards, createAdminMfaSessionGuard } = require('../middlewares/session-auth');
const { createRolePermissionGuard } = require('../middlewares/role-permissions');
const { createAuthController } = require('../controllers/auth-controller');
const { createItemsController } = require('../controllers/items-controller');
const { createClaimsController } = require('../controllers/claims-controller');
const { createProfileController } = require('../controllers/profile-controller');
const { createNotificationsController } = require('../controllers/notifications-controller');
const { createStaffController } = require('../controllers/staff-controller');
const { createAdminController } = require('../controllers/admin-controller');
const { createHealthRoutes } = require('./health.routes');
const { createAuthRoutes } = require('./auth.routes');
const { createItemsRoutes } = require('./items.routes');
const { createClaimsRoutes } = require('./claims.routes');
const { createProfileRoutes } = require('./profile.routes');
const { createNotificationsRoutes } = require('./notifications.routes');
const { createStaffRoutes } = require('./staff.routes');
const { createAdminDashboardRoutes } = require('./admin/dashboard.routes');
const { createAdminUsersRoutes } = require('./admin/users.routes');
const { createAdminItemsRoutes } = require('./admin/items.routes');
const { createAdminClaimsRoutes } = require('./admin/claims.routes');
const { createAdminSettingsRoutes } = require('./admin/settings.routes');
const { createAdminMfaRoutes } = require('./admin/mfa.routes');
const { createAdminSystemRecordsRoutes } = require('./admin/system-records.routes');
const { createAdminRolePermissionsRoutes } = require('./admin/role-permissions.routes');

function createApiRouter({ services, frontendOrigin }) {
  const router = express.Router();
  const rateLimits = services.rateLimits || createRateLimitService({
    database: undefined,
    audit: services.audit,
    secret: config.sessionSecret,
    config: config.rateLimits,
  });
  const limit = rateLimits.limit;
  const { authenticated, requireRole } = createAuthGuards(services.auth);
  const roleGuard = createRolePermissionGuard({
    auth: services.auth,
    rolePermissions: services.rolePermissions,
    roleChange: services.roleChange,
    items: services.items,
  });
  const guards = {
    authenticated,
    requireRole,
    requirePermission: roleGuard.requirePermission,
    denyUnmapped: roleGuard.denyUnmapped,
  };
  const controllers = {
    auth: createAuthController({
      auth: services.auth,
      rolePermissions: services.rolePermissions,
      email: services.email,
      googleOAuth: services.googleOAuth,
      recaptcha: services.recaptcha,
      integrationSettings: services.integrationSettings,
      adminMfa: services.adminMfa,
      notifications: services.notifications,
      frontendOrigin,
      audit: services.audit,
      callIntegration: services.callIntegration,
    }),
    items: createItemsController({
      items: services.items,
      googleCalendar: services.googleCalendar,
    }),
    claims: createClaimsController({ items: services.items, googleCalendar: services.googleCalendar }),
    profile: createProfileController({ auth: services.auth, items: services.items }),
    notifications: createNotificationsController({ notifications: services.notifications }),
    staff: createStaffController({
      items: services.items,
      audit: services.audit,
      googleCalendar: services.googleCalendar,
    }),
    admin: createAdminController({
      auth: services.auth,
      items: services.items,
      rolePermissions: services.rolePermissions,
      roleChange: services.roleChange,
      notifications: services.notifications,
      integrationSettings: services.integrationSettings,
      integrationSecurity: services.integrationSecurity,
      adminMfa: services.adminMfa,
      googleOAuth: services.googleOAuth,
      recaptcha: services.recaptcha,
      googleCalendar: services.googleCalendar,
      email: services.email,
      callIntegration: services.callIntegration,
      audit: services.audit,
      frontendOrigin,
    }),
  };

  router.use(createAdminMfaSessionGuard(services.adminMfa));
  router.use('/', createHealthRoutes());
  router.use('/auth', createAuthRoutes({ controllers, frontendOrigin }));
  router.use('/admin/mfa', createAdminMfaRoutes({ controllers, guards, frontendOrigin, limit }));
  router.use('/items', createItemsRoutes({ controllers, guards, frontendOrigin, limit }));
  router.use('/claims', createClaimsRoutes({ controllers, guards, limit }));
  router.use('/profile', createProfileRoutes({ controllers, guards, limit }));
  router.use('/notifications', createNotificationsRoutes({ controllers, guards, limit }));
  router.use('/staff', createStaffRoutes({ controllers, guards, frontendOrigin, limit }));
  router.use('/admin', createAdminRolePermissionsRoutes({ controllers, guards, limit }));
  router.use('/admin', createAdminDashboardRoutes({ controllers, guards, limit }));
  router.use('/admin', createAdminUsersRoutes({ controllers, guards, limit, auth: services.auth, rateLimits }));
  router.use('/admin', createAdminSystemRecordsRoutes({ controllers, guards, limit }));
  router.use('/admin', createAdminItemsRoutes({ controllers, guards, frontendOrigin, limit }));
  router.use('/admin', createAdminClaimsRoutes({ controllers, guards, limit }));
  router.use('/admin', createAdminSettingsRoutes({
    controllers,
    guards,
    frontendOrigin,
    integrationSecurity: services.integrationSecurity,
    limit,
    rateLimits,
  }));
  router.use(guards.denyUnmapped);

  return router;
}

module.exports = { createApiRouter };
