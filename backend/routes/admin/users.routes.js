const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminUsersRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/users', guards.requirePermission('GET', '/admin/users'), asyncRoute(controllers.admin.getAdminUsers));
  router.post('/users', guards.requirePermission('POST', '/admin/users'), asyncRoute(controllers.admin.postAdminUsers));
  router.patch('/users/:id', guards.requirePermission('PATCH', '/admin/users/:id'), asyncRoute(controllers.admin.patchAdminUsersById));
  router.get('/users/:id/permissions', guards.requirePermission('GET', '/admin/users/:id/permissions'), asyncRoute(controllers.admin.getAdminUserPermissions));
  router.put('/users/:id/permissions', guards.requirePermission('PUT', '/admin/users/:id/permissions'), asyncRoute(controllers.admin.putAdminUserPermissions));
  router.delete('/users/:id/permissions', guards.requirePermission('DELETE', '/admin/users/:id/permissions'), asyncRoute(controllers.admin.resetAdminUserPermissions));
  return router;
}

module.exports = { createAdminUsersRoutes };
