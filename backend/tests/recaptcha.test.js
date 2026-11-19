const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createIntegrationCaller, IntegrationError } = require('../../src/services/integration-calls');
const { createRecaptcha: createRecaptchaWithLimiter } = require('../../src/services/recaptcha');

const testIntegrationCaller = (_integrationId, operation) => operation({
  signal: new AbortController().signal,
});
function createRecaptcha(...args) {
  if (typeof args[2] !== 'function') args[2] = testIntegrationCaller;
  return createRecaptchaWithLimiter(...args);
}

function createHealthHarness(options = {}) {
  const health = new Map();
  const auditEvents = [];
  const failures = [];
  const logs = [];
  const integrationSettings = {
    async recordIntegrationFailure(id, failure) {
      failures.push({ id, ...failure });
      health.set(id, { ...failure, consecutive_failures: (health.get(id)?.consecutive_failures || 0) + 1 });
    },
    async recordIntegrationSuccess(id) {
      health.delete(id);
    },
    async claimIntegrationFailureAudit() {
      if (options.allowAudit === false) return false;
      return true;
    },
  };
  const audit = { async logAction(event) { auditEvents.push(event); } };
  const callIntegration = createIntegrationCaller({
    integrationSettings,
    audit,
    timeoutMs: options.timeoutMs,
  });
  return {
    callIntegration,
    health,
    failures,
    auditEvents,
    logs,
    captureLogs() {
      const originalError = console.error;
      console.error = (...values) => logs.push(values.join(' '));
      return () => { console.error = originalError; };
    },
  };
}

function configuredIntegration(overrides = {}) {
  return {
    configured: true,
    enabled: true,
    active: true,
    settings: { secret_key: 'private-secret', ...overrides },
  };
}

test('reCAPTCHA sends the current secret, challenge, client IP, and timeout signal to Google', async () => {
  let request;
  let calls = 0;
  const harness = createHealthHarness();
  const recaptcha = createRecaptcha(async (id) => {
    calls += 1;
    assert.equal(id, 'recaptcha');
    return configuredIntegration({ secret_key: `private-secret-${calls}` });
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { success: true }; } };
  }, harness.callIntegration);

  await recaptcha.verifyResponse('challenge-response', '192.0.2.1');
  await recaptcha.verifyResponse('second-response');

  assert.equal(calls, 2);
  assert.equal(request.url, 'https://www.google.com/recaptcha/api/siteverify');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(request.options.body), {
    secret: 'private-secret-2',
    response: 'second-response',
  });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(harness.failures.length, 0);
});

test('candidate reCAPTCHA proof uses the candidate secret and requires explicit success and expected hostname', async () => {
  let request;
  const harness = createHealthHarness();
  const recaptcha = createRecaptcha(
    async () => assert.fail('Candidate verification must not load active settings.'),
    async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { success: true, hostname: 'frontend.example.test' };
        },
      };
    },
    harness.callIntegration,
  );
  const result = await recaptcha.verifyCandidate({}, {
    site_key: 'candidate-site-key-123456789012345',
    secret_key: 'candidate-secret-key-1234567890123456789',
  }, {
    token: 'single-use-challenge-token',
    expectedHostname: 'frontend.example.test',
  });

  assert.deepEqual(result, { verified: true, proofType: 'real_challenge' });
  assert.deepEqual(Object.fromEntries(request.options.body), {
    secret: 'candidate-secret-key-1234567890123456789',
    response: 'single-use-challenge-token',
  });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.auditEvents.length, 0);
});

test('candidate reCAPTCHA fails closed on network errors, timeouts, 5xx, and malformed replies', async () => {
  const harness = createHealthHarness({ timeoutMs: 10 });
  const candidate = {
    site_key: 'candidate-site-key-123456789012345',
    secret_key: 'candidate-secret-key-1234567890123456789',
  };
  const proof = { token: 'single-use-challenge-token', expectedHostname: 'frontend.example.test' };
  const failures = [
    {
      name: 'network',
      fetch: async () => {
        const error = new Error('network failure with candidate-secret-key');
        error.code = 'ECONNRESET';
        throw error;
      },
    },
    { name: 'timeout', fetch: async () => new Promise(() => {}) },
    {
      name: '5xx',
      fetch: async () => ({ ok: false, async json() { return { success: true }; } }),
    },
    {
      name: 'malformed JSON',
      fetch: async () => ({ ok: true, async json() { throw new SyntaxError('unexpected reply'); } }),
    },
    {
      name: 'unexpected reply',
      fetch: async () => ({ ok: true, async json() { return { success: 'true' }; } }),
    },
  ];

  for (const failure of failures) {
    const recaptcha = createRecaptcha(
      async () => assert.fail('Candidate verification must not load active settings.'),
      failure.fetch,
      harness.callIntegration,
    );
    await assert.rejects(recaptcha.verifyCandidate({}, candidate, proof), (error) => (
      error instanceof IntegrationError && error.status === 503
    ), failure.name);
  }

  assert.deepEqual(harness.failures, []);
  assert.deepEqual(harness.auditEvents, []);
  assert.equal(harness.health.has('recaptcha'), false);
});

