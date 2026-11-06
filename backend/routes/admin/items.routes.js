const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');

function createAdminItemsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/items', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminItems));
  router.get('/items/:id', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminItemsById));
  router.get('/items/:id/image', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminItemsByIdImage));
  router.patch('/items/:id', guards.requireRole(['admin']), asyncRoute(controllers.admin.patchAdminItemsById));
  router.delete('/items/:id', guards.requireRole(['admin']), asyncRoute(controllers.admin.deleteAdminItemsById));
  return router;
}

module.exports = { createAdminItemsRoutes };
