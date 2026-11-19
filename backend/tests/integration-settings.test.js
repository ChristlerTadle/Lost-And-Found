const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { createIntegrationSettings, parseEncryptionKey } = require('../../src/services/integration-settings');
const { createEmailService: createEmailServiceWithLimiter } = require('../../src/services/email');
const { createGoogleOAuth: createGoogleOAuthWithLimiter } = require('../../src/services/google-oauth');
const { createIntegrationCaller, IntegrationError } = require('../../src/services/integration-calls');

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

const KEY = randomBytes(32).toString('base64');
const ENV = {
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  API_GOOGLE_REDIRECT_URI: 'https://example.test/api/auth/google/callback',
  RECAPTCHA_SITE_KEY: 'recaptcha-site-key',
  RECAPTCHA_SECRET_KEY: 'recaptcha-secret-key',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'mailer@example.test',
  SMTP_PASSWORD: 'smtp-private-password',
  SMTP_FROM: 'BukSU Notices <notices@example.test>',
};

function createDatabase(initialDocuments = []) {
  const documents = new Map(initialDocuments.map((document) => [document._id, structuredClone(document)]));
  let writeCount = 0;
  const collection = {
    async findOne({ _id }) {
      const document = documents.get(_id);
      return document ? structuredClone(document) : null;
    },
    async updateOne(filter, update, { upsert = false } = {}) {
      const { _id } = filter;
      let document = documents.get(_id);
      if (document && !matchesFilter(document, filter)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (!document && !upsert) return { matchedCount: 0, modifiedCount: 0 };
      const inserted = !document;
      document ||= { _id };
      if (inserted) applySet(document, update.$setOnInsert);
      applySet(document, update.$set);
      for (const [path, value] of Object.entries(update.$inc || {})) {
        document[path] = (document[path] || 0) + value;
      }
      for (const path of Object.keys(update.$unset || {})) delete document[path];
      documents.set(_id, document);
      writeCount += 1;
      return { matchedCount: inserted ? 0 : 1, modifiedCount: 1, upsertedCount: inserted ? 1 : 0 };
    },
    async bulkWrite(operations) {
      for (const { updateOne } of operations) {
        const document = documents.get(updateOne.filter._id) || { _id: updateOne.filter._id };
        applySet(document, updateOne.update.$set);
        documents.set(document._id, document);
      }
      writeCount += 1;
    },
  };
  return {
    database: { collection() { return collection; } },
    documents,
    get writeCount() { return writeCount; },
  };
}

function matchesFilter(document, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!expected.some((clause) => matchesFilter(document, clause))) return false;
      continue;
    }
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      if ((document[key] !== undefined) !== expected.$exists) return false;
    } else if (expected && typeof expected === 'object' && '$lte' in expected) {
      if (!(document[key] <= expected.$lte)) return false;
    } else if (document[key] !== expected) return false;
  }
  return true;
}

function applySet(document, values = {}) {
  for (const [path, value] of Object.entries(values)) {
    const parts = path.split('.');
    let target = document;
    while (parts.length > 1) {
      const part = parts.shift();
      target[part] ||= {};
      target = target[part];
    }
    target[parts[0]] = structuredClone(value);
  }
}

function createAudit() {
  const events = [];
  return {
    events,
    async runAction(entries, action) {
      events.push(...(Array.isArray(entries) ? entries : [entries]));
      return action();
    },
  };
}

test('encryption key is required and must be a base64-encoded 32-byte value', () => {
  assert.throws(() => parseEncryptionKey(''), /INTEGRATION_ENCRYPTION_KEY is required/);
  assert.throws(() => parseEncryptionKey('not-a-key'), /base64-encoded 32-byte key/);
  assert.equal(parseEncryptionKey(KEY).length, 32);
});

