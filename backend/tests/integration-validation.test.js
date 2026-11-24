const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { createAdminController } = require('../controllers/admin-controller');
const { createAuthController } = require('../controllers/auth-controller');
const { createIntegrationSettings } = require('../../src/services/integration-settings');
const { createIntegrationRouteLimit } = require('../middlewares/integration-route-limits');
const { createIntegrationCaller, IntegrationError } = require('../../src/services/integration-calls');
const { createEmailService: createEmailServiceWithLimiter } = require('../../src/services/email');
const { createGoogleOAuth: createGoogleOAuthWithLimiter } = require('../../src/services/google-oauth');
const { createRecaptcha: createRecaptchaWithLimiter } = require('../../src/services/recaptcha');
const { createGoogleCalendar } = require('../../src/services/google-calendar');
const { createIntegrationSecurity } = require('../../src/services/integration-security');

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const GOOGLE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString().trim();
const WRONG_GOOGLE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString().trim();

const testIntegrationCaller = (_integrationId, operation) => operation({
  signal: new AbortController().signal,
});
function createEmailService(...args) {
  if (typeof args[2] !== 'function') args[2] = testIntegrationCaller;
  return createEmailServiceWithLimiter(...args);
}
function createGoogleOAuth(...args) {
  if (typeof args[1] !== 'function') args[1] = testIntegrationCaller;
  return createGoogleOAuthWithLimiter(...args);
}
function createRecaptcha(...args) {
  if (typeof args[2] !== 'function') args[2] = testIntegrationCaller;
  return createRecaptchaWithLimiter(...args);
}

function createDatabase({ failWriteFor = null } = {}) {
  const documents = new Map();
  const control = { failWriteFor };
  const collection = {
    async findOne({ _id }) {
      const document = documents.get(_id);
      return document ? structuredClone(document) : null;
    },
    async updateOne({ _id }, update, { upsert = false } = {}) {
      if (_id === control.failWriteFor) throw new Error('Simulated database write failure.');
      let document = documents.get(_id);
      if (!document && !upsert) return { matchedCount: 0, modifiedCount: 0 };
      const inserted = !document;
      document ||= { _id };
      applyUpdate(document, update);
      documents.set(_id, document);
      return { matchedCount: inserted ? 0 : 1, modifiedCount: 1 };
    },
    async replaceOne({ _id }, replacement, { upsert = false } = {}) {
      if (!documents.has(_id) && !upsert) return { matchedCount: 0, modifiedCount: 0 };
      documents.set(_id, structuredClone(replacement));
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne({ _id }) {
      const deletedCount = documents.delete(_id) ? 1 : 0;
      return { deletedCount };
    },
  };
  return {
    database: { collection: () => collection },
    documents,
    control,
  };
}

function createSecurityDatabase() {
  const collections = new Map();
  function matches(document, filter) {
    return Object.entries(filter).every(([key, expected]) => {
      if (expected && typeof expected === 'object') {
        if ('$exists' in expected) return expected.$exists ? document[key] !== undefined : document[key] === undefined;
        if ('$lt' in expected) return document[key] < expected.$lt;
      }
      return document[key] === expected;
    });
  }
  function apply(document, changes) {
    for (const [key, value] of Object.entries(changes.$set || {})) document[key] = structuredClone(value);
    for (const [key, value] of Object.entries(changes.$inc || {})) document[key] = (document[key] || 0) + value;
    for (const key of Object.keys(changes.$unset || {})) delete document[key];
    for (const [key, value] of Object.entries(changes.$push || {})) {
      const entries = value && typeof value === 'object' && '$each' in value ? value.$each : [value];
      document[key] = [...(document[key] || []), ...structuredClone(entries)];
      if (value?.$slice < 0) document[key] = document[key].slice(value.$slice);
    }
  }
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const documents = collections.get(name);
      return {
        async findOne(filter) {
          const document = documents.get(filter._id);
          return document && matches(document, filter) ? structuredClone(document) : null;
        },
        async updateOne(filter, changes, { upsert = false } = {}) {
          let document = documents.get(filter._id);
          if (document && !matches(document, filter)) return { matchedCount: 0, modifiedCount: 0 };
          if (!document && !upsert) return { matchedCount: 0, modifiedCount: 0 };
          const inserted = !document;
          document ||= { _id: filter._id };
          apply(document, changes);
          documents.set(filter._id, document);
          return { matchedCount: inserted ? 0 : 1, modifiedCount: 1 };
        },
        async findOneAndUpdate(filter, changes, { upsert = false } = {}) {
          let document = documents.get(filter._id);
          if (!document && !upsert) return null;
          document ||= { _id: filter._id };
          apply(document, changes);
          documents.set(filter._id, document);
          return structuredClone(document);
        },
        async deleteOne(filter) {
          const document = documents.get(filter._id);
          if (document && matches(document, filter)) documents.delete(filter._id);
          return { deletedCount: document ? 1 : 0 };
        },
      };
    },
  };
}

function applyUpdate(document, update) {
  for (const [path, value] of Object.entries(update.$set || {})) {
    const parts = path.split('.');
    let target = document;
    while (parts.length > 1) {
      const part = parts.shift();
      target[part] ||= {};
      target = target[part];
    }
    target[parts[0]] = structuredClone(value);
  }
  for (const [path, value] of Object.entries(update.$setOnInsert || {})) {
    if (document[path] === undefined) document[path] = structuredClone(value);
  }
  for (const [path, value] of Object.entries(update.$inc || {})) {
    document[path] = (document[path] || 0) + value;
  }
  for (const path of Object.keys(update.$unset || {})) delete document[path];
}

function createAudit() {
  const events = [];
  return {
    events,
    async logAction(event) {
      events.push(structuredClone(event));
    },
    async runAction(entries, action) {
      const result = await action();
      events.push(...(Array.isArray(entries) ? entries : [entries]));
      return result;
    },
  };
}

