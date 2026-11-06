function createRecaptcha(getIntegration, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to verify reCAPTCHA responses.');

  return {
    async verifyResponse(token, remoteIp) {
      const integration = await getIntegration('recaptcha');
      if (!integration.active) {
        const error = new Error(integration.configured
          ? 'reCAPTCHA is disabled.'
          : 'reCAPTCHA is enabled but its keys are not configured.');
        error.status = 503;
        throw error;
      }
      if (typeof token !== 'string' || !token.trim()) {
        const error = new Error('Complete the reCAPTCHA challenge.');
        error.status = 400;
        throw error;
      }

      const body = new URLSearchParams({
        secret: integration.settings.secret_key,
        response: token,
      });
      if (typeof remoteIp === 'string' && remoteIp) body.set('remoteip', remoteIp);

      let response;
      try {
        response = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
      } catch {
        const error = new Error('Unable to verify reCAPTCHA right now. Please try again.');
        error.status = 503;
        throw error;
      }

      if (!response.ok) {
        const error = new Error('Unable to verify reCAPTCHA right now. Please try again.');
        error.status = 503;
        throw error;
      }

      let result;
      try {
        result = await response.json();
      } catch {
        const error = new Error('Unable to verify reCAPTCHA right now. Please try again.');
        error.status = 503;
        throw error;
      }

      if (result.success !== true) {
        const error = new Error('The reCAPTCHA challenge could not be verified. Please try again.');
        error.status = 400;
        throw error;
      }
    },
  };
}

module.exports = { createRecaptcha };
