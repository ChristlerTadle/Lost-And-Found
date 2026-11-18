const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');

function createAdminItemsRoutes({ controllers, guards, frontendOrigin }) {
  const router = express.Router();
  router.get('/items', guards.requirePermission('GET', '/admin/items'), asyncRoute(controllers.admin.getAdminItems));
  router.get('/items/:id', guards.requirePermission('GET', '/admin/items/:id'), asyncRoute(controllers.admin.getAdminItemsById));
  router.get('/items/:id/image', guards.requirePermission('GET', '/admin/items/:id/image'), asyncRoute(controllers.admin.getAdminItemsByIdImage));
  router.patch('/items/:id', guards.requirePermission('PATCH', '/admin/items/:id'), asyncRoute(controllers.admin.patchAdminItemsById));
  router.delete('/items/:id', guards.requirePermission('DELETE', '/admin/items/:id'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.deleteAdminItemsById));
  return router;
}

module.exports = { createAdminItemsRoutes };
