const { PERMISSIONS_BY_ROLE, normalizeRolePermissions } = require('../../backend/config/role-permissions');

function createRoleChangeService(database, { rolePermissions, notifications, audit }) {
  const users = database.collection('users');
  const accountPermissions = database.collection('account_permissions');

  function safeError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }

  async function validateTarget(actorId, targetId, newRole, submittedPermissions) {
    if (!targetId || !['user', 'staff', 'admin'].includes(newRole)) {
      safeError('Choose a valid account role.');
    }
    if (String(actorId) === String(targetId)) {
      safeError('You cannot change your own role.', 403);
    }
    const target = await users.findOne({ _id: String(targetId) });
    if (!target || target.status !== 'active') {
      safeError('Active user account was not found.', 404);
    }
    if (!['user', 'staff', 'admin'].includes(target.role_name)) {
      safeError('The account has an invalid role.', 403);
    }
    const roleEnabled = new Set(await rolePermissions.findRolePermissions(newRole));
    const normalized = submittedPermissions === undefined
      ? await rolePermissions.findRolePermissions(newRole)
      : normalizeRolePermissions(newRole, submittedPermissions);
    for (const permission of normalized) {
      if (!roleEnabled.has(permission)) {
        safeError(`The role has turned off permission: ${permission}`, 403);
      }
    }
    if (target.role_name === 'admin' && newRole !== 'admin') {
      const corePermissions = ['manage_permissions', 'view_users', 'manage_integrations'];
      const admins = await users.find(
        { role_name: 'admin', status: 'active' },
        { projection: { _id: 1 } },
      ).toArray();
      let qualifiedAdminRemains = false;
      for (const account of admins) {
        if (String(account._id) === String(targetId)) continue;
        const effective = await rolePermissions.findEffectivePermissions(String(account._id), 'admin');
        if (corePermissions.every((permission) => effective.includes(permission))) {
          qualifiedAdminRemains = true;
          break;
        }
      }
      if (!qualifiedAdminRemains) {
        safeError('This change would leave no active admin with the core permissions.', 403);
      }
    }
    return { target, normalized };
  }

  async function validateRoleChange(actorId, targetId, newRole, permissions) {
    return validateTarget(actorId, targetId, newRole, permissions);
  }

  async function changeRole({ actorId, targetId, newRole, permissions, auditContext, notifyAssignment = false }) {
    const { target, normalized } = await validateTarget(actorId, targetId, newRole, permissions);
    const oldRole = target.role_name;
    const oldOverrides = await accountPermissions.find(
      { user_id: String(targetId) },
      { projection: { permission_key: 1, enabled: 1 } },
    ).toArray();

    const events = oldRole === newRole
      ? [{
          ...auditContext,
          action: 'account_permissions.update',
          target_type: 'user',
          target_id: targetId,
          old_value: { permissions: await rolePermissions.findEffectivePermissions(targetId, oldRole) },
          new_value: { permissions: normalized },
        }]
      : [
          {
            ...auditContext,
            action: 'account.role_change',
            target_type: 'user',
            target_id: targetId,
            old_value: { role_name: oldRole },
            new_value: {
              role_name: newRole,
              ...(oldRole === 'admin' || newRole === 'admin' ? { privilege_change: true } : {}),
            },
          },
          {
            ...auditContext,
            action: 'account_permissions.reset',
            target_type: 'user',
            target_id: targetId,
            old_value: { permissions: oldOverrides.map(({ permission_key, enabled }) => ({ permission_key, enabled })) },
            new_value: { permissions: normalized },
          },
        ];

    return audit.runAction(events, async (session) => {
      try {
        await users.updateOne(
          { _id: String(targetId), role_name: oldRole, status: 'active' },
          { $set: { role_name: newRole, updated_at: new Date().toISOString() } },
          session ? { session } : undefined,
        );
        await accountPermissions.deleteMany(
          { user_id: String(targetId) },
          session ? { session } : undefined,
        );
        const roleEnabled = new Set(await rolePermissions.findRolePermissions(newRole));
        for (const permission of PERMISSIONS_BY_ROLE[newRole] || []) {
          if (!roleEnabled.has(permission.key) || normalized.includes(permission.key)) continue;
          await accountPermissions.updateOne(
            { user_id: String(targetId), permission_key: permission.key },
            {
              $set: { user_id: String(targetId), permission_key: permission.key, enabled: false },
              $setOnInsert: { created_at: new Date() },
              $currentDate: { updated_at: true },
            },
            { ...(session ? { session } : {}), upsert: true },
          );
        }
        if (notifyAssignment && oldRole === 'user' && newRole === 'staff') {
          await notifications.create(targetId, {
            type: 'status',
            title: 'Staff access granted',
            message: 'An administrator assigned staff access to your account.',
            href: '/?page=dashboard',
          }, session ? { session } : undefined);
        }
        return { id: targetId, old_role: oldRole, role_name: newRole, permissions: normalized };
      } catch (error) {
        if (!session) {
          await users.updateOne(
            { _id: String(targetId) },
            { $set: { role_name: oldRole, updated_at: target.updated_at } },
          ).catch(() => null);
          await accountPermissions.deleteMany({ user_id: String(targetId) }).catch(() => null);
          for (const override of oldOverrides) {
            await accountPermissions.updateOne(
              { user_id: String(targetId), permission_key: override.permission_key },
              { $set: override, $setOnInsert: { created_at: new Date() } },
              { upsert: true },
            ).catch(() => null);
          }
        }
        throw error;
      }
    });
  }

  return { changeRole, validateRoleChange };
}

module.exports = { createRoleChangeService };
