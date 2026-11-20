const { asyncRoute } = require('./async-route');

async function optionalUser(req) {
  return currentUser(req);
}

async function currentUser(req) {
  if (!req.session.user) return null;
  const user = await req.app.locals.services.auth.findActiveSessionUser(req.session.user.id);
  if (!user) {
    await destroySession(req);
    return null;
  }
  if (req.session.user.role_name && req.session.user.role_name !== user.role_name) {
    await destroySession(req);
    const error = new Error('Your access changed. Please sign in again.');
    error.status = 401;
    throw error;
  }
  req.session.user = user;
  return user;
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) {
    const error = new Error('Sign in is required.');
    error.status = 401;
    throw error;
  }
  req.session.user = user;
  return user;
}

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.user = user;
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function createAuthGuards(auth) {
  const authenticated = asyncRoute(async (req, _res, next) => {
    req.user = await requireUser(req);
    next();
  });
  const requireRole = (roles) => asyncRoute(async (req, _res, next) => {
    const user = req.user || await requireUser(req);
    req.user = user;
    auth.requireRole(user, roles);
    next();
  });

  return { authenticated, requireRole };
}

function createAdminMfaSessionGuard(adminMfa) {
  return asyncRoute(async (req, _res, next) => {
    const user = await optionalUser(req);
    if (user?.role_name === 'admin') {
      const access = await adminMfa.getAdminRouteAccess(user, req.session, req.ip);
      if (access.allowed) return next();
      const mfaRoute = req.path === '/admin/mfa' || req.path.startsWith('/admin/mfa/');
      const sessionRoute = req.path === '/auth' || req.path.startsWith('/auth/');
      if (mfaRoute || sessionRoute) return next();
      const messages = {
        setup_required: 'Complete administrator MFA setup before accessing this page.',
        verification_required: 'Administrator MFA verification is required. Sign out and sign in again to verify your account.',
        locked: `Administrator MFA is temporarily locked after failed code attempts. Try again in about ${Math.max(1, Math.ceil(access.retryAfterSeconds / 60))} minute${Math.ceil(access.retryAfterSeconds / 60) === 1 ? '' : 's'}.`,
      };
      const error = new Error(messages[access.reason] || 'Administrator MFA is required before accessing this page.');
      error.status = 403;
      throw error;
    }
    next();
  });
}

module.exports = {
  optionalUser,
  currentUser,
  requireUser,
  startSession,
  saveSession,
  destroySession,
  createAuthGuards,
  createAdminMfaSessionGuard,
};
