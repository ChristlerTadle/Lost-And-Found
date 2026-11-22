const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');

function createClaimsRoutes({ controllers, guards, limit }) {
  const accountRead = limit ? limit('user_reads') : (_req, _res, next) => next();
  const claimSubmit = limit ? limit('claim_submit') : (_req, _res, next) => next();
  const claimItem = limit ? limit('claim_item', {
    identifier: (req) => req.body?.item_id,
  }) : (_req, _res, next) => next();
  const router = express.Router();
  router.get('/mine', accountRead, guards.requirePermission('GET', '/claims/mine'), asyncRoute(controllers.claims.getClaimsMine));
  router.get('/:id/calendar.ics', accountRead, guards.requirePermission('GET', '/claims/:id/calendar.ics'), asyncRoute(controllers.claims.getClaimsCalendarIcs));
  router.get('/available/:id', accountRead, guards.requirePermission('GET', '/claims/available/:id'), asyncRoute(controllers.claims.getClaimsAvailableById));
  router.post('/',
    claimSubmit,
    guards.requirePermission('POST', '/claims'),
    (req, res, next) => {
      const itemId = req.body?.item_id;
      if (typeof itemId !== 'string' || itemId.length < 1 || itemId.length > 128) {
        const error = new Error('A valid item id is required.');
        error.status = 400;
        return next(error);
      }
      return claimItem(req, res, next);
    },
    asyncRoute(controllers.claims.postClaims),
  );
  return router;
}

module.exports = { createClaimsRoutes };
