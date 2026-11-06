const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecaptcha } = require('../../src/services/recaptcha');

test('reCAPTCHA reads current credentials and sends the secret, response, and client IP to Google', async () => {
  let request;
  let calls = 0;
  const recaptcha = createRecaptcha(async (id) => {
    calls += 1;
    assert.equal(id, 'recaptcha');
    return {
      active: true,
      enabled: true,
      settings: { secret_key: `private-secret-${calls}` },
    };
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { success: true }; } };
  });

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
});

test('reCAPTCHA rejects missing or invalid challenge responses and skips when disabled', async () => {
  let enabled = false;
  const recaptcha = createRecaptcha(async () => ({
    configured: true,
    enabled,
    active: enabled,
    settings: { secret_key: 'private-secret' },
  }), async () => ({ ok: true, async json() { return { success: false }; } }));

  await assert.rejects(recaptcha.verifyResponse('challenge-response'), {
    message: 'reCAPTCHA is disabled.',
    status: 503,
  });
  enabled = true;
  await assert.rejects(recaptcha.verifyResponse(''), {
    message: 'Complete the reCAPTCHA challenge.',
    status: 400,
  });
  await assert.rejects(recaptcha.verifyResponse('invalid-response'), {
    message: 'The reCAPTCHA challenge could not be verified. Please try again.',
    status: 400,
  });
});

test('reCAPTCHA fails closed when Google verification is unavailable', async () => {
  const recaptcha = createRecaptcha(async () => ({
    configured: true,
    enabled: true,
    active: true,
    settings: { secret_key: 'private-secret' },
  }), async () => { throw new Error('network error'); });

  await assert.rejects(recaptcha.verifyResponse('challenge-response'), {
    message: 'Unable to verify reCAPTCHA right now. Please try again.',
    status: 503,
  });
});
