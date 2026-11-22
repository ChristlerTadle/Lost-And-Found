const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminUsersRoutes({ controllers, guards, limit, auth, rateLimits }) {
  const adminUserWrite = limit('admin_user_write');
  const rolePermissionWrite = limit('role_permission_write');
  const roleChangeLimit = rateLimits.limitTogether(['admin_user_write', 'role_permission_write']);
  const editUserLimit = async (req, res, next) => {
    if (['assign_staff', 'revert_staff'].includes(req.body?.action)) {
      return roleChangeLimit(req, res, next);
    }
    if (req.body?.action !== 'edit') return adminUserWrite(req, res, next);
    if (req.body.role_name !== undefined
      && (typeof req.body.role_name !== 'string'
        || !['user', 'staff', 'admin'].includes(req.body.role_name.trim()))) {
      const error = new Error('Choose a valid account role.');
      error.status = 400;
      return next(error);
    }
    if (req.body.role_name === undefined) return adminUserWrite(req, res, next);
    try {
      const accounts = await auth.findAccountsForStaffAssignment();
      const target = accounts.find(({ id }) => id === String(req.params.id));
      if (target && target.role_name !== req.body.role_name.trim()) {
        return roleChangeLimit(req, res, next);
      }
      return adminUserWrite(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
  const router = express.Router();
  router.get('/users', limit('admin_reads'), guards.requirePermission('GET', '/admin/users'), asyncRoute(controllers.admin.getAdminUsers));
  router.post('/users', limit('admin_user_write'), guards.requirePermission('POST', '/admin/users'), asyncRoute(controllers.admin.postAdminUsers));
  router.patch('/users/:id', editUserLimit, guards.requirePermission('PATCH', '/admin/users/:id'), asyncRoute(controllers.admin.patchAdminUsersById));
  router.get('/users/:id/permissions', limit('admin_reads'), guards.requirePermission('GET', '/admin/users/:id/permissions'), asyncRoute(controllers.admin.getAdminUserPermissions));
  router.put('/users/:id/permissions', rolePermissionWrite, guards.requirePermission('PUT', '/admin/users/:id/permissions'), asyncRoute(controllers.admin.putAdminUserPermissions));
  router.delete('/users/:id/permissions', rolePermissionWrite, guards.requirePermission('DELETE', '/admin/users/:id/permissions'), asyncRoute(controllers.admin.resetAdminUserPermissions));
  return router;
}

module.exports = { createAdminUsersRoutes };
