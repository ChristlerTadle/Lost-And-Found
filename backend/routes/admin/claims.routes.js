const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminClaimsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/claims', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminClaims));
  router.get('/inventory', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminInventory));
  return router;
}

module.exports = { createAdminClaimsRoutes };
