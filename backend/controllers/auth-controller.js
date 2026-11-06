const { categories, locations } = require('../../src/data');
const { optionalUser, startSession, saveSession, destroySession } = require('../middlewares/session-auth');
const { requestAuditContext } = require('../../src/services/audit-log');

function createAuthController({ auth, rolePermissions, email, googleOAuth, recaptcha, integrationSettings, notifications, frontendOrigin, audit }) {
  const startGoogleAuth = async (req, res) => {
    await verifyRecaptcha(req, recaptcha, integrationSettings);
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
        const user = await optionalUser(req);
      const permissions = user && user.role_name !== 'admin'
        ? await rolePermissions.findRolePermissions(user.role_name) : [];
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
          user,
          rolePermissions: permissions,
          unreadNotifications,
        googleAuth,
        recaptcha: recaptchaStatus,
        categories,
        locations,
      });
    },

    postAuthRegister: async (req, res) => {
        await verifyRecaptcha(req, recaptcha, integrationSettings);
        const user = await auth.register(req.body);
      await startSession(req, user);
      return res.status(201).json({ user });
    },

    postAuthLogin: async (req, res) => {
      await verifyRecaptcha(req, recaptcha, integrationSettings);
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
      await startSession(req, user);
      if (['admin', 'staff'].includes(user.role_name)) {
        await logAuthEvent(audit, requestAuditContext(req, 'auth.login', {
          actor_id: user.id,
          actor_role: user.role_name,
          target_type: 'user',
          target_id: user.id,
        }));
      }
      return res.json({ user });
    },

    postAuthLogout: async (req, res) => {
        await destroySession(req);
      return res.json({ message: 'Signed out.' });
    },

    postAuthForgotpassword: async (req, res) => {
        await auth.requestPasswordReset(req.body.email, async (emailAddress, token) => {
        if (process.env.NODE_ENV === 'production' && new URL(frontendOrigin).protocol !== 'https:') {
          throw new Error('FRONTEND_ORIGIN must use HTTPS in production.');
        }
        const resetUrl = new URL('/?page=reset-password', frontendOrigin);
        resetUrl.searchParams.set('token', token);
        return email.sendPasswordReset(emailAddress, resetUrl.toString());
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
        });
        const user = await auth.authenticateGoogle(profile);
        await startSession(req, user);
        if (['admin', 'staff'].includes(user.role_name)) {
          await logAuthEvent(audit, requestAuditContext(req, 'auth.login', {
            actor_id: user.id,
            actor_role: user.role_name,
            target_type: 'user',
            target_id: user.id,
          }));
        }
        return res.redirect(frontendOrigin);
      } catch (error) {
        await logAuthEvent(audit, requestAuditContext(req, 'auth.login_failed', {
          actor_id: null,
          actor_role: null,
          target_type: error.accountId ? 'user' : null,
          target_id: error.accountId || null,
          result: 'failed',
        }));
        console.error('Google sign-in failed.');
        return res.redirect(`${frontendOrigin}/?authError=google`);
      }
    },
  };
}

async function verifyRecaptcha(req, recaptcha, integrationSettings) {
  const integration = await integrationSettings.getIntegration('recaptcha');
  if (!integration.enabled) return;
  await recaptcha.verifyResponse(req.body?.['g-recaptcha-response'], req.ip);
}

async function logAuthEvent(audit, event) {
  try {
    await audit.logAction(event);
  } catch (error) {
    console.error('Unable to write authentication audit event:', error);
  }
}

module.exports = { createAuthController };
