const assert = require('node:assert/strict');
const express = require('express');
const { after, before, test } = require('node:test');
const { createApiRouter } = require('../routes/api');
const { createItemsRoutes } = require('../routes/items.routes');
const { createClaimsRoutes } = require('../routes/claims.routes');
const { createProfileRoutes } = require('../routes/profile.routes');
const { createNotificationsRoutes } = require('../routes/notifications.routes');
const { createStaffRoutes } = require('../routes/staff.routes');
const {
  PERMISSIONS_BY_ROLE,
  ROLE_PERMISSION_EXEMPT_ROUTES,
  ROLE_PERMISSION_ROUTE_MAP,
  normalizeRolePermissions,
} = require('../config/role-permissions');
const { createAuthRoutes } = require('../routes/auth.routes');
const { createHealthRoutes } = require('../routes/health.routes');
const { IntegrationError } = require('../../src/services/integration-calls');

const user = { id: 'test-user', full_name: 'Test User', role_name: 'user', status: 'active' };
const staff = { id: 'test-staff', full_name: 'Test Staff', role_name: 'staff', status: 'active' };
const secondStaff = { id: 'test-staff-2', full_name: 'Second Staff', role_name: 'staff', status: 'active' };
const admin = { id: 'test-admin', full_name: 'Test Admin', role_name: 'admin', status: 'active' };
const disabledUser = { id: 'disabled-user', full_name: 'Disabled User', role_name: 'user', status: 'disabled' };
const accounts = new Map([user, staff, secondStaff, admin, disabledUser].map((account) => [account.id, account]));
const roleChangeCalls = [];
const accountOverrides = new Map();
let createdAccountSequence = 0;
let failAccountPermissionSave = false;
const permissionsByRole = new Map([
  ['user', PERMISSIONS_BY_ROLE.user.map(({ key }) => key)],
  ['staff', PERMISSIONS_BY_ROLE.staff.map(({ key }) => key)],
  ['admin', PERMISSIONS_BY_ROLE.admin.map(({ key }) => key)],
]);
const auditEvents = [];
let recaptchaEnabled = false;
let googleEnabled = false;
let integrationSaveCount = 0;
const testSessions = new Map();
const pendingRoleCodes = new Map();
const services = {
  auth: {
    async login(email) {
      if (email === 'admin@example.test') return admin;
      const account = [...accounts.values()].find((candidate) => (
        candidate.email === email && candidate.status === 'active'
      ));
      if (account) return { ...account };
      throw new Error('Invalid credentials.');
    },
    async findActiveSessionUser(id) {
      const account = accounts.get(id);
      return account?.status === 'active' ? { ...account } : null;
    },
    async createAdminUser(input, { roleName = 'user' } = {}) {
      createdAccountSequence += 1;
      const account = {
        id: `created-user-${createdAccountSequence}`,
        full_name: input.full_name,
        email: input.email,
        role_name: roleName,
        status: 'active',
      };
      accounts.set(account.id, account);
      return account;
    },
    async deleteAdminUser(id) {
      return accounts.delete(id);
    },
    async findAccountsForStaffAssignment() {
      return [...accounts.values()];
    },
    async updateUserByAdmin(id, input) {
      const account = accounts.get(id);
      if (account) Object.assign(account, {
        full_name: input.full_name,
        email: input.email,
        student_id: input.student_id || null,
        phone: input.phone || null,
      });
    },
    async countActiveAccountsByRole(role) {
      return [...accounts.values()].filter((account) => account.role_name === role && account.status === 'active').length;
    },
    async updateProfile(id, input) {
      assert.equal(id, user.id);
      return { ...user, full_name: input.full_name, phone: input.phone };
    },
    requireRole(currentUser, roles) {
      if (!roles.includes(currentUser?.role_name)) {
        const error = new Error('You do not have permission to perform this action.');
        error.status = 403;
        throw error;
      }
    },
  },
  rolePermissions: {
    async findRolePermissions(role) {
      return [...(permissionsByRole.get(role) || [])];
    },
    async findEffectivePermissions(userId, role) {
      const disabled = new Set(accountOverrides.get(userId) || []);
      return (permissionsByRole.get(role) || []).filter((permission) => !disabled.has(permission));
    },
    async getRoleSettings(role) {
      return {
        role,
        permissions: PERMISSIONS_BY_ROLE[role].map((permission) => ({
          ...permission,
          enabled: permissionsByRole.get(role).includes(permission.key),
        })),
      };
    },
    preparePermissions(role, input) {
      return normalizeRolePermissions(role, input.permissions);
    },
    async prepareAccountPermissions(role, input) {
      const normalized = normalizeRolePermissions(role, input.permissions);
      if (normalized.some((permission) => !permissionsByRole.get(role)?.includes(permission))) {
        const error = new Error('The role has turned off a permission.');
        error.status = 403;
        throw error;
      }
      return normalized;
    },
    async replaceAccountPermissions(userId, role, permissions) {
      if (failAccountPermissionSave) throw new Error('Simulated permission save failure.');
      const disabled = (permissionsByRole.get(role) || []).filter((permission) => !permissions.includes(permission));
      accountOverrides.set(userId, disabled);
      return { role, permissions };
    },
    async resetAccountPermissions(userId) {
      accountOverrides.delete(userId);
    },
    async replaceRolePermissions(role, permissions) {
      const old = permissionsByRole.get(role) || [];
      permissionsByRole.set(role, [...permissions]);
      return { role, permissions: [...permissions], old_permissions: old, changed: true };
    },
  },
  roleChange: {
    async validateRoleChange(actorId, targetId, newRole, permissions) {
      const target = accounts.get(targetId);
      if (String(actorId) === String(targetId)) {
        const error = new Error('You cannot change your own role.');
        error.status = 403;
        throw error;
      }
      if (!target || target.status !== 'active') {
        const error = new Error('Active user account was not found.');
        error.status = 404;
        throw error;
      }
      const normalized = normalizeRolePermissions(newRole, permissions);
      if (normalized.some((permission) => !permissionsByRole.get(newRole)?.includes(permission))) {
        const error = new Error('The role has turned off a permission.');
        error.status = 403;
        throw error;
      }
      return { target, normalized };
    },
    async changeRole(input) {
      roleChangeCalls.push(input);
      const account = accounts.get(input.targetId);
      if (account) {
        const oldRole = account.role_name;
        account.role_name = input.newRole;
        accountOverrides.set(input.targetId, (permissionsByRole.get(input.newRole) || [])
          .filter((permission) => !input.permissions.includes(permission)));
        auditEvents.push({
          action: 'account.role_change',
          target_id: input.targetId,
          old_value: { role_name: oldRole },
          new_value: {
            role_name: input.newRole,
            ...(oldRole === 'admin' || input.newRole === 'admin' ? { privilege_change: true } : {}),
          },
        });
      }
    },
  },
  email: {
    async testConnection() { return true; },
    async verifyCandidate() { return { verified: true, proofType: 'test_email_sent' }; },
  },
  googleOAuth: {
    async createAuthorizationRequest() {
      return { url: 'https://accounts.google.com/o/oauth2/auth?state=test', state: 'test' };
    },
    async testConnection() { return true; },
    async verifyCandidate() { return { verified: true, proofType: 'real_sign_in' }; },
  },
  recaptcha: {
    configured: true,
    siteKey: 'test-site-key',
    async verifyResponse(token) {
      if (!token) {
        const error = new Error('Complete the reCAPTCHA challenge.');
        error.status = 400;
        throw error;
      }
      if (token !== 'verified-test-token') {
        const error = new Error('The reCAPTCHA challenge could not be verified. Please try again.');
        error.status = 400;
        throw error;
      }
    },
    async testConnection() { return true; },
    async verifyCandidate() { return { verified: true, proofType: 'real_challenge' }; },
  },
  integrationSettings: {
    async getIntegration(id) {
      if (id === 'google_auth') {
        return { configured: true, enabled: googleEnabled, active: googleEnabled, settings: {} };
      }
      if (id === 'recaptcha') {
        return {
          configured: true,
          enabled: recaptchaEnabled,
          active: recaptchaEnabled,
          settings: { site_key: 'test-site-key' },
        };
      }
      return {
        configured: true,
        enabled: true,
        active: true,
        settings: {
          host: 'smtp.example.test',
          port: '587',
          secure: false,
          user: 'mailer@example.test',
          password: 'saved-password',
          sender_email: 'mailer@example.test',
          sender_name: 'Test Mailer',
        },
      };
    },
    async getAdminIntegrations() {
      return {
        google_auth: { id: 'google_auth', fields: [{ name: 'client_secret', value: '••••••••cret', secret: true }] },
        recaptcha: { id: 'recaptcha', fields: [] },
        smtp: { id: 'smtp', fields: [] },
        google_calendar: { id: 'google_calendar', fields: [] },
        admin_mfa: { id: 'admin_mfa', fields: [] },
      };
    },
    async saveIntegrations(input, audit, context) {
      for (const [id, settings] of Object.entries(input)) {
        if (id === 'google_auth') googleEnabled = settings.enabled;
        if (id === 'recaptcha') recaptchaEnabled = settings.enabled;
      }
      auditEvents.push({ action: 'integration.update', input, context });
      return { integrations: {}, changed: Object.keys(input) };
    },
    async prepareIntegrationSave(input) {
      const card = input.google_auth;
      const credentialChanged = card?.fields?.client_id === 'new-client-id';
      const enabledChanged = card && card.enabled !== googleEnabled;
      return {
        updates: credentialChanged || enabledChanged ? [{
          id: 'google_auth',
          enabled: card.enabled,
          changedFields: credentialChanged ? ['client_id'] : [],
          credentialFields: credentialChanged ? ['client_id'] : [],
          enabledChanged,
          values: { client_id: card.fields?.client_id || 'saved-client-id' },
        }] : [],
        changed: credentialChanged ? ['google_auth'] : [],
        credentialChanges: credentialChanged ? [{ integration: 'google_auth', fields: ['client_id'] }] : [],
        changes: credentialChanged ? [{ integration: 'google_auth', fields: ['client_id'] }] : [],
        payloadHash: credentialChanged ? 'credential-payload-hash' : 'payload-hash',
      };
    },
    async requireCurrentVerification() {
      return { verified: true, proofType: 'real_sign_in' };
    },
    async applyIntegrationSave(plan) {
      integrationSaveCount += 1;
      return { integrations: await this.getAdminIntegrations(), changed: plan.changed };
    },
    async recordVerification(input) {
      return {
        verified: Boolean(input.result),
        proofType: input.proofType,
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      };
    },
    getVerificationHash() { return 'a'.repeat(64); },
    getIntegrationLabel(id) { return id; },
    async setIntegrationDefault() { return { integrations: {} }; },
    async getDefaultRestorePreview() { return { id: 'google_auth', changedFields: [], values: {} }; },
    async restoreIntegrationDefault() { return { integrations: {}, changed: [], restored: false }; },
    async validateIntegrationFields() { return {}; },
  },
  integrationSecurity: {
    configuration() {
      return {
        accessReady: true,
        accessError: '',
        verificationEmailConfigured: true,
        verificationEmailError: '',
      };
    },
    touchSession(session, adminId) {
      const state = session.integrationSettingsAccess;
      if (!state || state.adminId !== String(adminId) || Date.now() - state.lastActivityAt >= 600_000) {
        delete session.integrationSettingsAccess;
        return false;
      }
      state.lastActivityAt = Date.now();
      return true;
    },
    async unlock({ adminId, candidate, session, audit, auditContext }) {
      if (candidate !== '123456') {
        const error = new Error('PIN could not be verified. Try again later.');
        error.status = 403;
        throw error;
      }
      session.integrationSettingsAccess = { adminId: String(adminId), lastActivityAt: Date.now() };
      await audit.logAction({ ...auditContext, action: 'integration.unlock' });
    },
    async sendCode({ adminId, sessionId, payloadHash, changes }) {
      pendingRoleCodes.set(sessionId, {
        adminId: String(adminId),
        payloadHash,
        code: '654321',
        expiresAt: Date.now() + 600_000,
        attempts: 0,
      });
      auditEvents.push({
        action: 'integration.code_sent',
        new_value: { changed_fields: changes.flatMap(({ fields }) => fields) },
      });
      return { expiresInSeconds: 600, resendInSeconds: 60 };
    },
    async verifyCode({ adminId, sessionId, candidate, payloadHash, changes }) {
      const entry = pendingRoleCodes.get(sessionId);
      const fail = (message) => {
        auditEvents.push({
          action: 'integration.code_failed',
          new_value: { changed_fields: changes.flatMap(({ fields }) => fields) },
        });
        const error = new Error(message);
        error.status = 400;
        throw error;
      };
      if (!entry || entry.adminId !== String(adminId) || entry.expiresAt <= Date.now()) {
        pendingRoleCodes.delete(sessionId);
        return fail('The verification code is invalid or expired.');
      }
      if (entry.payloadHash !== payloadHash) {
        pendingRoleCodes.delete(sessionId);
        return fail('The pending settings changed. Save again to request a new code.');
      }
      if (candidate !== entry.code) {
        entry.attempts += 1;
        if (entry.attempts >= 5) pendingRoleCodes.delete(sessionId);
        return fail('The verification code is invalid or expired.');
      }
      pendingRoleCodes.delete(sessionId);
      return true;
    },
    async cancelCode({ sessionId }) {
      pendingRoleCodes.delete(sessionId);
    },
    async sendBootstrapEmail() {},
  },
  adminMfa: {
    async getLoginAction() { return { action: 'complete' }; },
    async getAdminRouteAccess() { return { allowed: true }; },
    async getAdminSummary() {
      return { enabled: false, active: false, enrolledAdmins: 0, totalAdmins: 1 };
    },
    async getStatus() {
      return { enabled: false, requireForAllAdmins: false, enrolled: false };
    },
    async selfTest() { return true; },
  },
  items: {
    async search() {
      return [{
        id: 'public-item',
        item_name: 'Found item',
        identifying_details: 'Private serial number',
      }];
    },
    async findForUser() {
      return [];
    },
    async findStaffDashboardSummary() {
      return { stats: {}, activity: [] };
    },
    async getStaffItemType() {
      return 'found';
    },
    async findStaffItems() {
      return [];
    },
    async findStaffReturnedItems() {
      return [];
    },
    async findStaffRecords() {
      return { items: [], claims: [] };
    },
    async findStaffClaims() {
      return [];
    },
  },
  notifications: {
    async countUnread() {
      return 0;
    },
  },
  audit: {
    async logAction(event) {
      auditEvents.push(event);
    },
    async runAction(event, action) {
      const result = await action();
      auditEvents.push({ ...event, result: 'success' });
      return result;
    },
    async findRecords() {
      return { records: [], page: 1, page_size: 25, total: 0, total_pages: 0 };
    },
  },
};

