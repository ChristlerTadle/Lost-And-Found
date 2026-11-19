const { randomBytes } = require('node:crypto');
const { categories, locations } = require('../../src/data');
const { optionalUser, startSession, saveSession, destroySession } = require('../middlewares/session-auth');
const { requestAuditContext } = require('../../src/services/audit-log');
const { IntegrationError } = require('../../src/services/integration-calls');
const { PERMISSIONS_BY_ROLE } = require('../config/role-permissions');

function createAuthController({
  auth,
  rolePermissions,
  email,
  googleOAuth,
  recaptcha,
  integrationSettings,
  adminMfa,
  notifications,
  frontendOrigin,
  audit,
  callIntegration,
}) {
  const startGoogleAuth = async (req, res) => {
    if (!await verifyRecaptcha(req, res, recaptcha, integrationSettings)) return;
    const google = await integrationSettings.getIntegration('google_auth');
    if (!google.active) {
      const error = new Error('Google sign-in is not enabled.');
      error.status = 400;
      throw error;
    }
    const request = await googleOAuth.createAuthorizationRequest();
    req.session.googleOAuth = request;
    await saveSession(req);
    if (req.method === 'POST') return res.json({ url: request.url });
    return res.redirect(request.url);
  };

  return {
    getAuthMe: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const user = await optionalUser(req);
      if (!req.session.csrfToken) {
        req.session.csrfToken = randomBytes(32).toString('base64url');
        await saveSession(req);
      }
      const pendingMfa = req.session.pendingAdminMfa;
      const pendingMfaActive = Boolean(pendingMfa && pendingMfa.expiresAt > Date.now());
      if (pendingMfa && !pendingMfaActive) {
        delete req.session.pendingAdminMfa;
        await saveSession(req);
      }
      let adminMfaSetupRequired = false;
      let adminMfaReauthRequired = false;
      if (user?.role_name === 'admin') {
        const action = await adminMfa.getLoginAction(user, req.ip);
        adminMfaSetupRequired = action.action === 'enroll';
        adminMfaReauthRequired = action.action === 'verify'
          && req.session.adminMfaVerified !== String(user.id);
      }
      const permissions = user
        ? (typeof rolePermissions.findEffectivePermissions === 'function'
          ? await rolePermissions.findEffectivePermissions(user.id, user.role_name)
          : user.role_name === 'admin'
            ? PERMISSIONS_BY_ROLE.admin.map(({ key }) => key)
            : await rolePermissions.findRolePermissions(user.role_name))
        : [];
      const unreadNotifications = user && (user.role_name === 'admin'
        || permissions.includes('receive_notifications'))
        ? await notifications.countUnread(user.id) : 0;
        const google = await integrationSettings.getIntegration('google_auth');
        const recaptchaIntegration = await integrationSettings.getIntegration('recaptcha');
        const googleAuth = {
          configured: google.configured,
          enabled: google.enabled,
          active: google.active,
        };
        const recaptchaStatus = {
          configured: recaptchaIntegration.configured,
          enabled: recaptchaIntegration.enabled,
          active: recaptchaIntegration.active,
          siteKey: recaptchaIntegration.active ? recaptchaIntegration.settings.site_key : '',
        };
        return res.json({
          user: adminMfaReauthRequired ? null : user,
          pendingAdminMfa: pendingMfaActive,
          adminMfaSetupRequired,
          adminMfaReauthRequired,
          rolePermissions: permissions,
          unreadNotifications,
        googleAuth,
        recaptcha: recaptchaStatus,
        csrfToken: req.session.csrfToken,
        categories,
        locations,
      });
    },

    postAuthRegister: async (req, res) => {
        if (!await verifyRecaptcha(req, res, recaptcha, integrationSettings)) return;
        const user = await auth.register(req.body);
      await startSession(req, user);
      return res.status(201).json({ user });
    },

    postAuthLogin: async (req, res) => {
      if (!await verifyRecaptcha(req, res, recaptcha, integrationSettings)) return;
      let user;
      try {
        user = await auth.login(req.body.email, req.body.password);
      } catch (error) {
        await logAuthEvent(audit, requestAuditContext(req, 'auth.login_failed', {
          actor_id: null,
          actor_role: null,
          target_type: error.accountId ? 'user' : null,
          target_id: error.accountId || null,
          result: 'failed',
        }));
        throw error;
      }
      const result = await beginLoginSession(req, user, adminMfa);
      if (result.mfaRequired || result.adminMfaSetupRequired) {
        if (result.adminMfaSetupRequired) {
          req.session.adminMfaLoginPending = true;
          await saveSession(req);
        }
        return res.json(result);
      }
      await logSuccessfulLogin(audit, req, user);
      return res.json({ user });
    },

    postAuthLogout: async (req, res) => {
        await destroySession(req);
      return res.json({ message: 'Signed out.' });
    },

    postAuthMfaVerify: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const pending = req.session.pendingAdminMfa;
      if (!pending) {
        const error = new Error('No administrator verification is pending.');
        error.status = 401;
        throw error;
      }
      if (!Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now()) {
        await destroySession(req);
        const error = new Error('This sign-in attempt expired. Sign in again.');
        error.status = 401;
        throw error;
      }
      const user = await auth.findActiveSessionUser(pending.userId);
      if (!user || user.role_name !== 'admin') {
        await destroySession(req);
        const error = new Error('This sign-in attempt is no longer valid. Sign in again.');
        error.status = 401;
        throw error;
      }
      await adminMfa.verifyLogin({
        adminId: user.id,
        ipAddress: req.ip,
        code: req.body?.code,
        audit,
      });
      await startSession(req, user);
      req.session.adminMfaVerified = String(user.id);
      req.session.csrfToken = randomBytes(32).toString('base64url');
      await saveSession(req);
      await logSuccessfulLogin(audit, req, user);
      return res.json({ user });
    },

    postAuthForgotpassword: async (req, res) => {
      void auth.requestPasswordReset(req.body.email, async (emailAddress, token) => {
        if (process.env.NODE_ENV === 'production' && new URL(frontendOrigin).protocol !== 'https:') {
          throw new Error('FRONTEND_ORIGIN must use HTTPS in production.');
        }
        const resetUrl = new URL('/?page=reset-password', frontendOrigin);
        resetUrl.searchParams.set('token', token);
        return email.sendPasswordReset(emailAddress, resetUrl.toString(), requestAuditContext(req, null));
      }).catch((error) => {
        console.error(error instanceof IntegrationError
          ? error.code === 'rate_limited'
            ? 'Password reset delivery was rate limited.'
            : 'Password reset delivery failed.'
          : 'Password reset request failed.');
      });
      return res.json({ message: 'If an active account uses that email, reset instructions have been sent.' });
    },

    getAuthResetpasswordByToken: async (req, res) => {
        return res.json({ valid: await auth.isPasswordResetTokenValid(req.params.token) });
    },

    postAuthResetpassword: async (req, res) => {
        await auth.resetPassword(req.body.token, req.body.password, req.body.password_confirmation);
      return res.json({ message: 'Password reset. You can now sign in.' });
    },

    getAuthGoogle: startGoogleAuth,
    postAuthGoogle: startGoogleAuth,

    getAuthGoogleCallback: async (req, res) => {
        const verification = await googleOAuth.completeVerificationCallback?.({
          state: req.query.state,
          code: req.query.code,
          error: req.query.error,
        }, requestAuditContext(req, null));
        if (verification) {
          const candidateHash = verification.settings
            ? integrationSettings.getVerificationHash(
              'google_auth',
              verification.enabled,
              verification.settings,
            )
            : null;
          const verified = Boolean(verification.settings)
            && verification.status === 'success'
            && candidateHash === verification.candidateHash;
          const status = verified
            ? 'success'
            : verification.failureCode === 'redirect_uri_mismatch'
              ? 'redirect_mismatch'
              : verification.status === 'access_denied'
                ? 'access_denied'
                : verification.failureCode === 'expired' ? 'expired' : 'failed';
          if (verification.settings) {
            await integrationSettings.recordVerification({
              adminId: verification.adminId,
              integrationId: 'google_auth',
              enabled: verification.enabled,
              values: verification.settings,
              proofType: 'real_sign_in',
              result: verified,
            });
          }
          if (verified) {
            callIntegration?.clearValidationFailures?.('google_auth');
            await audit.logAction({
              ...requestAuditContext(req, 'integration.verify_success'),
              actor_id: String(verification.adminId),
              actor_role: 'admin',
              target_type: 'integration',
              target_id: 'google_auth',
              new_value: { proof_type: 'real_sign_in' },
            });
          } else {
            await callIntegration?.recordValidationFailure?.('google_auth');
            await audit.logAction({
              ...requestAuditContext(req, 'integration.verify_failed'),
              actor_id: String(verification.adminId),
              actor_role: 'admin',
              target_type: 'integration',
              target_id: 'google_auth',
              new_value: { proof_type: 'real_sign_in' },
              result: 'failed',
            });
          }
          const returnUrl = new URL('/', frontendOrigin);
          returnUrl.searchParams.set('page', 'admin-settings');
          returnUrl.searchParams.set('googleAuthVerification', status);
          if (verification.popup === true) returnUrl.searchParams.set('googleAuthPopup', '1');
          return res.redirect(returnUrl.toString());
        }
        const pending = req.session.googleOAuth;
      delete req.session.googleOAuth;
      await saveSession(req);
      if (!(await integrationSettings.getIntegration('google_auth')).active
        || !pending || typeof req.query.state !== 'string' || req.query.state !== pending.state
        || req.query.error || typeof req.query.code !== 'string') {
        return res.redirect(`${frontendOrigin}/?authError=google`);
      }
      try {
        const profile = await googleOAuth.verifyAuthorizationResponse({
          code: req.query.code,
          codeVerifier: pending.codeVerifier,
          nonce: pending.nonce,
        }, requestAuditContext(req, null));
        const user = await auth.authenticateGoogle(profile);
        const result = await beginLoginSession(req, user, adminMfa);
        if (result.adminMfaSetupRequired) {
          req.session.adminMfaLoginPending = true;
          await saveSession(req);
        }
        if (!result.mfaRequired && !result.adminMfaSetupRequired) {
          await logSuccessfulLogin(audit, req, user);
        }
        if (result.mfaRequired) return res.redirect(`${frontendOrigin}/?page=admin-mfa-verify`);
        if (result.adminMfaSetupRequired) return res.redirect(`${frontendOrigin}/?page=admin-security`);
        return res.redirect(frontendOrigin);
      } catch (error) {
        if (!(error instanceof IntegrationError && error.code === 'rate_limited')) {
          await logAuthEvent(audit, requestAuditContext(req, 'auth.login_failed', {
            actor_id: null,
            actor_role: null,
            target_type: error.accountId ? 'user' : null,
            target_id: error.accountId || null,
            result: 'failed',
          }));
        }
        if (error instanceof IntegrationError) {
          if (error.code !== 'rate_limited') console.error('Google sign-in could not be completed.');
          return sendSafeIntegrationError(res, error);
        }
        console.error('Google sign-in could not be completed.');
        return res.redirect(`${frontendOrigin}/?authError=google`);
      }
    },
  };
}