test('environment migration encrypts secrets, preserves existing toggles, initializes SMTP, and is rerunnable', async () => {
  const state = createDatabase([
    { _id: 'google_auth', enabled: true },
    { _id: 'recaptcha', enabled: false },
  ]);
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });

  const first = await integrations.migrateEnvironmentValues();
  assert.equal(first.find(({ id }) => id === 'google_auth').enabledPreserved, true);
  assert.equal(first.find(({ id }) => id === 'recaptcha').enabledPreserved, true);
  assert.equal(first.find(({ id }) => id === 'smtp').enabled, true);

  const stored = JSON.stringify([...state.documents.values()]);
  for (const secret of [ENV.GOOGLE_CLIENT_SECRET, ENV.RECAPTCHA_SECRET_KEY, ENV.SMTP_PASSWORD]) {
    assert.equal(stored.includes(secret), false);
  }
  for (const integrationId of ['google_auth', 'recaptcha', 'smtp']) {
    const integration = await integrations.getIntegration(integrationId);
    assert.ok(integration.settings);
  }

  const beforeRerun = state.writeCount;
  const second = await integrations.migrateEnvironmentValues();
  assert.deepEqual(second.map(({ fieldsMigrated }) => fieldsMigrated), [[], [], [], [], []]);
  assert.equal(state.writeCount, beforeRerun);
  assert.equal((await integrations.getIntegration('google_auth')).enabled, true);
  assert.equal((await integrations.getIntegration('recaptcha')).enabled, false);
  assert.equal((await integrations.getIntegration('smtp')).enabled, true);
  const defaults = JSON.stringify([...state.documents.values()].map(({ defaults: value }) => value));
  for (const secret of [ENV.GOOGLE_CLIENT_SECRET, ENV.RECAPTCHA_SECRET_KEY, ENV.SMTP_PASSWORD]) {
    assert.equal(defaults.includes(secret), false);
  }
  assert.equal((await integrations.getAdminIntegrations()).google_auth.usingDefault, true);
});

test('empty migration does not create an empty default or auto-default later saved settings', async () => {
  const state = createDatabase();
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: {} });

  await integrations.migrateEnvironmentValues();
  assert.equal(state.documents.get('google_auth').defaults, undefined);
  assert.equal(state.documents.get('google_auth').defaults_initialized, true);

  await integrations.saveIntegrations({
    google_auth: {
      enabled: true,
      fields: {
        client_id: 'configured-client-id',
        client_secret: 'configured-client-secret',
      },
    },
  }, createAudit(), {});
  await integrations.migrateEnvironmentValues();

  assert.equal(state.documents.get('google_auth').defaults, undefined);
  assert.equal((await integrations.getAdminIntegrations()).google_auth.hasDefault, false);
});

test('integration health is visible to admins, audit claims are rate limited, and success clears failures', async () => {
  const state = createDatabase([{ _id: 'google_auth', enabled: true }]);
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  await integrations.recordIntegrationFailure('google_auth', {
    code: 'invalid_credentials',
    message: 'Credentials rejected by provider',
    at: new Date(),
  });
  const failing = (await integrations.getAdminIntegrations()).google_auth;
  assert.equal(failing.status, 'Failing');
  assert.equal(failing.health.last_error_code, 'invalid_credentials');
  assert.equal(failing.health.last_error_message, 'Credentials rejected by provider');
  assert.equal(failing.health.consecutive_failures, 1);

  assert.equal(await integrations.claimIntegrationFailureAudit('google_auth', new Date(0)), true);
  assert.equal(await integrations.claimIntegrationFailureAudit('google_auth', new Date(0)), false);
  assert.equal(await integrations.claimIntegrationFailureAudit('google_auth', new Date(Date.now() + 1)), true);

  await integrations.recordIntegrationSuccess('google_auth');
  const recovered = (await integrations.getAdminIntegrations()).google_auth;
  assert.equal(recovered.status, 'Enabled');
  assert.equal(recovered.health.last_error_code, null);
  assert.equal(recovered.health.consecutive_failures, 0);
  assert.ok(recovered.health.last_success_at);

  await integrations.recordIntegrationFailure('google_auth', {
    code: 'network', message: 'Provider could not be reached', at: new Date(),
  });
  await integrations.saveIntegrations({
    google_auth: { enabled: false, fields: {} },
  }, createAudit(), {});
  assert.equal((await integrations.getAdminIntegrations()).google_auth.status, 'Disabled');
});

test('default snapshots only change explicitly and restore encrypted settings safely', async () => {
  const state = createDatabase();
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  const audit = createAudit();
  await integrations.migrateEnvironmentValues();
  const baseline = await integrations.getIntegration('google_auth');
  const plan = await integrations.prepareIntegrationSave({
    google_auth: {
      enabled: baseline.enabled,
      fields: {
        client_id: 'changed-client-id',
        client_secret: '••••••••cret',
        callback_url: baseline.settings.callback_url,
      },
    },
  });
  assert.deepEqual(plan.credentialChanges, [{ integration: 'google_auth', fields: ['client_id'] }]);
  assert.equal((await integrations.getAdminIntegrations()).google_auth.usingDefault, true);
  await integrations.applyIntegrationSave(plan, audit, {});
  assert.equal((await integrations.getAdminIntegrations()).google_auth.usingDefault, false);

  await integrations.restoreIntegrationDefault('google_auth', audit, {});
  const restored = await integrations.getIntegration('google_auth');
  assert.equal(restored.settings.client_id, ENV.GOOGLE_CLIENT_ID);
  assert.equal(restored.settings.client_secret, ENV.GOOGLE_CLIENT_SECRET);
  assert.equal((await integrations.getAdminIntegrations()).google_auth.usingDefault, true);
  assert.ok(audit.events.some(({ action }) => action === 'integration.restore_default'));
  assert.equal(JSON.stringify([...state.documents.values()]).includes(ENV.GOOGLE_CLIENT_SECRET), false);
});

