const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAdminController } = require('../controllers/admin-controller');
const { createAuthController } = require('../controllers/auth-controller');
const { createStaffController } = require('../controllers/staff-controller');
const { IntegrationError } = require('../../src/services/integration-calls');

function createAuditRecorder() {
  const events = [];
  return {
    events,
    async logAction(event) {
      events.push({ ...event, result: event.result || 'success' });
    },
    async runAction(input, action) {
      const result = await action(undefined);
      for (const event of Array.isArray(input) ? input : [input]) {
        events.push({
          ...event,
          target_id: typeof event.target_id === 'function' ? event.target_id(result) : event.target_id,
          result: 'success',
        });
      }
      return result;
    },
    async findRecords() {
      return { records: [], page: 1, page_size: 25, total: 0, total_pages: 0 };
    },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function adminRequest(body = {}, params = {}) {
  return {
    user: { id: 'admin-1', role_name: 'admin' },
    ip: '127.0.0.1',
    body,
    params,
    query: {},
  };
}

test('admin mutations audit safe values and soft-delete items', async () => {
  const audit = createAuditRecorder();
  const account = {
    id: 'user-1', full_name: 'Old Name', email: 'old@example.test',
    role_name: 'user', status: 'active', student_id: 'S-1', phone: null,
  };
  const item = {
    id: 'item-1', item_name: 'Wallet', category: 'Accessories',
    location: 'Library', date_lost: '2026-10-14', status: 'stored',
    identifying_details: 'NEVER AUDIT THIS CLAIM VERIFICATION DETAIL',
  };
  const controller = createAdminController({
    audit,
    auth: {
      async createAdminUser() {
        return { id: 'user-new', full_name: 'New User', email: 'new@example.test', role_name: 'user', status: 'active' };
      },
      async findAccountsForStaffAssignment() { return [account]; },
      async updateUserByAdmin() {},
      async setUserAccountStatus() {},
    },
    items: {
      async findAdminItem() { return item; },
      async updateAdminItem() {},
      async softDeleteAdminItem() {},
      async findInventoryReport() { return []; },
    },
    rolePermissions: {
      preparePermissions(_role, input) { return input.permissions; },
      async findRolePermissions() { return ['view_records']; },
      async replaceRolePermissions(role, permissions) {
        return { role, permissions, old_permissions: ['view_records'], changed: true };
      },
    },
    notifications: {},
    integrationSettings: {},
    googleOAuth: { enabled: false },
    googleCalendar: { async cleanupForItem() {} },
  });

  await controller.postAdminUsers(adminRequest({
    full_name: 'New User', email: 'new@example.test', password: 'NEVER AUDIT THIS PASSWORD',
  }), response());
  await controller.patchAdminUsersById(adminRequest({
    action: 'edit', full_name: 'New Name', email: 'new@example.test', student_id: 'S-1',
  }, { id: account.id }), response());
  await controller.patchAdminUsersById(adminRequest({ action: 'disable' }, { id: account.id }), response());
  await controller.putAdminRolePermissions(adminRequest({
    permissions: ['view_found_items'],
  }, { role: 'staff' }), response());
  await controller.patchAdminItemsById(adminRequest({
    item_name: 'Wallet', category: 'Accessories', location: 'Library',
    date_lost: '2026-10-14', identifying_details: 'NEVER AUDIT THIS CLAIM VERIFICATION DETAIL',
  }, { id: item.id }), response());
  await controller.deleteAdminItemsById(adminRequest({}, { id: item.id }), response());
  await controller.getAdminInventory(adminRequest(), response());

  assert.deepEqual(audit.events.map(({ action }) => action), [
    'user.create', 'user.update', 'user.disable', 'role_permissions.update',
    'item.update', 'item.remove', 'report.generate',
  ]);
  assert.deepEqual(audit.events[3].new_value, {
    role: 'staff',
    permissions: ['view_found_items'],
  });
  assert.deepEqual(audit.events[5].old_value, {
    id: 'item-1', item_name: 'Wallet', category: 'Accessories', status: 'stored',
  });
  const serialized = JSON.stringify(audit.events);
  assert.equal(serialized.includes('NEVER AUDIT THIS PASSWORD'), false);
  assert.equal(serialized.includes('NEVER AUDIT THIS CLAIM VERIFICATION DETAIL'), false);
});

test('staff claim decisions, status changes, and returns are audited without claim details', async () => {
  const audit = createAuditRecorder();
  const events = [];
  const controller = createStaffController({
    audit,
    googleCalendar: { async cleanupClaim() {} },
    items: {
      async findStaffItem() {
        return { id: 'item-1', status: 'found', physical_verification_status: 'pending' };
      },
      async updateItemStatus(_id, _staffId, status) {
        events.push(`status:${status}`);
      },
      async reviewClaim(_id, _staffId, decision) {
        events.push(`claim:${decision}`);
        return { id: 'claim-1' };
      },
      async findStaffClaim() {
        return {
          id: 'claim-1',
          status: 'approved',
          item: { id: 'item-1', status: 'claimed' },
          claim_details: 'NEVER AUDIT THIS CLAIM VERIFICATION DETAIL',
        };
      },
      async markItemReturned() {
        events.push('returned');
        return { id: 'claim-1' };
      },
    },
  });
  const staffRequest = (body, id) => ({
    user: { id: 'staff-1', role_name: 'staff' },
    ip: '127.0.0.1',
    body,
    params: { id },
    query: {},
  });

  await controller.patchStaffItemsByIdStatus(staffRequest({ status: 'stored' }, 'item-1'), response());
  await controller.patchStaffClaimsById(staffRequest({ action: 'review', decision: 'approved' }, 'claim-1'), response());
  await controller.patchStaffClaimsById(staffRequest({ action: 'review', decision: 'rejected' }, 'claim-1'), response());
  await controller.patchStaffClaimsById(staffRequest({ action: 'returned' }, 'claim-1'), response());

  assert.deepEqual(events, ['status:stored', 'claim:approved', 'claim:rejected', 'returned']);
  assert.deepEqual(audit.events.map(({ action }) => action), [
    'item.status_update', 'ownership.verify', 'claim.approve',
    'ownership.verify', 'claim.reject', 'item.mark_returned',
  ]);
  assert.equal(JSON.stringify(audit.events).includes('NEVER AUDIT THIS CLAIM VERIFICATION DETAIL'), false);
});

test('rate-limited Calendar sync does not block claim approval', async () => {
  const audit = createAuditRecorder();
  const calls = [];
  const claim = {
    id: 'claim-1',
    status: 'approved',
    pickup_at: '2030-01-07T08:30:00.000Z',
    pickup_location: 'Buksu SSC Office',
  };
  const controller = createStaffController({
    audit,
    googleCalendar: {
      async validatePickup() {
        return {
          pickup_at: claim.pickup_at,
          pickup_location: claim.pickup_location,
          pickup_time_zone: 'Asia/Manila',
        };
      },
      async syncApprovedClaim() {
        calls.push('calendar:failed');
        return { status: 'failed', reason: 'rate limited' };
      },
      async sendApprovalEmail() { calls.push('email'); return false; },
      async getPickupFormDefaults() { return {}; },
    },
    items: {
      async reviewClaim() { return claim; },
      async findStaffClaim() { return claim; },
    },
  });
  const res = response();
  await controller.patchStaffClaimsById({
    user: { id: 'staff-1', role_name: 'staff' },
    rolePermissions: ['approve_claim', 'schedule_pickup'],
    ip: '127.0.0.1',
    body: {
      action: 'review',
      decision: 'approved',
      pickup_date: '2030-01-07',
      pickup_time: '16:30',
      pickup_location: 'Buksu SSC Office',
    },
    params: { id: claim.id },
  }, res);

  assert.equal(res.body.claim.status, 'approved');
  assert.deepEqual(calls, ['calendar:failed', 'email']);
});

test('public reCAPTCHA provider errors return safe retryable responses', async () => {
  const makeController = (error) => createAuthController({
    auth: { async login() { throw new Error('Authentication must not run.'); } },
    recaptcha: { async verifyResponse() { throw error; } },
    integrationSettings: { async getIntegration() { return { enabled: true }; } },
  });
  const req = { body: { 'g-recaptcha-response': 'private-token' }, ip: '192.0.2.10' };

  const limitedResponse = response();
  await makeController(new IntegrationError('recaptcha', 'rate_limited', { retryAfter: 12 }))
    .postAuthLogin(req, limitedResponse);
  assert.equal(limitedResponse.statusCode, 429);
  assert.equal(limitedResponse.headers['Retry-After'], '12');
  assert.deepEqual(limitedResponse.body, { error: 'Please try again shortly' });

  const unavailableResponse = response();
  await makeController(new IntegrationError('recaptcha', 'network'))
    .postAuthLogin(req, unavailableResponse);
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(unavailableResponse.headers['Retry-After'], '60');
  assert.deepEqual(unavailableResponse.body, { error: 'Please try again shortly' });
});

test('rate-limited Google sign-in returns HTTP 429 without an auth-failure audit', async () => {
  const audit = createAuditRecorder();
  const controller = createAuthController({
    audit,
    auth: {},
    adminMfa: {},
    googleOAuth: {
      async verifyAuthorizationResponse() {
        throw new IntegrationError('google_auth', 'rate_limited', { retryAfter: 9 });
      },
    },
    integrationSettings: {
      async getIntegration() { return { active: true }; },
    },
    frontendOrigin: 'https://frontend.example.test',
  });
  const req = {
    query: { state: 'expected-state', code: 'private-code' },
    session: {
      googleOAuth: {
        state: 'expected-state',
        codeVerifier: 'private-verifier',
        nonce: 'private-nonce',
      },
      save(callback) { callback(); },
    },
    ip: '192.0.2.10',
  };
  const res = response();

  await controller.getAuthGoogleCallback(req, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '9');
  assert.deepEqual(res.body, { error: 'Please try again shortly' });
  assert.deepEqual(audit.events, []);
});

test('admin and staff logins are audited, and failed login never records credentials', async () => {
  const audit = createAuditRecorder();
  let nextUser = { id: 'admin-1', role_name: 'admin' };
  const controller = createAuthController({
    audit,
    adminMfa: { async getLoginAction() { return { action: 'complete' }; } },
    googleOAuth: { enabled: false },
    recaptcha: { configured: false, siteKey: '' },
    integrationSettings: {
      async getIntegration(id) {
        return id === 'recaptcha'
          ? { enabled: false, active: false, configured: false, settings: {} }
          : { enabled: false, active: false, configured: false, settings: {} };
      },
    },
    auth: {
      async login() {
        if (nextUser instanceof Error) throw nextUser;
        return nextUser;
      },
    },
  });
  const req = {
    body: { email: 'secret@example.test', password: 'NEVER AUDIT THIS PASSWORD' },
    ip: '127.0.0.1',
    session: {
      regenerate(callback) { callback(); },
      save(callback) { callback(); },
    },
  };
  await controller.postAuthLogin(req, response());
  nextUser = { id: 'staff-1', role_name: 'staff' };
  await controller.postAuthLogin(req, response());
  nextUser = Object.assign(new Error('Invalid credentials.'), { accountId: 'known-user' });
  await controller.postAuthLogin(req, response()).catch(() => {});

  assert.deepEqual(audit.events.map(({ action }) => action), [
    'auth.login', 'auth.login', 'auth.login_failed',
  ]);
  assert.equal(audit.events[0].actor_id, 'admin-1');
  assert.equal(audit.events[0].actor_role, 'admin');
  assert.equal(audit.events[2].target_id, 'known-user');
  assert.equal(audit.events[2].actor_id, null);
  assert.equal(JSON.stringify(audit.events).includes('secret@example.test'), false);
  assert.equal(JSON.stringify(audit.events).includes('NEVER AUDIT THIS PASSWORD'), false);
});
