const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { generate } = require('otplib');
const { createAdminMfa } = require('../../src/services/admin-mfa');
const { createIntegrationSettings } = require('../../src/services/integration-settings');
const { createAuthService } = require('../../src/services/auth');
const { createAuthController } = require('../controllers/auth-controller');
const { createAdminMfaSessionGuard } = require('../middlewares/session-auth');
const { createIntegrationCaller } = require('../../src/services/integration-calls');

const KEY = randomBytes(32).toString('base64');
const IP = '203.0.113.17';
const ADMIN = {
  _id: 'admin-1',
  email: 'admin@example.test',
  full_name: 'Test Admin',
  role_name: 'admin',
  status: 'active',
};

function createDatabase(initial = {}) {
  const collections = new Map();
  for (const [name, documents] of Object.entries(initial)) {
    collections.set(name, makeCollection(documents));
  }
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, makeCollection());
      return collections.get(name);
    },
    dump() {
      return Object.fromEntries([...collections].map(([name, collection]) => [name, collection.dump()]));
    },
  };
}

function makeCollection(initial = []) {
  const documents = new Map(initial.map((document) => [document._id, structuredClone(document)]));
  return {
    async findOne(filter) {
      const document = documents.get(filter._id);
      return document && matches(document, filter) ? structuredClone(document) : null;
    },
    async countDocuments(filter) {
      return [...documents.values()].filter((document) => matches(document, filter)).length;
    },
    async updateOne(filter, update, { upsert = false } = {}) {
      let document = documents.get(filter._id);
      if (document && !matches(document, filter)) return { matchedCount: 0, modifiedCount: 0 };
      if (!document && !upsert) return { matchedCount: 0, modifiedCount: 0 };
      const inserted = !document;
      document ||= { _id: filter._id };
      if (inserted) applySet(document, update.$setOnInsert);
      applySet(document, update.$set);
      for (const [path, amount] of Object.entries(update.$inc || {})) {
        setPath(document, path, (getPath(document, path) || 0) + amount);
      }
      for (const path of Object.keys(update.$unset || {})) deletePath(document, path);
      for (const [path, value] of Object.entries(update.$pull || {})) {
        const array = getPath(document, path) || [];
        setPath(document, path, array.filter((entry) => entry !== value));
      }
      documents.set(document._id, document);
      return { matchedCount: inserted ? 0 : 1, modifiedCount: 1, upsertedCount: inserted ? 1 : 0 };
    },
    async deleteOne(filter) {
      return { deletedCount: documents.delete(filter._id) ? 1 : 0 };
    },
    dump() {
      return [...documents.values()].map((document) => structuredClone(document));
    },
  };
}

function matches(document, filter) {
  for (const [path, expected] of Object.entries(filter)) {
    if (path === '$or') {
      if (!expected.some((clause) => matches(document, clause))) return false;
      continue;
    }
    const actual = getPath(document, path);
    if (Array.isArray(actual) && actual.includes(expected)) continue;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
      if ('$lt' in expected && !(actual < expected.$lt)) return false;
      if ('$gt' in expected && !(actual > expected.$gt)) return false;
      if ('$exists' in expected || '$lt' in expected || '$gt' in expected) continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const parts = path.split('.');
  let target = object;
  while (parts.length > 1) {
    const part = parts.shift();
    target[part] ||= {};
    target = target[part];
  }
  target[parts[0]] = structuredClone(value);
}

function deletePath(object, path) {
  const parts = path.split('.');
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value?.[part], object);
  if (parent) delete parent[key];
}

function applySet(document, values = {}) {
  for (const [path, value] of Object.entries(values)) setPath(document, path, value);
}

