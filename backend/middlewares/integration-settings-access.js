const { asyncRoute } = require('./async-route');
const { saveSession } = require('./session-auth');

function requireIntegrationSettingsAccess(security) {
  return asyncRoute(async (req, _res, next) => {
    const configuration = security.configuration();
    if (!configuration.accessReady || !security.touchSession(req.session, req.user.id)) {
      await saveSession(req);
      const error = new Error(configuration.accessReady
        ? 'Integration Settings are locked. Enter the PIN again.'
        : configuration.accessError);
      error.status = 403;
      return next(error);
    }
    await saveSession(req);
    return next();
  });
}

module.exports = { requireIntegrationSettingsAccess };
