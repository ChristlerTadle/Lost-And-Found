const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminUsersRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/users', guards.requirePermission('GET', '/admin/users'), asyncRoute(controllers.admin.getAdminUsers));
  router.post('/users', guards.requirePermission('POST', '/admin/users'), asyncRoute(controllers.admin.postAdminUsers));
  router.patch('/users/:id', guards.requirePermission('PATCH', '/admin/users/:id'), asyncRoute(controllers.admin.patchAdminUsersById));
  return router;
}

module.exports = { createAdminUsersRoutes };
