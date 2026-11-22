const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminSystemRecordsRoutes({ controllers, guards, limit }) {
  const router = express.Router();
  router.get('/system-records', limit('admin_system_records'), guards.requirePermission('GET', '/admin/system-records'), asyncRoute(controllers.admin.getAdminSystemRecords));
  return router;
}

module.exports = { createAdminSystemRecordsRoutes };
