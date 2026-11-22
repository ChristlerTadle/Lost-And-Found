const express = require('express');
const { asyncRoute } = require('../../middlewares/async-route');
const { requireCsrf } = require('../../middlewares/csrf');

function createAdminItemsRoutes({ controllers, guards, frontendOrigin, limit }) {
  const router = express.Router();
  router.get('/items', limit('admin_reads'), guards.requirePermission('GET', '/admin/items'), asyncRoute(controllers.admin.getAdminItems));
  router.get('/items/:id', limit('admin_reads'), guards.requirePermission('GET', '/admin/items/:id'), asyncRoute(controllers.admin.getAdminItemsById));
  router.get('/items/:id/image', limit('admin_item_images'), guards.requirePermission('GET', '/admin/items/:id/image'), asyncRoute(controllers.admin.getAdminItemsByIdImage));
  router.patch('/items/:id', limit('admin_item_write'), guards.requirePermission('PATCH', '/admin/items/:id'), asyncRoute(controllers.admin.patchAdminItemsById));
  router.delete('/items/:id', limit('admin_item_write'), guards.requirePermission('DELETE', '/admin/items/:id'), requireCsrf(frontendOrigin), asyncRoute(controllers.admin.deleteAdminItemsById));
  return router;
}

module.exports = { createAdminItemsRoutes };