test('startup validation fails clearly when the key cannot decrypt stored secrets', async () => {
  const state = createDatabase();
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  await integrations.migrateEnvironmentValues();
  const wrongKey = randomBytes(32).toString('base64');
  const restarted = createIntegrationSettings(state.database, { encryptionKey: wrongKey, env: {} });
  await assert.rejects(restarted.validateStoredSecrets(), /Unable to decrypt integration settings/);
});

test('admin view masks every secret and never returns its full value', async () => {
  const state = createDatabase();
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  const view = await integrations.getAdminIntegrations();
  const serialized = JSON.stringify(view);
  for (const secret of [ENV.GOOGLE_CLIENT_SECRET, ENV.RECAPTCHA_SECRET_KEY, ENV.SMTP_PASSWORD]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(view.google_auth.fields.find(({ name }) => name === 'client_secret').value, '••••••••cret');
  assert.equal(view.recaptcha.fields.find(({ name }) => name === 'secret_key').hasValue, true);
  assert.equal(view.smtp.status, 'Enabled');
});

test('verification records are admin-bound, value-bound, expiring, and contain no settings', async () => {
  const state = createDatabase();
  const integrationSettings = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  const { settings } = await integrationSettings.getIntegration('google_auth');
  const now = new Date();
  const record = await integrationSettings.recordVerification({
    adminId: 'admin-1',
    integrationId: 'google_auth',
    enabled: true,
    values: settings,
    proofType: 'real_sign_in',
    result: true,
    at: now,
  });

  assert.equal(record.verified, true);
  assert.equal(record.proofType, 'real_sign_in');
  assert.equal(
    (await integrationSettings.getCurrentVerification('admin-1', 'google_auth', true, settings)).verified,
    true,
  );
  assert.equal(await integrationSettings.getCurrentVerification('admin-2', 'google_auth', true, settings), null);
  assert.equal(await integrationSettings.getCurrentVerification(
    'admin-1', 'google_auth', false, settings,
  ), null);
  assert.equal(await integrationSettings.getCurrentVerification(
    'admin-1',
    'google_auth',
    true,
    { ...settings, client_secret: 'changed-secret' },
  ), null);
  assert.equal(await integrationSettings.getCurrentVerification(
    'admin-1',
    'google_auth',
    true,
    settings,
    new Date(now.getTime() + 10 * 60 * 1000),
  ), null);

  const stored = JSON.stringify(state.documents.get('verification-google_auth'));
  assert.equal(stored.includes(ENV.GOOGLE_CLIENT_SECRET), false);
  assert.match(state.documents.get('verification-google_auth').hash, /^[a-f0-9]{64}$/);
  await integrationSettings.recordVerification({
    adminId: 'admin-1',
    integrationId: 'google_auth',
    enabled: true,
    values: settings,
    proofType: 'real_sign_in',
    result: false,
  });
  assert.equal(await integrationSettings.getCurrentVerification('admin-1', 'google_auth', true, settings), null);
});

test('all submitted cards validate before writes and errors identify fields', async () => {
  const state = createDatabase();
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  const audit = createAudit();
  await assert.rejects(integrations.saveIntegrations({
    google_auth: {
      enabled: true,
      fields: { callback_url: 'javascript:alert(1)' },
    },
    recaptcha: {
      enabled: true,
      fields: { site_key: '' },
    },
  }, audit, {}), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.fieldErrors.google_auth.callback_url, 'Enter a valid HTTP or HTTPS URL.');
    assert.equal(error.fieldErrors.recaptcha.site_key, 'This field is required.');
    return true;
  });
  assert.equal(state.writeCount, 0);
  assert.equal(audit.events.length, 0);
});

