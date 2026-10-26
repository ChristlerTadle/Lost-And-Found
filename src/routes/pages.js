const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const config = require('../config');
const { categories } = require('../data');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function requireUser(req, res) {
  if (req.session.user) return req.session.user;
  res.redirect('/index.php?page=login');
  return null;
}

function dashboardPath(user) {
  if (user.role_name === 'staff') return '/index.php?page=staff-dashboard';
  if (user.role_name === 'admin') return '/index.php?page=admin-dashboard';
  return '/index.php?page=dashboard';
}

function setPage(res, title, active, user, extra = {}) {
  return res.render(extra.view, { title, active, user, ...extra });
}

async function resolveNotificationHref(notification, user, itemService) {
  const url = new URL(notification.href, 'http://localhost');
  if (url.origin !== 'http://localhost' || url.hash || url.searchParams.has('highlight')) return notification.href;
  const page = url.searchParams.get('page');
  const itemName = notification.message.match(/"([^"]+)"/)?.[1]?.toLocaleLowerCase();
  if (!itemName) return notification.href;
  const notificationTime = Date.parse(notification.created_at);
  const closest = (records, getDate) => records
    .filter((record) => record.item_name?.toLocaleLowerCase() === itemName)
    .sort((left, right) => {
      const leftDate = Date.parse(getDate(left)) || 0;
      const rightDate = Date.parse(getDate(right)) || 0;
      return Math.abs(leftDate - notificationTime) - Math.abs(rightDate - notificationTime);
    })[0];

  if (page === 'reports' && user.role_name === 'user') {
    const records = await itemService.findForUser(user.id);
    const item = closest(records, (record) => record.updated_at || record.created_at);
    return item ? `/index.php?page=reports&highlight=item-${encodeURIComponent(item.id)}` : notification.href;
  }

  if (page === 'claims' && user.role_name === 'user') {
    const records = await itemService.findClaimsForUser(user.id);
    const desiredStatus = notification.title === 'Claim approved' ? 'approved'
      : notification.title === 'Claim submitted' ? 'pending'
        : notification.title === 'Claim rejected' ? 'rejected' : '';
    const matchingRecords = desiredStatus
      ? records.filter((record) => record.status === desiredStatus)
      : records;
    const claim = closest(matchingRecords, (record) => record.updated_at || record.created_at);
    return claim ? `/index.php?page=claims&highlight=claim-${encodeURIComponent(claim.id)}` : notification.href;
  }

  if (page === 'staff-claims' && user.role_name === 'staff') {
    const records = await itemService.findStaffClaims();
    const claim = closest(records, (record) => record.created_at);
    return claim
      ? `/index.php?page=staff-claim&id=${encodeURIComponent(claim.id)}&highlight=claim-${encodeURIComponent(claim.id)}`
      : notification.href;
  }

  return notification.href;
}

router.get('/', (req, res) => res.render('landing', { layout: 'layouts/public', title: 'Home' }));

router.get('/auth/google', asyncRoute(async (req, res) => {
  const { googleOAuth, integrationSettings } = req.app.locals.services;
  if (!(await integrationSettings.isGoogleAuthEnabled(googleOAuth.enabled))) {
    return res.redirect('/index.php?page=login&google=unavailable');
  }
  if (req.session.user) return res.redirect(dashboardPath(req.session.user));

  const request = await googleOAuth.createAuthorizationRequest();
  req.session.googleOAuth = request;
  return req.session.save((error) => {
    if (error) return res.status(500).send('Unable to start Google sign-in.');
    return res.redirect(request.url);
  });
}));

