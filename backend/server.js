const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const config = require('../src/config');
const { connectDatabase, closeDatabase, getMongoClient } = require('../src/db');
const { createAuthService } = require('../src/services/auth');
const { createGoogleOAuth } = require('../src/services/google-oauth');
const { createIntegrationSettings } = require('../src/services/integration-settings');
const { createRecaptcha } = require('../src/services/recaptcha');
const { createEmailService } = require('../src/services/email');
const { createItemService } = require('../src/services/items');
const { createNotificationService } = require('../src/services/notifications');
const { createRolePermissionService } = require('../src/services/role-permissions');
const { createAuditLogService } = require('../src/services/audit-log');
const { parseEncryptionKey } = require('../src/services/integration-settings');
const { createApiRouter } = require('./routes/api');

const port = Number(process.env.API_PORT || 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

async function start() {
  parseEncryptionKey(config.integrationEncryptionKey);
  const database = await connectDatabase();
  const notificationService = createNotificationService(database);
  const integrationSettings = createIntegrationSettings(database, {
    encryptionKey: config.integrationEncryptionKey,
  });
  await integrationSettings.validateStoredSecrets();
  const services = {
    auth: createAuthService(database),
    googleOAuth: createGoogleOAuth(integrationSettings.getIntegration),
    recaptcha: createRecaptcha(integrationSettings.getIntegration),
    integrationSettings,
    email: createEmailService(integrationSettings.getIntegration),
    items: createItemService(database, notificationService),
    notifications: notificationService,
    rolePermissions: createRolePermissionService(database),
    audit: createAuditLogService(database, getMongoClient()),
  };
  const app = express();
  app.locals.services = services;

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
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(origin === frontendOrigin ? 204 : 403);
    return next();
  });
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
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const uploadError = error instanceof multer.MulterError;
    const status = uploadError ? 400 : Number.isInteger(error.status) ? error.status
      : error instanceof Error && error.constructor === Error ? 400 : 500;
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
    return res.status(status).json({
      error: status === 500 ? 'The API encountered an unexpected error.' : message,
    });
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
