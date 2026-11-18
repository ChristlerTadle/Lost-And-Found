
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { saveSession } = require('../middlewares/session-auth');
const { requestAuditContext } = require('../../src/services/audit-log');
const { IntegrationError } = require('../../src/services/integration-calls');

function createAdminController({
  auth,
  items,
  rolePermissions,
  notifications,
  integrationSettings,
  integrationSecurity,
  adminMfa,
  googleOAuth,
  recaptcha,
  googleCalendar,
  email,
  callIntegration,
  audit,
}) {
  return {
    getAdminDashboard: async (req, res) => {
      const [users, summary] = await Promise.all([
        auth.getAdminUserSummary(),
        items.getAdminDashboardSummary(),
      ]);
      return res.json({ users, summary });
    },

    getAdminUsers: async (req, res) => {
      return res.json({ users: await auth.findAccountsForStaffAssignment() });
    },

    postAdminUsers: async (req, res) => {
      const newValues = safeUserValues({
        ...req.body,
        role_name: 'user',
        status: 'active',
      });
      const created = await audit.runAction(requestAuditContext(req, 'user.create', {
        target_type: 'user',
        target_id: (result) => result.id,
        new_value: newValues,
      }), async (session) => {
        return auth.createAdminUser(req.body, { session });
      });
      return res.status(201).json({ user: created });
    },

    patchAdminUsersById: async (req, res) => {
      const action = req.body.action;
      const oldAccount = await findAccount(auth, req.params.id);
      if (action === 'edit') {
        const nextValues = safeUserValues({
          ...oldAccount,
          full_name: String(req.body.full_name || '').trim(),
          email: String(req.body.email || '').trim().toLowerCase(),
          student_id: req.body.student_id || null,
          phone: req.body.phone || null,
        });
        const changed = changedValues(safeUserValues(oldAccount), nextValues);
        await audit.runAction(requestAuditContext(req, 'user.update', {
          target_type: 'user',
          target_id: req.params.id,
          old_value: changed.old_value,
          new_value: changed.new_value,
        }), (session) => auth.updateUserByAdmin(req.params.id, req.body, { session }));
      }
      else if (action === 'assign_staff') {
        await audit.runAction(requestAuditContext(req, 'user.update', {
          target_type: 'user', target_id: req.params.id,
          old_value: { role_name: oldAccount.role_name }, new_value: { role_name: 'staff' },
        }), async (session) => {
          await auth.assignStaffRole(req.params.id, { session });
          await notifications.create(req.params.id, {
            type: 'status',
            title: 'Staff access granted',
            message: 'An administrator assigned staff access to your account.',
            href: '/?page=dashboard',
          }, { session });
        });
      } else if (action === 'revert_staff') {
        await audit.runAction(requestAuditContext(req, 'user.update', {
          target_type: 'user', target_id: req.params.id,
          old_value: { role_name: 'staff' }, new_value: { role_name: 'user' },
        }), (session) => auth.revertStaffRole(req.params.id, { session }));
      } else if (action === 'disable' || action === 'enable') {
        const status = action === 'disable' ? 'disabled' : 'active';
        await audit.runAction(requestAuditContext(req, action === 'disable' ? 'user.disable' : 'user.update', {
          target_type: 'user', target_id: req.params.id,
          old_value: { status: oldAccount.status }, new_value: { status },
        }), (session) => auth.setUserAccountStatus(req.params.id, status, { session }));
      }
      else {
        const error = new Error('Choose a valid user action.');
        error.status = 400;
        throw error;
      }
      return res.json({ message: 'User updated.' });
    },

    getAdminRolePermissions: async (_req, res) => {
      const roles = await Promise.all(['user', 'staff'].map((role) => rolePermissions.getRoleSettings(role)));
      return res.json({ roles });
    },

    putAdminRolePermissions: async (req, res) => {
      const role = req.params.role;
      const newPermissions = rolePermissions.preparePermissions(role, req.body);
      const oldPermissions = await rolePermissions.findRolePermissions(role);
      if (oldPermissions.length === newPermissions.length
        && oldPermissions.every((permission, index) => permission === newPermissions[index])) {
        return res.json({ role, permissions: newPermissions, changed: false });
      }
      const result = await audit.runAction(requestAuditContext(req, 'role_permissions.update', {
        target_type: 'role',
        target_id: role,
        old_value: { role, permissions: oldPermissions },
        new_value: { role, permissions: newPermissions },
      }), (session) => rolePermissions.replaceRolePermissions(role, newPermissions, session));
      return res.json(result);
    },

    getAdminItems: async (req, res) => {
      return res.json({ items: await items.findAdminItems(req.query) });
    },

    getAdminItemsById: async (req, res) => {
      return res.json({ item: await items.findAdminItem(req.params.id) });
    },

    getAdminItemsByIdImage: async (req, res) => {
      const item = await items.findAdminItem(req.params.id);
      if (item.item_type !== 'found' || !item.image_path || !/^[0-9a-f-]+\.(jpg|png|webp)$/i.test(item.image_path)) {
        return res.sendStatus(404);
      }
      res.set('Cache-Control', 'private, no-store');
      return res.sendFile(path.resolve(__dirname, '..', '..', 'private_uploads', 'found', item.image_path));
    },

    patchAdminItemsById: async (req, res) => {
      const oldItem = await items.findAdminItem(req.params.id);
      const nextItem = {
        item_name: String(req.body.item_name || '').trim(),
        category: String(req.body.category || '').trim(),
        location: String(req.body.location || '').trim(),
        date_lost: String(req.body.date_lost || '').trim(),
      };
      const changed = changedValues(safeItemEditValues(oldItem), safeItemEditValues(nextItem));
      await audit.runAction(requestAuditContext(req, 'item.update', {
        target_type: 'item', target_id: req.params.id,
        old_value: changed.old_value, new_value: changed.new_value,
      }), (session) => items.updateAdminItem(req.params.id, req.body, session));
      return res.json({ message: 'Item updated.' });
    },

    deleteAdminItemsById: async (req, res) => {
      const snapshot = await items.findAdminItem(req.params.id);
      const keyFields = safeItemValues(snapshot);
      const deletedAt = new Date();
      await audit.runAction(requestAuditContext(req, 'item.remove', {
        target_type: 'item', target_id: req.params.id,
        old_value: keyFields,
        new_value: { deleted_at: deletedAt.toISOString(), deleted_by: req.user.id },
      }), (session) => items.softDeleteAdminItem(req.params.id, req.user.id, session, deletedAt));
      await googleCalendar.cleanupForItem(
        req.params.id,
        requestAuditContext(req, null),
        { notify: true },
      );
      return res.json({ message: 'Item removed.' });
    },

    getAdminClaims: async (req, res) => {
      return res.json({ claims: await items.findAdminClaims(req.query) });
    },

    getAdminInventory: async (req, res) => {
      const report = await audit.runAction(requestAuditContext(req, 'report.generate', {
        target_type: 'report',
        new_value: { report_type: 'inventory' },
      }), () => items.findInventoryReport());
      return res.json({ items: report });
    },

    getAdminSystemRecords: async (req, res) => {
      return res.json(await audit.findRecords(req.query));
    },

    getAdminSettingsAccess: async (req, res) => {
      if (!req.session.csrfToken) {
        req.session.csrfToken = randomBytes(32).toString('base64url');
      }
      const state = integrationSecurity.configuration();
      const unlocked = state.accessReady
        && integrationSecurity.touchSession(req.session, req.user.id);
      await saveSession(req);
      return res.json({
        csrfToken: req.session.csrfToken,
        accessReady: state.accessReady,
        accessError: state.accessError,
        unlocked,
        verificationEmailConfigured: state.verificationEmailConfigured,
        verificationEmailError: state.verificationEmailError,
      });
    },

    postAdminSettingsUnlock: async (req, res) => {
      await integrationSecurity.unlock({
        adminId: req.user.id,
        ipAddress: req.ip,
        candidate: req.body?.pin,
        session: req.session,
        auditContext: requestAuditContext(req, null),
        audit,
      });
      await saveSession(req);
      return res.json({ unlocked: true });
    },

    postAdminSettingsLock: async (req, res) => {
      delete req.session.integrationSettingsAccess;
      await integrationSecurity.cancelCode({ adminId: req.user.id, sessionId: req.sessionID });
      await saveSession(req);
      return res.json({ locked: true });
    },

    getAdminSettings: async (req, res) => {
      const [integrations, enrollmentSummary] = await Promise.all([
        integrationSettings.getAdminIntegrations(),
        adminMfa.getAdminSummary(),
      ]);
      integrations.admin_mfa.enrollmentSummary = enrollmentSummary;
      return res.json({
        integrations,
      });
    },

    putAdminSettings: async (req, res) => {
      try {
        const plan = await integrationSettings.prepareIntegrationSave(
          req.body?.integrations,
        );
        await validateIntegrationSavePlan(req, plan, {
          integrationSettings, integrationSecurity, adminMfa, googleOAuth, recaptcha, googleCalendar, email, callIntegration, audit,
        });
        if (plan.credentialChanges.length) {
          const result = await sendIntegrationVerificationCode(req, integrationSecurity, integrationSettings, plan, audit);
          return res.json({ verificationRequired: true, ...result });
        }
        return res.json(await integrationSettings.applyIntegrationSave(
          plan, audit, requestAuditContext(req, null),
        ));
      } catch (error) {
        return integrationSettingsError(res, error, 'Integration settings could not be saved.');
      }
    },

    postAdminSettingsCodeResend: async (req, res) => {
      try {
        const restore = req.session.pendingAdminMfaRestore;
        if (restore && req.body?.restoreDefault === restore.integrationId) {
          const result = await sendIntegrationVerificationCode(
            req, integrationSecurity, integrationSettings, restore.plan, audit,
          );
          return res.json({ verificationRequired: true, restoreDefault: restore.integrationId, ...result });
        }
        const plan = await integrationSettings.prepareIntegrationSave(
          req.body?.integrations,
        );
        if (!plan.credentialChanges.length) {
          const error = new Error('There are no credential changes to verify.');
          error.status = 400;
          throw error;
        }
        await validateIntegrationSavePlan(req, plan, {
          integrationSettings, integrationSecurity, adminMfa, googleOAuth, recaptcha, googleCalendar, email, callIntegration, audit,
        });
        const result = await sendIntegrationVerificationCode(req, integrationSecurity, integrationSettings, plan, audit);
        return res.json({ verificationRequired: true, ...result });
      } catch (error) {
        return integrationSettingsError(res, error, 'The verification code could not be sent.');
      }
    },

    postAdminSettingsCodeCancel: async (req, res) => {
      await integrationSecurity.cancelCode({ adminId: req.user.id, sessionId: req.sessionID });
      delete req.session.pendingAdminMfaRestore;
      await saveSession(req);
      return res.json({ cancelled: true });
    },

    postAdminSettingsCodeVerify: async (req, res) => {
      try {
        const restore = req.session.pendingAdminMfaRestore;
        if (restore && req.body?.restoreDefault === restore.integrationId
          && restore.adminId === String(req.user.id)) {
          await integrationSecurity.verifyCode({
            adminId: req.user.id,
            sessionId: req.sessionID,
            candidate: req.body?.code,
            payloadHash: restore.plan.payloadHash,
            auditContext: requestAuditContext(req, null),
            audit,
            changes: restore.plan.changes,
          });
          delete req.session.pendingAdminMfaRestore;
          await saveSession(req);
          return res.json(await restoreIntegrationDefaultForRequest(
            req, restore.integrationId, integrationSettings, integrationSecurity, audit,
          ));
        }
        const plan = await integrationSettings.prepareIntegrationSave(
          req.body?.integrations,
        );
        if (!plan.credentialChanges.length) {
          const error = new Error('There are no credential changes to verify.');
          error.status = 400;
          throw error;
        }
        await integrationSecurity.verifyCode({
          adminId: req.user.id,
          sessionId: req.sessionID,
          candidate: req.body?.code,
          payloadHash: plan.payloadHash,
          auditContext: requestAuditContext(req, null),
          audit,
          changes: plan.changes,
        });
        await validateIntegrationSavePlan(req, plan, {
          integrationSettings, integrationSecurity, adminMfa, googleOAuth, recaptcha, googleCalendar, email, callIntegration, audit,
        });
        return res.json(await integrationSettings.applyIntegrationSave(
          plan, audit, requestAuditContext(req, null),
        ));
      } catch (error) {
        return integrationSettingsError(res, error, 'Integration settings could not be saved.');
      }
    },

    postAdminSettingsDefault: async (req, res) => {
      return res.json(await integrationSettings.setIntegrationDefault(
        req.params.integrationId, audit, requestAuditContext(req, null),
      ));
    },

    postAdminSettingsRestoreDefault: async (req, res) => {
      const { integrationId } = req.params;
      const preview = await integrationSettings.getDefaultRestorePreview(integrationId);
      if (integrationId === 'admin_mfa' && preview.changedFields.length) {
        const current = await integrationSettings.getIntegration(integrationId);
        const plan = await integrationSettings.prepareIntegrationSave({
          [integrationId]: { enabled: current.enabled, fields: preview.values },
        });
        if (plan.credentialChanges.length) {
          await validateIntegrationSavePlan(req, plan, {
            integrationSettings, integrationSecurity, adminMfa, googleOAuth, recaptcha, googleCalendar, email, callIntegration, audit,
          });
          req.session.pendingAdminMfaRestore = {
            adminId: String(req.user.id),
            integrationId,
            plan,
          };
          await saveSession(req);
          const result = await sendIntegrationVerificationCode(
            req, integrationSecurity, integrationSettings, plan, audit,
          );
          return res.json({ verificationRequired: true, restoreDefault: integrationId, ...result });
        }
      }
      return res.json(await restoreIntegrationDefaultForRequest(
        req, integrationId, integrationSettings, integrationSecurity, audit,
      ));
    },

    postAdminSettingsSmtpTest: async (req, res) => {
      const smtp = await integrationSettings.getIntegration('smtp');
      try {
        if (!smtp.configured) {
          const error = new Error('Configure all required saved SMTP fields before testing.');
          error.status = 400;
          throw error;
        }
        await email.testConnection(smtp.settings, requestAuditContext(req, null));
        if (integrationSettings.recordCandidateValidation) {
          await integrationSettings.recordCandidateValidation('smtp', smtp.settings, true, 'Validated');
        }
        return res.json({ verified: true, integrations: await integrationSettings.getAdminIntegrations() });
      } catch (error) {
        await recordSavedValidationFailure(integrationSettings, 'smtp', smtp.settings, error);
        const safeError = new Error('SMTP connection could not be verified. Check saved SMTP settings and credentials.');
        safeError.status = error.status || 400;
        throw safeError;
      }
    },

    postAdminSettingsGoogleCalendarTest: async (req, res) => {
      const current = await integrationSettings.getIntegration('google_calendar');
      try {
        await googleCalendar.testConnection(requestAuditContext(req, null), current.settings);
        if (integrationSettings.recordCandidateValidation) {
          await integrationSettings.recordCandidateValidation('google_calendar', current.settings, true, 'Validated');
        }
        return res.json({ verified: true, integrations: await integrationSettings.getAdminIntegrations() });
      } catch (error) {
        await recordSavedValidationFailure(integrationSettings, 'google_calendar', current.settings, error);
        const safeMessage = error instanceof IntegrationError && error.code === 'invalid_credentials'
          ? 'Google Calendar credentials were rejected. Check the service-account email and private key.'
          : error instanceof IntegrationError
            ? error.message
            : error.status === 400
              ? error.message
              : 'Google Calendar connection could not be verified. Check the saved calendar and service-account settings.';
        const safeError = new Error(safeMessage);
        safeError.status = error.status || 503;
        throw safeError;
      }
    },

    postAdminSettingsGoogleAuthTest: async (req, res) => {
      const current = await integrationSettings.getIntegration('google_auth');
      try {
        await googleOAuth.testConnection(requestAuditContext(req, null), current.settings);
        if (integrationSettings.recordCandidateValidation) {
          await integrationSettings.recordCandidateValidation('google_auth', current.settings, true, 'Validated');
        }
        return res.json({ verified: true, integrations: await integrationSettings.getAdminIntegrations() });
      } catch (error) {
        await recordSavedValidationFailure(integrationSettings, 'google_auth', current.settings, error);
        const safeMessage = error instanceof IntegrationError && error.code === 'invalid_credentials'
          ? 'Google sign-in credentials were rejected. Check the client ID, client secret, and callback URL.'
          : error instanceof IntegrationError
            ? error.message
            : error.status === 400
              ? error.message
              : 'Google sign-in connection could not be verified. Check the saved credentials and callback URL.';
        const safeError = new Error(safeMessage);
        safeError.status = error.status || 503;
        throw safeError;
      }
    },

    postAdminSettingsRecaptchaTest: async (req, res) => {
      const current = await integrationSettings.getIntegration('recaptcha');
      try {
        await recaptcha.testConnection(requestAuditContext(req, null), current.settings);
        if (integrationSettings.recordCandidateValidation) {
          await integrationSettings.recordCandidateValidation('recaptcha', current.settings, true, 'Validated');
        }
        return res.json({ verified: true, integrations: await integrationSettings.getAdminIntegrations() });
      } catch (error) {
        await recordSavedValidationFailure(integrationSettings, 'recaptcha', current.settings, error);
        const safeMessage = error instanceof IntegrationError && error.code === 'invalid_credentials'
          ? 'reCAPTCHA secret key was rejected. Check the saved secret key.'
          : error instanceof IntegrationError
            ? error.message
            : error.status === 400
              ? error.message
              : 'reCAPTCHA connection could not be verified. Check the saved secret key and provider availability.';
        const safeError = new Error(safeMessage);
        safeError.status = error.status || 503;
        throw safeError;
      }
    },

    postAdminSettingsAdminMfaTest: async (_req, res) => {
      const current = await integrationSettings.getIntegration('admin_mfa');
      try {
        await adminMfa.selfTest(current.settings);
        if (integrationSettings.recordCandidateValidation) {
          await integrationSettings.recordCandidateValidation('admin_mfa', current.settings, true, 'Validated');
        }
        return res.json({ verified: true, integrations: await integrationSettings.getAdminIntegrations() });
      } catch (error) {
        await recordSavedValidationFailure(integrationSettings, 'admin_mfa', current.settings, error);
        throw error;
      }
    },

    getAdminMfaStatus: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      return res.json(await adminMfa.getStatus(req.user.id));
    },

    postAdminMfaEnrollmentStart: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const result = await adminMfa.startEnrollment({
        adminId: req.user.id,
        ipAddress: req.ip,
        code: req.body?.code,
        audit,
      });
      return res.json(result);
    },

    postAdminMfaEnrollmentConfirm: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const result = await adminMfa.confirmEnrollment({
        adminId: req.user.id,
        ipAddress: req.ip,
        code: req.body?.code,
        audit,
      });
      req.session.adminMfaVerified = String(req.user.id);
      delete req.session.adminMfaSetupRequired;
      const completedLogin = req.session.adminMfaLoginPending === true;
      delete req.session.adminMfaLoginPending;
      await saveSession(req);
      if (completedLogin) {
        await audit.logAction(requestAuditContext(req, 'auth.login', {
          actor_id: req.user.id,
          actor_role: 'admin',
          target_type: 'user',
          target_id: req.user.id,
        }));
      }
      return res.json(result);
    },

    postAdminMfaRecoveryRegenerate: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      return res.json(await adminMfa.regenerateRecoveryCodes({
        adminId: req.user.id,
        ipAddress: req.ip,
        code: req.body?.code,
        audit,
      }));
    },
  };
}

