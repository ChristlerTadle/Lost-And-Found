const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');
const { requireCsrf } = require('../middlewares/csrf');

function createStaffRoutes({ controllers, guards, frontendOrigin, limit }) {
  const reads = limit ? limit('staff_reads') : (_req, _res, next) => next();
  const images = limit ? limit('staff_item_images') : (_req, _res, next) => next();
  const writes = limit ? limit('staff_writes') : (_req, _res, next) => next();
  const calendarRetry = limit ? limit('staff_calendar_retry') : (_req, _res, next) => next();
  const router = express.Router();
  router.get('/dashboard', reads, guards.requirePermission('GET', '/staff/dashboard'), asyncRoute(controllers.staff.getStaffDashboard));
  router.get('/records', reads, guards.requirePermission('GET', '/staff/records'), asyncRoute(controllers.staff.getStaffRecords));
  router.get('/returned-items', reads, guards.requirePermission('GET', '/staff/returned-items'), asyncRoute(controllers.staff.getStaffReturneditems));
  router.get('/items', reads, guards.requirePermission('GET', '/staff/items'), asyncRoute(controllers.staff.getStaffItems));
  router.get('/items/:id', reads, guards.requirePermission('GET', '/staff/items/:id'), asyncRoute(controllers.staff.getStaffItemsById));
  router.get('/items/:id/image', images, guards.requirePermission('GET', '/staff/items/:id/image'), asyncRoute(controllers.staff.getStaffItemsByIdImage));
  router.patch('/items/:id/status', writes, guards.requirePermission('PATCH', '/staff/items/:id/status'), asyncRoute(controllers.staff.patchStaffItemsByIdStatus));
  router.post('/items/:id/verify', writes, guards.requirePermission('POST', '/staff/items/:id/verify'), asyncRoute(controllers.staff.postStaffItemsByIdVerify));
  router.get('/claims', reads, guards.requirePermission('GET', '/staff/claims'), asyncRoute(controllers.staff.getStaffClaims));
  router.get('/claims/:id', reads, guards.requirePermission('GET', '/staff/claims/:id'), asyncRoute(controllers.staff.getStaffClaimsById));
  router.patch('/claims/:id', writes, requireCsrf(frontendOrigin), guards.requirePermission('PATCH', '/staff/claims/:id'), asyncRoute(controllers.staff.patchStaffClaimsById));
  router.patch('/claims/:id/pickup', writes, requireCsrf(frontendOrigin), guards.requirePermission('PATCH', '/staff/claims/:id/pickup'), asyncRoute(controllers.staff.patchStaffClaimsByIdPickup));
  router.post('/claims/:id/calendar-sync', calendarRetry, requireCsrf(frontendOrigin), guards.requirePermission('POST', '/staff/claims/:id/calendar-sync'), asyncRoute(controllers.staff.postStaffClaimsByIdCalendarSync));
  router.use('/', guards.denyUnmapped);
  return router;
}

module.exports = { createStaffRoutes };
