const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');
const { requireCsrf } = require('../middlewares/csrf');

function createAuthRoutes({ controllers, frontendOrigin }) {
  const router = express.Router();
  router.get('/me', asyncRoute(controllers.auth.getAuthMe));
  router.post('/register', asyncRoute(controllers.auth.postAuthRegister));
  router.post('/login', asyncRoute(controllers.auth.postAuthLogin));
  router.post('/mfa/verify', requireCsrf(frontendOrigin), asyncRoute(controllers.auth.postAuthMfaVerify));
  router.post('/logout', asyncRoute(controllers.auth.postAuthLogout));
  router.post('/forgot-password', asyncRoute(controllers.auth.postAuthForgotpassword));
  router.get('/reset-password/:token', asyncRoute(controllers.auth.getAuthResetpasswordByToken));
  router.post('/reset-password', asyncRoute(controllers.auth.postAuthResetpassword));
  router.get('/google', asyncRoute(controllers.auth.getAuthGoogle));
  router.post('/google', asyncRoute(controllers.auth.postAuthGoogle));
  router.get('/google/callback', asyncRoute(controllers.auth.getAuthGoogleCallback));
  return router;
}

module.exports = { createAuthRoutes };
