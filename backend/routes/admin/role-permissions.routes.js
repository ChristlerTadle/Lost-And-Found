const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminRolePermissionsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/role-permissions', guards.requirePermission('GET', '/admin/role-permissions'), asyncRoute(controllers.admin.getAdminRolePermissions));
  router.put('/role-permissions/:role', guards.requirePermission('PUT', '/admin/role-permissions/:role'), asyncRoute(controllers.admin.putAdminRolePermissions));
  return router;
}

module.exports = { createAdminRolePermissionsRoutes };
