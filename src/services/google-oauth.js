const { randomBytes } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

function createGoogleOAuth(getIntegration) {
  async function getClient() {
    const integration = await getIntegration('google_auth');
    if (!integration.active) {
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
    return {
      config: { clientId, callbackUrl },
      client: new OAuth2Client(clientId, clientSecret, callbackUrl),
    };
  }

  return {
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

    async verifyAuthorizationResponse({ code, codeVerifier, nonce }) {
      const { client, config } = await getClient();
      if (!code || !codeVerifier || !nonce) throw new Error('The Google sign-in response is incomplete.');

      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.id_token) throw new Error('Google did not return an identity token.');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
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

module.exports = { createGoogleOAuth };