const app = express();
app.locals.services = services;
app.use(express.json());
app.use((req, _res, next) => {
  const sessionKey = req.get('x-test-session') || req.get('x-test-user') || 'anonymous';
  if (!testSessions.has(sessionKey)) testSessions.set(sessionKey, {});
  const session = testSessions.get(sessionKey);
  req.sessionID = `${sessionKey}-session`;
  session.csrfToken = 'csrf-test-token';
  const accountId = req.get('x-test-account') || req.get('x-test-user');
  if (!Object.hasOwn(session, 'user')) {
    const account = accountId ? accounts.get(accountId) : null;
    session.user = account ? { ...account } : null;
  }
  req.session = Object.assign(session, {
    destroy(callback) { delete session.user; callback(); },
    save(callback) { callback(); },
    regenerate(callback) { delete session.user; callback(); },
  });
  next();
});
app.use('/api', createApiRouter({ services, frontendOrigin: 'http://localhost:5173' }));
app.use((error, req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status
    : error instanceof Error && error.constructor === Error ? 400 : 500;
  if ((status === 401 || status === 403)
    && (req.auditProtectedRoute || req.originalUrl.startsWith('/api/admin/'))) {
    void services.audit.logAction({
      actor_id: req.user?.id || null,
      actor_role: req.user?.role_name || null,
      action: 'access.denied',
      new_value: {
        route: req.auditRoute || req.path,
        http_method: req.auditMethod || req.method,
        required_permission: req.auditRequiredPermission || null,
      },
      result: 'denied',
    });
  }
  res.status(status).json({ error: error.message });
});

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('health endpoint responds with API status', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('browse endpoint omits private identifying details', async () => {
  const response = await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': user.id } });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.items[0].item_name, 'Found item');
  assert.equal(Object.hasOwn(data.items[0], 'identifying_details'), false);
});

test('private item list requires an authenticated user', async () => {
  const response = await fetch(`${baseUrl}/items/mine`);
  assert.equal(response.status, 401);
});

test('disabled accounts cannot access protected routes even when their role permissions are enabled', async () => {
  const response = await fetch(`${baseUrl}/items`, {
    headers: { 'x-test-user': disabledUser.id },
  });
  assert.equal(response.status, 401);
});

test('profile updates save the updated user in the session', async () => {
  const response = await fetch(`${baseUrl}/profile`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-test-user': user.id,
    },
    body: JSON.stringify({ full_name: 'Updated User', phone: '5551234' }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.user.full_name, 'Updated User');
  assert.equal(data.user.phone, '5551234');
});

test('staff and admin routes reject users without the required role', async () => {
  for (const path of ['/staff/dashboard', '/admin/dashboard']) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { 'x-test-user': user.id },
    });
    assert.equal(response.status, 403, `${path} should require its matching role`);
  }
});

