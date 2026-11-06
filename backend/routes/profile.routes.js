const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createProfileRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/', guards.requirePermission('GET', '/profile'), asyncRoute(controllers.profile.getProfile));
  router.patch('/', guards.requirePermission('PATCH', '/profile'), asyncRoute(controllers.profile.patchProfile));
  return router;
}

module.exports = { createProfileRoutes };