function setup({
  enrolled = false,
  required = true,
  disabled = false,
  rateLimitDisabled = false,
  integrationLimit = 30,
  nowValue = 1_800_000_000_000,
} = {}) {
  let now = nowValue;
  const user = structuredClone(ADMIN);
  if (enrolled) {
    user.admin_mfa = {
      enabled: true,
      secret: integrationSettingsPlaceholder(),
      recovery_hashes: [],
    };
  }
  const database = createDatabase({
    users: [user],
    integration_settings: [{
      _id: 'admin_mfa',
      enabled: true,
      values: {
        require_for_all_admins: required,
        issuer: 'Lost and Found System',
        window: '1',
        rate_limit_per_minute: String(integrationLimit),
      },
    }],
  });
  const integrationSettings = createIntegrationSettings(database, { encryptionKey: KEY, env: {} });
  if (enrolled) {
    user.admin_mfa.secret = integrationSettings.encryptSecret('JBSWY3DPEHPK3PXPGEZDGNBVGY3TQOJQ');
    database.collection('users').updateOne({ _id: user._id }, { $set: { admin_mfa: user.admin_mfa } });
  }
  const events = [];
  const audit = { async logAction(event) { events.push(structuredClone(event)); } };
  const callIntegration = createIntegrationCaller({
    integrationSettings,
    audit,
    now: () => now,
  });
  const service = createAdminMfa(database, integrationSettings, {
    disabled,
    rateLimitDisabled,
    now: () => now,
    callIntegration,
  });
  return {
    database,
    integrationSettings,
    service,
    events,
    audit,
    setNow(value) { now = value; },
    now() { return now; },
  };
}

test('Admin MFA rate buckets are keyed per administrator account', async () => {
  const state = setup({ enrolled: true, integrationLimit: 1 });
  const secondAdmin = {
    ...structuredClone(ADMIN),
    _id: 'admin-2',
    email: 'second-admin@example.test',
    admin_mfa: {
      enabled: true,
      secret: state.integrationSettings.encryptSecret('JBSWY3DPEHPK3PXPGEZDGNBVGY3TQOJQ'),
      recovery_hashes: [],
    },
  };
  await state.database.collection('users').updateOne(
    { _id: secondAdmin._id },
    { $set: secondAdmin },
    { upsert: true },
  );
  const code = await totp('JBSWY3DPEHPK3PXPGEZDGNBVGY3TQOJQ', state.now());
  await state.service.verifyLogin({
    adminId: ADMIN._id, ipAddress: IP, code, audit: state.audit,
  });
  await assert.rejects(state.service.verifyLogin({
    adminId: ADMIN._id, ipAddress: IP, code, audit: state.audit,
  }), (error) => error.code === 'rate_limited' && error.status === 429);
  assert.equal(await state.service.verifyLogin({
    adminId: secondAdmin._id, ipAddress: IP, code, audit: state.audit,
  }), true);
});

function integrationSettingsPlaceholder() {
  return { version: 1, iv: 'pending', tag: 'pending', data: 'pending' };
}

async function totp(secret, epoch) {
  return generate({
    secret,
    epoch: Math.floor(epoch / 1000),
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  });
}

test('admin MFA enrollment encrypts secrets, confirms TOTP, and returns recovery codes once', async () => {
  const state = setup();
  const beforeSelfTest = state.database.dump();
  assert.equal(await state.service.selfTest(), true);
  assert.deepEqual(state.database.dump(), beforeSelfTest);
  const setupResult = await state.service.startEnrollment({
    adminId: ADMIN._id, ipAddress: IP, audit: state.audit,
  });
  assert.match(setupResult.qrCode, /^data:image\/png;base64,/);
  assert.equal(setupResult.secret.length > 20, true);
  const storedPending = state.database.dump().users[0].admin_mfa.pending_secret;
  assert.equal(JSON.stringify(storedPending).includes(setupResult.secret), false);

  await assert.rejects(state.service.confirmEnrollment({
    adminId: ADMIN._id, ipAddress: IP, code: 'invalid', audit: state.audit,
  }), /could not be verified/);
  const code = await totp(setupResult.secret, state.now());
  const confirmed = await state.service.confirmEnrollment({
    adminId: ADMIN._id, ipAddress: IP, code, audit: state.audit,
  });
  assert.equal(confirmed.recoveryCodes.length, 8);

  const status = await state.service.getStatus(ADMIN._id);
  assert.equal(status.enrolled, true);
  assert.equal(status.recoveryCodesRemaining, 8);
  assert.equal(JSON.stringify(status).includes(setupResult.secret), false);
  const stored = JSON.stringify(state.database.dump());
  assert.equal(stored.includes(setupResult.secret), false);
  for (const recoveryCode of confirmed.recoveryCodes) assert.equal(stored.includes(recoveryCode), false);
  const auditLog = JSON.stringify(state.events);
  assert.equal(auditLog.includes(setupResult.secret), false);
  assert.equal(auditLog.includes(code), false);
  for (const recoveryCode of confirmed.recoveryCodes) assert.equal(auditLog.includes(recoveryCode), false);
  const auth = createAuthService(state.database);
  assert.equal('admin_mfa' in await auth.findActiveSessionUser(ADMIN._id), false);
  assert.deepEqual(state.events.map(({ action }) => action), [
    'admin.mfa_enroll_start', 'admin.mfa_verify_failed', 'admin.mfa_enrolled',
  ]);
});