async function beginLoginSession(req, user, adminMfa) {
  const { action } = await adminMfa.getLoginAction(user, req.ip);
  if (action === 'locked') {
    const error = new Error('The authentication code could not be verified. Try again later.');
    error.status = 429;
    throw error;
  }
  if (action === 'verify') {
    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) return reject(error);
        req.session.pendingAdminMfa = {
          userId: String(user.id),
          attemptId: randomBytes(24).toString('base64url'),
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        req.session.csrfToken = randomBytes(32).toString('base64url');
        req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
      });
    });
    return { mfaRequired: true };
  }
  await startSession(req, user);
  if (action === 'enroll') {
    req.session.adminMfaSetupRequired = String(user.id);
    req.session.csrfToken = randomBytes(32).toString('base64url');
    return { user, adminMfaSetupRequired: true };
  }
  return { user };
}

async function logSuccessfulLogin(audit, req, user) {
  if (!['admin', 'staff'].includes(user.role_name)) return;
  await logAuthEvent(audit, requestAuditContext(req, 'auth.login', {
    actor_id: user.id,
    actor_role: user.role_name,
    target_type: 'user',
    target_id: user.id,
  }));
}

async function verifyRecaptcha(req, res, recaptcha, integrationSettings) {
  const integration = await integrationSettings.getIntegration('recaptcha');
  if (!integration.enabled) return true;
  try {
    await recaptcha.verifyResponse(
      req.body?.['g-recaptcha-response'],
      req.ip,
      requestAuditContext(req, null),
    );
    return true;
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    sendSafeIntegrationError(res, error);
    return false;
  }
}

function sendSafeIntegrationError(res, error) {
  const rateLimited = error.code === 'rate_limited';
  const retryAfter = Number.isInteger(error.retryAfter) && error.retryAfter > 0
    ? error.retryAfter : 60;
  res.set('Retry-After', String(retryAfter));
  return res.status(rateLimited ? 429 : 503).json({
    error: 'Please try again shortly',
  });
}

async function logAuthEvent(audit, event) {
  try {
    await audit.logAction(event);
  } catch (error) {
    console.error('Unable to write authentication audit event:', error);
  }
}

module.exports = { createAuthController };
