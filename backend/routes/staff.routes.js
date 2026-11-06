const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createStaffRoutes({ controllers, guards }) {
  const router = express.Router();
  router.get('/dashboard', guards.requirePermission('GET', '/staff/dashboard'), asyncRoute(controllers.staff.getStaffDashboard));
  router.get('/records', guards.requirePermission('GET', '/staff/records'), asyncRoute(controllers.staff.getStaffRecords));
  router.get('/returned-items', guards.requirePermission('GET', '/staff/returned-items'), asyncRoute(controllers.staff.getStaffReturneditems));
  router.get('/items', guards.requirePermission('GET', '/staff/items'), asyncRoute(controllers.staff.getStaffItems));
  router.get('/items/:id', guards.requirePermission('GET', '/staff/items/:id'), asyncRoute(controllers.staff.getStaffItemsById));
  router.get('/items/:id/image', guards.requirePermission('GET', '/staff/items/:id/image'), asyncRoute(controllers.staff.getStaffItemsByIdImage));
  router.patch('/items/:id/status', guards.requirePermission('PATCH', '/staff/items/:id/status'), asyncRoute(controllers.staff.patchStaffItemsByIdStatus));
  router.post('/items/:id/verify', guards.requirePermission('POST', '/staff/items/:id/verify'), asyncRoute(controllers.staff.postStaffItemsByIdVerify));
  router.get('/claims', guards.requirePermission('GET', '/staff/claims'), asyncRoute(controllers.staff.getStaffClaims));
  router.get('/claims/:id', guards.requirePermission('GET', '/staff/claims/:id'), asyncRoute(controllers.staff.getStaffClaimsById));
  router.patch('/claims/:id', guards.requirePermission('PATCH', '/staff/claims/:id'), asyncRoute(controllers.staff.patchStaffClaimsById));
  router.use('/', guards.denyUnmapped);
  return router;
}

module.exports = { createStaffRoutes };