test('candidate reCAPTCHA rejects hostname mismatch and invalid v3 action or score', async () => {
  const harness = createHealthHarness();
  const settings = {
    site_key: 'candidate-site-key-123456789012345',
    secret_key: 'candidate-secret-key-1234567890123456789',
  };
  const withReply = (reply) => createRecaptcha(
    async () => assert.fail('Candidate verification must not load active settings.'),
    async () => ({ ok: true, async json() { return reply; } }),
    harness.callIntegration,
  );

  await assert.rejects(
    withReply({ success: true, hostname: 'other.example.test' }).verifyCandidate({}, settings, {
      token: 'challenge-token',
      expectedHostname: 'frontend.example.test',
    }),
    (error) => error.code === 'recaptcha_hostname_mismatch',
  );
  await assert.rejects(
    withReply({ success: true, action: 'login', score: 0.9 }).verifyCandidate({}, settings, {
      token: 'challenge-token',
      expectedHostname: 'frontend.example.test',
    }),
    /could not be verified/,
  );
  await assert.rejects(
    withReply({ success: true, action: 'integration_verify', score: 0.49 }).verifyCandidate({}, settings, {
      token: 'challenge-token',
      expectedHostname: 'frontend.example.test',
    }),
    /could not be verified/,
  );
  assert.equal(harness.failures.length, 0);
});

test('candidate reCAPTCHA rejects malformed keys and public test keys unless explicitly allowed', async () => {
  const harness = createHealthHarness();
  const candidate = {
    site_key: '6LeIxAcTAAAAAJcZVRXS4R1b3u0XWg0d8',
    secret_key: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { success: true, hostname: 'frontend.example.test' }; },
  });
  const rejected = createRecaptcha(async () => {}, fetchImpl, harness.callIntegration, {
    allowTestKeys: false,
  });
  await assert.rejects(
    rejected.verifyCandidate({}, candidate, {
      token: 'challenge-token',
      expectedHostname: 'frontend.example.test',
    }),
    (error) => error.code === 'recaptcha_test_keys',
  );
  await assert.rejects(
    rejected.verifyCandidate({}, { ...candidate, site_key: 'bad' }, {
      token: 'challenge-token',
      expectedHostname: 'frontend.example.test',
    }),
    (error) => error.code === 'recaptcha_invalid_configuration',
  );
  const allowedInDevelopment = createRecaptcha(async () => {}, fetchImpl, harness.callIntegration, {
    allowTestKeys: true,
  });
  assert.deepEqual(await allowedInDevelopment.verifyCandidate({}, candidate, {
    token: 'challenge-token',
    expectedHostname: 'frontend.example.test',
  }), { verified: true, proofType: 'real_challenge' });
});

test('reCAPTCHA connection test validates the saved secret without a user challenge', async () => {
  let request;
  const harness = createHealthHarness();
  const recaptcha = createRecaptcha(async () => configuredIntegration({
    site_key: 'public-site-key',
  }), async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { success: false, 'error-codes': ['invalid-input-response'] };
      },
    };
  }, harness.callIntegration);

  assert.equal(await recaptcha.testConnection(), true);
  assert.equal(request.url, 'https://www.google.com/recaptcha/api/siteverify');
  assert.deepEqual(Object.fromEntries(request.options.body), {
    secret: 'private-secret',
    response: 'integration-connection-test',
  });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.health.has('recaptcha'), false);
});

