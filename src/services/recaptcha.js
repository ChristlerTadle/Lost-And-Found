const { providerFailure, UserProviderError } = require('./integration-calls');

function createRecaptcha(getIntegration, fetchImpl = globalThis.fetch, callIntegration = runDirectly) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to verify reCAPTCHA responses.');

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
        const response = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
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
      }, auditContext, options);
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
        const response = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
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
  };
}

function runDirectly(_integrationId, operation) {
  return operation({ signal: new AbortController().signal });
}

module.exports = { createRecaptcha };
