const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { createAdminController } = require('../controllers/admin-controller');
const { createIntegrationSettings } = require('../../src/services/integration-settings');
const { createIntegrationRouteLimit } = require('../middlewares/integration-route-limits');
const { createIntegrationCaller } = require('../../src/services/integration-calls');
const { createEmailService } = require('../../src/services/email');
const { createGoogleOAuth } = require('../../src/services/google-oauth');
const { createRecaptcha } = require('../../src/services/recaptcha');
const { createGoogleCalendar } = require('../../src/services/google-calendar');

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const GOOGLE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString().trim();
const WRONG_GOOGLE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString().trim();

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
    seen.googleRequests = (seen.googleRequests || 0) + 1;
    if (values.client_secret === 'google-candidate-secret') {
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
  adminMfa.verifyCandidate = async ({ adminId, values, proof }) => {
    seen.adminMfaCandidate = values;
    seen.adminMfaCode = proof?.code;
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
  });
  return {
    state, integrationSettings, audit, seen, sentHashes, controller,
    callIntegration, baseSettings, email,
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

function request(body, params = {}) {
  return {
    body,
    params,
    user: { id: 'test-admin', role_name: 'admin' },
    ip: '127.0.0.1',
    hostname: 'api.example.test',
    sessionID: 'test-session',
    session: {},
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
  await harness.controller.putAdminSettings(request({ integrations }), res);
  return res;
}

async function verify(harness, code, integrations) {
  const res = response();
  await harness.controller.postAdminSettingsCodeVerify(
    request({ code, integrations }), res,
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
      if (entry.id === 'google_auth') assert.equal(harness.seen.googleSecret === entry.secret, true);
      if (entry.id === 'admin_mfa') {
        assert.equal(harness.seen.adminMfaCandidate.issuer, 'Candidate issuer');
      }
      const after = await harness.integrationSettings.getIntegration(entry.id);
      assert.equal(
        JSON.stringify(after.settings) === JSON.stringify(before.settings),
        true,
        `${entry.id} active config must remain unchanged`,
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
  assert.match(rejected.body.error, /pending settings changed/);
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
  const settings = {
    async getIntegration() {
      return { settings: { rate_limit_per_minute: '1' } };
    },
    async recordIntegrationSuccess() {},
    async recordIntegrationFailure() { healthFailures += 1; },
    async claimIntegrationFailureAudit() { return true; },
  };
  const callIntegration = createIntegrationCaller({ integrationSettings: settings, audit });
  assert.equal(await callIntegration('smtp', async () => true), true);
  await assert.rejects(callIntegration('smtp', async () => true), (error) => (
    error.name === 'IntegrationRateLimitError'
    && error.code === 'rate_limited'
    && error.status === 429
    && error.message === 'Please try again shortly'
  ));
  assert.equal(healthFailures, 0);
  assert.ok(audit.events.some(({ action }) => action === 'integration.rate_limited'));
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