test('reCAPTCHA connection test records rejected saved secrets as integration failures', async () => {
  const harness = createHealthHarness();
  const restoreLogs = harness.captureLogs();
  try {
    const recaptcha = createRecaptcha(async () => configuredIntegration(), async () => ({
      ok: true,
      async json() {
        return { success: false, 'error-codes': ['invalid-input-secret'] };
      },
    }), harness.callIntegration);
    await assert.rejects(recaptcha.testConnection(), (error) => (
      error instanceof IntegrationError && error.status === 503
    ));
  } finally {
    restoreLogs();
  }

  assert.equal(harness.failures.length, 1);
  assert.equal(harness.health.get('recaptcha').code, 'invalid_credentials');
  assert.equal(harness.auditEvents.length, 1);
  assert.equal(JSON.stringify(harness.logs).includes('private-secret'), false);
});

test('disabled reCAPTCHA skips and invalid or expired challenge tokens do not mark health failing', async () => {
  let enabled = false;
  const harness = createHealthHarness();
  const recaptcha = createRecaptcha(async () => ({
    ...configuredIntegration(),
    configured: enabled,
    enabled,
    active: enabled,
  }), async () => ({
    ok: true,
    async json() { return { success: false, 'error-codes': ['timeout-or-duplicate'] }; },
  }), harness.callIntegration);

  assert.equal(await recaptcha.verifyResponse('challenge-response'), false);
  enabled = true;
  await assert.rejects(recaptcha.verifyResponse(''), {
    message: 'Complete the reCAPTCHA challenge.',
    status: 400,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(recaptcha.verifyResponse(`invalid-response-${attempt}`), {
      message: 'The reCAPTCHA challenge could not be verified.',
      status: 400,
    });
  }
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.auditEvents.length, 0);
  assert.equal(harness.health.has('recaptcha'), false);
});

test('missing and rejected reCAPTCHA secrets fail closed with sanitized health and audit data', async () => {
  const harness = createHealthHarness();
  const restoreLogs = harness.captureLogs();
  try {
    const missingSecret = createRecaptcha(async () => ({
      ...configuredIntegration({ secret_key: '' }),
      configured: false,
    }), undefined, harness.callIntegration);
    await assert.rejects(missingSecret.verifyResponse('challenge-response'), (error) => (
      error instanceof IntegrationError
      && error.status === 503
      && error.message === 'Verification is temporarily unavailable. Please try again later.'
    ));

    const rejectedSecret = createRecaptcha(async () => configuredIntegration(), async () => ({
      ok: true,
      async json() {
        return { success: false, 'error-codes': ['invalid-input-secret', 'private-secret'] };
      },
    }), harness.callIntegration);
    await assert.rejects(rejectedSecret.verifyResponse('challenge-response'), IntegrationError);
  } finally {
    restoreLogs();
  }

  assert.equal(harness.failures.length, 2);
  assert.equal(harness.health.get('recaptcha').code, 'invalid_credentials');
  assert.equal(harness.auditEvents.length, 2);
  assert.ok(harness.auditEvents.every(({ action, new_value, target_id }) => (
    action === 'integration.failure'
    && target_id === 'recaptcha'
    && Object.keys(new_value).join(',') === 'code'
  )));
  const logged = JSON.stringify(harness.logs);
  assert.equal(logged.includes('private-secret'), false);
  assert.equal(logged.includes('invalid-input-secret'), false);
});

test('reCAPTCHA network errors and timeouts return safe errors and record failure health', async () => {
  const harness = createHealthHarness({ timeoutMs: 10 });
  const restoreLogs = harness.captureLogs();
  try {
    const networkFailure = createRecaptcha(async () => configuredIntegration(), async () => {
      const error = new Error('network error with private-secret');
      error.code = 'ECONNRESET';
      throw error;
    }, harness.callIntegration);
    await assert.rejects(networkFailure.verifyResponse('challenge-response'), (error) => (
      error instanceof IntegrationError && error.status === 503
    ));

    const timeout = createRecaptcha(async () => configuredIntegration(), async () => new Promise(() => {}), harness.callIntegration);
    await assert.rejects(timeout.verifyResponse('challenge-response'), (error) => (
      error instanceof IntegrationError
      && error.message === 'Verification is temporarily unavailable. Please try again later.'
    ));
  } finally {
    restoreLogs();
  }

  assert.deepEqual(harness.failures.map(({ code }) => code), ['network', 'timeout']);
  assert.equal(harness.auditEvents.length, 2);
  assert.equal(JSON.stringify(harness.logs).includes('private-secret'), false);
});