test('role permission changes apply to all accounts immediately and can be restored', async () => {
  const savedUserPermissions = [...permissionsByRole.get('user')];
  const savedStaffPermissions = [...permissionsByRole.get('staff')];
  try {
    permissionsByRole.set('user', savedUserPermissions.filter((key) => key !== 'view_items'));
    for (const account of [user, { id: 'test-user-2', role_name: 'user', status: 'active' }]) {
      if (account.id === 'test-user-2') accounts.set(account.id, account);
      const denied = await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': account.id } });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'This feature is currently disabled by the administrator.');
      assert.equal(auditEvents.at(-1).action, 'access.denied');
      assert.equal(auditEvents.at(-1).new_value.required_permission, 'view_items');
    }
    assert.equal((await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': admin.id } })).status, 200);
    permissionsByRole.set('user', savedUserPermissions);
    assert.equal((await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': user.id } })).status, 200);

    permissionsByRole.set('staff', savedStaffPermissions.filter((key) => key !== 'view_staff_dashboard'));
    for (const account of [staff, secondStaff]) {
      const denied = await fetch(`${baseUrl}/staff/dashboard`, { headers: { 'x-test-user': account.id } });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'This feature is currently disabled by the administrator.');
      assert.equal(auditEvents.at(-1).new_value.required_permission, 'view_staff_dashboard');
    }
    assert.equal((await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': admin.id } })).status, 200);
    permissionsByRole.set('staff', savedStaffPermissions);
    assert.equal((await fetch(`${baseUrl}/staff/dashboard`, { headers: { 'x-test-user': staff.id } })).status, 200);
  } finally {
    permissionsByRole.set('user', savedUserPermissions);
    permissionsByRole.set('staff', savedStaffPermissions);
    accounts.delete('test-user-2');
  }
});

test('unmapped staff routes are denied and logged by default', async () => {
  const response = await fetch(`${baseUrl}/staff/unmapped`, {
    headers: { 'x-test-user': staff.id },
  });
  assert.equal(response.status, 403);
  assert.equal(auditEvents.at(-1).action, 'access.denied');
  assert.equal(auditEvents.at(-1).new_value.required_permission, null);
});

test('unmapped user routes are denied and GET /items requires additional search and filter permissions', async () => {
  const unknown = await fetch(`${baseUrl}/user/unmapped`, { headers: { 'x-test-user': user.id } });
  assert.equal(unknown.status, 403);

  const saved = [...permissionsByRole.get('user')];
  try {
    permissionsByRole.set('user', saved.filter((permission) => permission !== 'search_items'));
    const search = await fetch(`${baseUrl}/items?query=wallet`, { headers: { 'x-test-user': user.id } });
    assert.equal(search.status, 403);
    assert.equal(auditEvents.at(-1).new_value.required_permission, 'search_items');

    permissionsByRole.set('user', saved.filter((permission) => permission !== 'filter_items'));
    const filter = await fetch(`${baseUrl}/items?status=stored`, { headers: { 'x-test-user': user.id } });
    assert.equal(filter.status, 403);
    assert.equal(auditEvents.at(-1).new_value.required_permission, 'filter_items');
  } finally {
    permissionsByRole.set('user', saved);
  }
});

test('list resolution, chained staff decisions, and default denial use role permissions', async () => {
  const saved = [...permissionsByRole.get('staff')];
  try {
    permissionsByRole.set('staff', saved.filter((permission) => permission !== 'view_lost_reports'));
    const lostItems = await fetch(`${baseUrl}/staff/items?type=lost`, { headers: { 'x-test-user': staff.id } });
    assert.equal(lostItems.status, 403);
    assert.equal(auditEvents.at(-1).new_value.required_permission, 'view_lost_reports');

    permissionsByRole.set('staff', saved.filter((permission) => permission !== 'approve_claim'));
    const claimDecision = await fetch(`${baseUrl}/staff/claims/claim-1`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-test-user': staff.id,
      origin: 'http://localhost:5173',
      'x-csrf-token': 'csrf-test-token',
    },
    body: JSON.stringify({ action: 'review', decision: 'approved' }),
  });
    assert.equal(claimDecision.status, 403);
    assert.equal(auditEvents.at(-1).new_value.required_permission, 'approve_claim');

  permissionsByRole.set('staff', saved.filter((permission) => permission !== 'schedule_pickup'));
  const pickupDecision = await fetch(`${baseUrl}/staff/claims/claim-1`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-test-user': staff.id,
      origin: 'http://localhost:5173',
      'x-csrf-token': 'csrf-test-token',
    },
    body: JSON.stringify({
      action: 'review',
      decision: 'approved',
      pickup_date: '2030-01-07',
      pickup_time: '10:00',
    }),
  });
  assert.equal(pickupDecision.status, 403);
  assert.equal(auditEvents.at(-1).new_value.required_permission, 'schedule_pickup');
  } finally {
    permissionsByRole.set('staff', saved);
  }
});

test('role permissions are admin-only and admin bypass does not alter user-only routes', async () => {
  const denied = await fetch(`${baseUrl}/admin/role-permissions`, {
    headers: { 'x-test-user': staff.id },
  });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`${baseUrl}/admin/role-permissions`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(allowed.status, 200);
  assert.equal((await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': admin.id } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/items/mine`, { headers: { 'x-test-user': admin.id } })).status, 403);
});

test('creating a Staff account requires add_user and manage_permissions', async () => {
  const savedAdminPermissions = [...permissionsByRole.get('admin')];
  const createdIds = [];
  permissionsByRole.set('admin', ['view_users', 'add_user']);
  try {
    const userResponse = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
        origin: 'http://localhost:5173',
        'x-csrf-token': 'csrf-test-token',
      },
      body: JSON.stringify({
        full_name: 'New User',
        email: 'new-user@example.test',
        password: 'secure-password',
        role_name: 'user',
      }),
    });
    assert.equal(userResponse.status, 201);
    const userResult = await userResponse.json();
    assert.equal(userResult.user.role_name, 'user');
    createdIds.push(userResult.user.id);

    const staffResponse = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
        origin: 'http://localhost:5173',
        'x-csrf-token': 'csrf-test-token',
      },
      body: JSON.stringify({
        full_name: 'New Staff',
        email: 'new-staff@example.test',
        password: 'secure-password',
        role_name: 'staff',
      }),
    });
    assert.equal(staffResponse.status, 403);

    const customPermissionsResponse = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
        origin: 'http://localhost:5173',
        'x-csrf-token': 'csrf-test-token',
      },
      body: JSON.stringify({
        full_name: 'Custom User',
        email: 'custom-user@example.test',
        password: 'secure-password',
        role_name: 'user',
        permissions: [],
      }),
    });
    assert.equal(customPermissionsResponse.status, 403);

    const adminRoleResponse = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
        origin: 'http://localhost:5173',
        'x-csrf-token': 'csrf-test-token',
      },
      body: JSON.stringify({
        full_name: 'Invalid Admin',
        email: 'invalid-admin@example.test',
        password: 'secure-password',
        role_name: 'admin',
      }),
    });
    assert.equal(adminRoleResponse.status, 400);
    assert.equal(accounts.size, 6);
  } finally {
    for (const id of createdIds) accounts.delete(id);
    permissionsByRole.set('admin', savedAdminPermissions);
  }
});

