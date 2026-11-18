const { PERMISSIONS_BY_ROLE, normalizeRolePermissions } = require('../../backend/config/role-permissions');

function createRolePermissionService(database) {
  const collection = database.collection('role_permissions');
  const accountCollection = database.collection('account_permissions');

  return {
    async findRolePermissions(role) {
      const definitions = PERMISSIONS_BY_ROLE[role] || [];
      if (!definitions.length) return [];
      const enabledRows = await collection.find(
        { role, enabled: true },
        { projection: { permission_key: 1 } },
      ).toArray();
      const enabled = new Set(enabledRows.map(({ permission_key }) => permission_key));
      return definitions.filter(({ key }) => enabled.has(key)).map(({ key }) => key);
    },

    async isEnabled(role, permissionKey, session = undefined) {
      if (!PERMISSIONS_BY_ROLE[role]?.some(({ key }) => key === permissionKey)) return false;
      const row = await collection.findOne(
        { role, permission_key: permissionKey, enabled: true },
        session ? { projection: { _id: 1 }, session } : { projection: { _id: 1 } },
      );
      return Boolean(row);
    },

    async findEffectivePermissions(userId, role, session = undefined) {
      if (!['user', 'staff', 'admin'].includes(role)) return [];
      const rolePermissions = await this.findRolePermissions(role);
      const roleEnabled = new Set(rolePermissions);
      if (!userId) return [...roleEnabled];
      if (!accountCollection || typeof accountCollection.find !== 'function') return [...roleEnabled];
      const overrides = await accountCollection.find(
        { user_id: String(userId) },
        session ? { projection: { permission_key: 1, enabled: 1 }, session } : { projection: { permission_key: 1, enabled: 1 } },
      ).toArray();
      const overrideMap = new Map(overrides.map(({ permission_key, enabled }) => [permission_key, enabled]));
      return [...roleEnabled].filter((permission) => (
        overrideMap.has(permission) ? overrideMap.get(permission) === true : true
      ));
    },

    async getRoleSettings(role) {
      const definitions = PERMISSIONS_BY_ROLE[role];
      if (!definitions) {
        const error = new Error('Choose a valid role.');
        error.status = 400;
        throw error;
      }
      const enabled = new Set(await this.findRolePermissions(role));
      return {
        role,
        permissions: definitions.map((permission) => ({
          ...permission,
          enabled: enabled.has(permission.key),
        })),
      };
    },

    preparePermissions(role, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        const error = new Error('Submit valid role permissions.');
        error.status = 400;
        throw error;
      }
      return normalizeRolePermissions(role, input.permissions);
    },

    async replaceRolePermissions(role, permissionKeys, session = undefined) {
      const definitions = PERMISSIONS_BY_ROLE[role];
      if (!definitions) {
        const error = new Error('Choose a valid role.');
        error.status = 400;
        throw error;
      }
      const permissions = normalizeRolePermissions(role, permissionKeys);
      const options = session ? { session } : undefined;
      const existing = await collection.find({ role }, {
        projection: { permission_key: 1, enabled: 1 },
        ...(session ? { session } : {}),
      }).toArray();
      const oldEnabled = new Set(existing.filter(({ enabled }) => enabled).map(({ permission_key }) => permission_key));
      const nextEnabled = new Set(permissions);
      const oldPermissions = definitions.filter(({ key }) => oldEnabled.has(key)).map(({ key }) => key);
      const newPermissions = definitions.filter(({ key }) => nextEnabled.has(key)).map(({ key }) => key);
      const changed = oldPermissions.length !== newPermissions.length
        || oldPermissions.some((key, index) => key !== newPermissions[index]);
      if (!changed) return { role, permissions: newPermissions, old_permissions: oldPermissions, changed: false };

      for (const definition of definitions) {
        await collection.updateOne(
          { role, permission_key: definition.key },
          {
            $set: { role, permission_key: definition.key, enabled: nextEnabled.has(definition.key) },
            $setOnInsert: { created_at: new Date() },
            $currentDate: { updated_at: true },
          },
          { ...options, upsert: true },
        );
      }
      return { role, permissions: newPermissions, old_permissions: oldPermissions, changed: true };
    },
  };
}

module.exports = { createRolePermissionService };
