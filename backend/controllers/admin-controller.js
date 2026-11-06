
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { saveSession } = require('../middlewares/session-auth');
const { requestAuditContext } = require('../../src/services/audit-log');

function createAdminController({ auth, items, rolePermissions, notifications, integrationSettings, email, audit }) {
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

    getAdminSettings: async (req, res) => {
      if (!req.session.csrfToken) {
        req.session.csrfToken = randomBytes(32).toString('base64url');
        await saveSession(req);
      }
      return res.json({
        csrfToken: req.session.csrfToken,
        integrations: await integrationSettings.getAdminIntegrations(),
      });
    },

    putAdminSettings: async (req, res) => {
      try {
        return res.json(await integrationSettings.saveIntegrations(
          req.body?.integrations,
          audit,
          requestAuditContext(req, null),
        ));
      } catch (error) {
        if (error.status === 400 && error.fieldErrors) {
          return res.status(400).json({ error: error.message, fieldErrors: error.fieldErrors });
        }
        if (error.status === 400) throw error;
        const safeError = new Error('Integration settings could not be saved.');
        safeError.status = 500;
        throw safeError;
      }
    },

    postAdminSettingsSmtpTest: async (_req, res) => {
      try {
        const smtpSettings = await integrationSettings.validateIntegrationFields('smtp', _req.body.fields);
        await email.testConnection(smtpSettings);
        return res.json({ verified: true });
      } catch (error) {
        if (error.status === 400 && error.fieldErrors) {
          return res.status(400).json({ error: error.message, fieldErrors: error.fieldErrors });
        }
        const safeError = new Error('SMTP connection could not be verified. Check the host, port, and credentials.');
        safeError.status = 400;
        throw safeError;
      }
    },
  };
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