test('Staff account creation saves only the validated checklist and rolls back on save failure', async () => {
  const createdIds = [];
  const headers = {
    'content-type': 'application/json',
    'x-test-user': admin.id,
    origin: 'http://localhost:5173',
    'x-csrf-token': 'csrf-test-token',
  };
  try {
    const response = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        full_name: 'Staff Account',
        email: 'staff-account@example.test',
        password: 'secure-password',
        role_name: 'staff',
        permissions: ['view_claims'],
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.user.role_name, 'staff');
    createdIds.push(result.user.id);
    assert.deepEqual(await services.rolePermissions.findEffectivePermissions(result.user.id, 'staff'), ['view_claims']);
    const createAudit = auditEvents.findLast((event) => event.action === 'user.create'
      && event.new_value?.email === 'staff-account@example.test');
    assert.equal(createAudit.new_value.role_name, 'staff');
    assert.deepEqual(createAudit.new_value.permission_keys, ['view_claims']);
    assert.equal(JSON.stringify(createAudit).includes('secure-password'), false);

    const beforeFailure = accounts.size;
    failAccountPermissionSave = true;
    const failed = await fetch(`${baseUrl}/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        full_name: 'Failed Staff',
        email: 'failed-staff@example.test',
        password: 'secure-password',
        role_name: 'staff',
        permissions: ['view_claims'],
      }),
    });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'Account could not be created. Please try again.' });
    assert.equal(accounts.size, beforeFailure);
  } finally {
    failAccountPermissionSave = false;
    for (const id of createdIds) {
      accounts.delete(id);
      accountOverrides.delete(id);
    }
  }
});

test('admin account edits pass role changes through the shared role-change service', async () => {
  const target = {
    id: 'role-change-target',
    full_name: 'Role Change Target',
    email: 'role-change-target@example.test',
    role_name: 'user',
    status: 'active',
  };
  const originalRoleChangeCount = roleChangeCalls.length;
  accounts.set(target.id, target);
  try {
    const response = await fetch(`${baseUrl}/admin/users/${target.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
        origin: 'http://localhost:5173',
        'x-csrf-token': 'csrf-test-token',
      },
      body: JSON.stringify({
        action: 'edit',
        full_name: target.full_name,
        email: target.email,
        role_name: 'staff',
        permissions: PERMISSIONS_BY_ROLE.staff.map(({ key }) => key),
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(target.role_name, 'staff');
    assert.equal(roleChangeCalls.length, originalRoleChangeCount + 1);
    assert.equal(roleChangeCalls.at(-1).targetId, target.id);
    assert.equal(roleChangeCalls.at(-1).newRole, 'staff');
  } finally {
    accounts.delete(target.id);
    accountOverrides.delete(target.id);
    roleChangeCalls.splice(originalRoleChangeCount);
  }
});

test('Admin promotion is permission-gated, confirmation-ready, payload-bound, and single-use', async () => {
  const target = {
    id: 'admin-promotion-target',
    full_name: 'Promotion Target',
    email: 'promotion-target@example.test',
    role_name: 'user',
    status: 'active',
  };
  const body = {
    action: 'edit',
    role_change: true,
    admin_role_change: true,
    full_name: target.full_name,
    email: target.email,
    role_name: 'admin',
    permissions: PERMISSIONS_BY_ROLE.admin.map(({ key }) => key),
  };
  accounts.set(target.id, target);
  const before = auditEvents.length;
  const path = `${baseUrl}/admin/users/${target.id}`;
  const options = (payload) => ({
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-test-user': admin.id,
      origin: 'http://localhost:5173',
      'x-csrf-token': 'csrf-test-token',
    },
    body: JSON.stringify(payload),
  });
  try {
    const savedAdminPermissions = [...permissionsByRole.get('admin')];
    permissionsByRole.set('admin', savedAdminPermissions.filter((key) => key !== 'assign_admin_role'));
    const denied = await fetch(path, options(body));
    assert.equal(denied.status, 403);
    assert.equal(target.role_name, 'user');
    permissionsByRole.set('admin', savedAdminPermissions);

    const challenge = await fetch(path, options(body));
    assert.equal(challenge.status, 200);
    assert.equal((await challenge.json()).verificationRequired, true);
    assert.equal(target.role_name, 'user');
    const codeSessionId = `${admin.id}-session:role-change`;
    const pending = pendingRoleCodes.get(codeSessionId);
    assert.ok(pending?.payloadHash);

    const wrongCode = await fetch(path, options({ ...body, role_change_code: '000000' }));
    assert.equal(wrongCode.status, 400);
    assert.equal(target.role_name, 'user');

    pending.expiresAt = Date.now() - 1;
    const expiredCode = await fetch(path, options({ ...body, role_change_code: '654321' }));
    assert.equal(expiredCode.status, 400);
    assert.equal(target.role_name, 'user');

    await fetch(path, options(body));
    const changedPayload = {
      ...body,
      permissions: body.permissions.filter((permission) => permission !== 'view_all_claims'),
      role_change_code: '654321',
    };
    const changed = await fetch(path, options(changedPayload));
    assert.equal(changed.status, 400);
    assert.match((await changed.json()).error, /pending settings changed/i);
    assert.equal(target.role_name, 'user');

    await fetch(path, options(body));
    const verified = await fetch(path, options({ ...body, role_change_code: '654321' }));
    assert.equal(verified.status, 200);
    assert.equal(target.role_name, 'admin');
    const roleAudit = auditEvents.slice(before).find((event) => (
      event.action === 'account.role_change' && event.target_id === target.id
    ));
    assert.equal(roleAudit.new_value.privilege_change, true);

    const reused = await fetch(path, options({
      ...body,
      role_name: 'user',
      permissions: PERMISSIONS_BY_ROLE.user.map(({ key }) => key),
      role_change_code: '654321',
    }));
    assert.equal(reused.status, 400);
    assert.equal(target.role_name, 'admin');
    assert.equal(JSON.stringify(auditEvents.slice(before)).includes('654321'), false);
    assert.equal(JSON.stringify(auditEvents.slice(before)).includes('000000'), false);
  } finally {
    accounts.delete(target.id);
    accountOverrides.delete(target.id);
    pendingRoleCodes.delete(`${admin.id}-session:role-change`);
  }
});

test('Admin demotion requires assign_admin_role while User and Staff role changes do not', async () => {
  const targetAdmin = {
    id: 'admin-demotion-target',
    full_name: 'Demotion Target',
    email: 'demotion-target@example.test',
    role_name: 'admin',
    status: 'active',
  };
  const targetUser = {
    id: 'staff-promotion-target',
    full_name: 'Staff Promotion Target',
    email: 'staff-promotion-target@example.test',
    role_name: 'user',
    status: 'active',
  };
  accounts.set(targetAdmin.id, targetAdmin);
  accounts.set(targetUser.id, targetUser);
  const saved = [...permissionsByRole.get('admin')];
  try {
    permissionsByRole.set('admin', saved.filter((permission) => permission !== 'assign_admin_role'));
    const demotion = await fetch(`${baseUrl}/admin/users/${targetAdmin.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
      },
      body: JSON.stringify({
        action: 'edit',
        role_change: true,
        admin_role_change: true,
        role_name: 'user',
        permissions: PERMISSIONS_BY_ROLE.user.map(({ key }) => key),
      }),
    });
    assert.equal(demotion.status, 403);
    assert.equal(targetAdmin.role_name, 'admin');

    const legacyDemotion = await fetch(`${baseUrl}/admin/users/${targetAdmin.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
      },
      body: JSON.stringify({ action: 'revert_staff' }),
    });
    assert.equal(legacyDemotion.status, 403);
    assert.equal(targetAdmin.role_name, 'admin');

    const staffChange = await fetch(`${baseUrl}/admin/users/${targetUser.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user': admin.id,
      },
      body: JSON.stringify({
        action: 'edit',
        role_change: true,
        role_name: 'staff',
        permissions: PERMISSIONS_BY_ROLE.staff.map(({ key }) => key),
      }),
    });
    assert.equal(staffChange.status, 200);
    assert.equal(targetUser.role_name, 'staff');
  } finally {
    permissionsByRole.set('admin', saved);
    accounts.delete(targetAdmin.id);
    accounts.delete(targetUser.id);
    accountOverrides.delete(targetAdmin.id);
    accountOverrides.delete(targetUser.id);
  }
});

test('role changes invalidate old sessions on their next request and fresh logins use the new role', async () => {
  const promoted = {
    id: 'session-promoted-user',
    full_name: 'Session Promoted',
    email: 'session-promoted@example.test',
    role_name: 'user',
    status: 'active',
  };
  const demoted = {
    id: 'session-demoted-admin',
    full_name: 'Session Demoted',
    email: 'session-demoted@example.test',
    role_name: 'admin',
    status: 'active',
  };
  const staffChanged = {
    id: 'session-staff-user',
    full_name: 'Session Staff',
    email: 'session-staff@example.test',
    role_name: 'staff',
    status: 'active',
  };
  for (const account of [promoted, demoted, staffChanged]) accounts.set(account.id, account);
  const sessionHeaders = (sessionId, accountId) => ({
    'x-test-session': sessionId,
    'x-test-account': accountId,
  });
  const patchAsAdmin = async (target, role) => {
    const adminRoleChange = target.role_name === 'admin' || role === 'admin';
    const body = {
      action: 'edit',
      role_change: true,
      admin_role_change: adminRoleChange,
      full_name: target.full_name,
      email: target.email,
      role_name: role,
      permissions: PERMISSIONS_BY_ROLE[role].map(({ key }) => key),
    };
    const headers = {
      'content-type': 'application/json',
      'x-test-user': admin.id,
    };
    const url = `${baseUrl}/admin/users/${target.id}`;
    if (!adminRoleChange) {
      return fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    }
    const challenge = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal(challenge.status, 200);
    assert.equal((await challenge.json()).verificationRequired, true);
    return fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ...body, role_change_code: '654321' }),
    });
  };
  const signIn = async (sessionId, account) => {
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-session': sessionId },
      body: JSON.stringify({ email: account.email, password: 'secure-password' }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.role_name, account.role_name);
  };

  try {
    for (const sessionId of ['promotion-old-a', 'promotion-old-b']) {
      const bootstrap = await fetch(`${baseUrl}/auth/me`, { headers: sessionHeaders(sessionId, promoted.id) });
      assert.equal((await bootstrap.json()).user.role_name, 'user');
    }
    const promotion = await patchAsAdmin(promoted, 'admin');
    assert.equal(promotion.status, 200);
    for (const sessionId of ['promotion-old-a', 'promotion-old-b']) {
      const response = await fetch(`${baseUrl}/admin/users`, { headers: sessionHeaders(sessionId, promoted.id) });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'Your access changed. Please sign in again.');
    }
    await signIn('promotion-fresh', promoted);
    const promotedAdminAccess = await fetch(`${baseUrl}/admin/users`, {
      headers: { 'x-test-session': 'promotion-fresh' },
    });
    assert.equal(promotedAdminAccess.status, 200);

    const demotionBootstrap = await fetch(`${baseUrl}/auth/me`, { headers: sessionHeaders('demotion-old', demoted.id) });
    assert.equal((await demotionBootstrap.json()).user.role_name, 'admin');
    const demotion = await patchAsAdmin(demoted, 'user');
    assert.equal(demotion.status, 200);
    const oldAdminAccess = await fetch(`${baseUrl}/admin/users`, { headers: sessionHeaders('demotion-old', demoted.id) });
    assert.equal(oldAdminAccess.status, 401);
    await signIn('demotion-fresh', demoted);
    const demotedUserAccess = await fetch(`${baseUrl}/items`, { headers: { 'x-test-session': 'demotion-fresh' } });
    assert.equal(demotedUserAccess.status, 200);

    const staffBootstrap = await fetch(`${baseUrl}/auth/me`, { headers: sessionHeaders('staff-old', staffChanged.id) });
    assert.equal((await staffBootstrap.json()).user.role_name, 'staff');
    const staffDemotion = await patchAsAdmin(staffChanged, 'user');
    assert.equal(staffDemotion.status, 200);
    const oldStaffAccess = await fetch(`${baseUrl}/staff/dashboard`, { headers: sessionHeaders('staff-old', staffChanged.id) });
    assert.equal(oldStaffAccess.status, 401);
    await signIn('staff-fresh', staffChanged);
    const refreshedUser = await fetch(`${baseUrl}/auth/me`, { headers: { 'x-test-session': 'staff-fresh' } });
    assert.equal((await refreshedUser.json()).user.role_name, 'user');

    const unchanged = await fetch(`${baseUrl}/auth/me`, { headers: { 'x-test-user': user.id } });
    assert.equal((await unchanged.json()).user.role_name, 'user');
    assert.equal((await fetch(`${baseUrl}/items`, { headers: { 'x-test-user': user.id } })).status, 200);
  } finally {
    for (const account of [promoted, demoted, staffChanged]) {
      accounts.delete(account.id);
      accountOverrides.delete(account.id);
    }
    for (const sessionId of [
      'promotion-old-a', 'promotion-old-b', 'promotion-fresh',
      'demotion-old', 'demotion-fresh', 'staff-old', 'staff-fresh',
    ]) testSessions.delete(sessionId);
    pendingRoleCodes.delete(`${admin.id}-session:role-change`);
  }
});

test('Admin access to shared item routes uses Admin role permissions', async () => {
  const saved = [...permissionsByRole.get('admin')];
  try {
    permissionsByRole.set('admin', saved.filter((permission) => permission !== 'view_all_items'));
    const response = await fetch(`${baseUrl}/items`, {
      headers: { 'x-test-user': admin.id },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'This feature is currently disabled by the administrator.');
  } finally {
    permissionsByRole.set('admin', saved);
  }
});

test('role defaults include active account counts for save confirmations', async () => {
  const response = await fetch(`${baseUrl}/admin/role-permissions`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(response.status, 200);
  const { roles } = await response.json();
  assert.deepEqual(roles.map(({ role }) => role), ['user', 'staff', 'admin']);
  assert.equal(roles.find(({ role }) => role === 'admin').active_accounts, 1);
});

test('System Records is admin-only and protected when opened directly by URL', async () => {
  const staffResponse = await fetch(`${baseUrl}/admin/system-records`, {
    headers: { 'x-test-user': staff.id },
  });
  assert.equal(staffResponse.status, 403);
  assert.equal(auditEvents.at(-1).action, 'access.denied');

  const anonymousResponse = await fetch(`${baseUrl}/admin/system-records`);
  assert.equal(anonymousResponse.status, 401);
  assert.equal(auditEvents.at(-1).actor_id, null);

  const adminResponse = await fetch(`${baseUrl}/admin/system-records`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(adminResponse.status, 200);
});

test('integration settings routes require admin role, CSRF, and a live PIN unlock', async () => {
  for (const account of [user, staff]) {
    for (const [path, method] of [
      ['/admin/settings/access', 'GET'],
      ['/admin/settings', 'GET'],
      ['/admin/settings', 'PUT'],
      ['/admin/settings/google_auth/verify', 'POST'],
      ['/admin/settings/unlock', 'POST'],
      ['/admin/settings/lock', 'POST'],
      ['/admin/settings/code/verify', 'POST'],
      ['/admin/settings/code/resend', 'POST'],
      ['/admin/settings/code/cancel', 'POST'],
      ['/admin/settings/verification-email/test', 'POST'],
      ['/admin/settings/smtp/test', 'POST'],
      ['/admin/settings/google-auth/test', 'POST'],
      ['/admin/settings/recaptcha/test', 'POST'],
      ['/admin/settings/google_auth/default', 'POST'],
      ['/admin/settings/google_auth/restore-default', 'POST'],
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'x-test-user': account.id,
          Origin: 'http://localhost:5173',
          'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify({ integrations: {} }),
      });
      assert.equal(response.status, 403, `${method} ${path} should be admin-only`);
    }
  }

  const anonymousResponse = await fetch(`${baseUrl}/admin/settings`);
  assert.equal(anonymousResponse.status, 401);

  const accessResponse = await fetch(`${baseUrl}/admin/settings/access`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(accessResponse.status, 200);
  const access = await accessResponse.json();
  assert.equal(access.unlocked, false);

  const lockedSettings = await fetch(`${baseUrl}/admin/settings`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(lockedSettings.status, 403);
  for (const [path, method] of [
    ['/admin/settings', 'PUT'],
    ['/admin/settings/google_auth/verify', 'POST'],
    ['/admin/settings/code/verify', 'POST'],
    ['/admin/settings/code/resend', 'POST'],
    ['/admin/settings/code/cancel', 'POST'],
    ['/admin/settings/smtp/test', 'POST'],
    ['/admin/settings/google-auth/test', 'POST'],
    ['/admin/settings/recaptcha/test', 'POST'],
    ['/admin/settings/google_auth/default', 'POST'],
    ['/admin/settings/google_auth/restore-default', 'POST'],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'x-test-user': admin.id,
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        'x-csrf-token': access.csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403, `${method} ${path} should require unlock`);
  }

  const unlockResponse = await fetch(`${baseUrl}/admin/settings/unlock`, {
    method: 'POST',
    headers: {
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'Content-Type': 'application/json',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({ pin: '123456' }),
  });
  assert.equal(unlockResponse.status, 200);

  const settingsResponse = await fetch(`${baseUrl}/admin/settings`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  assert.equal(JSON.stringify(settings).includes('full-secret-value'), false);

  const smtpTestResponse = await fetch(`${baseUrl}/admin/settings/smtp/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({}),
  });
  assert.equal(smtpTestResponse.status, 200);

  for (const path of ['/admin/settings/google-auth/test', '/admin/settings/recaptcha/test']) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': admin.id,
        Origin: 'http://localhost:5173',
        'x-csrf-token': access.csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200, `${path} should test the saved integration`);
    assert.equal((await response.json()).verified, true);
  }

  const savesBeforeCredentialCode = integrationSaveCount;
  const credentialPayload = {
    integrations: {
      google_auth: {
        enabled: true,
        fields: { client_id: 'new-client-id' },
      },
    },
  };
  const credentialSave = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify(credentialPayload),
  });
  const codeRequest = await credentialSave.json();
  assert.equal(credentialSave.status, 200);
  assert.equal(codeRequest.verificationRequired, true);
  assert.equal(JSON.stringify(codeRequest).includes('654321'), false);
  assert.equal(integrationSaveCount, savesBeforeCredentialCode);

  const invalidCode = await fetch(`${baseUrl}/admin/settings/code/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({ ...credentialPayload, code: '000000' }),
  });
  assert.equal(invalidCode.status, 400);
  assert.equal(integrationSaveCount, savesBeforeCredentialCode);

  const verifiedCredentialSave = await fetch(`${baseUrl}/admin/settings/code/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({ ...credentialPayload, code: '654321' }),
  });
  assert.equal(verifiedCredentialSave.status, 200);
  assert.equal(integrationSaveCount, savesBeforeCredentialCode + 1);

  const staffSmtpTestResponse = await fetch(`${baseUrl}/admin/settings/smtp/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': staff.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': 'invalid',
    },
    body: JSON.stringify({ fields: {} }),
  });
  assert.equal(staffSmtpTestResponse.status, 403);

  const deniedSave = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
    },
    body: JSON.stringify({ integrations: {} }),
  });
  assert.equal(deniedSave.status, 403);

  const session = testSessions.get(admin.id);
  session.integrationSettingsAccess.lastActivityAt = Date.now() - 600_001;
  const expiredSettings = await fetch(`${baseUrl}/admin/settings`, {
    headers: { 'x-test-user': admin.id },
  });
  assert.equal(expiredSettings.status, 403);

  const expiredSave = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({ integrations: {} }),
  });
  assert.equal(expiredSave.status, 403);

  await fetch(`${baseUrl}/admin/settings/unlock`, {
    method: 'POST',
    headers: {
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'Content-Type': 'application/json',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({ pin: '123456' }),
  });
  const saveResponse = await fetch(`${baseUrl}/admin/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'x-csrf-token': access.csrfToken,
    },
    body: JSON.stringify({ integrations: { google_auth: { enabled: false, fields: {} } } }),
  });
  assert.equal(saveResponse.status, 200);

  for (const oldPath of ['/admin/settings/google-auth', '/admin/settings/recaptcha']) {
    const oldRouteResponse = await fetch(`${baseUrl}${oldPath}`, {
      method: 'PATCH',
      headers: { 'x-test-user': admin.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(oldRouteResponse.status, 403);
  }
});

test('eleven rapid integration saves return 429 with Retry-After', async () => {
  const rateLimitedAdmin = {
    id: 'integration-rate-limit-admin',
    full_name: 'Rate Limit Admin',
    role_name: 'admin',
    status: 'active',
  };
  accounts.set(rateLimitedAdmin.id, rateLimitedAdmin);
  const headers = {
    'x-test-user': rateLimitedAdmin.id,
    Origin: 'http://localhost:5173',
    'Content-Type': 'application/json',
  };
  try {
    const accessResponse = await fetch(`${baseUrl}/admin/settings/access`, {
      headers: { 'x-test-user': rateLimitedAdmin.id },
    });
    const { csrfToken } = await accessResponse.json();
    const writeHeaders = { ...headers, 'x-csrf-token': csrfToken };
    const unlock = await fetch(`${baseUrl}/admin/settings/unlock`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ pin: '123456' }),
    });
    assert.equal(unlock.status, 200);

    const before = integrationSaveCount;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const saved = await fetch(`${baseUrl}/admin/settings`, {
        method: 'PUT',
        headers: writeHeaders,
        body: JSON.stringify({
          integrations: { google_auth: { enabled: false, fields: {} } },
        }),
      });
      assert.equal(saved.status, 200, `save ${attempt + 1} should be below the route limit`);
    }
    const limited = await fetch(`${baseUrl}/admin/settings`, {
      method: 'PUT',
      headers: writeHeaders,
      body: JSON.stringify({
        integrations: { google_auth: { enabled: false, fields: {} } },
      }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match((await limited.json()).error, /Too many attempts\. Try again in/);
    assert.equal(integrationSaveCount, before + 10);
  } finally {
    accounts.delete(rateLimitedAdmin.id);
    testSessions.delete(rateLimitedAdmin.id);
  }
});