test('Admin MFA integration proof requires the saving admin enrolled TOTP and runs the encryption self-test', async () => {
  const state = setup({ enrolled: true });
  let encryptionSelfTests = 0;
  state.integrationSettings.selfTestEncryption = () => {
    encryptionSelfTests += 1;
    return true;
  };
  const code = await totp('JBSWY3DPEHPK3PXPGEZDGNBVGY3TQOJQ', state.now());
  const proof = await state.service.verifyCandidate({
    adminId: ADMIN._id,
    ipAddress: IP,
    proof: { code },
    audit: state.audit,
  });

  assert.deepEqual(proof, {
    verified: true,
    proofType: 'authenticator_code_accepted',
  });
  assert.equal(encryptionSelfTests, 1);
  assert.equal(Number.isSafeInteger(state.database.dump().users[0].admin_mfa.last_time_step), true);
  assert.equal(JSON.stringify({ proof, database: state.database.dump(), events: state.events }).includes(code), false);
  await assert.rejects(state.service.verifyCandidate({
    adminId: ADMIN._id,
    ipAddress: IP,
    proof: { code },
    audit: state.audit,
  }), /could not be verified/);
  assert.equal(encryptionSelfTests, 2);

  await assert.rejects(state.service.verifyCandidate({
    adminId: 'different-admin',
    ipAddress: IP,
    proof: { code },
    audit: state.audit,
  }), /could not be verified/);
});

test('Admin MFA integration proof fails closed when enrollment or encryption self-test is unavailable', async () => {
  const notEnrolled = setup();
  await assert.rejects(notEnrolled.service.verifyCandidate({
    adminId: ADMIN._id,
    ipAddress: IP,
    proof: { code: '123456' },
    audit: notEnrolled.audit,
  }), /could not be verified/);
  assert.ok(notEnrolled.events.some(({ action }) => action === 'admin.mfa_verify_failed'));

  const selfTestFailure = setup({ enrolled: true });
  selfTestFailure.integrationSettings.selfTestEncryption = () => false;
  const code = await totp('JBSWY3DPEHPK3PXPGEZDGNBVGY3TQOJQ', selfTestFailure.now());
  await assert.rejects(selfTestFailure.service.verifyCandidate({
    adminId: ADMIN._id,
    ipAddress: IP,
    proof: { code },
    audit: selfTestFailure.audit,
  }), /Encryption self-test failed/);
  assert.equal(selfTestFailure.database.dump().users[0].admin_mfa.last_time_step, undefined);
});

test('Admin MFA integration proof rejects an invalid code without consuming its TOTP step', async () => {
  const state = setup({ enrolled: true });
  let encryptionSelfTests = 0;
  state.integrationSettings.selfTestEncryption = () => {
    encryptionSelfTests += 1;
    return true;
  };

  await assert.rejects(state.service.verifyCandidate({
    adminId: ADMIN._id,
    ipAddress: IP,
    proof: { code: '000000' },
    audit: state.audit,
  }), /could not be verified/);

  assert.equal(encryptionSelfTests, 1);
  assert.equal(state.database.dump().users[0].admin_mfa.last_time_step, undefined);
  assert.ok(state.events.some(({ action }) => action === 'admin.mfa_verify_failed'));
  assert.equal(JSON.stringify(state.events).includes('000000'), false);
});

