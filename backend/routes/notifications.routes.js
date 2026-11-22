const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createNotificationsRoutes({ controllers, guards, limit }) {
  const notificationRead = limit ? limit('notification_read') : (_req, _res, next) => next();
  const notificationWrite = limit ? limit('notification_write') : (_req, _res, next) => next();
  const router = express.Router();
  router.get('/', notificationRead, guards.requirePermission('GET', '/notifications'), asyncRoute(controllers.notifications.getNotifications));
  router.patch('/read-all', notificationWrite, guards.requirePermission('PATCH', '/notifications/read-all'), asyncRoute(controllers.notifications.patchNotificationsReadall));
  router.patch('/:id/read', notificationWrite, guards.requirePermission('PATCH', '/notifications/:id/read'), asyncRoute(controllers.notifications.patchNotificationsByIdRead));
  return router;
}

module.exports = { createNotificationsRoutes };