test('unchanged secret masks preserve the encrypted value; updates log field names only', async () => {
  const state = createDatabase([{ _id: 'google_auth', enabled: true }]);
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  const audit = createAudit();
  await integrations.migrateEnvironmentValues();
  const originalSecret = (await integrations.getIntegration('google_auth')).settings.client_secret;

  await integrations.saveIntegrations({
    google_auth: {
      enabled: false,
      fields: {
        client_id: ENV.GOOGLE_CLIENT_ID,
        client_secret: '••••••••cret',
        callback_url: 'https://new.example.test/google/callback',
      },
    },
  }, audit, { actor_id: 'admin-1', actor_role: 'admin' });

  const updated = await integrations.getIntegration('google_auth');
  assert.equal(updated.settings.client_secret, originalSecret);
  assert.equal(updated.enabled, false);
  assert.ok(audit.events.some(({ action }) => action === 'integration.disable'));
  assert.ok(audit.events.some(({ action, new_value }) => action === 'integration.update'
    && new_value.changed_fields.includes('callback_url')));
  assert.equal(JSON.stringify(audit.events).includes(originalSecret), false);
  assert.equal(JSON.stringify(state.documents.get('google_auth')).includes(originalSecret), false);
});

test('enabled integrations require configured fields and server-only secrets are encrypted at rest', async () => {
  const state = createDatabase();
  const integrations = createIntegrationSettings(state.database, { encryptionKey: KEY, env: {} });
  await assert.rejects(integrations.saveIntegrations({
    google_auth: { enabled: true, fields: { client_id: '', callback_url: '', client_secret: '' } },
  }, createAudit(), {}), (error) => {
    assert.equal(error.status, 400);
    assert.ok(error.fieldErrors.google_auth.client_secret);
    return true;
  });
  assert.equal(state.writeCount, 0);

  await integrations.saveIntegrations({
    google_auth: {
      enabled: true,
      fields: {
        client_id: 'google-client-id',
        callback_url: 'https://example.test/callback',
        client_secret: 'new-private-client-secret',
      },
    },
  }, createAudit(), {});
  const serialized = JSON.stringify(state.documents.get('google_auth'));
  assert.equal(serialized.includes('new-private-client-secret'), false);
  assert.equal((await integrations.getIntegration('google_auth')).settings.client_secret, 'new-private-client-secret');
});

