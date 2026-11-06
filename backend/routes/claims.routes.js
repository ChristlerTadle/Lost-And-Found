const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createClaimsRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/mine', guards.requirePermission('GET', '/claims/mine'), asyncRoute(controllers.claims.getClaimsMine));
  router.get('/available/:id', guards.requirePermission('GET', '/claims/available/:id'), asyncRoute(controllers.claims.getClaimsAvailableById));
  router.post('/', guards.requirePermission('POST', '/claims'), asyncRoute(controllers.claims.postClaims));
  return router;
}

module.exports = { createClaimsRoutes };
