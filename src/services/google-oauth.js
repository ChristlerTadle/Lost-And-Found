const { randomBytes } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

function createGoogleOAuth(config) {
  const enabled = Boolean(config.clientId && config.clientSecret);
  if (enabled && process.env.NODE_ENV === 'production' && new URL(config.redirectUri).protocol !== 'https:') {
    throw new Error('GOOGLE_REDIRECT_URI must use HTTPS in production.');
  }
  const client = enabled
    ? new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri)
    : null;

  return {
    enabled,

    async createAuthorizationRequest() {
      if (!client) throw new Error('Google sign-in is not configured.');
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
      if (!client) throw new Error('Google sign-in is not configured.');
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