test('Google Calendar settings validate and encrypt the full private key without returning it', async () => {
  const state = createDatabase();
  const integrationSettings = createIntegrationSettings(state.database, {
    encryptionKey: KEY,
    env: {},
  });
  const pastedKey = '-----BEGIN PRIVATE KEY-----\\nprivate-key-bytes\\n-----END PRIVATE KEY-----';
  const plan = await integrationSettings.prepareIntegrationSave({
    google_calendar: {
      enabled: true,
      fields: {
        calendar_id: 'pickup-calendar@example.test',
        service_account_email: 'calendar-bot@example.iam.gserviceaccount.com',
        private_key: pastedKey,
        time_zone: 'Asia/Manila',
        office_location: 'Buksu SSC Office',
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
  });
  assert.deepEqual(plan.credentialChanges, [{
    integration: 'google_calendar',
    fields: ['calendar_id', 'service_account_email', 'private_key'],
  }]);

  await integrationSettings.applyIntegrationSave(plan, createAudit(), {});
  const saved = await integrationSettings.getIntegration('google_calendar');
  assert.equal(saved.settings.private_key, pastedKey.replace(/\\n/g, '\n'));
  const admin = (await integrationSettings.getAdminIntegrations()).google_calendar;
  assert.equal(admin.fields.find(({ name }) => name === 'private_key').value, '••••••••');
  assert.equal(JSON.stringify(admin).includes('private-key-bytes'), false);
  assert.equal(JSON.stringify([...state.documents.values()]).includes('private-key-bytes'), false);

  await assert.rejects(integrationSettings.prepareIntegrationSave({
    google_calendar: {
      enabled: true,
      fields: { ...saved.settings, service_account_email: 'not-an-account@example.test' },
    },
  }), (error) => Boolean(error.fieldErrors.google_calendar.service_account_email));
});

test('disabled SMTP is skipped and Test Connection verifies without sending mail', async () => {
  const inactiveEmail = createEmailService(async () => ({ active: false, settings: {} }), {
    createTransport() { assert.fail('Disabled SMTP must not create a transporter.'); },
  });
  assert.equal(await inactiveEmail.sendPasswordReset('to@example.test', 'https://example.test/reset'), false);

  let sent = false;
  let verified = false;
  const email = createEmailService(async () => ({
    active: true,
    settings: {
      host: 'smtp.example.test',
      port: '587',
      secure: false,
      user: 'user',
      password: 'pass',
      sender_email: 'from@example.test',
      sender_name: 'Test',
    },
  }), {
    createTransport() {
      return {
        async verify() { verified = true; },
        async sendMail() { sent = true; },
      };
    },
  });
  await email.testConnection();
  assert.equal(verified, true);
  assert.equal(sent, false);
});

test('SMTP candidate verification authenticates and sends an accepted test email through candidate settings', async () => {
  const calls = [];
  let transportOptions;
  const email = createEmailService(async () => assert.fail('Candidate verification must not load active settings.'), {
    createTransport(options) {
      transportOptions = options;
      return {
        async verify() { calls.push('verify'); },
        async sendMail(message) {
          calls.push('send');
          assert.equal(message.from, '"Test Sender" <candidate@example.test>');
          assert.equal(message.to, 'admin@example.test');
          assert.doesNotMatch(message.text, /candidate-password|candidate-user/);
          return { accepted: ['admin@example.test'] };
        },
      };
    },
  }, async (integrationId, operation, _auditContext, options) => {
    assert.equal(integrationId, 'smtp');
    assert.deepEqual(options, { candidateValidation: true, purpose: 'admin_check' });
    return operation({ signal: new AbortController().signal });
  }, { verificationEmail: 'admin@example.test' });

  const result = await email.verifyCandidate({
    host: 'smtp.example.test',
    port: '587',
    secure: false,
    user: 'candidate-user',
    password: 'candidate-password',
    sender_name: 'Test Sender',
    sender_email: 'candidate@example.test',
  });
  assert.deepEqual(result, { verified: true, proofType: 'test_email_sent' });
  assert.deepEqual(calls, ['verify', 'send']);
  assert.deepEqual(transportOptions.auth, {
    user: 'candidate-user',
    pass: 'candidate-password',
  });
});

test('SMTP candidate verification rejects an unaccepted recipient without exposing provider details', async () => {
  const email = createEmailService(async () => assert.fail('Candidate verification must not load active settings.'), {
    createTransport() {
      return {
        async verify() {},
        async sendMail() {
          const error = new Error('Rejected candidate-password');
          error.code = 'EENVELOPE';
          throw error;
        },
      };
    },
  }, async (_integrationId, operation) => operation({ signal: new AbortController().signal }), {
    verificationEmail: 'admin@example.test',
  });

  await assert.rejects(
    email.verifyCandidate({
      host: 'smtp.example.test',
      port: '587',
      secure: false,
      sender_email: 'candidate@example.test',
    }),
    (error) => error.integrationFailureCode === 'provider_error'
      && !error.message.includes('candidate-password'),
  );
});

test('SMTP candidate verification fails closed on network, timeout, 5xx, and unaccepted replies', async () => {
  const healthChanges = [];
  const auditEvents = [];
  const callIntegration = createIntegrationCaller({
    integrationSettings: {
      async recordIntegrationFailure(id, failure) { healthChanges.push({ id, failure }); },
      async recordIntegrationSuccess(id) { healthChanges.push({ id, success: true }); },
      async claimIntegrationFailureAudit() { return true; },
    },
    audit: { async logAction(event) { auditEvents.push(event); } },
    timeoutMs: 10,
  });
  const candidate = {
    host: 'smtp.example.test',
    port: '587',
    secure: false,
    user: 'candidate-user',
    password: 'candidate-private-password',
    sender_email: 'candidate@example.test',
  };
  const modes = ['network', 'timeout', 'server_error', 'unaccepted'];

  for (const mode of modes) {
    const email = createEmailService(async () => assert.fail('Candidate verification must not load active settings.'), {
      createTransport() {
        return {
          async verify() {
            if (mode === 'network') {
              const error = new Error(`SMTP connection failed: ${candidate.password}`);
              error.code = 'ECONNRESET';
              throw error;
            }
            if (mode === 'timeout') return new Promise(() => {});
          },
          async sendMail() {
            if (mode === 'server_error') {
              const error = new Error(`SMTP 550 rejected ${candidate.password}`);
              error.code = 'EENVELOPE';
              error.responseCode = 550;
              throw error;
            }
            if (mode === 'unaccepted') return { accepted: ['other@example.test'] };
            return { accepted: ['admin@example.test'] };
          },
        };
      },
    }, callIntegration, { verificationEmail: 'admin@example.test' });

    await assert.rejects(email.verifyCandidate(candidate), (error) => (
      error instanceof IntegrationError
      && error.status === 503
      && !error.message.includes(candidate.password)
    ), mode);
  }

  assert.deepEqual(healthChanges, []);
  assert.deepEqual(auditEvents, []);
});

test('SMTP provider failures are sanitized, health and audit are recorded once, and a passing test clears health', async () => {
  const state = createDatabase([
    { _id: 'smtp', enabled: true },
  ]);
  const integrationSettings = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  await integrationSettings.migrateEnvironmentValues();
  const auditEvents = [];
  const audit = { async logAction(event) { auditEvents.push(event); } };
  const callIntegration = createIntegrationCaller({ integrationSettings, audit });
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  try {
    const failingEmail = createEmailService(integrationSettings.getIntegration, {
      createTransport() {
        return {
          async sendMail() {
            const error = new Error(`535 authentication failed: ${ENV.SMTP_PASSWORD}`);
            error.code = 'EAUTH';
            error.responseCode = 535;
            throw error;
          },
        };
      },
    }, callIntegration);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        failingEmail.sendPasswordReset('to@example.test', 'https://example.test/reset'),
        (error) => error instanceof IntegrationError
          && error.status === 503
          && error.message === 'Email could not be sent. Please try again later.',
      );
    }

    const failing = (await integrationSettings.getAdminIntegrations()).smtp;
    assert.equal(failing.status, 'Failing');
    assert.equal(failing.health.last_error_code, 'invalid_credentials');
    assert.equal(failing.health.last_error_message, 'Credentials rejected by provider');
    assert.equal(failing.health.consecutive_failures, 2);
    assert.equal(auditEvents.filter(({ action }) => action === 'integration.failure').length, 1);
    assert.equal(JSON.stringify(auditEvents).includes(ENV.SMTP_PASSWORD), false);
    assert.equal(JSON.stringify(logs).includes(ENV.SMTP_PASSWORD), false);

    const passingEmail = createEmailService(integrationSettings.getIntegration, {
      createTransport() {
        return {
          async verify() { return true; },
        };
      },
    }, callIntegration);
    assert.equal(await passingEmail.testConnection(), true);
    const recovered = (await integrationSettings.getAdminIntegrations()).smtp;
    assert.equal(recovered.status, 'Enabled');
    assert.equal(recovered.health.last_error_code, null);
    assert.equal(recovered.health.consecutive_failures, 0);
    assert.ok(recovered.health.last_success_at);
  } finally {
    console.error = originalError;
  }
});

