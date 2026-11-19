const { providerFailure, UserProviderError } = require('./integration-calls');
const config = require('../config');
const SITE_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const PUBLIC_TEST_KEYS = new Set([
  '6LeIxAcTAAAAAJcZVRXS4R1b3u0XWg0d8',
  '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
]);

function createRecaptcha(
  getIntegration,
  fetchImpl = globalThis.fetch,
  callIntegration,
  { allowTestKeys = config.recaptchaAllowTestKeys } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to verify reCAPTCHA responses.');
  if (typeof callIntegration !== 'function') {
    throw new Error('callIntegration is required for reCAPTCHA provider calls.');
  }

  return {
    async testConnection(auditContext, settings = null, options = {}) {
      const integration = settings
        ? { configured: true, active: true, settings }
        : await getIntegration('recaptcha');
      if (!integration.configured || !integration.settings.secret_key) {
        const error = new Error('Configure all required saved reCAPTCHA fields before testing.');
        error.status = 400;
        throw error;
      }

      const body = new URLSearchParams({
        secret: integration.settings.secret_key,
        response: 'integration-connection-test',
      });
      return callIntegration('recaptcha', async ({ signal }) => {
        const response = await fetchImpl(SITE_VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal,
        });
        if (!response.ok) throw providerFailure('provider_error');

        let result;
        try {
          result = await response.json();
        } catch {
          throw providerFailure('provider_error');
        }
        const errors = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
        if (errors.some((code) => ['invalid-input-secret', 'missing-input-secret'].includes(code))) {
          throw providerFailure('invalid_credentials');
        }
        if (typeof result.success !== 'boolean') throw providerFailure('provider_error');
        return true;
      }, auditContext, { ...options, purpose: 'admin_check' });
    },

    async verifyResponse(token, remoteIp, auditContext) {
      const integration = await getIntegration('recaptcha');
      if (!integration.enabled) return false;
      if (!integration.configured || !integration.settings.secret_key) {
        return callIntegration('recaptcha', async () => {
          throw providerFailure('invalid_credentials');
        }, auditContext);
      }
      if (typeof token !== 'string' || !token.trim()) {
        throw new UserProviderError('Complete the reCAPTCHA challenge.');
      }

      const body = new URLSearchParams({
        secret: integration.settings.secret_key,
        response: token,
      });
      if (typeof remoteIp === 'string' && remoteIp) body.set('remoteip', remoteIp);

      return callIntegration('recaptcha', async ({ signal }) => {
        const response = await fetchImpl(SITE_VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal,
        });
        if (!response.ok) throw providerFailure('provider_error');

        let result;
        try {
          result = await response.json();
        } catch {
          throw providerFailure('provider_error');
        }
        const errors = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
        if (errors.some((code) => ['invalid-input-secret', 'missing-input-secret'].includes(code))) {
          throw providerFailure('invalid_credentials');
        }
        if (result.success !== true) {
          throw new UserProviderError('The reCAPTCHA challenge could not be verified.');
        }
        return true;
      }, auditContext);
    },

    async verifyCandidate(auditContext, settings, proof = {}) {
      if (!isSiteKeyFormatValid(settings?.site_key) || !isSecretKeyFormatValid(settings?.secret_key)) {
        throw candidateError('recaptcha_invalid_configuration', 'Enter valid reCAPTCHA site and secret keys.');
      }
      if (!allowTestKeys
        && (PUBLIC_TEST_KEYS.has(settings.site_key) || PUBLIC_TEST_KEYS.has(settings.secret_key))) {
        throw candidateError('recaptcha_test_keys', 'Google public test keys cannot be used for verification.');
      }
      if (typeof proof?.token !== 'string' || !proof.token.trim()) {
        throw new UserProviderError('Complete the reCAPTCHA challenge.');
      }

      const body = new URLSearchParams({
        secret: settings.secret_key,
        response: proof.token,
      });
      return callIntegration('recaptcha', async ({ signal }) => {
        const response = await fetchImpl(SITE_VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal,
        });
        if (!response.ok) throw providerFailure('provider_error');

        let result;
        try {
          result = await response.json();
        } catch {
          throw providerFailure('provider_error');
        }
        if (!result || typeof result.success !== 'boolean') {
          throw providerFailure('provider_error');
        }
        const errors = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
        if (errors.some((code) => ['invalid-input-secret', 'missing-input-secret'].includes(code))) {
          throw providerFailure('invalid_credentials');
        }
        if (result.success !== true) {
          throw new UserProviderError('The reCAPTCHA challenge could not be verified.');
        }
        if (result.hostname !== undefined) {
          const expected = normalizeHostname(proof.expectedHostname);
          const actual = normalizeHostname(result.hostname);
          if (!expected || !actual || expected !== actual) {
            throw candidateError('recaptcha_hostname_mismatch', 'The challenge hostname did not match this site.');
          }
        }
        if (result.action !== undefined || result.score !== undefined) {
          if (result.action !== 'integration_verify'
            || typeof result.score !== 'number'
            || !Number.isFinite(result.score)
            || result.score < 0.5
            || result.score > 1) {
            throw new UserProviderError('The reCAPTCHA challenge could not be verified.');
          }
        }
        return { verified: true, proofType: 'real_challenge' };
      }, auditContext, { candidateValidation: true, purpose: 'admin_check' });
    },
  };
}

function isSiteKeyFormatValid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{30,512}$/.test(value);
}

function isSecretKeyFormatValid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40}$/.test(value);
}

function normalizeHostname(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function candidateError(code, message) {
  const error = new UserProviderError(message, 400);
  error.code = code;
  return error;
}

module.exports = { createRecaptcha };