async function createHarness({ failAdminMfa = false, failWriteFor = null } = {}) {
  const state = createDatabase({ failWriteFor });
  const integrationSettings = createIntegrationSettings(state.database, {
    encryptionKey: ENCRYPTION_KEY,
    env: {},
  });
  const audit = createAudit();
  const seen = {};
  const sentHashes = [];
  const baseSettings = {
    google_auth: {
      enabled: true,
      fields: {
        client_id: 'google-client-id',
        client_secret: 'google-original-secret',
        callback_url: 'https://example.test/api/auth/google/callback',
      },
    },
    recaptcha: {
      enabled: true,
      fields: {
        site_key: 'recaptcha-site-key',
        secret_key: 'recaptcha-original-secret',
      },
    },
    smtp: {
      enabled: true,
      fields: {
        host: 'smtp.example.test',
        port: '587',
        secure: false,
        user: 'mailer@example.test',
        password: 'smtp-original-secret',
        sender_email: 'notices@example.test',
        sender_name: 'Test Mailer',
      },
    },
    google_calendar: {
      enabled: true,
      fields: {
        calendar_id: 'pickup@example.test',
        service_account_email: 'calendar-bot@example.iam.gserviceaccount.com',
        private_key: GOOGLE_KEY,
        time_zone: 'Asia/Manila',
        office_location: 'BukSU SSC Office',
        pickup_open_time: '08:00',
        pickup_close_time: '17:00',
        pickup_monday: true,
        pickup_tuesday: true,
        pickup_wednesday: true,
        pickup_thursday: true,
        pickup_friday: true,
        pickup_saturday: true,
        pickup_sunday: false,
      },
    },
    admin_mfa: {
      enabled: false,
      fields: {
        issuer: 'Lost and Found System',
        window: '1',
      },
    },
  };
  await integrationSettings.saveIntegrations(baseSettings, audit, {});

  const callIntegration = createIntegrationCaller({ integrationSettings, audit });
  const email = createEmailService(integrationSettings.getIntegration, {
    createTransport(options) {
      return {
        async verify() {
          seen.smtpPassword = options.auth?.pass;
          seen.smtpVerifyRequests = (seen.smtpVerifyRequests || 0) + 1;
          if (options.auth?.pass === 'smtp-wrong-candidate-secret') {
            const error = new Error(`SMTP rejected ${options.auth.pass}`);
            error.code = 'EAUTH';
            error.responseCode = 535;
            throw error;
          }
        },
        async sendMail() {
          seen.smtpEmailsSent = (seen.smtpEmailsSent || 0) + 1;
        },
      };
    },
  }, callIntegration);
  const googleOAuth = createGoogleOAuth(
    integrationSettings.getIntegration,
    callIntegration,
    async (_url, options) => {
      const candidate = new URLSearchParams(options.body).get('client_secret');
      seen.googleSecret = candidate;
      seen.googleRequests = (seen.googleRequests || 0) + 1;
      const wrong = candidate === 'google-candidate-secret';
      return {
        ok: false,
        async json() {
          return wrong
            ? { error: 'invalid_client', error_description: candidate }
            : { error: 'invalid_grant' };
        },
      };
    },
  );
  const recaptcha = createRecaptcha(
    integrationSettings.getIntegration,
    async (_url, options) => {
      const candidate = new URLSearchParams(options.body).get('secret');
      seen.recaptchaSecret = candidate;
      const wrong = candidate === 'recaptcha-candidate-secret';
      return {
        ok: true,
        async json() {
          return wrong
            ? { success: false, 'error-codes': ['invalid-input-secret'] }
            : { success: false, 'error-codes': ['invalid-input-response'] };
        },
      };
    },
    callIntegration,
  );
  const calendarClient = {
    auth: {
      JWT: class {
        constructor(credentials) {
          this.key = credentials.key;
        }
      },
    },
    calendar({ auth }) {
      return {
        calendars: {
          async get() {
            seen.calendarPrivateKey = auth.key;
            if (auth.key === WRONG_GOOGLE_KEY) throw { response: { status: 401 } };
            return { data: { id: 'pickup@example.test' } };
          },
        },
      };
    },
  };
  const googleCalendar = createGoogleCalendar({
    integrationSettings,
    items: {},
    notifications: {},
    email,
    audit,
    callIntegration,
    client: calendarClient,
  });
  const adminMfa = {
    async selfTest(candidate) {
      seen.adminMfaCandidate = candidate;
      if (failAdminMfa) throw new Error('Admin MFA self-test failed.');
      return true;
    },
  };
  email.verifyCandidate = async (values) => {
    seen.smtpPassword = values.password;
    seen.smtpVerifyRequests = (seen.smtpVerifyRequests || 0) + 1;
    if (values.password === 'smtp-wrong-candidate-secret') {
      const error = new Error('SMTP credentials rejected.');
      error.code = 'invalid_credentials';
      error.status = 503;
      throw error;
    }
    return { verified: true, proofType: 'test_email_sent' };
  };
  googleCalendar.verifyCandidate = async (_context, values) => {
    seen.calendarPrivateKey = values.private_key;
    if (values.private_key === WRONG_GOOGLE_KEY) {
      const error = new Error('Calendar credentials rejected.');
      error.code = 'invalid_credentials';
      error.status = 503;
      throw error;
    }
    return { verified: true, proofType: 'test_event_created_and_removed' };
  };
  googleOAuth.verifyCandidate = async (_context, values) => {
    seen.googleSecret = values.client_secret;
    seen.googleClientId = values.client_id;
    seen.googleRequests = (seen.googleRequests || 0) + 1;
    if (values.client_secret === 'google-candidate-secret'
      || values.client_id === 'google-wrong-client-id') {
      const error = new Error('Google credentials rejected.');
      error.code = 'invalid_credentials';
      error.status = 503;
      throw error;
    }
    return { verified: true, proofType: 'real_sign_in' };
  };
  recaptcha.verifyCandidate = async (_context, values, proof) => {
    seen.recaptchaSecret = values.secret_key;
    seen.recaptchaProof = proof;
    if (values.secret_key === 'recaptcha-candidate-secret') {
      const error = new Error('reCAPTCHA credentials rejected.');
      error.code = 'invalid_credentials';
      error.status = 503;
      throw error;
    }
    return { verified: true, proofType: 'real_challenge' };
  };
  adminMfa.verifyCandidate = async ({ adminId, ipAddress, audit: verificationAudit, values, proof }) => {
    seen.adminMfaCandidate = values;
    seen.adminMfaVerification = {
      adminId,
      ipAddress,
      code: proof?.code,
      auditProvided: verificationAudit === audit,
    };
    if (failAdminMfa) throw new Error('Admin MFA proof failed.');
    return { verified: true, proofType: 'authenticator_code_accepted', adminId };
  };
  const integrationSecurity = {
    async sendCode({ payloadHash }) {
      sentHashes.push(payloadHash);
      return { expiresInSeconds: 600, resendInSeconds: 60 };
    },
    async verifyCode({ candidate, payloadHash }) {
      if (candidate !== '123456' || payloadHash !== sentHashes.at(-1)) {
        const error = new Error('The pending settings changed. Save again to request a new code.');
        error.status = 400;
        throw error;
      }
    },
  };
  const sessionState = {};
  const locks = {
    async withLocks(_requests, operation) {
      return operation({ async assertHeld() {} });
    },
  };
  const controller = createAdminController({
    auth: {},
    items: {},
    rolePermissions: {},
    notifications: {},
    integrationSettings,
    integrationSecurity,
    adminMfa,
    googleOAuth,
    recaptcha,
    googleCalendar,
    email,
    callIntegration,
    audit,
    frontendOrigin: 'https://frontend.example.test',
    locks,
  });
  return {
    state, integrationSettings, audit, seen, sentHashes, controller,
    callIntegration, baseSettings, email, googleOAuth, recaptcha, googleCalendar, adminMfa, sessionState, locks,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function request(body, params = {}, sessionState = {}) {
  return {
    body,
    params,
    user: { id: 'test-admin', role_name: 'admin' },
    ip: '127.0.0.1',
    hostname: 'api.example.test',
    sessionID: 'test-session',
    session: Object.assign(sessionState, {
      save(callback) { callback(); },
    }),
  };
}

test('verification route limits are scoped by admin and integration', () => {
  const limit = createIntegrationRouteLimit({
    limit: 1,
    windowMs: 60_000,
    bucketKey: (req) => `verification:${req.params.integrationId}`,
  });
  const hit = (adminId, integrationId) => {
    let nextCalled = false;
    const res = {
      statusCode: 200,
      set() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    limit({
      user: { id: adminId },
      ip: '127.0.0.1',
      params: { integrationId },
      path: `/admin/settings/${integrationId}/verify`,
    }, res, () => { nextCalled = true; });
    return { res, nextCalled };
  };

  assert.equal(hit('admin-1', 'smtp').nextCalled, true);
  assert.equal(hit('admin-1', 'smtp').res.statusCode, 429);
  assert.equal(hit('admin-1', 'recaptcha').nextCalled, true);
  assert.equal(hit('admin-2', 'smtp').nextCalled, true);
});

async function save(harness, integrations) {
  const res = response();
  await harness.controller.putAdminSettings(request({ integrations }, {}, harness.sessionState), res);
  return res;
}

async function verify(harness, code, integrations) {
  const res = response();
  await harness.controller.postAdminSettingsCodeVerify(
    request({ code, integrations }, {}, harness.sessionState), res,
  );
  return res;
}

async function verifyCandidate(harness, integrationId, body) {
  const res = response();
  await harness.controller.postAdminSettingsVerify(
    request(body, { integrationId }), res,
  );
  return res;
}

test('saving every integration sends its code through the independent bootstrap mailer', async () => {
  const harness = await createHarness();
  await harness.integrationSettings.saveIntegrations({
    admin_mfa: { enabled: true, fields: {} },
  }, harness.audit, {});
  const bootstrapMessages = [];
  const bootstrapTransports = [];
  let timestamp = 1_800_000_000_000;
  const integrationSecurity = createIntegrationSecurity(createSecurityDatabase(), {
    pin: 'test-pin',
    email: 'admin@example.test',
    smtp: {
      host: 'bootstrap.example.test',
      port: 587,
      secure: false,
      user: 'bootstrap-user',
      password: 'bootstrap-password',
      from: 'settings@example.test',
    },
    hashKey: randomBytes(32),
    now: () => timestamp,
    mailer: {
      createTransport(options) {
        bootstrapTransports.push(options);
        return { async sendMail(message) { bootstrapMessages.push(message); } };
      },
    },
  });
  const controller = createAdminController({
    auth: {},
    items: {},
    rolePermissions: {},
    notifications: {},
    integrationSettings: harness.integrationSettings,
    integrationSecurity,
    adminMfa: harness.adminMfa,
    googleOAuth: harness.googleOAuth,
    recaptcha: harness.recaptcha,
    googleCalendar: harness.googleCalendar,
    email: harness.email,
    callIntegration: harness.callIntegration,
    audit: harness.audit,
    frontendOrigin: 'https://frontend.example.test',
    locks: harness.locks,
  });
  const calendarKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString().trim();
  const candidates = [
    { google_auth: { enabled: true, fields: { client_secret: 'google-next-candidate-secret' } } },
    { recaptcha: { enabled: true, fields: { secret_key: 'recaptcha-next-candidate-secret' } } },
    { smtp: { enabled: true, fields: { password: 'smtp-next-candidate-secret' } } },
    { google_calendar: { enabled: true, fields: { private_key: calendarKey } } },
    { admin_mfa: { enabled: false, fields: {} } },
  ];
  const integrationIds = ['google_auth', 'recaptcha', 'smtp', 'google_calendar', 'admin_mfa'];
  for (const [index, integrations] of candidates.entries()) {
    if (index) timestamp += 60_000;
    const integrationId = integrationIds[index];
    if (['google_auth', 'recaptcha'].includes(integrationId)) {
      const verified = response();
      await controller.postAdminSettingsVerify(
        request(integrations[integrationId], { integrationId }),
        verified,
      );
      assert.equal(verified.statusCode, 200);
    }
    const send = response();
    await controller.putAdminSettings(
      request({ integrations }, {}, harness.sessionState), send,
    );
    assert.equal(send.body.verificationRequired, true, `integration index ${index}: ${send.body.error}`);
    assert.equal(send.body.maskedRecipient, 'a***@example.test');
    assert.ok(send.body.expiresAt);
    const code = /code is: (\d{6})/.exec(bootstrapMessages[index].text)[1];
    const apply = response();
    await controller.postAdminSettingsCodeVerify(
      request({ code, integrations }, {}, harness.sessionState), apply,
    );
    assert.equal(apply.statusCode, 200, `integration index ${index}: ${apply.body.error}`);
    assert.equal(bootstrapMessages[index].to, 'admin@example.test');
    assert.equal(bootstrapTransports[index].host, 'bootstrap.example.test');
    assert.equal(bootstrapTransports[index].auth.pass, 'bootstrap-password');
    assert.equal(JSON.stringify(harness.audit.events).includes(code), false);
  }
  assert.deepEqual(bootstrapMessages.map(({ to }) => to), Array(5).fill('admin@example.test'));
  assert.deepEqual(bootstrapTransports.map(({ host }) => host), Array(5).fill('bootstrap.example.test'));
  for (const integrationId of integrationIds) {
    assert.equal(
      (await harness.integrationSettings.getIntegration(integrationId)).enabled,
      integrationId !== 'admin_mfa',
    );
  }
  for (const candidate of candidates) {
    const candidateSecret = candidate.google_auth?.fields?.client_secret
      || candidate.recaptcha?.fields?.secret_key
      || candidate.smtp?.fields?.password
      || candidate.google_calendar?.fields?.private_key;
    if (candidateSecret) assert.equal(JSON.stringify(harness.audit.events).includes(candidateSecret), false);
  }
  const testEmail = response();
  await controller.postAdminSettingsVerificationEmailTest(request({}), testEmail);
  assert.deepEqual(testEmail.body, { sent: true, maskedRecipient: 'a***@example.test' });
  assert.equal(bootstrapMessages[5].subject, 'Verification email test');
});

test('enabling an integration requests an emailed code after candidate verification', async () => {
  const harness = await createHarness();
  await harness.integrationSettings.saveIntegrations({
    google_auth: { enabled: false, fields: {} },
  }, harness.audit, {});
  const candidate = {
    enabled: true,
    fields: {
      client_id: 'google-client-id',
      client_secret: 'google-original-secret',
      callback_url: 'https://example.test/api/auth/google/callback',
    },
  };
  const verified = response();
  await harness.controller.postAdminSettingsVerify(
    request(candidate, { integrationId: 'google_auth' }),
    verified,
  );
  assert.equal(verified.statusCode, 200);

  const saved = response();
  await harness.controller.putAdminSettings(request({
    integrations: { google_auth: candidate },
  }), saved);
  assert.equal(saved.body.verificationRequired, true);
  assert.equal(harness.sentHashes.length, 1);
});

test('reCAPTCHA Verify passes the one-use token and server-configured frontend hostname only to the verifier', async () => {
  const harness = await createHarness();
  const proofToken = 'single-use-recaptcha-token';
  const result = await verifyCandidate(harness, 'recaptcha', {
    enabled: true,
    fields: { secret_key: 'recaptcha-valid-candidate-secret' },
    proof: { token: proofToken, expectedHostname: 'attacker.example.test' },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(harness.seen.recaptchaProof.token, proofToken);
  assert.equal(harness.seen.recaptchaProof.expectedHostname, 'frontend.example.test');
  assert.equal('expectedHostname' in result.body, false);
  assert.equal(JSON.stringify([...harness.state.documents.values()]).includes(proofToken), false);
  assert.equal(JSON.stringify(harness.audit.events).includes(proofToken), false);
});

test('Admin MFA Verify binds the code to the saving admin and stores only verification metadata', async () => {
  const harness = await createHarness();
  const code = '654321';
  const payload = {
    enabled: true,
    fields: { require_for_all_admins: true },
  };
  const result = await verifyCandidate(harness, 'admin_mfa', { ...payload, proof: { code } });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(harness.seen.adminMfaVerification, {
    adminId: 'test-admin',
    ipAddress: '127.0.0.1',
    code,
    auditProvided: true,
  });
  assert.equal(result.body.verification.proofType, 'authenticator_code_accepted');
  const storedVerification = JSON.stringify(harness.state.documents.get('verification-admin_mfa'));
  assert.equal(storedVerification.includes(code), false);
  assert.equal(JSON.stringify(harness.audit.events).includes(code), false);
  assert.ok(harness.audit.events.some(({ action, target_id }) => (
    action === 'integration.verify_success' && target_id === 'admin_mfa'
  )));
  const saved = await save(harness, { admin_mfa: payload });
  assert.equal(saved.statusCode, 200);
  assert.equal(harness.sentHashes.length, 0);
  assert.ok(harness.state.documents.get('admin_mfa').defaults);
  assert.equal(
    (await harness.integrationSettings.getIntegration('admin_mfa')).settings.require_for_all_admins,
    true,
  );
  assert.equal(JSON.stringify(harness.audit.events).includes(code), false);
});

test('Google OAuth Verify starts a pending candidate-bound redirect without recording a completed proof', async () => {
  const harness = await createHarness();
  harness.googleOAuth.verifyCandidate = async (_context, _values, proof) => {
    harness.seen.googleVerificationProof = proof;
    return {
      pending: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
    };
  };
  const result = await verifyCandidate(harness, 'google_auth', {
    enabled: true,
    fields: { client_secret: 'google-pending-candidate-secret' },
    proof: { popup: true },
  });
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.verificationPending, true);
  assert.equal(result.body.authorizationUrl.startsWith('https://accounts.google.com/'), true);
  assert.equal(harness.seen.googleVerificationProof.adminId, 'test-admin');
  assert.equal(harness.seen.googleVerificationProof.popup, true);
  assert.equal(
    harness.seen.googleVerificationProof.candidateHash,
    harness.integrationSettings.getVerificationHash(
      'google_auth',
      true,
      await harness.integrationSettings.validateIntegrationFields('google_auth', {
        client_secret: 'google-pending-candidate-secret',
      }),
    ),
  );
  assert.equal(harness.audit.events.some(({ action }) => action === 'integration.verify_success'), false);
});

test('Google verification callback records proof without signing in or mutating the session', async () => {
  const harness = await createHarness();
  const settings = (await harness.integrationSettings.getIntegration('google_auth')).settings;
  const candidateHash = harness.integrationSettings.getVerificationHash(
    'google_auth',
    true,
    settings,
  );
  let authenticateCalls = 0;
  let clearedFailures = 0;
  const controller = createAuthController({
    auth: {
      async authenticateGoogle() {
        authenticateCalls += 1;
        return { id: 'signed-in-user', role_name: 'user' };
      },
    },
    googleOAuth: {
      async completeVerificationCallback({ state }) {
        return state === 'verification-state' ? {
          adminId: 'test-admin',
          candidateHash,
          enabled: true,
          settings,
          status: 'success',
          popup: true,
        } : null;
      },
      async verifyAuthorizationResponse({ code, codeVerifier, nonce }) {
        assert.deepEqual({ code, codeVerifier, nonce }, {
          code: 'ordinary-code',
          codeVerifier: 'ordinary-verifier',
          nonce: 'ordinary-nonce',
        });
        return { sub: 'ordinary-user', email: 'user@example.test', emailVerified: true };
      },
    },
    integrationSettings: harness.integrationSettings,
    adminMfa: { async getLoginAction() { return { action: 'allow' }; } },
    frontendOrigin: 'https://frontend.example.test',
    audit: harness.audit,
    callIntegration: {
      clearValidationFailures() { clearedFailures += 1; },
    },
  });
  const session = {
    googleOAuth: {
      state: 'ordinary-login-state',
      codeVerifier: 'ordinary-verifier',
      nonce: 'ordinary-nonce',
    },
    userId: 'existing-session-user',
    regenerate(callback) {
      delete this.googleOAuth;
      delete this.userId;
      delete this.user;
      callback();
    },
    save(callback) { callback(); },
  };
  const response = { redirectUrl: null, redirect(url) { this.redirectUrl = url; return this; } };
  await controller.getAuthGoogleCallback({
    query: { state: 'verification-state', code: 'oauth-code' },
    session,
    ip: '192.0.2.1',
  }, response);

  assert.match(response.redirectUrl, /googleAuthVerification=success/);
  assert.match(response.redirectUrl, /googleAuthPopup=1/);
  assert.equal(response.redirectUrl.includes('verification-state'), false);
  assert.equal(response.redirectUrl.includes('oauth-code'), false);
  assert.equal(authenticateCalls, 0);
  assert.equal(clearedFailures, 1);
  assert.deepEqual(session.googleOAuth, {
    state: 'ordinary-login-state',
    codeVerifier: 'ordinary-verifier',
    nonce: 'ordinary-nonce',
  });
  assert.equal(session.userId, 'existing-session-user');
  assert.equal(session.user, undefined);
  assert.ok(await harness.integrationSettings.getCurrentVerification(
    'test-admin',
    'google_auth',
    true,
    settings,
  ));
  assert.equal(await harness.integrationSettings.getCurrentVerification(
    'different-admin',
    'google_auth',
    true,
    settings,
  ), null);
  assert.equal(await harness.integrationSettings.getCurrentVerification(
    'test-admin',
    'google_auth',
    true,
    { ...settings, client_id: 'different-client-id' },
  ), null);
  assert.equal(JSON.stringify(harness.audit.events).includes('oauth-code'), false);
  assert.equal(JSON.stringify(harness.audit.events).includes('verification-state'), false);
  assert.equal(JSON.stringify(harness.audit.events).includes(settings.client_secret), false);
  assert.ok(harness.audit.events.some(({ action, actor_id }) => (
    action === 'integration.verify_success' && actor_id === 'test-admin'
  )));

  const normalResponse = { redirectUrl: null, redirect(url) { this.redirectUrl = url; return this; } };
  await controller.getAuthGoogleCallback({
    query: { state: 'ordinary-login-state', code: 'ordinary-code' },
    session,
    ip: '192.0.2.1',
  }, normalResponse);
  assert.equal(authenticateCalls, 1);
  assert.equal(normalResponse.redirectUrl, 'https://frontend.example.test');
  assert.equal(session.user.id, 'signed-in-user');
});

test('Google OAuth callback rejects a mismatched candidate hash and cannot authorize saving', async () => {
  const harness = await createHarness();
  const settings = (await harness.integrationSettings.getIntegration('google_auth')).settings;
  const controller = createAuthController({
    auth: {},
    googleOAuth: {
      async completeVerificationCallback() {
        return {
          adminId: 'test-admin',
          candidateHash: 'f'.repeat(64),
          enabled: true,
          settings,
          status: 'success',
        };
      },
    },
    integrationSettings: harness.integrationSettings,
    frontendOrigin: 'https://frontend.example.test',
    audit: harness.audit,
    callIntegration: { async recordValidationFailure() {} },
  });
  const response = { redirectUrl: null, redirect(url) { this.redirectUrl = url; return this; } };
  await controller.getAuthGoogleCallback({
    query: { state: 'verification-state', code: 'oauth-code' },
    session: {},
    ip: '192.0.2.1',
  }, response);

  assert.match(response.redirectUrl, /googleAuthVerification=failed/);
  assert.equal(new URL(response.redirectUrl).searchParams.has('googleAuthPopup'), false);
  assert.equal(response.redirectUrl.includes('verification-state'), false);
  assert.equal(response.redirectUrl.includes('oauth-code'), false);
  assert.equal(response.redirectUrl.includes(settings.client_secret), false);
  assert.equal(await harness.integrationSettings.getCurrentVerification(
    'test-admin',
    'google_auth',
    true,
    settings,
  ), null);
  const beforeDefault = structuredClone(harness.state.documents.get('google_auth').defaults);
  const before = await harness.integrationSettings.getIntegration('google_auth');
  const result = await save(harness, {
    google_auth: { enabled: true, fields: { client_secret: 'unverified-candidate-secret' } },
  });
  assert.equal(result.statusCode, 400);
  assert.equal(harness.sentHashes.length, 0);
  assert.equal(
    JSON.stringify((await harness.integrationSettings.getIntegration('google_auth')).settings),
    JSON.stringify(before.settings),
  );
  assert.deepEqual(harness.state.documents.get('google_auth').defaults, beforeDefault);
  assert.notEqual(
    (await harness.integrationSettings.getAdminIntegrations()).google_auth.status,
    'Failing',
  );
  const auditJson = JSON.stringify(harness.audit.events);
  assert.equal(auditJson.includes('verification-state'), false);
  assert.equal(auditJson.includes('oauth-code'), false);
  assert.equal(auditJson.includes('unverified-candidate-secret'), false);
});

test('Google OAuth proof is reused only for the exact re-entered candidate values', async () => {
  const harness = await createHarness();
  const payload = {
    enabled: true,
    fields: { client_secret: 'google-reusable-candidate-secret' },
  };
  const first = await verifyCandidate(harness, 'google_auth', payload);
  assert.equal(first.statusCode, 200);
  const requestsBeforeReuse = harness.seen.googleRequests;
  harness.googleOAuth.verifyCandidate = async () => {
    throw new Error('An exact unexpired proof should be reused without another OAuth request.');
  };

  const same = await verifyCandidate(harness, 'google_auth', payload);
  assert.equal(same.statusCode, 200);
  assert.equal(same.body.verification.proofType, 'real_sign_in');
  assert.equal(harness.seen.googleRequests, requestsBeforeReuse);

  const changed = await verifyCandidate(harness, 'google_auth', {
    enabled: true,
    fields: { client_secret: 'different-candidate-secret' },
  });
  assert.equal(changed.statusCode, 503);
});

test('wrong candidate credentials block every integration save without emailing or leaking secrets', async () => {
  const cases = [
    {
      id: 'smtp',
      secret: 'smtp-wrong-candidate-secret',
      fields: { password: 'smtp-wrong-candidate-secret' },
      observed: 'smtpPassword',
    },
    {
      id: 'google_calendar',
      secret: WRONG_GOOGLE_KEY,
      fields: { private_key: WRONG_GOOGLE_KEY },
      observed: 'calendarPrivateKey',
    },
    {
      id: 'recaptcha',
      secret: 'recaptcha-candidate-secret',
      fields: { secret_key: 'recaptcha-candidate-secret' },
      observed: 'recaptchaSecret',
    },
    {
      id: 'google_auth',
      secret: 'google-candidate-secret',
      fields: { client_secret: 'google-candidate-secret' },
      observed: 'googleSecret',
    },
      {
        id: 'google_auth',
        secret: 'google-wrong-client-id',
        fields: { client_id: 'google-wrong-client-id' },
        observed: 'googleClientId',
        expected: 'google-wrong-client-id',
      },
    {
      id: 'admin_mfa',
      secret: null,
      fields: { issuer: 'Candidate issuer' },
      enabled: true,
      failAdminMfa: true,
      observed: 'adminMfaCandidate',
    },
  ];
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  try {
    for (const entry of cases) {
      const harness = await createHarness({ failAdminMfa: entry.failAdminMfa });
      const before = await harness.integrationSettings.getIntegration(entry.id);
      const beforeDefault = structuredClone(harness.state.documents.get(entry.id)?.defaults);
      if (entry.id === 'google_calendar') {
        const candidatePlan = await harness.integrationSettings.prepareIntegrationSave({
          google_calendar: { enabled: true, fields: entry.fields },
        });
        assert.equal(candidatePlan.updates[0].values.private_key === entry.secret, true);
      }
      const payload = {
        enabled: entry.enabled ?? true,
        fields: entry.fields,
      };
      const result = ['google_auth', 'recaptcha', 'admin_mfa'].includes(entry.id)
        ? await verifyCandidate(harness, entry.id, payload)
        : await save(harness, { [entry.id]: payload });
      assert.equal(result.statusCode, 503, entry.id);
      assert.equal(result.body.error, entry.id === 'admin_mfa'
        ? 'Could not verify, try again'
        : 'Credentials rejected by provider');
      assert.ok(harness.audit.events.some(({ action, target_id }) => (
        action === 'integration.verify_failed' && target_id === entry.id
      )));
      assert.equal(harness.sentHashes.length, 0, `${entry.id} must not email a code`);
      assert.equal(harness.seen[entry.observed] !== undefined, true, `${entry.id} must validate candidate values`);
      if (entry.id === 'smtp') assert.equal(harness.seen.smtpPassword === entry.secret, true);
      if (entry.id === 'google_calendar') assert.equal(harness.seen.calendarPrivateKey === entry.secret, true);
      if (entry.id === 'recaptcha') assert.equal(harness.seen.recaptchaSecret === entry.secret, true);
      if (entry.id === 'google_auth' && entry.observed === 'googleSecret') {
        assert.equal(harness.seen.googleSecret === entry.secret, true);
      }
      if (entry.expected) assert.equal(harness.seen[entry.observed], entry.expected);
      if (entry.id === 'admin_mfa') {
        assert.equal(harness.seen.adminMfaCandidate.issuer, 'Candidate issuer');
      }
      const after = await harness.integrationSettings.getIntegration(entry.id);
      assert.equal(
        JSON.stringify(after.settings) === JSON.stringify(before.settings),
        true,
        `${entry.id} active config must remain unchanged`,
      );
      assert.deepEqual(
        harness.state.documents.get(entry.id)?.defaults,
        beforeDefault,
        `${entry.id} default must remain unchanged`,
      );
      assert.notEqual(
        (await harness.integrationSettings.getAdminIntegrations())[entry.id].status,
        'Failing',
      );
      if (entry.secret) {
        const scanned = JSON.stringify({
          response: result.body,
          logs,
          audit: harness.audit.events,
          documents: [...harness.state.documents.values()],
        });
        assert.equal(scanned.includes(entry.secret), false, `${entry.id} candidate secret leaked`);
      }
    }
  } finally {
    console.error = originalError;
  }
});

test('a provider without an explicit proof verifier fails closed', async () => {
  const harness = await createHarness();
  harness.email.verifyCandidate = undefined;
  const before = await harness.integrationSettings.getIntegration('smtp');
  const result = await save(harness, {
    smtp: {
      enabled: true,
      fields: { password: 'candidate-password' },
    },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error, 'Verification is not available yet.');
  assert.equal(harness.sentHashes.length, 0);
  assert.equal(
    JSON.stringify((await harness.integrationSettings.getIntegration('smtp')).settings),
    JSON.stringify(before.settings),
  );
  assert.ok(harness.audit.events.some(({ action }) => action === 'integration.verify_failed'));
});

test('one invalid card in a mixed save leaves every active configuration untouched', async () => {
  const harness = await createHarness();
  const googleBefore = await harness.integrationSettings.getIntegration('google_auth');
  const recaptchaBefore = await harness.integrationSettings.getIntegration('recaptcha');
  await verifyCandidate(harness, 'google_auth', {
    enabled: true,
    fields: { client_secret: 'google-valid-candidate-secret' },
  });
  const result = await verifyCandidate(harness, 'recaptcha', {
    enabled: true,
    fields: { secret_key: 'recaptcha-candidate-secret' },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(
    JSON.stringify((await harness.integrationSettings.getIntegration('google_auth')).settings)
      === JSON.stringify(googleBefore.settings),
    true,
  );
  assert.equal(
    JSON.stringify((await harness.integrationSettings.getIntegration('recaptcha')).settings)
      === JSON.stringify(recaptchaBefore.settings),
    true,
  );
  assert.equal(harness.sentHashes.length, 0);
});

test('interactive verification records are required before emailed-code delivery and save', async () => {
  const harness = await createHarness();
  const payload = {
    google_auth: {
      enabled: true,
      fields: { client_secret: 'google-valid-candidate-secret' },
    },
    recaptcha: {
      enabled: true,
      fields: { secret_key: 'recaptcha-valid-candidate-secret' },
    },
  };
  for (const [integrationId, candidate] of Object.entries(payload)) {
    const verified = await verifyCandidate(harness, integrationId, candidate);
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body.verification.verified, true);
  }
  const issued = await save(harness, payload);
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.body.verificationRequired, true);
  assert.equal(harness.seen.googleSecret === 'google-valid-candidate-secret', true);
  assert.equal(harness.seen.recaptchaSecret === 'recaptcha-valid-candidate-secret', true);
  assert.equal(harness.sentHashes.length, 1);
  const saved = await verify(harness, '123456', payload);
  assert.equal(saved.statusCode, 200);
  assert.equal(
    (await harness.integrationSettings.getIntegration('google_auth')).settings.client_secret
      === 'google-valid-candidate-secret',
    true,
  );
  assert.equal(
    (await harness.integrationSettings.getIntegration('recaptcha')).settings.secret_key
      === 'recaptcha-valid-candidate-secret',
    true,
  );
  assert.ok(harness.state.documents.get('google_auth').defaults);
  assert.ok(harness.state.documents.get('recaptcha').defaults);
});

test('interactive verification cannot be reused for a different or expired candidate', async () => {
  const harness = await createHarness();
  const verifiedPayload = {
    enabled: true,
    fields: { client_secret: 'google-verified-candidate-secret' },
  };
  const verified = await verifyCandidate(harness, 'google_auth', verifiedPayload);
  assert.equal(verified.statusCode, 200);

  const changed = await save(harness, {
    google_auth: {
      enabled: true,
      fields: { client_secret: 'google-changed-candidate-secret' },
    },
  });
  assert.equal(changed.statusCode, 400);
  assert.equal(harness.sentHashes.length, 0);

  const expiredHarness = await createHarness();
  const plan = await expiredHarness.integrationSettings.prepareIntegrationSave({
    google_auth: verifiedPayload,
  });
  await expiredHarness.integrationSettings.recordVerification({
    adminId: 'test-admin',
    integrationId: 'google_auth',
    enabled: true,
    values: plan.updates[0].values,
    proofType: 'real_sign_in',
    result: true,
    at: new Date(Date.now() - 10 * 60 * 1000 - 1),
  });
  const expired = await save(expiredHarness, { google_auth: verifiedPayload });
  assert.equal(expired.statusCode, 400);
  assert.equal(expiredHarness.sentHashes.length, 0);
});

test('unchanged cards are skipped and disabling a card does not validate credentials', async () => {
  const harness = await createHarness();
  const unchanged = await save(harness, {
    google_auth: { enabled: true, fields: {} },
  });
  assert.equal(unchanged.statusCode, 200);
  assert.deepEqual(unchanged.body.changed, []);
  assert.equal(harness.seen.googleSecret, undefined);
  const disabled = await save(harness, {
    google_auth: {
      enabled: false,
      fields: {},
    },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(harness.seen.googleSecret, undefined);
});

test('email-code save rejects a payload changed after validation', async () => {
  const harness = await createHarness();
  const original = 'smtp-candidate-secret';
  const initialPayload = {
    smtp: { enabled: true, fields: { password: original } },
  };
  const issued = await save(harness, initialPayload);
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.body.verificationRequired, true);
  assert.equal(harness.seen.smtpPassword === original, true);
  assert.equal(harness.seen.smtpVerifyRequests, 1);
  const changedPayload = {
    smtp: { enabled: true, fields: { password: 'tampered-secret' } },
  };
  const rejected = await verify(harness, '123456', changedPayload);
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body.error, /settings changed/i);
  assert.equal(harness.seen.smtpVerifyRequests, 1);
  assert.equal(
    (await harness.integrationSettings.getIntegration('smtp')).settings.password === 'smtp-original-secret',
    true,
  );
});

test('valid SMTP candidate is verified before code delivery and is not revalidated after the code', async () => {
  const harness = await createHarness();
  const candidate = 'smtp-candidate-secret';
  const payload = { smtp: { enabled: true, fields: { password: candidate } } };
  const issued = await save(harness, payload);
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.body.verificationRequired, true);
  assert.equal(harness.seen.smtpPassword === candidate, true);
  assert.equal(harness.sentHashes.length, 1);
  assert.equal(harness.seen.smtpVerifyRequests, 1);
  assert.equal(harness.seen.smtpEmailsSent || 0, 0);
  const saved = await verify(harness, '123456', payload);
  assert.equal(saved.statusCode, 200);
  assert.equal(harness.seen.smtpPassword === candidate, true);
  assert.equal(harness.seen.smtpVerifyRequests, 1);
  assert.equal((await harness.integrationSettings.getIntegration('smtp')).settings.password === candidate, true);
  assert.equal(saved.body.integrations.smtp.isCurrentVerification, true);
  assert.equal(saved.body.integrations.smtp.verification.proofType, 'test_email_sent');
  const verificationAudit = harness.audit.events.find(({ action }) => action === 'integration.verify_success');
  assert.deepEqual(verificationAudit.new_value, { proof_type: 'test_email_sent' });
  assert.ok(harness.state.documents.get('smtp').defaults);
});

test('validation cooldown starts after five failed provider validations', async () => {
  const harness = await createHarness();
  const payload = {
    google_auth: { enabled: true, fields: { client_secret: 'google-candidate-secret' } },
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await verifyCandidate(harness, 'google_auth', payload.google_auth);
    assert.equal(result.statusCode, 503);
  }
  const blocked = await verifyCandidate(harness, 'google_auth', payload.google_auth);
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.body.error, /Could not verify/);
  assert.equal(harness.seen.googleRequests, 5);
  assert.equal(harness.sentHashes.length, 0);
});

test('integration token bucket returns a typed error without marking health failing', async () => {
  const audit = createAudit();
  let healthFailures = 0;
  let timestamp = 0;
  const settings = {
    async getIntegration() {
      return { settings: { rate_limit_per_minute: '1' } };
    },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure() { healthFailures += 1; },
    async claimIntegrationFailureAudit() { return true; },
  };
  const callIntegration = createIntegrationCaller({
    integrationSettings: settings,
    audit,
    now: () => timestamp,
  });
  assert.equal(await callIntegration('smtp', async () => true), true);
  await assert.rejects(callIntegration('smtp', async () => true), (error) => (
    error instanceof IntegrationError
    && error.code === 'rate_limited'
    && error.status === 429
    && error.message === 'Please try again shortly'
    && error.retryAfter === 60
  ));
  assert.equal(healthFailures, 0);
  assert.equal(audit.events.filter(({ action }) => action === 'integration.rate_limited').length, 1);
  assert.deepEqual(audit.events[0].new_value, { suppressed_count: 0 });
  await assert.rejects(callIntegration('smtp', async () => true), { code: 'rate_limited' });
  assert.equal(audit.events.filter(({ action }) => action === 'integration.rate_limited').length, 1);
  timestamp += 10 * 60 * 1000;
  assert.equal(await callIntegration('smtp', async () => true), true);
  await assert.rejects(callIntegration('smtp', async () => true), { code: 'rate_limited' });
  assert.equal(audit.events.filter(({ action }) => action === 'integration.rate_limited').length, 2);
  assert.deepEqual(audit.events[1].new_value, { suppressed_count: 1 });
  timestamp += 60 * 1000;
  assert.equal(await callIntegration('smtp', async () => true), true);
  assert.equal(healthFailures, 0);
});

test('all integration buckets refill after a minute', async () => {
  const ids = ['google_auth', 'recaptcha', 'smtp', 'google_calendar', 'admin_mfa'];
  let timestamp = 0;
  const integrationSettings = {
    async getIntegration() { return { settings: { rate_limit_per_minute: '1' } }; },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure() { assert.fail('Rate limits must not record failures.'); },
  };
  const callIntegration = createIntegrationCaller({
    integrationSettings,
    audit: createAudit(),
    now: () => timestamp,
  });
  for (const id of ids) {
    assert.equal(await callIntegration(id, async () => true), true);
    await assert.rejects(callIntegration(id, async () => true), { code: 'rate_limited' });
  }
  timestamp += 60 * 1000;
  for (const id of ids) assert.equal(await callIntegration(id, async () => true), true);
});

test('limit changes add capacity when raised and cap available tokens when lowered', async () => {
  let timestamp = 0;
  let limit = 2;
  const integrationSettings = {
    async getIntegration() { return { settings: { rate_limit_per_minute: String(limit) } }; },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure() { assert.fail('Rate limits must not record failures.'); },
  };
  const callIntegration = createIntegrationCaller({
    integrationSettings,
    audit: createAudit(),
    now: () => timestamp,
  });
  await callIntegration('smtp', async () => true);
  limit = 4;
  for (let count = 0; count < 3; count += 1) {
    assert.equal(await callIntegration('smtp', async () => true), true);
  }
  await assert.rejects(callIntegration('smtp', async () => true), { code: 'rate_limited' });

  timestamp += 60 * 1000;
  limit = 4;
  const lowered = createIntegrationCaller({
    integrationSettings,
    audit: createAudit(),
    now: () => timestamp,
  });
  await lowered('google_calendar', async () => true);
  limit = 1;
  assert.equal(await lowered('google_calendar', async () => true), true);
  await assert.rejects(lowered('google_calendar', async () => true), { code: 'rate_limited' });
});

test('admin checks bypass the user-traffic bucket', async () => {
  const audit = createAudit();
  const integrationSettings = {
    async getIntegration() { return { settings: { rate_limit_per_minute: '1' } }; },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure() { assert.fail('Rate-limited checks must not mark health.'); },
  };
  const callIntegration = createIntegrationCaller({ integrationSettings, audit });
  await callIntegration('recaptcha', async () => true);
  for (let count = 0; count < 10; count += 1) {
    assert.equal(await callIntegration('recaptcha', async () => true, {}, {
      purpose: 'admin_check',
      candidateValidation: true,
    }), true);
  }
  await assert.rejects(callIntegration('recaptcha', async () => true), { code: 'rate_limited' });
  assert.equal(audit.events.filter(({ action }) => action === 'integration.rate_limited').length, 1);
});

test('reCAPTCHA user calls are limited while connection and candidate checks do not drain the bucket', async () => {
  const { createRecaptcha } = require('../../src/services/recaptcha');
  const integration = {
    configured: true,
    enabled: true,
    active: true,
    settings: { secret_key: 'active-secret' },
  };
  const settings = {
    async getIntegration() {
      return { ...integration, settings: { ...integration.settings, rate_limit_per_minute: '1' } };
    },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure() { assert.fail('Admin checks must not mark provider health.'); },
  };
  const callIntegration = createIntegrationCaller({ integrationSettings: settings, audit: createAudit() });
  const recaptcha = createRecaptcha(
    settings.getIntegration,
    async () => ({ ok: true, async json() { return { success: true }; } }),
    callIntegration,
  );
  assert.equal(await recaptcha.verifyResponse('user-token'), true);
  assert.equal(await recaptcha.testConnection(), true);
  assert.deepEqual(await recaptcha.verifyCandidate({}, {
    site_key: 'candidate-site-key-123456789012345',
    secret_key: 'candidate-secret-key-1234567890123456789',
  }, { token: 'admin-token' }), { verified: true, proofType: 'real_challenge' });
  await assert.rejects(recaptcha.verifyResponse('second-user-token'), {
    code: 'rate_limited',
    message: 'Please try again shortly',
  });
});

test('provider factories fail closed when callIntegration is not injected', () => {
  assert.throws(() => require('../../src/services/email').createEmailService(
    async () => ({ active: false, settings: {} }),
  ), /callIntegration is required/);
  assert.throws(() => require('../../src/services/google-oauth').createGoogleOAuth(
    async () => ({ active: false, configured: false, settings: {} }),
  ), /callIntegration is required/);
  assert.throws(() => require('../../src/services/recaptcha').createRecaptcha(
    async () => ({ active: false, configured: false, settings: {} }),
  ), /callIntegration is required/);
});

test('Set Default requires an active configuration with an exact unexpired verification', async () => {
  const harness = await createHarness();
  await assert.rejects(
    harness.integrationSettings.setIntegrationDefault('google_auth', harness.audit, {}),
    /no current verification/,
  );
  const testResult = response();
  await harness.controller.postAdminSettingsGoogleAuthTest(request({}), testResult);
  assert.equal(testResult.statusCode, 200);
  assert.equal(testResult.body.verified, true);
  assert.equal(testResult.body.integrations.google_auth.isCurrentVerification, true);
  await harness.integrationSettings.setIntegrationDefault('google_auth', harness.audit, {});
  assert.ok(harness.state.documents.get('google_auth').defaults);

  await harness.integrationSettings.saveIntegrations({
    google_auth: {
      enabled: true,
      fields: { client_id: 'changed-client-id' },
    },
  }, harness.audit, {});
  await assert.rejects(
    harness.integrationSettings.setIntegrationDefault('google_auth', harness.audit, {}),
    /no current verification/,
  );

  await harness.integrationSettings.saveIntegrations({
    google_auth: { enabled: false, fields: {} },
  }, harness.audit, {});
  await assert.rejects(
    harness.integrationSettings.setIntegrationDefault('google_auth', harness.audit, {}),
    /active integration/,
  );
});

test('non-transactional multi-card write failure restores previously written documents', async () => {
  const state = createDatabase();
  const integrationSettings = createIntegrationSettings(state.database, {
    encryptionKey: ENCRYPTION_KEY,
    env: {},
  });
  const audit = createAudit();
  const initial = await createHarness();
  await integrationSettings.saveIntegrations(initial.baseSettings, audit, {});
  state.control.failWriteFor = 'recaptcha';
  const beforeGoogle = await integrationSettings.getIntegration('google_auth');
  const beforeRecaptcha = await integrationSettings.getIntegration('recaptcha');
  const plan = await integrationSettings.prepareIntegrationSave({
    google_auth: { enabled: true, fields: { client_id: 'new-client-id' } },
    recaptcha: { enabled: true, fields: { site_key: 'new-site-key' } },
  });
  await assert.rejects(
    integrationSettings.applyIntegrationSave(plan, audit, {}),
    (error) => error.status === 503 && /No configuration changes were applied/.test(error.message),
  );
  assert.equal(
    JSON.stringify((await integrationSettings.getIntegration('google_auth')).settings)
      === JSON.stringify(beforeGoogle.settings),
    true,
  );
  assert.equal(
    JSON.stringify((await integrationSettings.getIntegration('recaptcha')).settings)
      === JSON.stringify(beforeRecaptcha.settings),
    true,
  );
});
