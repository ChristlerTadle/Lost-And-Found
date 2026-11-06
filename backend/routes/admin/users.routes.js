const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminUsersRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/users', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminUsers));
  router.post('/users', guards.requireRole(['admin']), asyncRoute(controllers.admin.postAdminUsers));
  router.patch('/users/:id', guards.requireRole(['admin']), asyncRoute(controllers.admin.patchAdminUsersById));
  return router;
}

module.exports = { createAdminUsersRoutes };