test('admin MFA rejects TOTP replay, consumes recovery codes once, and regenerates codes with a fresh TOTP', async () => {
  const state = setup();
  const enrolled = await state.service.startEnrollment({
    adminId: ADMIN._id, ipAddress: IP, audit: state.audit,
  });
  await state.service.confirmEnrollment({
    adminId: ADMIN._id,
    ipAddress: IP,
    code: await totp(enrolled.secret, state.now()),
    audit: state.audit,
  });
  const firstRecovery = (await state.service.getStatus(ADMIN._id)).recoveryCodesRemaining;
  const account = state.database.dump().users[0];
  const storedHashes = account.admin_mfa.recovery_hashes;
  assert.equal(storedHashes.length, firstRecovery);
  const code = await totp(enrolled.secret, state.now());
  await assert.rejects(state.service.verifyLogin({
    adminId: ADMIN._id, ipAddress: IP, code, audit: state.audit,
  }), /could not be verified/);

  const recoveryCode = 'AAAA-BBBB-CCCC-DDDD';
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update('AAAABBBBCCCCDDDD').digest('hex');
  await state.database.collection('users').updateOne(
    { _id: ADMIN._id },
    { $set: { 'admin_mfa.recovery_hashes': [hash] } },
  );
  await state.service.verifyLogin({
    adminId: ADMIN._id, ipAddress: IP, code: recoveryCode, audit: state.audit,
  });
  await assert.rejects(state.service.verifyLogin({
    adminId: ADMIN._id, ipAddress: IP, code: recoveryCode, audit: state.audit,
  }), /could not be verified/);

  state.setNow(state.now() + 30_000);
  const freshCode = await totp(enrolled.secret, state.now());
  const regenerated = await state.service.regenerateRecoveryCodes({
    adminId: ADMIN._id, ipAddress: IP, code: freshCode, audit: state.audit,
  });
  assert.equal(regenerated.recoveryCodes.length, 8);
  assert.equal((await state.service.getStatus(ADMIN._id)).recoveryCodesRemaining, 8);
  assert.equal(state.events.some(({ action }) => action === 'admin.mfa_recovery_used'), true);
  assert.equal(state.events.some(({ action }) => action === 'admin.mfa_recovery_regenerated'), true);
});

test('disabling MFA or relaxing the all-admin requirement requires emailed credential verification', async () => {
  const state = setup({ required: true });
  const turningOff = await state.integrationSettings.prepareIntegrationSave({
    admin_mfa: {
      enabled: false,
      fields: { require_for_all_admins: false, issuer: 'Lost and Found System', window: '1' },
    },
  });
  assert.deepEqual(turningOff.credentialChanges, [{
    integration: 'admin_mfa',
    fields: ['enabled', 'require_for_all_admins'],
  }]);

  const changingIssuer = await state.integrationSettings.prepareIntegrationSave({
    admin_mfa: {
      enabled: true,
      fields: { require_for_all_admins: true, issuer: 'New Issuer', window: '0' },
    },
  });
  assert.deepEqual(changingIssuer.credentialChanges, []);
  await assert.rejects(state.integrationSettings.prepareIntegrationSave({
    admin_mfa: {
      enabled: true,
      fields: { require_for_all_admins: true, issuer: 'New Issuer', window: '2' },
    },
  }), /highlighted integration settings/);
});