test('Google OAuth observes integration changes without reconstructing its service', async () => {
  let active = false;
  const google = createGoogleOAuth(async () => ({
    active,
    configured: true,
    settings: {
      client_id: 'client-id',
      client_secret: 'client-secret',
      callback_url: 'http://localhost:3001/api/auth/google/callback',
    },
  }));
  await assert.rejects(google.createAuthorizationRequest(), /Google sign-in is disabled/);
  active = true;
  const authorization = await google.createAuthorizationRequest();
  assert.match(authorization.url, /^https:\/\/accounts\.google\.com\//);
  active = false;
  await assert.rejects(google.createAuthorizationRequest(), /Google sign-in is disabled/);
});

test('candidate Google OAuth verification uses PKCE and candidate credentials without creating tokens or sessions', async () => {
  const clients = [];
  const verifierCalls = [];
  class MockOAuthClient {
    constructor(clientId, clientSecret, callbackUrl) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
      this.callbackUrl = callbackUrl;
      this.credentials = {};
      clients.push(this);
    }

    async generateCodeVerifierAsync() {
      return { codeVerifier: 'candidate-code-verifier', codeChallenge: 'pkce-challenge' };
    }

    generateAuthUrl(options) {
      const url = new URL('https://accounts.google.com/o/oauth2/auth');
      url.search = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: this.callbackUrl,
        state: options.state,
        nonce: options.nonce,
        code_challenge: options.code_challenge,
        code_challenge_method: options.code_challenge_method,
        scope: options.scope.join(' '),
      }).toString();
      this.authorizationUrl = url.toString();
      return this.authorizationUrl;
    }

    async getToken(options) {
      verifierCalls.push(options);
      return { tokens: { id_token: 'private-id-token', access_token: 'private-access-token' } };
    }

    async verifyIdToken(options) {
      assert.deepEqual(options, {
        idToken: 'private-id-token',
        audience: 'candidate-client-id',
      });
      const nonce = new URL(this.authorizationUrl).searchParams.get('nonce');
      return {
        getPayload() {
          return {
            sub: 'verified-subject',
            email: 'admin@example.test',
            email_verified: true,
            nonce,
          };
        },
      };
    }

    setCredentials(credentials) {
      this.credentials = credentials;
    }
  }

  const google = createGoogleOAuth(
    async () => assert.fail('Candidate verification must use the submitted settings.'),
    async (integrationId, operation, _auditContext, options) => {
      assert.equal(integrationId, 'google_auth');
      assert.deepEqual(options, { candidateValidation: true, purpose: 'admin_check' });
      return operation({ signal: new AbortController().signal });
    },
    undefined,
    { OAuthClient: MockOAuthClient },
  );
  const settings = {
    client_id: 'candidate-client-id',
    client_secret: 'candidate-client-secret',
    callback_url: 'https://candidate.example.test/auth/google/callback',
  };
  const started = await google.verifyCandidate({}, settings, {
    adminId: 'admin-123',
    candidateHash: 'a'.repeat(64),
    enabled: true,
  });
  clients[0].authorizationUrl = started.authorizationUrl;
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('client_id'), settings.client_id);
  assert.equal(authorization.searchParams.get('redirect_uri'), settings.callback_url);
  assert.equal(authorization.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(started.authorizationUrl.includes(settings.client_secret), false);

  const result = await google.completeVerificationCallback({
    state: authorization.searchParams.get('state'),
    code: 'authorization-code',
  });
  assert.equal(result.status, 'success');
  assert.equal(result.adminId, 'admin-123');
  assert.equal(result.candidateHash, 'a'.repeat(64));
  assert.deepEqual(verifierCalls, [{
    code: 'authorization-code',
    codeVerifier: 'candidate-code-verifier',
  }]);
  assert.deepEqual(clients[0].credentials, {});
  assert.equal(JSON.stringify(result).includes('private-id-token'), false);
  assert.equal(JSON.stringify(result).includes('private-access-token'), false);
  assert.equal(await google.completeVerificationCallback({
    state: authorization.searchParams.get('state'),
    code: 'authorization-code',
  }), null);
});

