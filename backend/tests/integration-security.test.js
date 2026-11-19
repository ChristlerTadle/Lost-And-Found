const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const { createIntegrationSecurity, ACCESS_WINDOW_MS } = require('../../src/services/integration-security');

const HASH_KEY = randomBytes(32);
const SMTP = {
  host: 'bootstrap.example.test',
  port: '587',
  secure: 'false',
  user: 'bootstrap@example.test',
  password: 'bootstrap-password',
  from: 'Lost and Found <bootstrap@example.test>',
};

function createHarness(options = {}) {
  let timestamp = 1_800_000_000_000;
  const documents = new Map();
  const messages = [];
  const events = [];
  const waits = [];
  let mailAttempts = 0;
  const database = {
    collection(name) {
      if (!documents.has(name)) documents.set(name, new Map());
      const collection = documents.get(name);
      return {
        async findOne(filter) {
          const entry = collection.get(filter._id);
          if (!entry || !matches(entry, filter)) return null;
          return structuredClone(entry);
        },
        async updateOne(filter, update, { upsert = false } = {}) {
          let entry = collection.get(filter._id);
          if (entry && !matches(entry, filter)) return { matchedCount: 0, modifiedCount: 0 };
          if (!entry && !upsert) return { matchedCount: 0, modifiedCount: 0 };
          entry = entry || { _id: filter._id };
          for (const [key, value] of Object.entries(update.$set || {})) entry[key] = structuredClone(value);
          for (const [key, value] of Object.entries(update.$inc || {})) entry[key] = (entry[key] || 0) + value;
          for (const key of Object.keys(update.$unset || {})) delete entry[key];
          collection.set(filter._id, entry);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async findOneAndUpdate(filter, update, { upsert = false } = {}) {
          let entry = collection.get(filter._id);
          if (!entry && !upsert) return null;
          entry = entry || { _id: filter._id };
          for (const [key, value] of Object.entries(update.$set || {})) entry[key] = structuredClone(value);
          for (const [key, value] of Object.entries(update.$inc || {})) entry[key] = (entry[key] || 0) + value;
          if (update.$push) {
            for (const [key, value] of Object.entries(update.$push)) {
              const items = value && typeof value === 'object' && '$each' in value ? value.$each : [value];
              entry[key] = [...(entry[key] || []), ...structuredClone(items)];
              if (value?.$slice < 0) entry[key] = entry[key].slice(value.$slice);
            }
          }
          collection.set(filter._id, entry);
          return structuredClone(entry);
        },
        async deleteOne(filter) {
          const entry = collection.get(filter._id);
          if (entry && matches(entry, filter)) collection.delete(filter._id);
          return { deletedCount: entry ? 1 : 0 };
        },
      };
    },
  };
  const audit = {
    async logAction(event) { events.push(event); },
  };
  const security = createIntegrationSecurity(database, {
    pin: options.pin ?? 'test-pin-9876',
    email: options.email ?? 'admin@example.test',
    smtp: options.smtp ?? SMTP,
    hashKey: HASH_KEY,
    now: () => timestamp,
    delay: async (milliseconds) => waits.push(milliseconds),
    codeRequestLimit: options.codeRequestLimit ?? 5,
    codeRequestWindowMs: options.codeRequestWindowMs ?? 60 * 60 * 1000,
    codeResendMs: options.codeResendMs ?? 60 * 1000,
    mailer: {
      createTransport(config) {
        assert.equal(config.host, SMTP.host);
        assert.notEqual(config.host, 'editable-smtp.example.test');
        return {
          async sendMail(message) {
            messages.push(message);
            mailAttempts += 1;
            if (options.bootstrapMailError
              && (options.bootstrapMailErrorCount === undefined
                || mailAttempts <= options.bootstrapMailErrorCount)) {
              throw options.bootstrapMailError;
            }
          },
        };
      },
    },
  });
  return {
    security,
    audit,
    events,
    messages,
    waits,
    documents,
    advance(milliseconds) { timestamp += milliseconds; },
    timestamp: () => timestamp,
  };
}

function matches(entry, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return expected.$exists ? entry[key] !== undefined : entry[key] === undefined;
    }
    if (expected && typeof expected === 'object' && '$lt' in expected) return entry[key] < expected.$lt;
    return entry[key] === expected;
  });
}

