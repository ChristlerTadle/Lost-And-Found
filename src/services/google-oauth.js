const { randomBytes } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { providerFailure } = require('./integration-calls');

function createGoogleOAuth(getIntegration, callIntegration = runDirectly, fetchImpl = globalThis.fetch) {
  function getClientConfig(integration, { allowDisabled = false } = {}) {
    if (!integration.configured) {
      const error = new Error('Google sign-in is not configured.');
      error.status = 400;
      throw error;
    }
    if (!allowDisabled && !integration.active) {
      const error = new Error(integration.configured
        ? 'Google sign-in is disabled.'
        : 'Google sign-in is not configured.');
      error.status = 400;
      throw error;
    }
    const { client_id: clientId, client_secret: clientSecret, callback_url: callbackUrl } = integration.settings;
    if (process.env.NODE_ENV === 'production' && new URL(callbackUrl).protocol !== 'https:') {
      throw new Error('Google callback URL must use HTTPS in production.');
    }
    return { clientId, clientSecret, callbackUrl };
  }

  async function getClient() {
    const integration = await getIntegration('google_auth');
    const config = getClientConfig(integration);
    return {
      config,
      client: new OAuth2Client(config.clientId, config.clientSecret, config.callbackUrl),
    };
  }

  return {
    async testConnection(auditContext) {
      const integration = await getIntegration('google_auth');
      if (!integration.configured) {
        const error = new Error('Configure all required saved Google sign-in fields before testing.');
        error.status = 400;
        throw error;
      }
      const config = getClientConfig(integration, { allowDisabled: true });

      return callIntegration('google_auth', async ({ signal }) => {
        const response = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: 'integration-connection-test',
            code_verifier: 'integration-connection-test',
            grant_type: 'authorization_code',
            redirect_uri: config.callbackUrl,
          }),
          signal,
        });
        let result;
        try {
          result = await response.json();
        } catch {
          throw providerFailure('provider_error');
        }
        if (result.error === 'invalid_grant') return true;
        if (['invalid_client', 'unauthorized_client', 'redirect_uri_mismatch'].includes(result.error)) {
          throw providerFailure('invalid_credentials');
        }
        if (!response.ok || result.error) throw providerFailure('provider_error');
        return true;
      }, auditContext);
    },

    async createAuthorizationRequest() {
      const { client } = await getClient();
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const url = client.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return { url, state, nonce, codeVerifier };
    },

    async verifyAuthorizationResponse({ code, codeVerifier, nonce }, auditContext) {
      const { client, config } = await getClient();
      if (!code || !codeVerifier || !nonce) throw new Error('The Google sign-in response is incomplete.');

      const { tokens } = await callIntegration('google_auth',
        () => client.getToken({ code, codeVerifier }), auditContext);
      if (!tokens.id_token) throw new Error('Google did not return an identity token.');
      const ticket = await callIntegration('google_auth',
        () => client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId }), auditContext);
      const payload = ticket.getPayload();
      if (!payload || payload.nonce !== nonce) throw new Error('The Google sign-in response could not be verified.');

      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name,
      };
    },
  };
}

function runDirectly(_integrationId, operation) {
  return operation({ signal: new AbortController().signal });
}

module.exports = { createGoogleOAuth };
