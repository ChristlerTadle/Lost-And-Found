const { asyncRoute } = require('./async-route');
const { PERMISSIONS_BY_ROLE, ROLE_PERMISSION_ROUTE_MAP, resolvePermissionKeys } = require('../config/role-permissions');
const { requireUser, optionalUser } = require('./session-auth');

function createRolePermissionGuard({ auth, rolePermissions, items }) {
  const requirePermission = (method, path) => asyncRoute(async (req, _res, next) => {
    req.auditProtectedRoute = true;
    req.auditRoute = path;
    req.auditMethod = method;
    const mapping = ROLE_PERMISSION_ROUTE_MAP.find((entry) => entry.method === method && entry.path === path);
    if (!mapping) return deny(req, null);

    const user = req.user || await requireUser(req);
    req.user = user;
    if (!(user.role_name === 'admin' && mapping.allowAdmin)
      && !mapping.roles.includes(user.role_name)) auth.requireRole(user, mapping.roles);

    const configuredPermission = await resolvePermissionKeys(mapping.permission, req, items);
    const anyOfPermissions = configuredPermission && Array.isArray(configuredPermission.anyOf)
      ? configuredPermission.anyOf
      : null;
    const requiredPermissions = Array.isArray(configuredPermission)
      ? configuredPermission
      : typeof configuredPermission === 'string' ? [configuredPermission] : [];
    if (!requiredPermissions.length && !anyOfPermissions?.length) return deny(req, null);

    const enabled = typeof rolePermissions.findEffectivePermissions === 'function'
      ? await rolePermissions.findEffectivePermissions(user.id, user.role_name)
      : user.role_name === 'admin'
        ? PERMISSIONS_BY_ROLE.admin.map(({ key }) => key)
        : await rolePermissions.findRolePermissions(user.role_name);
    req.rolePermissions = enabled;
    const missing = requiredPermissions.find((permission) => !enabled.includes(permission));
    const missingAnyOf = anyOfPermissions?.length
      && !anyOfPermissions.some((permission) => enabled.includes(permission));
    if (missing || missingAnyOf) {
      req.auditRequiredPermission = missing || anyOfPermissions;
      const error = new Error('This feature is currently disabled by the administrator.');
      error.status = 403;
      throw error;
    }

    req.auditRequiredPermission = anyOfPermissions
      ? anyOfPermissions
      : requiredPermissions.length === 1 ? requiredPermissions[0] : requiredPermissions;
    next();
  });

  const denyUnmapped = asyncRoute(async (req, _res, next) => {
    req.auditProtectedRoute = true;
    const normalizedUrl = req.originalUrl.split('?')[0]
      .replace(/^\/api\/v1/, '')
      .replace(/^\/api/, '');
    req.auditRoute = normalizedUrl || req.path;
    req.auditMethod = req.method;
    req.auditRequiredPermission = null;
    const user = await optionalUser(req);
    if (/^\/(staff|locks|admin|items|claims|profile|notifications|user)(\/|$)/.test(normalizedUrl)) {
      if (!user) {
        const error = new Error('Sign in is required.');
        error.status = 401;
        throw error;
      }
      return deny(req, null);
    }
    const error = new Error('API endpoint not found.');
    error.status = 404;
    throw error;
  });

  return { requirePermission, denyUnmapped };
}

function deny(req, permission) {
  req.auditRequiredPermission = permission;
  const error = new Error('This route is not assigned a permission and is denied by default.');
  error.status = 403;
  throw error;
}

module.exports = { createRolePermissionGuard };
