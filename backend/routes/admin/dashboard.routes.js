const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminDashboardRoutes({ controllers, guards, limit }) {
  const router = express.Router();
  router.get('/dashboard', limit('admin_reads'), guards.requirePermission('GET', '/admin/dashboard'), asyncRoute(controllers.admin.getAdminDashboard));
  return router;
}

module.exports = { createAdminDashboardRoutes };
