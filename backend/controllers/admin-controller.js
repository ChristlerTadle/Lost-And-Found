
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { saveSession } = require('../middlewares/session-auth');
const { requestAuditContext } = require('../../src/services/audit-log');

function createAdminController({
  auth,
  items,
  rolePermissions,
  roleChange,
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
  frontendOrigin,
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
      const roleName = String(req.body.role_name || 'user').trim();
      if (!['user', 'staff'].includes(roleName)) {
        const error = new Error('Choose User or Staff for a new account.');
        error.status = 400;
        throw error;
      }
      const hasSubmittedPermissions = req.body.permissions !== undefined;
      const canManagePermissions = req.rolePermissions?.includes('manage_permissions');
      if ((roleName === 'staff' || hasSubmittedPermissions) && !canManagePermissions) {
        const error = new Error('Creating a Staff account or setting account permissions requires manage_permissions.');
        error.status = 403;
        throw error;
      }
      const permissions = hasSubmittedPermissions
        ? await rolePermissions.prepareAccountPermissions(roleName, req.body)
        : await rolePermissions.findRolePermissions(roleName);
      const newValues = safeUserValues({
        ...req.body,
        role_name: roleName,
        status: 'active',
      });
      if (hasSubmittedPermissions) newValues.permission_keys = permissions;
      const created = await audit.runAction(requestAuditContext(req, 'user.create', {
        target_type: 'user',
        target_id: (result) => result.id,
        new_value: newValues,
      }), async (session) => {
        const account = await auth.createAdminUser(req.body, { session, roleName });
        if (hasSubmittedPermissions) {
          try {
            await rolePermissions.replaceAccountPermissions(
              account.id,
              roleName,
              permissions,
              session,
            );
          } catch {
            if (!session) await rollbackCreatedAccount(auth, rolePermissions, account.id);
            const safeError = new Error('Account could not be created. Please try again.');
            safeError.status = 503;
            throw safeError;
          }
        }
        return account;
      });
      return res.status(201).json({ user: created });
    },

    patchAdminUsersById: async (req, res) => {
      const action = req.body.action;
      const oldAccount = await findAccount(auth, req.params.id);
      if (action === 'edit') {
        const targetRole = String(req.body.role_name || oldAccount.role_name).trim();
        if (String(req.user.id) === String(req.params.id)) {
          if (targetRole !== oldAccount.role_name || req.body.permissions !== undefined) {
            const error = new Error('You cannot edit your own role or permissions.');
            error.status = 403;
            throw error;
          }
        }
        const nextValues = safeUserValues({
          ...oldAccount,
          full_name: String(req.body.full_name || '').trim(),
          email: String(req.body.email || '').trim().toLowerCase(),
          student_id: req.body.student_id || null,
          phone: req.body.phone || null,
        });
        const changed = changedValues(safeUserValues(oldAccount), nextValues);
        if (targetRole !== oldAccount.role_name) {
          if (!req.rolePermissions?.includes('manage_permissions')
            || !req.rolePermissions?.includes('edit_user')) {
            const error = new Error('Role changes require edit_user and manage_permissions.');
            error.status = 403;
            throw error;
          }
          const adminRoleChange = oldAccount.role_name === 'admin' || targetRole === 'admin';
          if (adminRoleChange && !req.rolePermissions?.includes('assign_admin_role')) {
            const error = new Error('Admin role changes require assign_admin_role.');
            error.status = 403;
            throw error;
          }
          const prepared = await roleChange.validateRoleChange(
            req.user.id,
            req.params.id,
            targetRole,
            req.body.permissions,
          );
          if (adminRoleChange) {
            const payloadHash = adminRoleChangePayloadHash(
              req.user.id,
              req.params.id,
              targetRole,
              prepared.normalized,
            );
            const sessionId = `${req.sessionID}:role-change`;
            const changes = [{ integration: 'account role', fields: ['target account', 'role', 'permissions'] }];
            if (req.body.role_change_code === undefined) {
              const verification = await integrationSecurity.sendCode({
                adminId: req.user.id,
                sessionId,
                payloadHash,
                changes,
                requester: req.user.full_name || req.user.email || 'Administrator',
                ipAddress: req.ip,
                auditContext: requestAuditContext(req, null),
                audit,
              });
              return res.json({ verificationRequired: true, ...verification });
            }
            await integrationSecurity.verifyCode({
              adminId: req.user.id,
              sessionId,
              candidate: req.body.role_change_code,
              payloadHash,
              auditContext: requestAuditContext(req, null),
              audit,
              changes,
            });
          } else {
            await integrationSecurity.cancelCode({
              adminId: req.user.id,
              sessionId: `${req.sessionID}:role-change`,
            });
          }
          await roleChange.changeRole({
            actorId: req.user.id,
            targetId: req.params.id,
            newRole: targetRole,
            permissions: prepared.normalized,
            auditContext: requestAuditContext(req, null),
            notifyAssignment: true,
          });
        } else if (req.body.permissions !== undefined) {
          if (!req.rolePermissions?.includes('manage_permissions')) {
            const error = new Error('Account permissions require manage_permissions.');
            error.status = 403;
            throw error;
          }
          const normalized = await rolePermissions.prepareAccountPermissions(oldAccount.role_name, req.body);
          await audit.runAction(requestAuditContext(req, 'account_permissions.update', {
            target_type: 'user',
            target_id: req.params.id,
            old_value: { permissions: await rolePermissions.findEffectivePermissions(req.params.id, oldAccount.role_name) },
            new_value: { permissions: normalized },
          }), (session) => rolePermissions.replaceAccountPermissions(
            req.params.id,
            oldAccount.role_name,
            normalized,
            session,
          ));
        }
        await audit.runAction(requestAuditContext(req, 'user.update', {
          target_type: 'user',
          target_id: req.params.id,
          old_value: changed.old_value,
          new_value: changed.new_value,
        }), (session) => auth.updateUserByAdmin(req.params.id, req.body, { session }));
      }
      else if (action === 'assign_staff') {
        if (!req.rolePermissions?.includes('manage_permissions')
          || !req.rolePermissions?.includes('edit_user')) {
          const error = new Error('Role changes require edit_user and manage_permissions.');
          error.status = 403;
          throw error;
        }
        if (oldAccount.role_name === 'admin') {
          const error = new Error('Admin role changes must be made through Edit user.');
          error.status = 403;
          throw error;
        }
        await roleChange.changeRole({
          actorId: req.user.id,
          targetId: req.params.id,
          newRole: 'staff',
          auditContext: requestAuditContext(req, 'account.role_change'),
          notifyAssignment: true,
        });
      } else if (action === 'revert_staff') {
        if (!req.rolePermissions?.includes('manage_permissions')
          || !req.rolePermissions?.includes('edit_user')) {
          const error = new Error('Role changes require edit_user and manage_permissions.');
          error.status = 403;
          throw error;
        }
        if (oldAccount.role_name === 'admin') {
          const error = new Error('Admin role changes must be made through Edit user.');
          error.status = 403;
          throw error;
        }
        await roleChange.changeRole({
          actorId: req.user.id,
          targetId: req.params.id,
          newRole: 'user',
          auditContext: requestAuditContext(req, 'account.role_change'),
          notifyAssignment: false,
        });
      } else if (action === 'disable' || action === 'enable') {
        if (String(req.user.id) === String(req.params.id) && action === 'disable') {
          const error = new Error('You cannot disable your own account.');
          error.status = 403;
          throw error;
        }
        const status = action === 'disable' ? 'disabled' : 'active';
        if (action === 'disable' && oldAccount.role_name === 'admin') {
          const core = ['manage_permissions', 'view_users', 'manage_integrations'];
          const accounts = await auth.findAccountsForStaffAssignment();
          const remaining = accounts.filter((account) => account.id !== String(req.params.id)
            && account.role_name === 'admin' && account.status === 'active');
          const qualified = [];
          for (const account of remaining) {
            const effective = await rolePermissions.findEffectivePermissions(account.id, 'admin');
            if (core.every((permission) => effective.includes(permission))) qualified.push(account);
          }
          if (!qualified.length) {
            const error = new Error('This change would leave no active admin with the core permissions.');
            error.status = 403;
            throw error;
          }
        }
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
      const roles = await Promise.all(['user', 'staff', 'admin'].map(async (role) => ({
        ...await rolePermissions.getRoleSettings(role),
        active_accounts: await auth.countActiveAccountsByRole(role),
      })));
      return res.json({ roles });
    },

    getAdminUserPermissions: async (req, res) => {
      const account = await findAccount(auth, req.params.id);
      return res.json(await rolePermissions.getAccountPermissions(account.id, account.role_name));
    },

    putAdminUserPermissions: async (req, res) => {
      if (String(req.user.id) === String(req.params.id)) {
        const error = new Error('You cannot edit your own permissions.');
        error.status = 403;
        throw error;
      }
      const account = await findAccount(auth, req.params.id);
      const normalized = await rolePermissions.prepareAccountPermissions(account.role_name, req.body);
      if (account.role_name === 'admin') {
        const core = ['manage_permissions', 'view_users', 'manage_integrations'];
        if (core.some((permission) => !normalized.includes(permission))) {
          const error = new Error('Core Admin permissions cannot be removed.');
          error.status = 403;
          throw error;
        }
      }
      const result = await audit.runAction(requestAuditContext(req, 'account_permissions.update', {
        target_type: 'user',
        target_id: req.params.id,
        old_value: { permissions: await rolePermissions.findEffectivePermissions(req.params.id, account.role_name) },
        new_value: { permissions: normalized },
      }), (session) => rolePermissions.replaceAccountPermissions(
        req.params.id,
        account.role_name,
        normalized,
        session,
      ));
      return res.json(result);
    },

    resetAdminUserPermissions: async (req, res) => {
      if (String(req.user.id) === String(req.params.id)) {
        const error = new Error('You cannot reset your own permissions.');
        error.status = 403;
        throw error;
      }
      const account = await findAccount(auth, req.params.id);
      const result = await audit.runAction(requestAuditContext(req, 'account_permissions.reset', {
        target_type: 'user',
        target_id: req.params.id,
        old_value: { permissions: await rolePermissions.findEffectivePermissions(req.params.id, account.role_name) },
        new_value: { permissions: await rolePermissions.findRolePermissions(account.role_name) },
      }), (session) => rolePermissions.resetAccountPermissions(
        req.params.id,
        account.role_name,
        session,
      ));
      return res.json(result);
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
      res.set('Cache-Control', 'no-store');
      if (!req.session.csrfToken) {
        req.session.csrfToken = randomBytes(32).toString('base64url');
      }
      const state = integrationSecurity.configuration();
      const unlocked = state.accessReady
        && integrationSecurity.touchSession(req.session, req.user.id);
      await saveSession(req);
      const pendingCode = unlocked
        ? await integrationSecurity.getPendingCodeStatus({
          adminId: req.user.id,
          sessionId: req.sessionID,
        })
        : null;
      return res.json({
        csrfToken: req.session.csrfToken,
        accessReady: state.accessReady,
        accessError: state.accessError,
        unlocked,
        verificationEmailConfigured: state.verificationEmailConfigured,
        verificationEmailError: state.verificationEmailError,
        verificationRecipient: state.maskedRecipient,
        pendingCode,
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

    postAdminSettingsVerificationEmailTest: async (req, res) => {
      try {
        const result = await integrationSecurity.sendTestEmail({
          adminId: req.user.id,
          auditContext: requestAuditContext(req, null),
        });
        return res.json({ sent: true, ...result });
      } catch (error) {
        return integrationSettingsError(res, error, 'The verification test email could not be sent.');
      }
    },

    getAdminSettings: async (req, res) => {
      const [integrations, enrollmentSummary] = await Promise.all([
        integrationSettings.getAdminIntegrations(req.user.id),
        adminMfa.getAdminSummary(),
      ]);
      integrations.admin_mfa.enrollmentSummary = enrollmentSummary;
      return res.json({
        integrations,
      });
    },

    postAdminSettingsVerify: async (req, res) => {
      try {
        const integrationId = req.params.integrationId;
        const plan = await integrationSettings.prepareIntegrationSave({
          [integrationId]: req.body,
        });
        let candidate = plan.updates.find(({ id }) => id === integrationId);
        if (!candidate) {
          const current = await integrationSettings.getIntegration(integrationId);
          candidate = {
            id: integrationId,
            enabled: req.body?.enabled,
            values: await integrationSettings.validateIntegrationFields(
              integrationId,
              req.body?.fields,
            ),
          };
          if (typeof candidate.enabled !== 'boolean') candidate.enabled = current.enabled;
        }
        const verification = await verifyIntegrationCandidate(
          req,
          candidate.id,
          candidate.enabled,
          candidate.values,
          {
            integrationSettings, adminMfa, googleOAuth, recaptcha, googleCalendar, email, callIntegration, audit,
            frontendOrigin,
          },
          req.body?.proof,
        );
        if (verification?.pending) {
          return res.status(202).json({
            verificationPending: true,
            authorizationUrl: verification.authorizationUrl,
          });
        }
        return res.json({ verification });
      } catch (error) {
        return integrationSettingsError(res, error, 'Integration settings could not be verified.');
      }
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
          plan, audit, requestAuditContext(req, null), req.user.id,
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
            req, integrationSecurity, integrationSettings, restore.plan, audit, restore.integrationId,
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
        await requirePlanVerifications(req, plan, integrationSettings);
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
        await requirePlanVerifications(req, plan, integrationSettings);
        return res.json(await integrationSettings.applyIntegrationSave(
          plan, audit, requestAuditContext(req, null), req.user.id,
        ));
      } catch (error) {
        return integrationSettingsError(res, error, 'Integration settings could not be saved.');
      }
    },

    postAdminSettingsDefault: async (req, res) => {
      return res.json(await integrationSettings.setIntegrationDefault(
        req.params.integrationId, audit, requestAuditContext(req, null), req.user.id,
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
            req, integrationSecurity, integrationSettings, plan, audit, integrationId,
          );
          return res.json({ verificationRequired: true, restoreDefault: integrationId, ...result });
        }
      }
      return res.json(await restoreIntegrationDefaultForRequest(
        req, integrationId, integrationSettings, integrationSecurity, audit,
      ));
    },

    postAdminSettingsSmtpTest: async (req, res) => {
      try {
        const smtp = await integrationSettings.getIntegration('smtp');
        if (!smtp.configured) {
          const error = new Error('Configure all required saved SMTP fields before testing.');
          error.status = 400;
          throw error;
        }
        const verification = await verifyIntegrationCandidate(
          req, 'smtp', true, smtp.settings,
          { integrationSettings, email, callIntegration, audit },
        );
        return res.json({
          verified: true,
          verification,
          integrations: await integrationSettings.getAdminIntegrations(req.user.id),
        });
      } catch (error) {
        return integrationSettingsError(res, error, 'SMTP configuration could not be verified.');
      }
    },

    postAdminSettingsGoogleCalendarTest: async (req, res) => {
      try {
        const current = await integrationSettings.getIntegration('google_calendar');
        const verification = await verifyIntegrationCandidate(
          req, 'google_calendar', true, current.settings,
          { integrationSettings, googleCalendar, callIntegration, audit },
        );
        return res.json({
          verified: true,
          verification,
          integrations: await integrationSettings.getAdminIntegrations(req.user.id),
        });
      } catch (error) {
        return integrationSettingsError(res, error, 'Google Calendar could not be verified.');
      }
    },

    postAdminSettingsGoogleAuthTest: async (req, res) => {
      try {
        const current = await integrationSettings.getIntegration('google_auth');
        const verification = await verifyIntegrationCandidate(
          req, 'google_auth', true, current.settings,
          { integrationSettings, googleOAuth, callIntegration, audit, frontendOrigin },
        );
        if (verification?.pending) {
          return res.status(202).json({
            verificationPending: true,
            authorizationUrl: verification.authorizationUrl,
          });
        }
        return res.json({
          verified: true,
          verification,
          integrations: await integrationSettings.getAdminIntegrations(req.user.id),
        });
      } catch (error) {
        return integrationSettingsError(res, error, 'Google sign-in could not be verified.');
      }
    },

    postAdminSettingsRecaptchaTest: async (req, res) => {
      try {
        const current = await integrationSettings.getIntegration('recaptcha');
        const verification = await verifyIntegrationCandidate(
          req, 'recaptcha', true, current.settings,
          { integrationSettings, recaptcha, callIntegration, audit },
        );
        return res.json({
          verified: true,
          verification,
          integrations: await integrationSettings.getAdminIntegrations(req.user.id),
        });
      } catch (error) {
        return integrationSettingsError(res, error, 'reCAPTCHA could not be verified.');
      }
    },

    postAdminSettingsAdminMfaTest: async (req, res) => {
      try {
        const current = await integrationSettings.getIntegration('admin_mfa');
        const verification = await verifyIntegrationCandidate(
          req, 'admin_mfa', true, current.settings,
          { integrationSettings, adminMfa, callIntegration, audit },
          { code: req.body?.code },
        );
        return res.json({
          verified: true,
          verification,
          integrations: await integrationSettings.getAdminIntegrations(req.user.id),
        });
      } catch (error) {
        return integrationSettingsError(res, error, 'Admin MFA could not be verified.');
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

async function sendIntegrationVerificationCode(
  req, integrationSecurity, integrationSettings, plan, audit, restoreDefault = null,
) {
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
    restoreDefault,
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
    integrationId, audit, requestAuditContext(req, null), req.user.id,
  );
  return { ...result, noticeSent, warning };
}

async function validateIntegrationSavePlan(req, plan, services) {
  const verified = [];
  for (const update of plan.updates || []) {
    const needsVerification = update.changedFields.length > 0
      || (update.enabled && update.enabledChanged);
    if (!needsVerification) continue;
    if (['smtp', 'google_calendar'].includes(update.id)) {
      await verifyIntegrationCandidate(
        req,
        update.id,
        update.enabled,
        update.values,
        services,
      );
    } else {
      await services.integrationSettings.requireCurrentVerification(
        req.user.id, update.id, update.enabled, update.values,
      );
    }
    verified.push(update.id);
  }
  plan.verifiedIntegrationIds = verified;
}

async function requirePlanVerifications(req, plan, integrationSettings) {
  const verified = [];
  for (const update of plan.updates || []) {
    const needsVerification = update.changedFields.length > 0
      || (update.enabled && update.enabledChanged);
    if (!needsVerification) continue;
    await integrationSettings.requireCurrentVerification(
      req.user.id, update.id, update.enabled, update.values,
    );
    verified.push(update.id);
  }
  plan.verifiedIntegrationIds = verified;
}

async function verifyIntegrationCandidate(req, integrationId, enabled, values, services, proof) {
  const { integrationSettings, callIntegration, audit } = services;
  const proofTypes = {
    google_auth: 'real_sign_in',
    recaptcha: 'real_challenge',
    smtp: 'test_email_sent',
    google_calendar: 'test_event_created_and_removed',
    admin_mfa: 'authenticator_code_accepted',
  };
  const proofType = proofTypes[integrationId];
  if (!proofType) {
    const error = new Error('Unknown integration verification.');
    error.status = 400;
    throw error;
  }

  await callIntegration?.checkValidationCooldown?.(integrationId);
  if (integrationId === 'google_auth'
    && typeof integrationSettings.getCurrentVerification === 'function') {
    const existing = await integrationSettings.getCurrentVerification(
      req.user.id,
      integrationId,
      enabled,
      values,
    );
    if (existing) return existing;
  }
  await integrationSettings.recordVerification({
    adminId: req.user.id,
    integrationId,
    enabled,
    values,
    proofType: 'pending',
    result: false,
  });

  try {
    let verification;
    if (integrationId === 'smtp') {
      verification = await services.email.verifyCandidate?.(values, requestAuditContext(req, null), proof);
    } else if (integrationId === 'google_calendar') {
      verification = await services.googleCalendar.verifyCandidate?.(
        requestAuditContext(req, null), values, proof,
      );
    } else if (integrationId === 'google_auth') {
      verification = await services.googleOAuth.verifyCandidate?.(
        requestAuditContext(req, null),
        values,
        {
          adminId: String(req.user.id),
          candidateHash: integrationSettings.getVerificationHash(
            integrationId,
            enabled,
            values,
          ),
          enabled,
          popup: proof?.popup === true,
        },
      );
    } else if (integrationId === 'recaptcha') {
      verification = await services.recaptcha.verifyCandidate?.(
        requestAuditContext(req, null),
        values,
        {
          token: proof?.token,
          expectedHostname: expectedRecaptchaHostname(req, services.frontendOrigin),
        },
      );
    } else if (integrationId === 'admin_mfa') {
      verification = await services.adminMfa.verifyCandidate?.({
        adminId: req.user.id,
        ipAddress: req.ip,
        audit,
        values,
        proof,
      });
    }
    if (verification?.pending === true
      && typeof verification.authorizationUrl === 'string'
      && verification.authorizationUrl.startsWith('https://accounts.google.com/')) {
      return verification;
    }
    if (!verification || verification.verified !== true || verification.proofType !== proofType) {
      const error = new Error('Integration verifier did not return an explicit proof result.');
      error.status = 503;
      error.code = 'verification_unavailable';
      throw error;
    }
  } catch (error) {
    if (error?.code !== 'rate_limited'
      && error?.code !== 'validation_cooldown'
      && error?.name !== 'IntegrationRateLimitError') {
      await callIntegration?.recordValidationFailure?.(integrationId);
    }
    const reason = safeValidationReason(error);
    await integrationSettings.recordVerification({
      adminId: req.user.id,
      integrationId,
      enabled,
      values,
      proofType,
      result: false,
    });
    await audit.logAction({
      ...requestAuditContext(req, 'integration.verify_failed'),
      target_type: 'integration',
      target_id: integrationId,
      new_value: { proof_type: proofType },
      result: 'failed',
    });
    const safeError = new Error(reason);
    safeError.status = error?.status === 429 ? 429
      : error?.status === 400 ? 400 : 503;
    safeError.code = error?.code;
    safeError.eventId = error?.eventId;
    throw safeError;
  }

  await audit.logAction({
    ...requestAuditContext(req, 'integration.verify_success'),
    target_type: 'integration',
    target_id: integrationId,
    new_value: { proof_type: proofType },
  });
  const record = await integrationSettings.recordVerification({
    adminId: req.user.id,
    integrationId,
    enabled,
    values,
    proofType,
    result: true,
  });
  await callIntegration?.clearValidationFailures?.(integrationId);
  return record;
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
  if (error?.code === 'verification_unavailable') return 'Verification is not available yet.';
  if (error?.code === 'verification_configuration') return 'SMTP verification recipient is not configured.';
  if (error?.code === 'calendar_no_event_permission') return 'No permission to edit events on this calendar';
  if (error?.code === 'calendar_cleanup_failed') {
    const eventId = /^[a-f0-9]{32}$/i.test(error.eventId || '') ? error.eventId : '';
    return eventId
      ? `Test event deletion failed. Event ID for manual cleanup: ${eventId}`
      : 'Test event deletion failed. Remove the test event manually.';
  }
  if (error?.code === 'calendar_invalid_time_zone') {
    return 'Enter a valid IANA time zone, such as Asia/Manila.';
  }
  if (error?.code === 'recaptcha_invalid_configuration') {
    return 'Enter valid reCAPTCHA site and secret keys.';
  }
  if (error?.code === 'recaptcha_test_keys') {
    return 'Google public test keys cannot be used for verification.';
  }
  if (error?.code === 'recaptcha_hostname_mismatch') {
    return 'The challenge hostname did not match this site.';
  }
  if (error?.status === 429) return 'Please try again shortly';
  if (error?.status === 503) return 'Could not verify, try again';
  return 'Could not verify, try again';
}

function expectedRecaptchaHostname(req, frontendOrigin) {
  try {
    return new URL(frontendOrigin).hostname;
  } catch {
    return req.hostname;
  }
}

function integrationSettingsError(res, error, fallbackMessage) {
  if (error.fieldErrors) {
    return res.status(error.status || 400).json({ error: error.message, fieldErrors: error.fieldErrors });
  }
  if (error.failures) {
    return res.status(error.status || 400).json({ error: error.message, failures: error.failures });
  }
  if ([400, 403, 404, 429, 503].includes(error.status)) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.maskedRecipient ? { maskedRecipient: error.maskedRecipient } : {}),
    });
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

async function rollbackCreatedAccount(auth, rolePermissions, accountId) {
  const failures = [];
  try {
    await rolePermissions.resetAccountPermissions(accountId);
  } catch (error) {
    failures.push(error);
  }
  try {
    await auth.deleteAdminUser(accountId);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    console.error('Unable to fully roll back admin account creation:', failures[0]);
    const error = new Error('Account creation failed and cleanup could not be completed. Contact the system administrator.');
    error.status = 500;
    throw error;
  }
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

function adminRoleChangePayloadHash(actorId, targetId, roleName, permissions) {
  const payload = JSON.stringify({
    actor_id: String(actorId),
    target_id: String(targetId),
    role_name: roleName,
    permissions,
  });
  return createHash('sha256').update(payload).digest('hex');
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
