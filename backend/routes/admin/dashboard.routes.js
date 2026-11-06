const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminDashboardRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/dashboard', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminDashboard));
  return router;
}

module.exports = { createAdminDashboardRoutes };
