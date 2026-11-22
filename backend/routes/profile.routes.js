const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createProfileRoutes({ controllers, guards, limit }) {
  const accountRead = limit ? limit('user_reads') : (_req, _res, next) => next();
  const profileEdit = limit ? limit('profile_edit') : (_req, _res, next) => next();
  const router = express.Router();
  router.get('/', accountRead, guards.requirePermission('GET', '/profile'), asyncRoute(controllers.profile.getProfile));
  router.patch('/', profileEdit, guards.requirePermission('PATCH', '/profile'), asyncRoute(controllers.profile.patchProfile));
  return router;
}

module.exports = { createProfileRoutes };
