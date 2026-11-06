const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { createIntegrationSettings, parseEncryptionKey } = require('../../src/services/integration-settings');
const { createEmailService } = require('../../src/services/email');
const { createGoogleOAuth } = require('../../src/services/google-oauth');

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
    async updateOne({ _id }, { $set }, { upsert }) {
      assert.equal(upsert, true);
      const document = documents.get(_id) || { _id };
      applySet(document, $set);
      documents.set(_id, document);
      writeCount += 1;
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

function applySet(document, values) {
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
      events.push(...entries);
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
  assert.deepEqual(second.map(({ fieldsMigrated }) => fieldsMigrated), [[], [], []]);
  assert.equal(state.writeCount, beforeRerun);
  assert.equal((await integrations.getIntegration('google_auth')).enabled, true);
  assert.equal((await integrations.getIntegration('recaptcha')).enabled, false);
  assert.equal((await integrations.getIntegration('smtp')).enabled, true);
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