async function sendIntegrationVerificationCode(req, integrationSecurity, integrationSettings, plan, audit) {
  const changes = plan.changes.map(({ integration, fields }) => ({
    integration,
    label: integrationSettings.getIntegrationLabel(integration),
    fields,
  }));
  return integrationSecurity.sendCode({
    adminId: req.user.id,
    sessionId: req.sessionID,
    payloadHash: plan.payloadHash,
    changes,
    requester: req.user.full_name || req.user.email || 'Administrator',
    ipAddress: req.ip,
    auditContext: requestAuditContext(req, null),
    audit,
  });
}

async function restoreIntegrationDefaultForRequest(req, integrationId, integrationSettings, integrationSecurity, audit) {
  const preview = await integrationSettings.getDefaultRestorePreview(integrationId);
  let noticeSent = false;
  let warning = '';
  if (preview.changedFields.length) {
    const state = integrationSecurity.configuration();
    if (state.verificationEmailConfigured) {
      const names = integrationSettings.getIntegrationLabel(integrationId);
      const requester = req.user.full_name || req.user.email || 'Administrator';
      const fields = preview.changedFields.join(', ');
      try {
        await integrationSecurity.sendBootstrapEmail({
          subject: 'Integration defaults restored',
          text: [
            `${names} default settings were restored.`,
            `Changed fields: ${fields}`,
            `Requested by: ${requester}`,
            `Time: ${new Date().toISOString()}`,
            `IP: ${req.ip || 'Unavailable'}`,
          ].join('\n'),
        });
        noticeSent = true;
      } catch {
        const error = new Error('The default was not restored because its notification could not be sent.');
        error.status = 503;
        throw error;
      }
    } else {
      warning = state.verificationEmailError;
    }
  }
  const result = await integrationSettings.restoreIntegrationDefault(
    integrationId, audit, requestAuditContext(req, null),
  );
  return { ...result, noticeSent, warning };
}

