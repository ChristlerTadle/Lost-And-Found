const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminSystemRecordsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/system-records', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminSystemRecords));
  return router;
}

module.exports = { createAdminSystemRecordsRoutes };
