const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminRolePermissionsRoutes({ controllers, guards, limit }) {
  const router = express.Router();
  router.get('/role-permissions', limit('admin_reads'), guards.requirePermission('GET', '/admin/role-permissions'), asyncRoute(controllers.admin.getAdminRolePermissions));
  router.put('/role-permissions/:role', limit('role_permission_write'), guards.requirePermission('PUT', '/admin/role-permissions/:role'), asyncRoute(controllers.admin.putAdminRolePermissions));
  return router;
}

module.exports = { createAdminRolePermissionsRoutes };