test('candidate Google OAuth verification fails safely for provider errors, cancellation, redirects, unverified email, and expiry', async () => {
  const clients = [];
  let tokenError = null;
  let malformedTokenResponse = false;
  let emailVerified = true;
  class MockOAuthClient {
    constructor(clientId, clientSecret, callbackUrl) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
      this.callbackUrl = callbackUrl;
      clients.push(this);
    }
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'verifier', codeChallenge: 'challenge' };
    }
    generateAuthUrl(options) {
      const url = new URL('https://accounts.google.com/o/oauth2/auth');
      url.searchParams.set('client_id', this.clientId);
      url.searchParams.set('redirect_uri', this.callbackUrl);
      url.searchParams.set('state', options.state);
      url.searchParams.set('nonce', options.nonce);
      this.authorizationUrl = url.toString();
      return this.authorizationUrl;
    }
    async getToken() {
      if (tokenError) throw tokenError;
      if (malformedTokenResponse) return { tokens: { access_token: 'unexpected-token' } };
      return { tokens: { id_token: 'id-token' } };
    }
    async verifyIdToken() {
      return { getPayload: () => ({ nonce: new URL(this.authorizationUrl).searchParams.get('nonce'), email: 'a@example.test', email_verified: emailVerified }) };
    }
    setCredentials() {}
  }
  const google = createGoogleOAuth(
    async () => assert.fail('Candidate verification must use the submitted settings.'),
    async (_id, operation) => operation({ signal: new AbortController().signal }),
    undefined,
    { OAuthClient: MockOAuthClient, verificationTtlMs: 100 },
  );
  const start = async (overrides = {}) => {
    const request = await google.verifyCandidate({}, {
      client_id: 'candidate-client-id',
      client_secret: 'candidate-client-secret',
      callback_url: 'https://candidate.example.test/auth/google/callback',
      ...overrides,
    }, { adminId: 'admin-123', candidateHash: 'b'.repeat(64), enabled: true });
    clients[clients.length - 1].authorizationUrl = request.authorizationUrl;
    return new URL(request.authorizationUrl).searchParams.get('state');
  };

  const cancelledState = await start();
  assert.equal((await google.completeVerificationCallback({
    state: cancelledState,
    error: 'access_denied',
  })).status, 'access_denied');

  const providerMismatchState = await start();
  assert.equal((await google.completeVerificationCallback({
    state: providerMismatchState,
    error: 'redirect_uri_mismatch',
  })).failureCode, 'redirect_uri_mismatch');

  const wrongClientIdState = await start({ client_id: 'wrong-client-id' });
  assert.equal(
    new URL(clients.at(-1).authorizationUrl).searchParams.get('client_id'),
    'wrong-client-id',
  );
  assert.equal((await google.completeVerificationCallback({
    state: wrongClientIdState,
    error: 'invalid_client',
  })).failureCode, 'invalid_response');

  tokenError = Object.assign(new Error('redirect_uri_mismatch'), {
    response: { data: { error: 'redirect_uri_mismatch' } },
  });
  const mismatchState = await start();
  assert.equal((await google.completeVerificationCallback({
    state: mismatchState,
    code: 'code',
  })).failureCode, 'redirect_uri_mismatch');

  tokenError = Object.assign(new Error('invalid_client wrong-candidate-secret'), {
    response: {
      data: { error: 'invalid_client', error_description: 'wrong-candidate-secret' },
    },
  });
  const wrongClientSecretState = await start({ client_secret: 'wrong-candidate-secret' });
  const wrongClientSecret = await google.completeVerificationCallback({
    state: wrongClientSecretState,
    code: 'code',
  });
  assert.equal(wrongClientSecret.failureCode, 'verification_failed');

  tokenError = null;
  malformedTokenResponse = true;
  const malformedResponseState = await start();
  assert.equal((await google.completeVerificationCallback({
    state: malformedResponseState,
    code: 'code',
  })).failureCode, 'invalid_response');

  malformedTokenResponse = false;
  emailVerified = false;
  const unverifiedState = await start();
  assert.equal((await google.completeVerificationCallback({
    state: unverifiedState,
    code: 'code',
  })).failureCode, 'unverified_identity');

  emailVerified = true;
  const expiredState = await start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await google.completeVerificationCallback({
    state: expiredState,
    code: 'code',
  })).failureCode, 'expired');
});