test('role permission dependencies expand parents and reject unknown keys', () => {
  assert.deepEqual(normalizeRolePermissions('staff', ['approve_claim']), [
    'view_claims', 'verify_item_ownership', 'approve_claim',
  ]);
  assert.deepEqual(normalizeRolePermissions('user', ['filter_items']), [
    'view_items', 'search_items', 'filter_items',
  ]);
  assert.throws(() => normalizeRolePermissions('user', ['view_claims']), { status: 400 });
});

test('admin MFA routes require an admin session and CSRF on writes', async () => {
  const nonAdmin = await fetch(`${baseUrl}/admin/mfa`, {
    headers: { 'x-test-user': user.id },
  });
  assert.equal(nonAdmin.status, 403);

  const missingCsrf = await fetch(`${baseUrl}/admin/mfa/enrollment/start`, {
    method: 'POST',
    headers: {
      'x-test-user': admin.id,
      Origin: 'http://localhost:5173',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(missingCsrf.status, 403);
});

test('admin role permission save is audited and server-normalizes dependencies', async () => {
  const original = [...permissionsByRole.get('user')];
  try {
    const response = await fetch(`${baseUrl}/admin/role-permissions/user`, {
      method: 'PUT',
      headers: { 'x-test-user': admin.id, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['edit_my_report'] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).permissions, ['view_my_reports', 'edit_my_report']);
    const auditEvent = auditEvents.at(-1);
    assert.equal(auditEvent.action, 'role_permissions.update');
    assert.deepEqual(auditEvent.old_value.role, 'user');
    assert.deepEqual(auditEvent.new_value.permissions, ['view_my_reports', 'edit_my_report']);
    const blocked = await fetch(`${baseUrl}/items/mine`, { headers: { 'x-test-user': user.id } });
    assert.equal(blocked.status, 200);

    const invalidRole = await fetch(`${baseUrl}/admin/role-permissions/admin`, {
      method: 'PUT',
      headers: { 'x-test-user': admin.id, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.equal(invalidRole.status, 400);
  } finally {
    permissionsByRole.set('user', original);
  }
});

test('route permission map covers the declared user and staff features and auth exemptions remain unguarded', () => {
  const keys = ROLE_PERMISSION_ROUTE_MAP.map(({ method, path }) => `${method} ${path}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, note }) =>
    method === 'GET' && path === '/items' && note?.includes('multiple permissions')));
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, note }) =>
    method === 'PATCH' && path === '/staff/claims/:id' && note?.includes('approve_claim')));
  for (const [method, path] of [
    ['GET', '/health'], ['GET', '/auth/me'], ['POST', '/auth/login'],
    ['POST', '/auth/register'], ['POST', '/auth/logout'],
  ]) {
    assert.equal(ROLE_PERMISSION_ROUTE_MAP.some((entry) => entry.method === method && entry.path === path), false);
  }
});

test('every user and staff route is present in the role permission map', () => {
  const noop = (_req, _res, next) => next?.();
  const controllers = new Proxy({}, { get: () => new Proxy({}, { get: () => noop }) });
  const guards = new Proxy({}, { get: () => () => noop });
  const routeGroups = [
    ['/items', createItemsRoutes],
    ['/claims', createClaimsRoutes],
    ['/profile', createProfileRoutes],
    ['/notifications', createNotificationsRoutes],
    ['/staff', createStaffRoutes],
  ];
  const declared = routeGroups.flatMap(([prefix, createRoutes]) => {
    const router = createRoutes({ controllers, guards });
    return router.stack.flatMap((layer) => {
      if (!layer.route) return [];
      const path = layer.route.path === '/' ? prefix : `${prefix}${layer.route.path}`;
      return Object.keys(layer.route.methods)
        .filter((method) => method !== '_all')
        .map((method) => `${method.toUpperCase()} ${path}`);
    });
  });
  const mapped = ROLE_PERMISSION_ROUTE_MAP.map(({ method, path }) => `${method} ${path}`);
  assert.ok(declared.every((route) => mapped.includes(route)), 'every declared user/staff route must be mapped');
});

test('public health and authentication routes are explicitly listed as permission exemptions', () => {
  const noop = (_req, _res, next) => next?.();
  const controllers = new Proxy({}, { get: () => new Proxy({}, { get: () => noop }) });
  const declared = [
    ...createHealthRoutes().stack.flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`)),
    ...createAuthRoutes({ controllers, limit: () => noop }).stack.flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} /auth${layer.route.path}`)),
  ];
  const exempt = ROLE_PERMISSION_EXEMPT_ROUTES.map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(declared.sort(), exempt.sort());
});

test('invalid login is returned as a client error', async () => {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'unknown@example.com', password: 'bad-password' }),
  });
  assert.equal(response.status, 401);
  assert.equal(auditEvents.at(-1).action, 'auth.login_failed');
  assert.equal(auditEvents.at(-1).result, 'failed');
});

test('local password login remains available when Google sign-in is disabled', async () => {
  googleEnabled = false;
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'valid-password' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role_name, 'admin');
});

test('password reset keeps responses generic for unknown, inactive, failed, and rate-limited sends', async () => {
  const originalRequestPasswordReset = services.auth.requestPasswordReset;
  const originalSendPasswordReset = services.email.sendPasswordReset;
  const originalConsoleError = console.error;
  const deliveries = [];
  const serverLogs = [];
  services.auth.requestPasswordReset = async (email, sendEmail) => {
    if (email === 'known@example.test' || email === 'limited@example.test') {
      const delivery = sendEmail(email, 'test-reset-token');
      deliveries.push(delivery.then(() => undefined, () => undefined));
      await delivery;
    }
  };
  services.email.sendPasswordReset = async (email) => {
    if (email === 'limited@example.test') {
      throw new IntegrationError('smtp', 'rate_limited', { retryAfter: 10 });
    }
    throw new IntegrationError('smtp', 'invalid_credentials');
  };
  console.error = (...values) => serverLogs.push(values.join(' '));

  try {
    const request = (email) => fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const unknownResponse = await request('unknown@example.test');
    const unknownBody = await unknownResponse.json();
    const inactiveResponse = await request('inactive@example.test');
    const inactiveBody = await inactiveResponse.json();
    const knownResponse = await request('known@example.test');
    const knownBody = await knownResponse.json();
    const limitedResponse = await request('limited@example.test');
    const limitedBody = await limitedResponse.json();
    await Promise.all(deliveries);

    assert.equal(unknownResponse.status, 200);
    assert.equal(knownResponse.status, unknownResponse.status);
    assert.equal(inactiveResponse.status, unknownResponse.status);
    assert.equal(limitedResponse.status, unknownResponse.status);
    assert.deepEqual(inactiveBody, unknownBody);
    assert.deepEqual(knownBody, unknownBody);
    assert.deepEqual(limitedBody, unknownBody);
    assert.equal(knownBody.message, 'If an active account uses that email, reset instructions have been sent.');
    assert.equal(serverLogs.length, 2);
    assert.ok(serverLogs.every((entry) => !entry.includes('@example.test')
      && !entry.includes('test-reset-token')));
    assert.match(serverLogs.join(' '), /Password reset delivery failed/);
    assert.match(serverLogs.join(' '), /Password reset delivery was rate limited/);
  } finally {
    services.auth.requestPasswordReset = originalRequestPasswordReset;
    services.email.sendPasswordReset = originalSendPasswordReset;
    console.error = originalConsoleError;
  }
});

test('enabled reCAPTCHA is verified before password authentication', async () => {
  recaptchaEnabled = true;
  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unknown@example.com', password: 'bad-password' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Complete the reCAPTCHA challenge.');

    const registrationResponse = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'password' }),
    });
    assert.equal(registrationResponse.status, 400);
    assert.equal((await registrationResponse.json()).error, 'Complete the reCAPTCHA challenge.');

    const googleResponse = await fetch(`${baseUrl}/auth/google`);
    assert.equal(googleResponse.status, 400);
    assert.equal((await googleResponse.json()).error, 'Complete the reCAPTCHA challenge.');

    const googlePostResponse = await fetch(`${baseUrl}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(googlePostResponse.status, 400);
    assert.equal((await googlePostResponse.json()).error, 'Complete the reCAPTCHA challenge.');

    const verifiedResponse = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unknown@example.com',
        password: 'bad-password',
        'g-recaptcha-response': 'verified-test-token',
      }),
    });
    assert.equal(verifiedResponse.status, 401);
    assert.equal((await verifiedResponse.json()).error, 'Invalid credentials.');
  } finally {
    recaptchaEnabled = false;
  }
});

