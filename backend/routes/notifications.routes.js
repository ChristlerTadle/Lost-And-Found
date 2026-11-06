const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createNotificationsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/', guards.requirePermission('GET', '/notifications'), asyncRoute(controllers.notifications.getNotifications));
  router.patch('/read-all', guards.requirePermission('PATCH', '/notifications/read-all'), asyncRoute(controllers.notifications.patchNotificationsReadall));
  router.patch('/:id/read', guards.requirePermission('PATCH', '/notifications/:id/read'), asyncRoute(controllers.notifications.patchNotificationsByIdRead));
  return router;
}

module.exports = { createNotificationsRoutes };
