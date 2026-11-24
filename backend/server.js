const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const config = require('../src/config');
const { connectDatabase, closeDatabase, getMongoClient } = require('../src/db');
const { createAuthService } = require('../src/services/auth');
const { createGoogleOAuth } = require('../src/services/google-oauth');
const { createIntegrationSettings } = require('../src/services/integration-settings');
const { createAdminMfa } = require('../src/services/admin-mfa');
const { createIntegrationCaller } = require('../src/services/integration-calls');
const { createIntegrationSecurity } = require('../src/services/integration-security');
const { createRecaptcha } = require('../src/services/recaptcha');
const { createEmailService } = require('../src/services/email');
const { createGoogleCalendar } = require('../src/services/google-calendar');
const { createItemService } = require('../src/services/items');
const { createNotificationService } = require('../src/services/notifications');
const { createRolePermissionService } = require('../src/services/role-permissions');
const { createRoleChangeService } = require('../src/services/role-change');
const { createAuditLogService } = require('../src/services/audit-log');
const { createRateLimitService } = require('../src/services/rate-limits');
const { LockConflictError, createLockManager } = require('../src/services/locks');
const { parseEncryptionKey } = require('../src/services/integration-settings');
const { createApiRouter } = require('./routes/api');

const port = Number(process.env.API_PORT || 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

async function start() {
  if (config.locking.isProduction && config.locking.demoHoldMs > 0) {
    console.warn('WARNING: LOCK_DEMO_HOLD_MS is ignored in production.');
  }
  const integrationEncryptionKey = parseEncryptionKey(config.integrationEncryptionKey);
  for (const warning of [
    config.integrationSettingsEmailError,
    ...config.integrationBootstrapSmtpErrors,
  ].filter(Boolean)) {
    console.warn(`WARNING: ${warning}.`);
  }
  if (config.adminMfaDisabled) {
    console.warn('WARNING: ADMIN_MFA_DISABLED=true; admin MFA login enforcement is bypassed.');
  }
  if (config.adminMfaRateLimitDisabled) {
    console.warn('WARNING: ADMIN_MFA_RATE_LIMIT_DISABLED=true; admin MFA attempt limits are bypassed for testing.');
  } else if (config.adminMfaRateLimitBypassRequested) {
    console.warn('WARNING: ADMIN_MFA_RATE_LIMIT_DISABLED is ignored in production; admin MFA attempt limits remain enabled.');
  }
  const database = await connectDatabase();
  const notificationService = createNotificationService(database);
  const integrationSettings = createIntegrationSettings(database, {
    encryptionKey: config.integrationEncryptionKey,
  });
  const integrationSecurity = createIntegrationSecurity(database, {
    pin: config.integrationSettingsPin,
    email: config.integrationSettingsEmail,
    emailError: config.integrationSettingsEmailError,
    smtp: config.integrationBootstrapSmtp,
    smtpErrors: config.integrationBootstrapSmtpErrors,
    hashKey: integrationEncryptionKey,
    codeRequestLimit: config.integrationCodeRequestLimit,
    codeRequestWindowMs: config.integrationCodeRequestWindowMs,
    codeResendMs: config.integrationCodeResendMs,
    ...config.rateLimitControls.integrationSettings,
  });
  const audit = createAuditLogService(database, getMongoClient());
  const locks = createLockManager(database, { audit, config: config.locking });
  await locks.initialize();
  const rateLimits = createRateLimitService({
    database,
    audit,
    secret: config.sessionSecret,
    config: config.rateLimits,
    controls: config.rateLimitControls,
  });
  await rateLimits.initialize();
  const callIntegration = createIntegrationCaller({ integrationSettings, audit, rateLimits });
  const adminMfa = createAdminMfa(database, integrationSettings, {
    disabled: config.adminMfaDisabled,
    rateLimitDisabled: config.adminMfaRateLimitDisabled,
    callIntegration,
    ...config.rateLimitControls.adminMfa,
  });
  await integrationSettings.validateStoredSecrets();
  const items = createItemService(database, notificationService);
  const email = createEmailService(integrationSettings.getIntegration, undefined, callIntegration);
  const googleCalendar = createGoogleCalendar({
    integrationSettings,
    items,
    notifications: notificationService,
    email,
    audit,
    callIntegration,
  });
  const rolePermissions = createRolePermissionService(database);
  const services = {
    auth: createAuthService(database),
    googleOAuth: createGoogleOAuth(integrationSettings.getIntegration, callIntegration),
    recaptcha: createRecaptcha(integrationSettings.getIntegration, globalThis.fetch, callIntegration),
    integrationSettings,
    integrationSecurity,
    adminMfa,
    callIntegration,
    email,
    googleCalendar,
    items,
    notifications: notificationService,
    rolePermissions,
    audit,
    rateLimits,
    locks,
  };
  services.roleChange = createRoleChangeService(database, {
    rolePermissions,
    notifications: notificationService,
    audit,
  });
  const app = express();
  app.locals.services = services;

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== frontendOrigin) {
      return res.status(403).json({ error: 'This origin is not allowed to use the API.' });
    }
    if (origin === frontendOrigin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Lock-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(origin === frontendOrigin ? 204 : 403);
    return next();
  });
  app.use('/api', rateLimits.limit('global_api', {
    skip: (req) => req.method === 'POST' && req.path === '/locks/renew',
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(session({
    name: 'buksu.api.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: config.mongodbUri,
      dbName: config.mongodbDatabase,
      collectionName: 'api_sessions',
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }));
  app.use('/api', createApiRouter({ services, frontendOrigin }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use(async (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const lockConflict = error instanceof LockConflictError;
    const lockLost = error.code === 'lock_lost';
    const uploadError = error instanceof multer.MulterError;
    let status = uploadError ? 400 : Number.isInteger(error.status) ? error.status
      : error instanceof Error && error.constructor === Error ? 400 : 500;
    if (typeof req.rateLimitFinalize === 'function') {
      try {
        await req.rateLimitFinalize(status);
      } catch {
        error = new Error('Please try again shortly');
        error.status = 503;
        error.retryAfter = 1;
        status = 503;
      }
    }
    let lockCounterRollbackAttempted = false;
    if ((lockConflict || lockLost) && req.rateLimitConflictRollback) {
      lockCounterRollbackAttempted = true;
      try {
        await req.rateLimitConflictRollback();
      } catch {
        error = new Error('Please try again shortly');
        error.status = 503;
        error.retryAfter = 1;
        status = 503;
      }
    }
    if ((status === 429 || status === 503)
      && req.rateLimitGlobalRollback && !lockCounterRollbackAttempted) {
      await req.rateLimitGlobalRollback();
    }
    if ((status === 429 || status === 503 || ((lockConflict || lockLost) && status === 409))
      && Number.isInteger(error.retryAfter)) {
      res.set('Retry-After', String(error.retryAfter));
    }
    if (status === 500) console.error(error);
    if ((status === 401 || status === 403)
      && (req.auditProtectedRoute || req.originalUrl.startsWith('/api/admin/'))) {
      services.audit.logAction({
        actor_id: req.user?.id || null,
        actor_role: req.user?.role_name || null,
        action: 'access.denied',
        target_type: null,
        target_id: null,
        new_value: {
          route: req.auditRoute || req.path,
          http_method: req.auditMethod || req.method,
          required_permission: req.auditRequiredPermission || null,
        },
        result: 'denied',
        ip_address: req.ip || null,
      }).catch((auditError) => console.error('Unable to write access-denied audit event:', auditError));
    }
    const message = uploadError
      ? error.code === 'LIMIT_FILE_SIZE' ? 'The image must be 5 MB or smaller.' : 'The image upload could not be processed.'
      : error.message;
    const body = {
      error: status === 500 ? 'The API encountered an unexpected error.' : message,
    };
    if (lockConflict) body.code = error.code || 'lock_conflict';
    else if (lockLost) body.code = 'lock_lost';
    else if (error.code === 'state_conflict' && status === 409) body.code = 'state_conflict';
    if (error.lockHolder) body.holder = error.lockHolder;
    if ((lockConflict || lockLost || error.code === 'state_conflict') && Number.isInteger(error.retryAfter)) {
      body.retryAfter = error.retryAfter;
    }
    return res.status(status).json(body);
  });

  const server = app.listen(port, () => {
    console.log(`REST API running at http://localhost:${port}`);
  });
  const shutdown = () => {
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start the REST API:', error.message);
    process.exitCode = 1;
  });
}
