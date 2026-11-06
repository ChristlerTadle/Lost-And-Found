const express = require('express');
const multer = require('multer');
const { asyncRoute } = require('../middlewares/async-route');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function createItemsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/', guards.requirePermission('GET', '/items'), asyncRoute(controllers.items.getItems));
  router.get('/:id/image', guards.requirePermission('GET', '/items/:id/image'), asyncRoute(controllers.items.getItemsByIdImage));
  router.get('/mine', guards.requirePermission('GET', '/items/mine'), asyncRoute(controllers.items.getItemsMine));
  router.get('/mine/:id', guards.requirePermission('GET', '/items/mine/:id'), asyncRoute(controllers.items.getItemsMineById));
  router.post('/', guards.requirePermission('POST', '/items'), upload.single('image'), asyncRoute(controllers.items.postItems));
  router.get('/:id', guards.requirePermission('GET', '/items/:id'), asyncRoute(controllers.items.getItemsById));
  router.put('/:id', guards.requirePermission('PUT', '/items/:id'), upload.single('image'), asyncRoute(controllers.items.putItemsById));
  router.delete('/:id', guards.requirePermission('DELETE', '/items/:id'), asyncRoute(controllers.items.deleteItemsById));
  return router;
}

module.exports = { createItemsRoutes };