const auditContext = { actor_id: 'admin-1', actor_role: 'admin', ip_address: '127.0.0.1' };

test('PIN unlock uses generic failures, increasing delay, five-try lockout, and inactivity expiry', async () => {
  const harness = createHarness();
  const session = {};
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(harness.security.unlock({
      adminId: 'admin-1', ipAddress: '127.0.0.1', candidate: 'wrong',
      session, auditContext, audit: harness.audit,
    }), (error) => error.status === 403 && error.message === 'PIN could not be verified. Try again later.');
  }
  await assert.rejects(harness.security.unlock({
    adminId: 'admin-1', ipAddress: '127.0.0.1', candidate: 'test-pin-9876',
    session, auditContext, audit: harness.audit,
  }), (error) => error.status === 403);
  assert.equal(harness.events.filter(({ action }) => action === 'integration.unlock_failed').length, 4);
  assert.equal(harness.events.filter(({ action }) => action === 'integration.unlock_locked').length, 2);
  assert.ok(harness.events.filter(({ action }) => action === 'integration.unlock_failed')
    .every(({ result }) => result === 'failed'));
  assert.ok(harness.events.filter(({ action }) => action === 'integration.unlock_locked')
    .every(({ result }) => result === 'denied'));
  assert.deepEqual(harness.waits, [250, 500, 1000, 2000]);

  harness.advance(15 * 60 * 1000);
  await harness.security.unlock({
    adminId: 'admin-1', ipAddress: '127.0.0.1', candidate: 'test-pin-9876',
    session, auditContext, audit: harness.audit,
  });
  assert.equal(harness.events.at(-1).action, 'integration.unlock');
  assert.equal(harness.events.at(-1).result, 'success');
  assert.equal(harness.security.touchSession(session, 'admin-1'), true);
  harness.advance(ACCESS_WINDOW_MS);
  assert.equal(harness.security.touchSession(session, 'admin-1'), false);
});

test('missing PIN or email locks settings without requiring SMTP values at startup', async () => {
  const harness = createHarness({ pin: '', email: '' });
  const state = harness.security.configuration();
  assert.equal(state.accessReady, false);
  assert.match(state.accessError, /SU_PIN is missing.*SU_EMAIL is missing/);
  await assert.rejects(harness.security.unlock({
    adminId: 'admin-1', ipAddress: '127.0.0.1', candidate: 'x',
    session: {}, auditContext, audit: harness.audit,
  }), (error) => error.status === 503 && /SU_PIN is missing.*SU_EMAIL is missing/.test(error.message));

  const noBootstrap = createHarness({ smtp: {} });
  assert.equal(noBootstrap.security.configuration().accessReady, true);
  assert.equal(noBootstrap.security.configuration().verificationEmailConfigured, false);
  await assert.rejects(noBootstrap.security.sendCode({
    adminId: 'admin-1',
    sessionId: 'session-1',
    payloadHash: 'pending-hash',
    changes: [],
    auditContext,
    audit: noBootstrap.audit,
  }), (error) => error.status === 503 && /SU_SMTP_HOST is missing/.test(error.message));
});