test('admin MFA requires enrollment for all admins, locks after five failures, then unlocks after fifteen minutes', async () => {
  const state = setup({ enrolled: true });
  assert.equal(await state.service.canAccessAdminRoutes(
    { ...ADMIN, id: 'unenrolled' },
    { user: { id: 'unenrolled' } },
    IP,
  ), false);
  assert.deepEqual(await state.service.getLoginAction({ ...ADMIN, id: ADMIN._id }, IP), { action: 'verify' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(state.service.verifyLogin({
      adminId: ADMIN._id, ipAddress: IP, code: 'not-a-code', audit: state.audit,
    }), /could not be verified/);
  }
  assert.equal(state.events.filter(({ action }) => action === 'admin.mfa_verify_failed').length, 5);
  assert.equal(state.events.filter(({ action }) => action === 'admin.mfa_locked').length, 1);
  assert.deepEqual(await state.service.getLoginAction({ ...ADMIN, id: ADMIN._id }, IP), { action: 'locked' });
  state.setNow(state.now() + 15 * 60 * 1000 + 1);
  assert.deepEqual(await state.service.getLoginAction({ ...ADMIN, id: ADMIN._id }, IP), { action: 'verify' });
  assert.deepEqual(await state.service.getLoginAction({ ...ADMIN, id: 'unenrolled' }, IP), { action: 'enroll' });
});

test('disabled admin MFA bypasses login checks and session route gates', async () => {
  const state = setup({ enrolled: true, disabled: true });
  assert.deepEqual(await state.service.getLoginAction({ ...ADMIN, id: ADMIN._id }, IP), { action: 'complete' });
  assert.equal(await state.service.canAccessAdminRoutes({ ...ADMIN, id: ADMIN._id }, {}, IP), true);
});

test('local rate-limit bypass allows repeated setup and failed codes without removing MFA checks', async () => {
  const state = setup({ rateLimitDisabled: true });
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await state.service.startEnrollment({
      adminId: ADMIN._id, ipAddress: IP, audit: state.audit,
    });
  }
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await assert.rejects(state.service.confirmEnrollment({
      adminId: ADMIN._id, ipAddress: IP, code: 'not-a-code', audit: state.audit,
    }), /could not be verified/);
  }
  assert.equal(state.events.filter(({ action }) => action === 'admin.mfa_verify_failed').length, 7);
  assert.equal(state.events.some(({ action }) => action === 'admin.mfa_locked'), false);
  assert.equal(state.database.dump().admin_mfa_attempts.length, 0);
});

test('password admin login creates only a pending MFA session until code verification', async () => {
  const adminUser = { id: ADMIN._id, email: ADMIN.email, role_name: 'admin', status: 'active' };
  const events = [];
  const controller = createAuthController({
    auth: {
      async login() { return adminUser; },
      async findActiveSessionUser() { return adminUser; },
    },
    rolePermissions: { async findRolePermissions() { return []; } },
    email: {},
    googleOAuth: {},
    recaptcha: {},
    integrationSettings: {
      async getIntegration() { return { enabled: false, active: false, settings: {} }; },
    },
    adminMfa: {
      async getLoginAction() { return { action: 'verify' }; },
      async verifyLogin(input) { assert.equal(input.code, '123456'); },
    },
    notifications: {},
    frontendOrigin: 'https://example.test',
    audit: { async logAction(event) { events.push(event); } },
  });
  const req = request(ADMIN._id);
  const loginResponse = response();
  await controller.postAuthLogin(req, loginResponse);
  assert.deepEqual(loginResponse.body, { mfaRequired: true });
  assert.equal(req.session.user, undefined);
  assert.equal(req.session.pendingAdminMfa.userId, ADMIN._id);
  assert.ok(req.session.pendingAdminMfa.expiresAt > Date.now());
  assert.equal(events.some(({ action }) => action === 'auth.login'), false);

  req.body = { code: '123456' };
  const verifyResponse = response();
  await controller.postAuthMfaVerify(req, verifyResponse);
  assert.equal(verifyResponse.body.user.id, ADMIN._id);
  assert.equal(req.session.adminMfaVerified, ADMIN._id);
  assert.equal(req.session.pendingAdminMfa, undefined);
  assert.equal(events.some(({ action }) => action === 'auth.login'), true);
});

test('Google admin login creates a pending MFA session and does not complete sign-in', async () => {
  const adminUser = { id: ADMIN._id, email: ADMIN.email, role_name: 'admin', status: 'active' };
  const controller = createAuthController({
    auth: { async authenticateGoogle() { return adminUser; } },
    rolePermissions: { async findRolePermissions() { return []; } },
    email: {},
    googleOAuth: {
      async verifyAuthorizationResponse() {
        return { sub: 'google-sub', email: ADMIN.email, emailVerified: true };
      },
    },
    recaptcha: {},
    integrationSettings: {
      async getIntegration() { return { enabled: true, active: true, settings: {} }; },
    },
    adminMfa: { async getLoginAction() { return { action: 'verify' }; } },
    notifications: {},
    frontendOrigin: 'https://example.test',
    audit: { async logAction() {} },
  });
  const req = request();
  req.session.googleOAuth = { state: 'state', codeVerifier: 'verifier', nonce: 'nonce' };
  req.query = { state: 'state', code: 'google-code' };
  const res = response();
  await controller.getAuthGoogleCallback(req, res);
  assert.equal(res.redirectedTo, 'https://example.test/?page=admin-mfa-verify');
  assert.equal(req.session.user, undefined);
  assert.equal(req.session.pendingAdminMfa.userId, ADMIN._id);
  assert.ok(req.session.pendingAdminMfa.expiresAt > Date.now());
});