async function recordSavedValidationFailure(integrationSettings, integrationId, values, error) {
  if (!integrationSettings.recordCandidateValidation) return;
  await integrationSettings.recordCandidateValidation(
    integrationId, values, false, safeValidationReason(error),
  );
}

async function validateIntegrationSavePlan(req, plan, services) {
  const {
    integrationSettings, adminMfa, googleOAuth, recaptcha, googleCalendar, email,
    callIntegration, audit,
  } = services;
  const failures = [];
  const validated = [];
  const context = requestAuditContext(req, null);
  let responseStatus = 400;

  for (const update of plan.updates || []) {
    const shouldValidate = update.enabled
      && (update.credentialFields.length || update.enabledChanged);
    if (!shouldValidate) continue;

    try {
      callIntegration?.checkValidationCooldown?.(update.id);
      if (update.id === 'smtp') {
        await email.testConnection(update.values, context, { candidateValidation: true });
      } else if (update.id === 'google_calendar') {
        await googleCalendar.testConnection(context, update.values, { candidateValidation: true });
      } else if (update.id === 'google_auth') {
        await googleOAuth.testConnection(context, update.values, { candidateValidation: true });
      } else if (update.id === 'recaptcha') {
        await recaptcha.testConnection(context, update.values, { candidateValidation: true });
      } else if (update.id === 'admin_mfa') {
        await adminMfa.selfTest(update.values);
      }
      if (integrationSettings.recordCandidateValidation) {
        await integrationSettings.recordCandidateValidation(
          update.id, update.values, true, 'Validated',
        );
      }
      callIntegration?.clearValidationFailures?.(update.id);
      validated.push(update.id);
    } catch (error) {
      if (error?.code !== 'rate_limited'
        && error?.code !== 'validation_cooldown'
        && error?.name !== 'IntegrationRateLimitError') {
        callIntegration?.recordValidationFailure?.(update.id);
      }
      if (error?.status === 429) responseStatus = 429;
      else if (error?.status >= 500 && responseStatus !== 429) responseStatus = 503;
      const reason = safeValidationReason(error);
      if (integrationSettings.recordCandidateValidation) {
        await integrationSettings.recordCandidateValidation(update.id, update.values, false, reason);
      }
      try {
        await audit.logAction({
          ...context,
          action: 'integration.validate_failed',
          target_type: 'integration',
          target_id: update.id,
          new_value: {},
          result: 'failed',
        });
      } catch {}
      failures.push({
        integration: update.id,
        label: integrationSettings.getIntegrationLabel(update.id),
        reason,
      });
    }
  }

  if (failures.length) {
    const error = new Error('One or more integration configurations could not be verified.');
    error.status = responseStatus;
    error.failures = failures;
    throw error;
  }
  plan.validatedIntegrationIds = validated;
}

