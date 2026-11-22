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

function createApiRouteModules({ services, controllers, guards, frontendOrigin, limit, rateLimits }) {
  return [
    { prefix: '/auth', router: createAuthRoutes({ controllers, frontendOrigin, limit }) },
    { prefix: '', router: createHealthRoutes() },
    { prefix: '/admin/mfa', router: createAdminMfaRoutes({ controllers, guards, frontendOrigin, limit }) },
    { prefix: '/items', router: createItemsRoutes({ controllers, guards, frontendOrigin, limit }) },
    { prefix: '/claims', router: createClaimsRoutes({ controllers, guards, limit }) },
    { prefix: '/profile', router: createProfileRoutes({ controllers, guards, limit }) },
    { prefix: '/notifications', router: createNotificationsRoutes({ controllers, guards, limit }) },
    { prefix: '/staff', router: createStaffRoutes({ controllers, guards, frontendOrigin, limit }) },
    { prefix: '/admin', router: createAdminRolePermissionsRoutes({ controllers, guards, limit }) },
    { prefix: '/admin', router: createAdminDashboardRoutes({ controllers, guards, limit }) },
    {
      prefix: '/admin',
      router: createAdminUsersRoutes({ controllers, guards, limit, auth: services.auth, rateLimits }),
    },
    { prefix: '/admin', router: createAdminSystemRecordsRoutes({ controllers, guards, limit }) },
    { prefix: '/admin', router: createAdminItemsRoutes({ controllers, guards, frontendOrigin, limit }) },
    { prefix: '/admin', router: createAdminClaimsRoutes({ controllers, guards, limit }) },
    {
      prefix: '/admin',
      router: createAdminSettingsRoutes({
        controllers,
        guards,
        frontendOrigin,
        integrationSecurity: services.integrationSecurity,
        limit,
        rateLimits,
      }),
    },
  ];
}

function createApiRouter({ services, frontendOrigin }) {
  const router = express.Router();
  const rateLimits = services.rateLimits || createRateLimitService({
    database: undefined,
    audit: services.audit,
    secret: config.sessionSecret,
    config: config.rateLimits,
    controls: config.rateLimitControls,
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
      rateLimitConfig: config,
    }),
  };

  const routeModules = createApiRouteModules({
    services,
    controllers,
    guards,
    frontendOrigin,
    limit,
    rateLimits,
  });
  const [authModule, ...protectedModules] = routeModules;
  router.use(authModule.prefix, authModule.router);
  router.use(createAdminMfaSessionGuard(services.adminMfa));
  for (const { prefix, router: moduleRouter } of protectedModules) {
    router.use(prefix || '/', moduleRouter);
  }
  router.use(guards.denyUnmapped);

  return router;
}

module.exports = { createApiRouter, createApiRouteModules };