test('expired pending MFA state is destroyed and cannot complete login', async () => {
  const controller = createAuthController({
    auth: { async findActiveSessionUser() { return { id: ADMIN._id, role_name: 'admin' }; } },
    rolePermissions: {},
    email: {},
    googleOAuth: {},
    recaptcha: {},
    integrationSettings: {},
    adminMfa: {},
    notifications: {},
    frontendOrigin: 'https://example.test',
    audit: {},
  });
  const req = request();
  req.session.pendingAdminMfa = { userId: ADMIN._id, attemptId: 'attempt', expiresAt: Date.now() - 1 };
  const res = response();
  await assert.rejects(controller.postAuthMfaVerify(req, res), (error) => error.status === 401);
  assert.equal(req.session.pendingAdminMfa, undefined);
  assert.equal(req.session.user, undefined);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('MFA verification without a pending attempt does not destroy another signed-in session', async () => {
  const controller = createAuthController({
    auth: {},
    rolePermissions: {},
    email: {},
    googleOAuth: {},
    recaptcha: {},
    integrationSettings: {},
    adminMfa: {},
    notifications: {},
    frontendOrigin: 'https://example.test',
    audit: {},
  });
  const req = request();
  req.session.user = { id: 'existing-user', role_name: 'user' };
  const res = response();
  await assert.rejects(controller.postAuthMfaVerify(req, res), (error) => error.status === 401);
  assert.equal(req.session.user.id, 'existing-user');
});

test('restricted admin setup sessions can sign out or restart login but cannot access admin resources', async () => {
  const guard = createAdminMfaSessionGuard({
    async canAccessAdminRoutes() { return false; },
  });
  const adminUser = { id: ADMIN._id, role_name: 'admin', status: 'active' };
  for (const [method, path] of [
    ['GET', '/auth/me'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/login'],
    ['GET', '/auth/google'],
    ['GET', '/auth/google/callback'],
  ]) {
    let forwardedError;
    let continued = false;
    await guard({
      method,
      path,
      ip: IP,
      session: { user: adminUser },
      app: { locals: { services: { auth: { async findActiveSessionUser() { return adminUser; } } } } },
    }, {}, (error) => {
      forwardedError = error;
      continued = !error;
    });
    assert.equal(forwardedError, undefined, `${method} ${path} should remain reachable`);
    assert.equal(continued, true, `${method} ${path} should continue`);
  }

  let blockedError;
  await guard({
    method: 'GET',
    path: '/admin/dashboard',
    ip: IP,
    session: { user: adminUser },
    app: { locals: { services: { auth: { async findActiveSessionUser() { return adminUser; } } } } },
  }, {}, (error) => { blockedError = error; });
  assert.equal(blockedError.status, 403);
});

function request(userId) {
  const session = {
    regenerate(callback) {
      for (const key of Object.keys(this)) {
        if (!['regenerate', 'save', 'destroy'].includes(key)) delete this[key];
      }
      callback();
    },
    save(callback) { callback(); },
    destroy(callback) {
      for (const key of Object.keys(this)) {
        if (!['regenerate', 'save', 'destroy'].includes(key)) delete this[key];
      }
      callback();
    },
  };
  return {
    body: { email: ADMIN.email, password: 'valid-password' },
    ip: IP,
    session,
    sessionID: 'session-id',
    params: {},
    query: {},
    get() { return undefined; },
    user: userId ? { id: userId, role_name: 'admin' } : undefined,
  };
}

function response() {
  return {
    body: null,
    statusCode: 200,
    headers: {},
    json(value) { this.body = value; return this; },
    status(value) { this.statusCode = value; return this; },
    redirect(value) { this.redirectedTo = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}