router.get('/auth/google/callback', asyncRoute(async (req, res) => {
  const { googleOAuth, integrationSettings } = req.app.locals.services;
  if (!(await integrationSettings.isGoogleAuthEnabled(googleOAuth.enabled))) {
    delete req.session.googleOAuth;
    await saveSession(req);
    return res.redirect('/index.php?page=login&google=unavailable');
  }
  if (req.session.user) return res.redirect(dashboardPath(req.session.user));
  const pending = req.session.googleOAuth;
  delete req.session.googleOAuth;
  if (!pending || typeof req.query.state !== 'string' || req.query.state !== pending.state) {
    await saveSession(req);
    return res.redirect('/index.php?page=login&google=failed');
  }
  if (req.query.error || typeof req.query.code !== 'string') {
    await saveSession(req);
    return res.redirect('/index.php?page=login&google=failed');
  }

  try {
    const { auth, googleOAuth } = req.app.locals.services;
    const profile = await googleOAuth.verifyAuthorizationResponse({
      code: req.query.code,
      codeVerifier: pending.codeVerifier,
      nonce: pending.nonce,
    });
    const user = await auth.authenticateGoogle(profile);
    await regenerateSession(req);
    req.session.user = user;
    await saveSession(req);
    return res.redirect(dashboardPath(user));
  } catch (error) {
    console.error('Google sign-in failed:', error);
    return res.redirect('/index.php?page=login&google=failed');
  }
}));

