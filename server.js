const path = require('node:path');
const { statSync } = require('node:fs');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const config = require('./src/config');
const { connectDatabase, closeDatabase } = require('./src/db');
const { createAuthService } = require('./src/services/auth');
const { createGoogleOAuth } = require('./src/services/google-oauth');
const { createIntegrationSettings } = require('./src/services/integration-settings');
const { createEmailService } = require('./src/services/email');
const { createItemService } = require('./src/services/items');
const { createNotificationService } = require('./src/services/notifications');
const pages = require('./src/routes/pages');
const { categories, locations, departments } = require('./src/data');

const iconPaths = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.02a1.7 1.7 0 0 0-1.77.5l-.06.06h-3.4l-.03-.08a1.7 1.7 0 0 0-1.28-1.18 1.7 1.7 0 0 0-1.37.27l-.07.05-2.94-1.7.02-.08a1.7 1.7 0 0 0-.5-1.77l-.06-.06v-3.4l.08-.03a1.7 1.7 0 0 0 1.18-1.28 1.7 1.7 0 0 0-.27-1.37l-.05-.07 1.7-2.94.08.02a1.7 1.7 0 0 0 1.77-.5l.06-.06h3.4l.03.08a1.7 1.7 0 0 0 1.28 1.18 1.7 1.7 0 0 0 1.37-.27l.07-.05 2.94 1.7-.02.08a1.7 1.7 0 0 0 .5 1.77l.06.06v3.4l-.08.03A1.7 1.7 0 0 0 19.4 15z"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
};

function icon(name, size = 17) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
}

function roleLabel(role) {
  return ({ user: 'Student', staff: 'Staff', admin: 'Administrator' })[role] || 'Member';
}

function formatDate(value, pattern = 'M j, Y') {
  if (!value) return '';
  const dateString = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? new Date(`${dateString}T12:00:00`) : new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  const options = {
    month: pattern.includes('F') ? 'long' : 'short',
    year: 'numeric',
    ...(pattern.includes('j') ? { day: 'numeric' } : {}),
  };
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

async function start() {
  const database = await connectDatabase();
  const app = express();
  const root = __dirname;
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.use(expressLayouts);
  app.set('layout', 'layouts/app');
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use('/assets', express.static(path.join(root, 'assets'), { maxAge: '1h' }));
  app.use('/uploads', express.static(path.join(root, 'uploads'), { maxAge: '1d' }));
  app.use(session({
    name: 'buksu.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: config.mongodbUri, dbName: config.mongodbDatabase, collectionName: 'sessions' }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 14 },
  }));

  const notificationService = createNotificationService(database);
  const googleOAuth = createGoogleOAuth(config.googleOAuth);
  const integrationSettings = createIntegrationSettings(database);
  app.locals.services = {
    auth: createAuthService(database),
    googleOAuth,
    integrationSettings,
    email: createEmailService(config.smtp),
    items: createItemService(database, notificationService),
    notifications: notificationService,
  };
  app.locals.categories = categories;
  app.locals.locations = locations;
  app.locals.departments = departments;
  app.locals.icon = icon;
  app.locals.roleLabel = roleLabel;
  app.locals.formatDate = formatDate;
  app.locals.nav = [
    { key: 'dashboard', label: 'Dashboard', href: '/index.php?page=dashboard', icon: 'home' },
    { key: 'report', label: 'Report Lost Item', href: '/index.php?page=report', icon: 'alert' },
    { key: 'report-found', label: 'Report Found Item', href: '/index.php?page=report&kind=found', icon: 'check' },
    { key: 'items', label: 'Browse Items', href: '/index.php?page=items', icon: 'file' },
    { key: 'reports', label: 'My Reports', href: '/index.php?page=reports', icon: 'file' },
    { key: 'claims', label: 'My Claims', href: '/index.php?page=claims', icon: 'check' },
    { key: 'notifications', label: 'Notifications', href: '/index.php?page=notifications', icon: 'bell' },
    { key: 'staff-dashboard', label: 'Staff Dashboard', href: '/index.php?page=staff-dashboard', icon: 'home' },
    { key: 'staff-records', label: 'View Records', href: '/index.php?page=staff-records', icon: 'file' },
    { key: 'staff-lost-reports', label: 'Lost Item Reports', href: '/index.php?page=staff-lost-reports', icon: 'file' },
    { key: 'staff-found-items', label: 'Found Items', href: '/index.php?page=staff-found-items', icon: 'check' },
    { key: 'staff-stored-items', label: 'Stored Items', href: '/index.php?page=staff-stored-items', icon: 'clipboard' },
    { key: 'staff-returned-items', label: 'Returned Items', href: '/index.php?page=staff-returned-items', icon: 'check' },
    { key: 'staff-claims', label: 'Ownership Claims', href: '/index.php?page=staff-claims', icon: 'clipboard' },
    { key: 'admin-dashboard', label: 'Admin Dashboard', href: '/index.php?page=admin-dashboard', icon: 'shield' },
    { key: 'admin-settings', label: 'Settings', href: '/index.php?page=admin-settings', icon: 'settings' },
    { key: 'profile', label: 'Profile', href: '/index.php?page=profile', icon: 'user' },
  ];

  app.use((req, res, next) => {
    res.locals.assetVersion = [
      statSync(path.join(root, 'assets', 'app.css')).mtimeMs,
      statSync(path.join(root, 'assets', 'app.js')).mtimeMs,
    ].join('-');
    next();
  });

  app.use(async (req, res, next) => {
    try {
      res.locals.googleAuthEnabled = await integrationSettings.isGoogleAuthEnabled(googleOAuth.enabled);
      if (!req.session.user) return next();
      res.locals.unreadNotifications = await notificationService.countUnread(req.session.user.id);
      return next();
    } catch (error) {
      return next(error);
    }
  });

  app.use(pages);
  app.use((req, res) => res.status(404).render('error', {
    layout: req.session.user ? 'layouts/app' : 'layouts/public', title: 'Not Found',
    user: req.session.user || null, active: '', error: 'Page not found.', backHref: '/',
  }));
  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(500).send('The application encountered an unexpected error. Check the server console for details.');
  });

  const server = app.listen(config.port, () => {
    console.log(`BukSU Lost & Found running at http://localhost:${config.port}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Unable to start the application:', error.message);
  process.exitCode = 1;
});