test('Google invalid_grant is user-caused while rejected client credentials update integration health', async () => {
  const state = createDatabase([{ _id: 'google_auth', enabled: true }]);
  const integrationSettings = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  await integrationSettings.migrateEnvironmentValues();
  const auditEvents = [];
  const audit = { async logAction(event) { auditEvents.push(event); } };
  const callIntegration = createIntegrationCaller({ integrationSettings, audit });
  const originalError = console.error;
  console.error = () => {};
  try {
    const invalidGrant = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    await assert.rejects(callIntegration('google_auth', async () => { throw invalidGrant; }), (error) => (
      error === invalidGrant
    ));
    assert.equal((await integrationSettings.getAdminIntegrations()).google_auth.health.consecutive_failures, 0);

    const invalidClient = Object.assign(new Error('invalid_client with private-secret'), {
      response: { data: { error: 'invalid_client', error_description: 'private-secret' } },
    });
    await assert.rejects(callIntegration('google_auth', async () => { throw invalidClient; }), (error) => (
      error instanceof IntegrationError
      && error.message === 'Google sign-in is temporarily unavailable. Please use email and password.'
    ));
  } finally {
    console.error = originalError;
  }

  const google = (await integrationSettings.getAdminIntegrations()).google_auth;
  assert.equal(google.status, 'Failing');
  assert.equal(google.health.last_error_code, 'invalid_credentials');
  assert.equal(JSON.stringify(auditEvents).includes('private-secret'), false);
  assert.deepEqual(auditEvents.map(({ new_value }) => new_value), [{ code: 'invalid_credentials' }]);
});

test('Google OAuth connection test validates saved credentials without completing sign-in', async () => {
  const state = createDatabase([{ _id: 'google_auth', enabled: true }]);
  const integrationSettings = createIntegrationSettings(state.database, { encryptionKey: KEY, env: ENV });
  await integrationSettings.migrateEnvironmentValues();
  const auditEvents = [];
  const audit = { async logAction(event) { auditEvents.push(event); } };
  const callIntegration = createIntegrationCaller({ integrationSettings, audit });
  let request;
  const google = createGoogleOAuth(
    integrationSettings.getIntegration,
    callIntegration,
    async (url, options) => {
      request = { url, options };
      return { ok: false, async json() { return { error: 'invalid_grant' }; } };
    },
  );

  assert.equal(await google.testConnection(), true);
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(Object.fromEntries(request.options.body), {
    client_id: ENV.GOOGLE_CLIENT_ID,
    client_secret: ENV.GOOGLE_CLIENT_SECRET,
    code: 'integration-connection-test',
    code_verifier: 'integration-connection-test',
    grant_type: 'authorization_code',
    redirect_uri: ENV.API_GOOGLE_REDIRECT_URI,
  });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.ok((await integrationSettings.getAdminIntegrations()).google_auth.health.last_success_at);
  assert.equal(auditEvents.length, 0);

  const originalError = console.error;
  console.error = () => {};
  try {
    const invalidClient = createGoogleOAuth(
      integrationSettings.getIntegration,
      callIntegration,
      async () => ({
        ok: false,
        async json() {
          return { error: 'invalid_client', error_description: ENV.GOOGLE_CLIENT_SECRET };
        },
      }),
    );
    await assert.rejects(invalidClient.testConnection(), (error) => (
      error instanceof IntegrationError && error.status === 503
    ));
  } finally {
    console.error = originalError;
  }

  const failing = (await integrationSettings.getAdminIntegrations()).google_auth;
  assert.equal(failing.status, 'Failing');
  assert.equal(failing.health.last_error_code, 'invalid_credentials');
  assert.equal(JSON.stringify(auditEvents).includes(ENV.GOOGLE_CLIENT_SECRET), false);
});