test('bootstrap configuration normalizes quoted values and rejects invalid addresses by variable name', () => {
  const configPath = path.resolve(__dirname, '../../src/config');
  const childEnv = {
    ...process.env,
    SU_EMAIL: '  "  admin@example.test  "  ',
    SU_SMTP_HOST: ' " smtp.example.test " ',
    SU_SMTP_PORT: ' 587 ',
    SU_SMTP_SECURE: ' " false " ',
    SU_SMTP_USER: ' " mailer " ',
    SU_SMTP_PASSWORD: ' " password " ',
    SU_SMTP_FROM: ' " System <mailer@example.test> " ',
    SU_CODE_REQUEST_LIMIT: '5',
    SU_CODE_REQUEST_WINDOW_SECONDS: '3600',
    SU_CODE_RESEND_SECONDS: '60',
  };
  const script = `const c=require(${JSON.stringify(configPath)}); process.stdout.write(JSON.stringify({
    email:c.integrationSettingsEmail,emailError:c.integrationSettingsEmailError,
    host:c.integrationBootstrapSmtp.host,port:c.integrationBootstrapSmtp.port,
    secure:c.integrationBootstrapSmtp.secure,from:c.integrationBootstrapSmtp.from,
    smtpErrors:c.integrationBootstrapSmtpErrors
  }));`;
  const normalized = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    env: childEnv,
    encoding: 'utf8',
  }));
  assert.equal(normalized.email, 'admin@example.test');
  assert.equal(normalized.emailError, '');
  assert.equal(normalized.host, 'smtp.example.test');
  assert.equal(normalized.port, 587);
  assert.equal(normalized.secure, false);
  assert.equal(normalized.from, 'System <mailer@example.test>');
  assert.deepEqual(normalized.smtpErrors, []);

  const invalidScript = `const c=require(${JSON.stringify(configPath)}); process.stdout.write(JSON.stringify({
    emailError:c.integrationSettingsEmailError,smtpErrors:c.integrationBootstrapSmtpErrors
  }));`;
  const invalid = JSON.parse(execFileSync(process.execPath, ['-e', invalidScript], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...childEnv, SU_EMAIL: 'not-an-address' },
    encoding: 'utf8',
  }));
  assert.equal(invalid.emailError, 'SU_EMAIL is invalid');
  assert.equal(JSON.stringify(invalid).includes('not-an-address'), false);

  const invalidSmtp = JSON.parse(execFileSync(process.execPath, ['-e', invalidScript], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...childEnv, SU_SMTP_PORT: 'invalid-port' },
    encoding: 'utf8',
  }));
  assert.ok(invalidSmtp.smtpErrors.includes('SU_SMTP_PORT is invalid'));
  assert.equal(JSON.stringify(invalidSmtp).includes('invalid-port'), false);
});

test('credential code is hashed, expires, binds to admin and payload, and is one-use', async () => {
  const harness = createHarness();
  const sent = await harness.security.sendCode({
    adminId: 'admin-1',
    sessionId: 'session-1',
    payloadHash: 'payload-hash-1',
    changes: [{ integration: 'google_auth', label: 'Google sign-in', fields: ['client_id', 'client_secret'] }],
    requester: 'Admin Example',
    ipAddress: '127.0.0.1',
    auditContext,
    audit: harness.audit,
  });
  assert.equal(sent.expiresInSeconds, 600);
  assert.equal(sent.resendInSeconds, 60);
  assert.equal(sent.maskedRecipient, 'a***@example.test');
  assert.ok(sent.expiresAt);
  assert.ok(sent.resendAvailableAt);
  const message = harness.messages[0];
  const code = /code is: (\d{6})/.exec(message.text)[1];
  const stored = harness.documents.get('integration_settings_pending_codes').get('session-1');
  assert.notEqual(stored.codeHash, code);
  assert.equal(JSON.stringify(stored).includes(code), false);
  assert.match(message.text, /Google sign-in: client_id, client_secret/);
  assert.match(message.text, /Admin Example/);
  assert.match(message.text, /127\.0\.0\.1/);
  assert.equal(message.text.includes('client-secret-value'), false);
  assert.equal(JSON.stringify(harness.events).includes(code), false);
  const pending = await harness.security.getPendingCodeStatus({
    adminId: 'admin-1',
    sessionId: 'session-1',
  });
  assert.equal(pending.maskedRecipient, 'a***@example.test');
  assert.deepEqual(pending.integrationIds, ['google_auth']);
  assert.equal(JSON.stringify(pending).includes(code), false);

  await assert.rejects(harness.security.verifyCode({
    adminId: 'admin-2', sessionId: 'session-1', candidate: code,
    payloadHash: 'payload-hash-1', auditContext, audit: harness.audit,
  }), /invalid or expired/);
  await assert.rejects(harness.security.verifyCode({
    adminId: 'admin-1', sessionId: 'session-1', candidate: code,
    payloadHash: 'different-payload', auditContext, audit: harness.audit,
  }), /pending settings changed/);
  assert.equal(harness.events.at(-1).action, 'integration.code_failed');
  assert.equal(harness.events.at(-1).result, 'failed');
  await assert.rejects(harness.security.verifyCode({
    adminId: 'admin-1', sessionId: 'session-1', candidate: code,
    payloadHash: 'payload-hash-1', auditContext, audit: harness.audit,
  }), /invalid or expired/);
});