function safeValidationReason(error) {
  if (error?.name === 'IntegrationRateLimitError' || error?.code === 'rate_limited') {
    return 'Please try again shortly';
  }
  if (error?.code === 'validation_cooldown') return 'Could not verify, try again';
  if (error?.code === 'invalid_credentials') return 'Credentials rejected by provider';
  if (error?.code === 'calendar_not_shared') return 'Calendar not shared with the service account';
  if (error?.code === 'timeout') return 'Connection timed out';
  if (error?.code === 'network') return 'Could not verify, try again';
  if (error?.code === 'provider_error') return 'Could not verify, try again';
  if (error?.status === 429) return 'Please try again shortly';
  if (error?.status === 503) return 'Could not verify, try again';
  return 'Could not verify, try again';
}

function integrationSettingsError(res, error, fallbackMessage) {
  if (error.fieldErrors) {
    return res.status(error.status || 400).json({ error: error.message, fieldErrors: error.fieldErrors });
  }
  if (error.failures) {
    return res.status(error.status || 400).json({ error: error.message, failures: error.failures });
  }
  if ([400, 403, 404, 429, 503].includes(error.status)) {
    return res.status(error.status).json({ error: error.message });
  }
  return res.status(500).json({ error: fallbackMessage });
}

async function findAccount(auth, id) {
  const accounts = await auth.findAccountsForStaffAssignment();
  const account = accounts.find(({ id: accountId }) => accountId === String(id));
  if (!account) {
    const error = new Error('User account was not found.');
    error.status = 404;
    throw error;
  }
  return account;
}

function safeUserValues(user) {
  return {
    full_name: user.full_name,
    email: user.email,
    student_id: user.student_id || null,
    phone: user.phone || null,
    role_name: user.role_name,
    status: user.status,
  };
}

function safeItemValues(item) {
  return {
    id: item.id,
    item_name: item.item_name,
    category: item.category,
    status: item.status,
  };
}

function safeItemEditValues(item) {
  return {
    item_name: item.item_name,
    category: item.category,
    location: item.location,
    date_lost: item.date_lost,
  };
}

function changedValues(oldValues, newValues) {
  const old_value = {};
  const new_value = {};
  for (const key of Object.keys(newValues)) {
    if (oldValues[key] !== newValues[key]) {
      old_value[key] = oldValues[key];
      new_value[key] = newValues[key];
    }
  }
  return { old_value, new_value };
}

module.exports = { createAdminController };