router.get('/index.php', asyncRoute(async (req, res) => {
  const page = String(req.query.page || 'landing');
  if (req.query.logout) {
    return req.session.destroy(() => res.redirect('/'));
  }
  if (page === 'landing') return res.redirect('/');
  if (page === 'login') {
    if (req.session.user) return res.redirect(dashboardPath(req.session.user));
    return res.render('login', {
      layout: 'layouts/public', title: 'Sign In', showRegister: req.query.tab === 'register',
      showForgot: false, showReset: false, error: null,
      message: req.query.disabled ? 'Your account is no longer active. Contact an administrator for help.' : req.query.reset ? 'Your password has been reset. You can now sign in.' : null,
      googleError: req.query.google === 'failed' ? 'Google sign-in could not be completed. Please try again.'
        : req.query.google === 'unavailable' ? 'Google sign-in is not configured yet.' : null,
      hidePublicHeader: true,
    });
  }
  if (page === 'forgot-password') {
    if (req.session.user) return res.redirect(dashboardPath(req.session.user));
    return res.render('login', {
      layout: 'layouts/public', title: 'Forgot Password', showRegister: false, showForgot: true, showReset: false,
      error: null,
      message: req.query.sent ? 'If an active account uses that email, password reset instructions have been sent.' : null,
      hidePublicHeader: true,
    });
  }
  if (page === 'reset-password') {
    if (req.session.user) return res.redirect(dashboardPath(req.session.user));
    const token = String(req.query.token || '');
    const validToken = await req.app.locals.services.auth.isPasswordResetTokenValid(token);
    return res.render('login', {
      layout: 'layouts/public', title: 'Reset Password', showRegister: false, showForgot: false, showReset: true,
      token, validToken, error: validToken ? null : 'This password reset link is invalid or has expired. Request a new one.',
      message: null, hidePublicHeader: true,
    });
  }

  const user = requireUser(req, res);
  if (!user) return;
  const { auth, items: itemService } = req.app.locals.services;

  if (page === 'dashboard') {
    if (user.role_name === 'staff') return res.redirect('/index.php?page=staff-dashboard');
    if (user.role_name === 'admin') return res.redirect('/index.php?page=admin-dashboard');
    auth.requireRole(user, ['user']);
    const [items, claims] = await Promise.all([itemService.findForUser(user.id), itemService.findClaimsForUser(user.id)]);
    const lostCount = items.filter((item) => item.item_type === 'lost').length;
    const foundCount = items.filter((item) => item.item_type === 'found').length;
    const storedCount = items.filter((item) => item.status === 'stored').length;
    const pendingClaims = claims.filter((claim) => claim.status === 'pending').length;
    const activity = [
      ...items.map((item) => ({
        type: item.item_type,
        label: item.status === 'stored' ? 'Found item stored'
          : item.status === 'returned' ? 'Returned to owner'
            : `${capitalize(item.item_type)} report submitted`,
        name: item.item_name,
        date: item.updated_at || item.created_at,
      })),
      ...claims.map((claim) => ({ type: 'claim', label: `Claim ${claim.status}`, name: claim.item_name, date: claim.created_at })),
    ].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 5);
    return setPage(res, 'Dashboard', 'dashboard', user, { view: 'dashboard', items, claims, lostCount, foundCount, storedCount, pendingClaims, activity });
  }

  if (page === 'staff-dashboard') {
    auth.requireRole(user, ['staff']);
    const records = await itemService.findStaffRecords();
    const items = records.items;
    const claims = records.claims;
    const activity = [
      ...items.map((item) => ({
        type: item.item_type,
        label: item.status === 'stored' ? 'Found item stored'
          : item.status === 'returned' ? 'Returned to owner'
            : item.status === 'claimed' ? 'Found item claimed'
              : `${capitalize(item.item_type)} report submitted`,
        name: item.item_name,
        date: item.updated_at || item.created_at,
      })),
      ...claims.map((claim) => ({
        type: 'claim',
        label: claim.status === 'pending' ? 'Claim submitted' : `Claim ${claim.status}`,
        name: claim.item_name,
        date: claim.updated_at || claim.created_at,
      })),
    ].sort((left, right) => String(right.date).localeCompare(String(left.date))).slice(0, 5);
    return setPage(res, 'Staff Dashboard', 'staff-dashboard', user, {
      view: 'staff-dashboard',
      lostCount: items.filter((item) => item.item_type === 'lost' && item.status !== 'cancelled').length,
      foundCount: items.filter((item) => item.item_type === 'found' && ['found', 'stored'].includes(item.status)).length,
      pendingClaimCount: claims.filter((claim) => claim.status === 'pending').length,
      pendingVerificationCount: items.filter((item) => item.item_type === 'found'
        && ['found', 'stored'].includes(item.status) && item.physical_verification_status !== 'verified').length,
      storedCount: items.filter((item) => item.status === 'stored').length,
      returnedCount: items.filter((item) => item.status === 'returned').length,
      activity,
    });
  }

  if (page === 'staff-records') {
    auth.requireRole(user, ['staff']);
    const filters = {
      query: String(req.query.query || ''),
      record_type: ['items', 'claims'].includes(req.query.record_type) ? req.query.record_type : 'all',
      item_type: ['lost', 'found'].includes(req.query.item_type) ? req.query.item_type : '',
      status: String(req.query.status || ''),
      category: categories.includes(req.query.category) ? req.query.category : '',
      date_from: String(req.query.date_from || ''),
      date_to: String(req.query.date_to || ''),
    };
    const records = await itemService.findStaffRecords(filters);
    return setPage(res, 'Staff Records', 'staff-records', user, {
      view: 'staff-records',
      items: records.items,
      claims: records.claims,
      filters,
      categories,
    });
  }

  if (page === 'staff-returned-items') {
    auth.requireRole(user, ['staff']);
    const filters = {
      query: String(req.query.query || ''),
      category: categories.includes(req.query.category) ? req.query.category : '',
      date_from: String(req.query.date_from || ''),
      date_to: String(req.query.date_to || ''),
    };
    const items = await itemService.findStaffReturnedItems(filters);
    return setPage(res, 'Returned Items', 'staff-returned-items', user, {
      view: 'staff-returned-items',
      items,
      filters,
      categories,
    });
  }

  if (['staff-lost-reports', 'staff-found-items', 'staff-stored-items'].includes(page)) {
    auth.requireRole(user, ['staff']);
    const itemType = page === 'staff-lost-reports' ? 'lost'
      : page === 'staff-stored-items' ? 'stored' : 'found';
    const items = await itemService.findStaffItems(itemType);
    const title = itemType === 'lost' ? 'Lost Item Reports'
      : itemType === 'stored' ? 'Stored Items' : 'Found Items';
    return setPage(res, title,
      page, user, { view: 'staff-items', items, itemType });
  }

  if (page === 'staff-item') {
    auth.requireRole(user, ['staff']);
    const item = await itemService.findStaffItem(String(req.query.id || ''));
    return setPage(res, 'Review Item Report', item.item_type === 'lost' ? 'staff-lost-reports' : 'staff-found-items',
      user, {
        view: 'staff-item',
        item,
        message: req.query.verified ? 'Found item marked as physically verified.'
          : req.query.statusUpdated ? 'Item status updated.' : null,
      });
  }

  if (page === 'staff-claims') {
    auth.requireRole(user, ['staff']);
    const claims = await itemService.findStaffClaims();
    return setPage(res, 'Review Claims', 'staff-claims', user, {
      view: 'staff-claims',
      claims,
      highlightTarget: String(req.query.highlight || ''),
    });
  }

  if (page === 'staff-claim') {
    auth.requireRole(user, ['staff']);
    const claim = await itemService.findStaffClaim(String(req.query.id || ''));
    return setPage(res, 'Verify Item Ownership', 'staff-claims', user, {
      view: 'staff-claim',
      claim,
      highlightTarget: String(req.query.highlight || ''),
      message: req.query.reviewed ? 'Ownership decision saved and claimant notified.' : null,
    });
  }

  if (page === 'admin-dashboard') {
    auth.requireRole(user, ['admin']);
    const [userSummary, summary] = await Promise.all([
      auth.getAdminUserSummary(),
      itemService.getAdminDashboardSummary(),
    ]);
    return setPage(res, 'Admin Dashboard', 'admin-dashboard', user, {
      view: 'admin-dashboard',
      userCount: userSummary.totalUsers,
      activeUserCount: userSummary.activeUsers,
      summary,
    });
  }

  if (page === 'admin-users') {
    auth.requireRole(user, ['admin']);
    const accounts = await auth.findAccountsForStaffAssignment();
    return setPage(res, 'User Management', 'admin-users', user, {
      view: 'admin-users',
      accounts,
      message: req.query.updated === 'staff' ? 'Staff access has been assigned.'
        : req.query.updated === 'user' ? 'Staff access was removed. The account now has regular user access.'
          : req.query.updated === 'disabled' ? 'Account disabled. The user will be signed out on their next request.'
            : req.query.updated === 'enabled' ? 'Account re-enabled successfully.' : null,
    });
  }

  if (page === 'admin-items') {
    auth.requireRole(user, ['admin']);
    const filters = {
      query: String(req.query.query || ''),
      item_type: ['lost', 'found'].includes(req.query.item_type) ? req.query.item_type : '',
      status: ['lost', 'found', 'stored', 'claimed', 'returned', 'cancelled'].includes(req.query.status)
        ? req.query.status : '',
      category: categories.includes(req.query.category) ? req.query.category : '',
      date_from: String(req.query.date_from || ''),
      date_to: String(req.query.date_to || ''),
    };
    const items = await itemService.findAdminItems(filters);
    return setPage(res, 'All Items', 'admin-items', user, {
      view: 'admin-items',
      items,
      filters,
      categories,
    });
  }

  if (page === 'admin-edit-item') {
    auth.requireRole(user, ['admin']);
    const editItem = await itemService.findAdminItem(String(req.query.id || ''));
    return setPage(res, 'Edit Item', 'admin-items', user, {
      view: 'admin-edit-item',
      editItem,
      formValues: editItem,
      error: null,
      message: req.query.saved ? 'Item record updated successfully.' : null,
      categories,
      today: today(),
    });
  }

  if (page === 'admin-claims') {
    auth.requireRole(user, ['admin']);
    const filters = {
      query: String(req.query.query || ''),
      status: ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '',
    };
    const claims = await itemService.findAdminClaims(filters);
    return setPage(res, 'All Claims', 'admin-claims', user, {
      view: 'admin-claims',
      claims,
      filters,
    });
  }

  if (page === 'admin-inventory') {
    auth.requireRole(user, ['admin']);
    const items = await itemService.findInventoryReport();
    const categoryCounts = items.reduce((counts, item) => {
      counts[item.category] = (counts[item.category] || 0) + 1;
      return counts;
    }, {});
    return setPage(res, 'Inventory Report', 'admin-inventory', user, {
      view: 'admin-inventory',
      items,
      categoryCounts,
      generatedAt: new Date(),
    });
  }

  if (page === 'admin-add-user') {
    auth.requireRole(user, ['admin']);
    return setPage(res, 'Add User', 'admin-add-user', user, {
      view: 'admin-add-user',
      message: req.query.created ? 'User account created successfully.' : null,
      error: null,
      formValues: {},
    });
  }

  if (page === 'admin-edit-user') {
    auth.requireRole(user, ['admin']);
    const editUser = await auth.findAdminEditableUser(String(req.query.id || ''));
    return setPage(res, 'Edit User', 'admin-users', user, {
      view: 'admin-edit-user',
      editUser,
      message: req.query.saved ? 'User account updated successfully.' : null,
      error: null,
      formValues: editUser,
    });
  }

  if (page === 'admin-settings') {
    auth.requireRole(user, ['admin']);
    const googleAuth = await req.app.locals.services.integrationSettings.getGoogleAuthSettings(
      req.app.locals.services.googleOAuth.enabled,
    );
    const message = req.query.updated === 'enabled' ? 'Google sign-in has been enabled.'
      : req.query.updated === 'disabled' ? 'Google sign-in has been disabled.' : null;
    return setPage(res, 'Settings', 'admin-settings', user, {
      view: 'admin-settings',
      googleAuth,
      message,
      error: req.query.error === 'not-configured'
        ? 'Add the Google OAuth client ID and secret to the server environment before enabling Google sign-in.'
        : null,
    });
  }

  if (page === 'profile') {
    const [items, claims] = await Promise.all([itemService.findForUser(user.id), itemService.findClaimsForUser(user.id)]);
    return setPage(res, 'Profile', 'profile', user, {
      view: 'profile', items, claims,
      lostCount: items.filter((item) => item.item_type === 'lost').length,
      foundCount: items.filter((item) => item.item_type === 'found').length,
      message: req.query.saved ? 'Profile updated successfully.' : null,
      error: null,
    });
  }

  if (page === 'report') {
    auth.requireRole(user, ['user']);
    const isFound = req.query.kind === 'found';
    return setPage(res, isFound ? 'Report Found Item' : 'Report Lost Item', isFound ? 'report-found' : 'report', user, {
      view: isFound ? 'report-found' : 'report-lost', isFound, error: null, categories, today: today(),
    });
  }

  if (page === 'reports') {
    auth.requireRole(user, ['user']);
    const reports = await itemService.findForUser(user.id);
    return setPage(res, 'My Reports', 'reports', user, {
      view: 'reports', items: reports,
      message: req.query.saved ? 'Report updated successfully.' : null,
      foundReportSubmitted: req.query.found_submitted === '1',
      highlightTarget: String(req.query.highlight || ''),
      error: null,
    });
  }

  if (page === 'edit-report') {
    auth.requireRole(user, ['user']);
    const editItem = await itemService.findOne(user.id, String(req.query.id || ''));
    if (editItem.status === 'cancelled') throw new Error('Only active reports can be edited.');
    return setPage(res, 'Edit Report', 'reports', user, {
      view: 'edit-report', editItem, categories, today: today(), error: null,
    });
  }

  if (page === 'items') {
    const requestedType = req.query.type_tab !== undefined ? req.query.type_tab : req.query.item_type;
    const itemType = ['lost', 'found'].includes(requestedType) ? requestedType : '';
    const storedOnly = req.query.status_tab === 'stored';
    const filters = { ...req.query };
    delete filters.type_tab;
    delete filters.status_tab;
    delete filters.item_type;
    const results = await itemService.search(filters, user.id);
    const counts = {
      all: results.length,
      lost: results.filter((item) => item.item_type === 'lost').length,
      found: results.filter((item) => item.item_type === 'found').length,
      stored: results.filter((item) => item.status === 'stored').length,
    };
    const visibleItems = storedOnly
      ? results.filter((item) => item.status === 'stored')
      : itemType ? results.filter((item) => item.item_type === itemType) : results;
    return setPage(res, 'Browse Items', 'items', user, {
      view: 'items', items: visibleItems, counts, filters: { ...filters, item_type: itemType }, storedOnly, categories, error: null,
    });
  }

  if (page === 'item') {
    const item = await itemService.findPublic(String(req.query.id || ''), user.id);
    return setPage(res, 'Item Details', 'items', user, {
      view: 'item',
      item,
      isFound: item.item_type === 'found',
      canClaim: item.item_type === 'found'
        && item.status === 'stored'
        && item.user_id !== user.id
        && !item.user_claim_id,
    });
  }

  if (page === 'staff-found-image') {
    auth.requireRole(user, ['staff', 'admin']);
    const item = await itemService.findStaffItem(String(req.query.id || ''));
    if (item.item_type !== 'found' || !item.image_path || !/^[0-9a-f-]+\.(jpg|png|webp)$/i.test(item.image_path)) {
      return res.sendStatus(404);
    }
    res.set('Cache-Control', 'private, no-store');
    return res.sendFile(path.resolve(__dirname, '..', '..', 'private_uploads', 'found', item.image_path));
  }

  if (page === 'claim') {
    auth.requireRole(user, ['user']);
    const item = await itemService.findAvailable(String(req.query.item || ''), user.id);
    return setPage(res, 'Submit Claim', 'claims', user, { view: 'claim', item, error: null });
  }

  if (page === 'claims') {
    auth.requireRole(user, ['user']);
    const claims = await itemService.findClaimsForUser(user.id);
    return setPage(res, 'My Claims', 'claims', user, {
      view: 'claims',
      claims,
      highlightTarget: String(req.query.highlight || ''),
      error: null,
    });
  }

  if (page === 'notifications') {
    const savedNotifications = await req.app.locals.services.notifications.findForUser(user.id);
    const notifications = await Promise.all(savedNotifications.map(async (notification) => ({
      ...notification,
      href: await resolveNotificationHref(notification, user, itemService),
    })));
    return setPage(res, 'Notifications', 'notifications', user, { view: 'notifications', notifications });
  }

  return res.redirect('/index.php?page=dashboard');
}));