test('bootstrap mail failures log a sanitized message without emitting editable integration health events', async () => {
  const harness = createHarness({
    bootstrapMailError: Object.assign(new Error('535 authentication failed: bootstrap-password'), {
      code: 'EAUTH',
      command: 'AUTH PLAIN',
      responseCode: 535,
    }),
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  try {
    await assert.rejects(harness.security.sendCode({
      adminId: 'admin-1',
      sessionId: 'failed-mail-session',
      payloadHash: 'payload-hash',
      changes: [],
      auditContext,
      audit: harness.audit,
    }), (error) => error.status === 503 && /verification email could not be sent/i.test(error.message));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(logs, [
    'Bootstrap email delivery failed. {"code":"EAUTH","command":"AUTH PLAIN","responseCode":535}',
  ]);
  assert.equal(JSON.stringify(logs).includes('bootstrap-password'), false);
  assert.equal(harness.documents.get('integration_settings_pending_codes').has('failed-mail-session'), false);
  assert.equal(harness.events.some(({ action }) => action === 'integration.failure'), false);
  const failureEvent = harness.events.find(({ action }) => action === 'integration.code_send_failed');
  assert.deepEqual(failureEvent.new_value, { reason: 'login_rejected' });
  assert.equal(JSON.stringify(failureEvent).includes('admin@example.test'), false);
  assert.equal(JSON.stringify(failureEvent).includes('bootstrap-password'), false);
  const failedCode = /code is: (\d{6})/.exec(harness.messages[0].text)[1];
  assert.equal(JSON.stringify(failureEvent).includes(failedCode), false);
  assert.deepEqual(
    harness.documents.get('integration_settings_code_requests').get('admin-1')?.timestamps || [],
    [],
  );
  assert.equal(
    harness.documents.get('integration_settings_code_send_failures').get('admin-1').timestamps.length,
    1,
  );
});

test('failed code sends void the pending code and do not consume resend or success-request limits', async () => {
  const harness = createHarness({
    bootstrapMailError: Object.assign(new Error('Authentication failed.'), {
      code: 'EAUTH',
      responseCode: 535,
    }),
    bootstrapMailErrorCount: 1,
  });
  const send = () => harness.security.sendCode({
    adminId: 'admin-1',
    sessionId: 'retry-session',
    payloadHash: 'pending-hash',
    changes: [{ integration: 'smtp', label: 'SMTP', fields: ['password'] }],
    auditContext,
    audit: harness.audit,
  });
  await assert.rejects(send(), /login was rejected/i);
  assert.equal(harness.documents.get('integration_settings_pending_codes').has('retry-session'), false);
  assert.equal(
    harness.documents.get('integration_settings_code_requests').get('admin-1')?.timestamps,
    undefined,
  );
  harness.advance(0);
  const resent = await send();
  assert.equal(resent.maskedRecipient, 'a***@example.test');
  assert.equal(harness.messages.length, 2);
  assert.equal(
    harness.documents.get('integration_settings_code_requests').get('admin-1').timestamps.length,
    1,
  );
  assert.equal(
    harness.documents.get('integration_settings_code_send_failures').get('admin-1').timestamps.length,
    1,
  );
});

test('code-send failures have a separate ten-per-hour cap and report a retry wait', async () => {
  const harness = createHarness({
    bootstrapMailError: Object.assign(new Error('Connection refused.'), { code: 'ECONNECTION' }),
  });
  const send = (sessionId) => harness.security.sendCode({
    adminId: 'admin-1',
    sessionId,
    payloadHash: `pending-${sessionId}`,
    changes: [],
    auditContext,
    audit: harness.audit,
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await assert.rejects(send(`failure-${attempt}`), /could not be sent/i);
  }
  await assert.rejects(send('failure-11'), (error) => (
    error.status === 429 && error.retryAfter === 3600 && /Try again in 3600 seconds/.test(error.message)
  ));
  assert.equal(
    harness.documents.get('integration_settings_code_send_failures').get('admin-1').timestamps.length,
    10,
  );
  assert.equal(
    harness.documents.get('integration_settings_code_requests').get('admin-1')?.timestamps,
    undefined,
  );
  assert.equal(
    harness.events.filter(({ action }) => action === 'integration.code_send_failed').length,
    11,
  );
});

test('bootstrap test emails are fixed, masked, and limited to three attempts per hour', async () => {
  const harness = createHarness();
  const result = await harness.security.sendTestEmail({
    adminId: 'admin-1',
    auditContext,
  });
  assert.deepEqual(result, { maskedRecipient: 'a***@example.test' });
  assert.equal(harness.messages[0].subject, 'Verification email test');
  assert.match(harness.messages[0].text, /test message confirming/i);
  assert.equal(/\d{6}/.test(harness.messages[0].text), false);
  await harness.security.sendTestEmail({ adminId: 'admin-1', auditContext });
  await harness.security.sendTestEmail({ adminId: 'admin-1', auditContext });
  await assert.rejects(
    harness.security.sendTestEmail({ adminId: 'admin-1', auditContext }),
    (error) => error.status === 429 && error.retryAfter === 3600,
  );
  assert.equal(harness.messages.length, 3);
});

test('bootstrap test email failures return a safe reason and masked recipient', async () => {
  const harness = createHarness({
    bootstrapMailError: Object.assign(new Error('Authentication failed: bootstrap-password'), {
      code: 'EAUTH',
      responseCode: 535,
    }),
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      harness.security.sendTestEmail({ adminId: 'admin-1', auditContext }),
      (error) => error.status === 503
        && error.reason === 'login_rejected'
        && error.maskedRecipient === 'a***@example.test'
        && /login was rejected/.test(error.message)
        && !error.message.includes('bootstrap-password'),
    );
  } finally {
    console.error = originalError;
  }
});

test('one-character recipient local parts are fully masked', async () => {
  const harness = createHarness({ email: 'x@example.test' });
  const result = await harness.security.sendCode({
    adminId: 'admin-1',
    sessionId: 'single-character-recipient',
    payloadHash: 'pending-hash',
    changes: [],
    auditContext,
    audit: harness.audit,
  });
  assert.equal(result.maskedRecipient, '***');
  assert.equal((await harness.security.getPendingCodeStatus({
    adminId: 'admin-1',
    sessionId: 'single-character-recipient',
  })).maskedRecipient, '***');
});

test('code delivery always uses the bootstrap mailer for every integration identifier', async () => {
  const harness = createHarness();
  const integrations = ['google_auth', 'recaptcha', 'smtp', 'google_calendar', 'admin_mfa'];
  for (const [index, integration] of integrations.entries()) {
    if (index) harness.advance(60_000);
    await harness.security.sendCode({
      adminId: 'admin-1',
      sessionId: `integration-${integration}`,
      payloadHash: `payload-${integration}`,
      changes: [{ integration, label: integration, fields: ['credential'] }],
      auditContext,
      audit: harness.audit,
    });
  }
  assert.equal(harness.messages.length, integrations.length);
  assert.equal(
    JSON.stringify(harness.messages.map(({ to }) => to)).includes('admin@example.test'),
    true,
  );
});

test('verification code succeeds once, then cannot be reused or guessed five times', async () => {
  const harness = createHarness();
  const send = async (sessionId) => harness.security.sendCode({
    adminId: 'admin-1',
    sessionId,
    payloadHash: `payload-${sessionId}`,
    changes: [{ integration: 'smtp', label: 'Email (SMTP)', fields: ['password'] }],
    auditContext,
    audit: harness.audit,
  });
  await send('success-session');
  const code = /code is: (\d{6})/.exec(harness.messages[0].text)[1];
  await harness.security.verifyCode({
    adminId: 'admin-1', sessionId: 'success-session', candidate: code,
    payloadHash: 'payload-success-session', auditContext, audit: harness.audit,
  });
  await assert.rejects(harness.security.verifyCode({
    adminId: 'admin-1', sessionId: 'success-session', candidate: code,
    payloadHash: 'payload-success-session', auditContext, audit: harness.audit,
  }), /invalid or expired/);

  harness.advance(60_000);
  await send('guess-session');
  const wrongCode = /code is: (\d{6})/.exec(harness.messages[1].text)[1];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(harness.security.verifyCode({
      adminId: 'admin-1', sessionId: 'guess-session', candidate: '000000',
      payloadHash: 'payload-guess-session', auditContext, audit: harness.audit,
    }), /invalid or expired/);
  }
  await assert.rejects(harness.security.verifyCode({
    adminId: 'admin-1', sessionId: 'guess-session', candidate: wrongCode,
    payloadHash: 'payload-guess-session', auditContext, audit: harness.audit,
  }), /invalid or expired/);
});

test('verification codes expire and resend attempts are rate limited', async () => {
  const harness = createHarness();
  const send = (sessionId = 'rate-session') => harness.security.sendCode({
    adminId: 'admin-1',
    sessionId,
    payloadHash: 'same-payload',
    changes: [{ integration: 'recaptcha', label: 'reCAPTCHA', fields: ['secret_key'] }],
    auditContext,
    audit: harness.audit,
  });
  await send();
  await assert.rejects(send(), (error) => error.status === 429);
  harness.advance(60_000);
  await send();
  harness.advance(60_000);
  await send();
  harness.advance(60_000);
  await send();
  harness.advance(60_000);
  await send();
  harness.advance(60_000);
  await assert.rejects(send(), (error) => error.status === 429);

  const expiredCode = /code is: (\d{6})/.exec(harness.messages.at(-1).text)[1];
  harness.advance(10 * 60 * 1000);
  await assert.rejects(harness.security.verifyCode({
    adminId: 'admin-1', sessionId: 'rate-session', candidate: expiredCode,
    payloadHash: 'same-payload', auditContext, audit: harness.audit,
  }), /invalid or expired/);
});

test('verification request limit and window can be shortened for local testing', async () => {
  const harness = createHarness({
    codeRequestLimit: 2,
    codeRequestWindowMs: 10_000,
    codeResendMs: 1_000,
  });
  const send = (sessionId) => harness.security.sendCode({
    adminId: 'admin-1',
    sessionId,
    payloadHash: `payload-${sessionId}`,
    changes: [{ integration: 'google_auth', label: 'Google sign-in', fields: ['client_id'] }],
    auditContext,
    audit: harness.audit,
  });

  await send('test-session-1');
  harness.advance(1_000);
  await send('test-session-2');
  harness.advance(1_000);
  await assert.rejects(send('test-session-3'), (error) => error.status === 429);
  harness.advance(8_000);
  await send('test-session-4');
  assert.equal(harness.messages.length, 3);
});
