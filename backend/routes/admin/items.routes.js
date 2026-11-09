const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');

function createAdminItemsRoutes({ controllers, guards, frontendOrigin }) {
  const router = express.Router();
  router.get('/items', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminItems));
  router.get('/items/:id', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminItemsById));
  router.get('/items/:id/image', guards.requireRole(['admin']), asyncRoute(controllers.admin.getAdminItemsByIdImage));
  router.patch('/items/:id', guards.requireRole(['admin']), asyncRoute(controllers.admin.patchAdminItemsById));
  router.delete('/items/:id', guards.requireRole(['admin']), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.deleteAdminItemsById));
  return router;
}

module.exports = { createAdminItemsRoutes };