test('Google OAuth start returns its redirect URL after successful reCAPTCHA verification', async () => {
  const originalGoogleEnabled = googleEnabled;
  recaptchaEnabled = true;
  googleEnabled = true;
  try {
    const response = await fetch(`${baseUrl}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'g-recaptcha-response': 'verified-test-token' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, 'https://accounts.google.com/o/oauth2/auth?state=test');
  } finally {
    googleEnabled = originalGoogleEnabled;
    recaptchaEnabled = false;
  }
});

test('a user-cancelled Google sign-in does not invoke provider verification', async () => {
  const session = testSessions.get('anonymous') || {};
  const previous = session.googleOAuth;
  session.googleOAuth = {
    state: 'cancelled-state',
    codeVerifier: 'verifier',
    nonce: 'nonce',
  };
  testSessions.set('anonymous', session);
  let verificationCalls = 0;
  const originalVerification = services.googleOAuth.verifyAuthorizationResponse;
  services.googleOAuth.verifyAuthorizationResponse = async () => {
    verificationCalls += 1;
    throw new Error('Should not verify a user-cancelled authorization.');
  };

  try {
    const response = await fetch(
      `${baseUrl}/auth/google/callback?error=access_denied&state=cancelled-state`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'http://localhost:5173/?authError=google');
    assert.equal(verificationCalls, 0);
  } finally {
    services.googleOAuth.verifyAuthorizationResponse = originalVerification;
    if (previous === undefined) delete session.googleOAuth;
    else session.googleOAuth = previous;
  }
});

test('auth metadata includes the signed-in user and frontend configuration', async () => {
  const response = await fetch(`${baseUrl}/auth/me`, {
    headers: { 'x-test-user': user.id },
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.user.id, user.id);
  assert.equal(data.recaptcha.active, false);
  assert.ok(Array.isArray(data.categories));
});