router.post('/index.php', (req, res, next) => {
  if (req.query.page === 'report') {
    return upload.single('image')(req, res, next);
  }
  if (['reports', 'edit-report'].includes(req.query.page)) return upload.single('image')(req, res, next);
  return next();
}, asyncRoute(async (req, res) => {
  const page = String(req.query.page || '');
  const { auth, email: emailService, items: itemService } = req.app.locals.services;
  if (page === 'login') {
    try {
      const user = req.body.action === 'register'
        ? await auth.register(req.body)
        : await auth.login(req.body.email, req.body.password);
      await regenerateSession(req);
      req.session.user = user;
      return req.session.save(() => res.redirect(dashboardPath(user)));
    } catch (error) {
      return res.status(400).render('login', {
        layout: 'layouts/public', title: req.body.action === 'register' ? 'Create Account' : 'Sign In',
        showRegister: req.body.action === 'register', showForgot: false, showReset: false,
        error: error.message, message: null, googleError: null, hidePublicHeader: true,
      });
    }
  }

  if (page === 'forgot-password') {
    await auth.requestPasswordReset(req.body.email, (email, token) => {
      const resetUrl = new URL('/index.php?page=reset-password', config.appBaseUrl);
      if (process.env.NODE_ENV === 'production' && resetUrl.protocol !== 'https:') {
        throw new Error('APP_BASE_URL must use HTTPS in production.');
      }
      resetUrl.searchParams.set('token', token);
      return emailService.sendPasswordReset(email, resetUrl.toString());
    });
    return res.redirect('/index.php?page=forgot-password&sent=1');
  }

  if (page === 'reset-password') {
    const token = String(req.body.token || '');
    try {
      await auth.resetPassword(token, req.body.password, req.body.password_confirmation);
      return res.redirect('/index.php?page=login&reset=1');
    } catch (error) {
      const validToken = await auth.isPasswordResetTokenValid(token);
      return res.status(400).render('login', {
        layout: 'layouts/public', title: 'Reset Password', showRegister: false, showForgot: false, showReset: true,
        token, validToken, error: error.message, message: null, hidePublicHeader: true,
      });
    }
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (page === 'staff-item') {
    auth.requireRole(user, ['staff']);
    const itemId = String(req.body.item_id || '');
    if (req.body.action === 'verify_found_item') {
      await itemService.verifyFoundItem(itemId, user.id);
      return res.redirect(`/index.php?page=staff-item&id=${encodeURIComponent(itemId)}&verified=1`);
    }
    if (req.body.action === 'update_item_status') {
      await itemService.updateItemStatus(itemId, user.id, String(req.body.status || ''));
      return res.redirect(`/index.php?page=staff-item&id=${encodeURIComponent(itemId)}&statusUpdated=1`);
    }
    throw new Error('Unknown item review action.');
  }

  if (page === 'staff-claim') {
    auth.requireRole(user, ['staff']);
    const claimId = String(req.body.claim_id || '');
    if (req.body.action === 'review_claim') {
      await itemService.reviewClaim(claimId, user.id, String(req.body.decision || ''));
    } else if (req.body.action === 'mark_item_returned') {
      await itemService.markItemReturned(claimId, user.id);
    } else {
      throw new Error('Unknown claim review action.');
    }
    return res.redirect(`/index.php?page=staff-claim&id=${encodeURIComponent(claimId)}&reviewed=1`);
  }

  if (page === 'report') {
    auth.requireRole(user, ['user']);
    const itemType = req.query.kind === 'found' ? 'found' : 'lost';
    const imagePath = req.file ? await saveItemImage(req.file, itemType) : null;
    await itemService.create(user.id, { ...req.body, item_type: itemType }, imagePath);
    return res.redirect(`/index.php?page=reports${itemType === 'found' ? '&found_submitted=1' : ''}`);
  }

  if (page === 'profile') {
    req.session.user = await auth.updateProfile(user.id, req.body);
    return req.session.save(() => res.redirect('/index.php?page=profile&saved=1'));
  }

  if (page === 'reports') {
    auth.requireRole(user, ['user']);
    if (req.body.action === 'cancel_report') await itemService.cancel(user.id, String(req.body.id || ''));
    else throw new Error('Unknown report action.');
    return res.redirect('/index.php?page=reports');
  }

  if (page === 'edit-report') {
    auth.requireRole(user, ['user']);
    const itemId = String(req.query.id || '');
    const editItem = await itemService.findOne(user.id, itemId);
    if (editItem.status === 'cancelled') throw new Error('Only active reports can be edited.');
    try {
      if (req.file && editItem.item_type !== 'lost') throw new Error('Images can only be added to lost reports.');
      const imagePath = req.file && editItem.item_type === 'lost' ? await saveItemImage(req.file, 'lost') : null;
      await itemService.update(user.id, itemId, req.body, imagePath);
    } catch (error) {
      return res.status(400).render('edit-report', {
        title: 'Edit Report', active: 'reports', user, editItem: { ...editItem, ...req.body },
        categories, today: today(), error: error.message,
      });
    }
    return res.redirect('/index.php?page=reports&saved=1');
  }

  if (page === 'claim') {
    auth.requireRole(user, ['user']);
    await itemService.createClaim(user.id, req.body);
    return res.redirect('/index.php?page=claims');
  }

  if (page === 'notifications') {
    const notificationService = req.app.locals.services.notifications;
    if (req.body.action === 'mark_read') {
      await notificationService.markRead(user.id, String(req.body.notification_id || ''));
    } else if (req.body.action === 'mark_all_read') {
      await notificationService.markAllRead(user.id);
    } else {
      throw new Error('Unknown notification action.');
    }
    return res.redirect('/index.php?page=notifications');
  }

  if (page === 'admin-add-user') {
    auth.requireRole(user, ['admin']);
    try {
      await auth.createAdminUser(req.body);
    } catch (error) {
      if (error.status !== 400) throw error;
      return res.status(400).render('admin-add-user', {
        layout: 'layouts/app',
        title: 'Add User',
        active: 'admin-add-user',
        user,
        message: null,
        error: error.message,
        formValues: req.body,
      });
    }
    return res.redirect('/index.php?page=admin-add-user&created=1');
  }

  if (page === 'admin-edit-user') {
    auth.requireRole(user, ['admin']);
    const userId = String(req.query.id || '');
    try {
      await auth.updateUserByAdmin(userId, req.body);
    } catch (error) {
      if (error.status !== 400) throw error;
      const editUser = await auth.findAdminEditableUser(userId);
      return res.status(400).render('admin-edit-user', {
        layout: 'layouts/app',
        title: 'Edit User',
        active: 'admin-users',
        user,
        editUser,
        message: null,
        error: error.message,
        formValues: req.body,
      });
    }
    return res.redirect(`/index.php?page=admin-edit-user&id=${encodeURIComponent(userId)}&saved=1`);
  }

  if (page === 'admin-edit-item') {
    auth.requireRole(user, ['admin']);
    const itemId = String(req.query.id || '');
    try {
      await itemService.updateAdminItem(itemId, req.body);
    } catch (error) {
      if (error.status !== 400) throw error;
      const editItem = await itemService.findAdminItem(itemId);
      return res.status(400).render('admin-edit-item', {
        layout: 'layouts/app',
        title: 'Edit Item',
        active: 'admin-items',
        user,
        editItem,
        formValues: req.body,
        error: error.message,
        message: null,
        categories,
        today: today(),
      });
    }
    return res.redirect(`/index.php?page=admin-edit-item&id=${encodeURIComponent(itemId)}&saved=1`);
  }

  if (['admin-dashboard', 'admin-users'].includes(page)) {
    auth.requireRole(user, ['admin']);
    const userId = String(req.body.user_id || '');
    if (req.body.action === 'assign_staff') {
      await auth.assignStaffRole(userId);
      await req.app.locals.services.notifications.create(userId, {
        type: 'status',
        title: 'Staff access granted',
        message: 'An administrator assigned staff access to your account.',
        href: '/index.php?page=dashboard',
      });
      return res.redirect('/index.php?page=admin-users&updated=staff');
    }
    if (req.body.action === 'revert_staff') {
      await auth.revertStaffRole(userId);
      return res.redirect('/index.php?page=admin-users&updated=user');
    }
    if (req.body.action === 'disable_user') {
      await auth.setUserAccountStatus(userId, 'disabled');
      return res.redirect('/index.php?page=admin-users&updated=disabled');
    }
    if (req.body.action === 'enable_user') {
      await auth.setUserAccountStatus(userId, 'active');
      return res.redirect('/index.php?page=admin-users&updated=enabled');
    }
    throw new Error('Unknown admin action.');
  }

  if (page === 'admin-settings') {
    auth.requireRole(user, ['admin']);
    const { googleOAuth, integrationSettings } = req.app.locals.services;
    if (!['enable_google_auth', 'disable_google_auth'].includes(req.body.action)) {
      throw new Error('Unknown settings action.');
    }
    const enabled = req.body.action === 'enable_google_auth';
    if (enabled && !googleOAuth.enabled) {
      return res.redirect('/index.php?page=admin-settings&error=not-configured');
    }
    await integrationSettings.setGoogleAuthEnabled(enabled);
    return res.redirect(`/index.php?page=admin-settings&updated=${enabled ? 'enabled' : 'disabled'}`);
  }

  return res.redirect('/index.php?page=dashboard');
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const user = req.session?.user || null;
  const message = error instanceof multer.MulterError
    ? (error.code === 'LIMIT_FILE_SIZE' ? 'The image must be 5 MB or smaller.' : 'The image upload could not be processed.')
    : error.message || 'Something went wrong.';
  res.status(error instanceof multer.MulterError ? 400 : (error.status || 400)).render('error', {
    layout: user ? 'layouts/app' : 'layouts/public',
    title: 'Request Error',
    user,
    active: '',
    error: message,
    backHref: user?.role_name === 'staff' ? '/index.php?page=staff-dashboard'
      : user?.role_name === 'admin' ? '/index.php?page=admin-dashboard'
        : user ? '/index.php?page=items' : '/',
  });
});

async function saveItemImage(file, itemType) {
  const buffer = file.buffer;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const extension = isJpeg ? 'jpg' : isPng ? 'png' : isWebp ? 'webp' : null;
  if (!extension) throw new Error('Upload a valid JPG, PNG, or WEBP image.');
  const filename = `${randomUUID()}.${extension}`;
  const isFoundItem = itemType === 'found';
  const directory = isFoundItem
    ? path.resolve(__dirname, '..', '..', 'private_uploads', 'found')
    : path.resolve(__dirname, '..', '..', 'uploads', 'lost');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), buffer, { flag: 'wx' });
  return isFoundItem ? filename : `uploads/lost/${filename}`;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = router;
