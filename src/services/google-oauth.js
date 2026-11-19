const { randomBytes } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { providerFailure, UserProviderError } = require('./integration-calls');
const VERIFICATION_TTL_MS = 10 * 60 * 1000;

function createGoogleOAuth(
  getIntegration,
  callIntegration,
  fetchImpl = globalThis.fetch,
  {
    OAuthClient = OAuth2Client,
    verificationTtlMs = VERIFICATION_TTL_MS,
  } = {},
) {
  if (typeof callIntegration !== 'function') {
    throw new Error('callIntegration is required for Google OAuth provider calls.');
  }
  const pendingVerifications = new Map();

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
    let callbackProtocol;
    try {
      callbackProtocol = new URL(callbackUrl).protocol;
    } catch {
      const error = new Error('Google callback URL is invalid.');
      error.status = 400;
      throw error;
    }
    if (process.env.NODE_ENV === 'production' && callbackProtocol !== 'https:') {
      throw new Error('Google callback URL must use HTTPS in production.');
    }
    return { clientId, clientSecret, callbackUrl };
  }

  async function getClient() {
    const integration = await getIntegration('google_auth');
    const config = getClientConfig(integration);
    return {
      config,
      client: new OAuthClient(config.clientId, config.clientSecret, config.callbackUrl),
    };
  }

  return {
    async testConnection(auditContext, settings = null, options = {}) {
      const integration = settings
        ? { configured: true, active: true, settings }
        : await getIntegration('google_auth');
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
      }, auditContext, { ...options, purpose: 'admin_check' });
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

    async verifyCandidate(_auditContext, settings, proof = {}) {
      if (typeof proof.adminId !== 'string' || !proof.adminId
        || typeof proof.candidateHash !== 'string' || !/^[a-f0-9]{64}$/i.test(proof.candidateHash)
        || typeof proof.enabled !== 'boolean') {
        throw new UserProviderError('Google verification could not be started.');
      }

      const config = getClientConfig({
        configured: true,
        active: true,
        settings,
      }, { allowDisabled: true });
      const client = new OAuthClient(config.clientId, config.clientSecret, config.callbackUrl);
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + verificationTtlMs;
      for (const [pendingState, pending] of pendingVerifications) {
        if (pending.expiresAt <= Date.now()) {
          discardPendingCredentials(pending);
          pendingVerifications.delete(pendingState);
        }
      }
      const pending = {
        adminId: proof.adminId,
        candidateHash: proof.candidateHash,
        enabled: proof.enabled,
        settings: { ...settings },
        expiresAt,
        codeVerifier,
        nonce,
        client,
        clientId: config.clientId,
      };
      pending.expiryTimer = setTimeout(() => {
        if (pendingVerifications.get(state) !== pending) return;
        pending.expired = true;
        discardPendingCredentials(pending);
      }, verificationTtlMs);
      pending.expiryTimer.unref?.();
      pendingVerifications.set(state, pending);

      return {
        pending: true,
        authorizationUrl: client.generateAuthUrl({
          access_type: 'online',
          prompt: 'consent',
          scope: ['openid', 'email', 'profile'],
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        }),
      };
    },

    async completeVerificationCallback({ state, code, error }, auditContext = {}) {
      if (typeof state !== 'string') return null;
      const pending = pendingVerifications.get(state);
      if (!pending) return null;
      pendingVerifications.delete(state);
      const result = {
        adminId: pending.adminId,
        candidateHash: pending.candidateHash,
        enabled: pending.enabled,
        settings: pending.settings,
        status: 'failed',
      };
      if (pending.expiresAt <= Date.now()) {
        discardPendingCredentials(pending);
        return { ...result, failureCode: 'expired' };
      }
      if (error === 'redirect_uri_mismatch') {
        discardPendingCredentials(pending);
        return { ...result, failureCode: 'redirect_uri_mismatch' };
      }
      if (error === 'access_denied') {
        discardPendingCredentials(pending);
        return { ...result, status: 'access_denied' };
      }
      if (typeof code !== 'string' || !code) {
        discardPendingCredentials(pending);
        return { ...result, failureCode: 'invalid_response' };
      }
      if (pending.expired || !pending.client) {
        return { ...result, settings: null, failureCode: 'expired' };
      }

      let tokens;
      try {
        const tokenResult = await callIntegration(
          'google_auth',
          async () => {
            try {
              return await pending.client.getToken({ code, codeVerifier: pending.codeVerifier });
            } catch (tokenError) {
              if (getGoogleErrorCode(tokenError) === 'redirect_uri_mismatch') {
                throw new UserProviderError(
                  'The Google callback URL does not match the candidate settings.',
                  400,
                );
              }
              throw tokenError;
            }
          },
          auditContext,
          { candidateValidation: true, purpose: 'admin_check' },
        );
        tokens = tokenResult?.tokens;
        if (!tokens?.id_token) return { ...result, failureCode: 'invalid_response' };
        const ticket = await callIntegration(
          'google_auth',
          () => pending.client.verifyIdToken({
            idToken: tokens.id_token,
            audience: pending.clientId,
          }),
          auditContext,
          { candidateValidation: true, purpose: 'admin_check' },
        );
        const payload = ticket.getPayload();
        if (!payload || payload.nonce !== pending.nonce
          || payload.email_verified !== true
          || typeof payload.email !== 'string' || !payload.email.includes('@')) {
          return { ...result, failureCode: 'unverified_identity' };
        }
        return { ...result, status: 'success' };
      } catch (verificationError) {
        if (getGoogleErrorCode(verificationError) === 'redirect_uri_mismatch'
          || verificationError?.message === 'The Google callback URL does not match the candidate settings.') {
          return { ...result, failureCode: 'redirect_uri_mismatch' };
        }
        return { ...result, failureCode: 'verification_failed' };
      } finally {
        discardPendingCredentials(pending);
        if (tokens) {
          for (const key of Object.keys(tokens)) tokens[key] = undefined;
        }
      }
    },
  };
}

function discardPendingCredentials(pending) {
  if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
  pending.client?.setCredentials({});
  pending.client = null;
  pending.settings = null;
  pending.codeVerifier = null;
  pending.nonce = null;
  pending.clientId = null;
}

function getGoogleErrorCode(error) {
  return String(error?.response?.data?.error || error?.response?.data?.error_description || '');
}

module.exports = { createGoogleOAuth };
