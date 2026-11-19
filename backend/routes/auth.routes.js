const express = require('express');
const { asyncRoute } = require('../middlewares/async-route');
const { requireCsrf } = require('../middlewares/csrf');

function createAuthRoutes({
  controllers,
  frontendOrigin,
  publicAuthLimit = createPublicAuthRateLimit(),
}) {
  const router = express.Router();
  router.get('/me', asyncRoute(controllers.auth.getAuthMe));
  router.post('/register', publicAuthLimit, asyncRoute(controllers.auth.postAuthRegister));
  router.post('/login', publicAuthLimit, asyncRoute(controllers.auth.postAuthLogin));
  router.post('/mfa/verify', requireCsrf(frontendOrigin), asyncRoute(controllers.auth.postAuthMfaVerify));
  router.post('/logout', asyncRoute(controllers.auth.postAuthLogout));
  router.post('/forgot-password', publicAuthLimit, asyncRoute(controllers.auth.postAuthForgotpassword));
  router.get('/reset-password/:token', asyncRoute(controllers.auth.getAuthResetpasswordByToken));
  router.post('/reset-password', asyncRoute(controllers.auth.postAuthResetpassword));
  router.get('/google', asyncRoute(controllers.auth.getAuthGoogle));
  router.post('/google', asyncRoute(controllers.auth.postAuthGoogle));
  router.get('/google/callback', asyncRoute(controllers.auth.getAuthGoogleCallback));
  return router;
}

function createPublicAuthRateLimit({ limit = 20, windowMs = 60 * 1000, now = Date.now } = {}) {
  const requests = new Map();
  return function publicAuthRateLimit(req, res, next) {
    const timestamp = now();
    const ipAddress = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = requests.get(ipAddress);
    if (!entry || timestamp - entry.startedAt >= windowMs) {
      entry = { startedAt: timestamp, count: 0 };
      requests.set(ipAddress, entry);
    }
    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.startedAt + windowMs - timestamp) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Please try again shortly' });
    }
    entry.count += 1;
    if (requests.size > 10_000) {
      for (const [key, value] of requests) {
        if (timestamp - value.startedAt >= windowMs) requests.delete(key);
      }
    }
    return next();
  };
}

module.exports = { createAuthRoutes, createPublicAuthRateLimit };
