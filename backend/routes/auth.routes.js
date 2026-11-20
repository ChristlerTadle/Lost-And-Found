const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');
const { requireCsrf } = require('../middlewares/csrf');

function createAuthRoutes({
  controllers,
  frontendOrigin,
  limit,
}) {
  if (typeof limit !== 'function') throw new TypeError('A rate-limit factory is required for auth routes.');
  const router = express.Router();
  router.get('/me', asyncRoute(controllers.auth.getAuthMe));
  router.post('/register', limit('register'), asyncRoute(controllers.auth.postAuthRegister));
  router.post('/login', limit('login'), asyncRoute(controllers.auth.postAuthLogin));
  router.post('/mfa/verify', requireCsrf(frontendOrigin), asyncRoute(controllers.auth.postAuthMfaVerify));
  router.post('/logout', asyncRoute(controllers.auth.postAuthLogout));
  router.post('/forgot-password', limit('forgot'), asyncRoute(controllers.auth.postAuthForgotpassword));
  router.get('/reset-password/:token', limit('reset'), asyncRoute(controllers.auth.getAuthResetpasswordByToken));
  router.post('/reset-password', limit('reset'), asyncRoute(controllers.auth.postAuthResetpassword));
  router.get('/google', limit('google_signin'), asyncRoute(controllers.auth.getAuthGoogle));
  router.post('/google', limit('google_signin'), asyncRoute(controllers.auth.postAuthGoogle));
  router.get('/google/callback', limit('google_signin'), asyncRoute(controllers.auth.getAuthGoogleCallback));
  return router;
}

module.exports = { createAuthRoutes };
