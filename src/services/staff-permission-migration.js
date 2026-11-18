const { PERMISSIONS_BY_ROLE } = require('../../backend/config/role-permissions');

const MIGRATION_SOURCE = 'legacy migration';
const AUDIT_ACTION = 'account_permissions.update';

async function migrateStaffPermissionOverrides(database, audit, plan) {
  validatePlan(plan);
  const userIds = plan.map(({ user_id: userId }) => String(userId));
  const [users, enabledRows] = await Promise.all([
    database.collection('users').find(
      { _id: { $in: userIds } },
      { projection: { _id: 1, full_name: 1, role_name: 1 } },
    ).toArray(),
    database.collection('role_permissions').find(
      { role: 'staff', enabled: true },
      { projection: { permission_key: 1 } },
    ).toArray(),
  ]);
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  for (const userId of userIds) {
    const user = usersById.get(userId);
    if (!user || user.role_name !== 'staff' || typeof user.full_name !== 'string' || !user.full_name.trim()) {
      throw new Error(`Migration target ${userId} is not a named Staff account.`);
    }
  }

  const staffDefinitions = PERMISSIONS_BY_ROLE.staff;
  const definitionsByKey = new Map(staffDefinitions.map((definition) => [definition.key, definition]));
  const roleEnabled = new Set(enabledRows.map(({ permission_key: key }) => key));
  if (!roleEnabled.has('schedule_pickup')) {
    throw new Error('Staff role does not currently allow schedule_pickup; migration was not applied.');
  }

  const accountCollection = database.collection('account_permissions');
  const auditCollection = database.collection('audit_log');
  const currentRows = await accountCollection.find(
    { user_id: { $in: userIds } },
    { projection: { user_id: 1, permission_key: 1, enabled: 1 } },
  ).toArray();
  const overridesByUser = new Map(userIds.map((userId) => [userId, new Map()]));
  for (const row of currentRows) {
    overridesByUser.get(String(row.user_id))?.set(row.permission_key, row.enabled);
  }

  const prepared = plan.map(({ user_id: userId, permissions }) => {
    const target = usersById.get(String(userId));
    const unknownPermission = permissions.find((key) => !definitionsByKey.has(key));
    if (unknownPermission) {
      throw new Error(`Unknown Staff permission in migration plan: ${unknownPermission}`);
    }
    const allowedKeys = expandDisabledPermissions(permissions, staffDefinitions, roleEnabled);
    const overrides = new Map(overridesByUser.get(String(userId)));
    for (const key of allowedKeys) overrides.set(key, false);
    resolveEffectivePermissions(
      staffDefinitions,
      definitionsByKey,
      roleEnabled,
      overrides,
      String(userId),
    );
    return {
      user_id: String(userId),
      account_name: target.full_name.trim(),
      permission_keys: allowedKeys,
    };
  });

  const results = [];
  for (const entry of prepared) {
    const existingOverrides = overridesByUser.get(entry.user_id);
    const changedPermissions = [];
    for (const key of entry.permission_keys) {
      if (existingOverrides.get(key) === false) continue;
      await accountCollection.updateOne(
        { user_id: entry.user_id, permission_key: key },
        {
          $set: { user_id: entry.user_id, permission_key: key, enabled: false },
          $setOnInsert: { created_at: new Date() },
          $currentDate: { updated_at: true },
        },
        { upsert: true },
      );
      existingOverrides.set(key, false);
      changedPermissions.push(key);
    }

    const auditExists = await auditCollection.findOne({
      action: AUDIT_ACTION,
      target_type: 'user',
      target_id: entry.user_id,
      'new_value.source': MIGRATION_SOURCE,
    });
    if (!auditExists) {
      await audit.logAction({
        action: AUDIT_ACTION,
        target_type: 'user',
        target_id: entry.user_id,
        old_value: null,
        new_value: {
          account_name: entry.account_name,
          permission_keys: entry.permission_keys,
          source: MIGRATION_SOURCE,
        },
      });
    }

    const savedOverrides = await accountCollection.find(
      { user_id: entry.user_id },
      { projection: { permission_key: 1, enabled: 1 } },
    ).toArray();
    const savedOverrideMap = new Map(
      savedOverrides.map(({ permission_key: key, enabled }) => [key, enabled]),
    );
    const effectivePermissions = resolveEffectivePermissions(
      staffDefinitions,
      definitionsByKey,
      roleEnabled,
      savedOverrideMap,
      entry.user_id,
    );

    results.push({
      user_id: entry.user_id,
      changed_permissions: changedPermissions,
      effective_permissions: effectivePermissions,
      schedule_pickup_effective: effectivePermissions.includes('schedule_pickup'),
      audit_recorded: true,
    });
  }
  return results;
}

function expandDisabledPermissions(permissionKeys, definitions, roleEnabled) {
  const disabled = new Set(permissionKeys.filter((key) => roleEnabled.has(key)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { key, requires } of definitions) {
      if (roleEnabled.has(key) && !disabled.has(key) && requires.some((parent) => disabled.has(parent))) {
        disabled.add(key);
        changed = true;
      }
    }
  }
  return definitions.filter(({ key }) => disabled.has(key)).map(({ key }) => key);
}

function resolveEffectivePermissions(definitions, definitionsByKey, roleEnabled, overrides, userId) {
  const permissions = definitions
    .filter(({ key }) => roleEnabled.has(key) && overrides.get(key) !== false)
    .map(({ key }) => key);
  const effective = new Set(permissions);
  for (const key of permissions) {
    const missingParent = definitionsByKey.get(key).requires.find((parent) => !effective.has(parent));
    if (missingParent) {
      throw new Error(`Saved permissions leave ${key} enabled without ${missingParent} for account ${userId}.`);
    }
  }
  const expectedSchedulePickup = overrides.get('approve_claim') !== false;
  if (effective.has('schedule_pickup') !== expectedSchedulePickup) {
    throw new Error(`Saved schedule_pickup state conflicts with approve_claim for account ${userId}.`);
  }
  return permissions;
}

function validatePlan(plan) {
  if (!Array.isArray(plan) || !plan.length) {
    throw new Error('Supply a non-empty list of approved Staff account permission changes.');
  }
  const seenUsers = new Set();
  for (const entry of plan) {
    if (!entry || typeof entry.user_id !== 'string' || !entry.user_id.trim()
      || !Array.isArray(entry.permissions)
      || entry.permissions.some((key) => typeof key !== 'string')) {
      throw new Error('Migration plan entries must include a Staff account ID and permission key list.');
    }
    if (seenUsers.has(entry.user_id)) throw new Error(`Duplicate account in migration plan: ${entry.user_id}`);
    if (new Set(entry.permissions).size !== entry.permissions.length) {
      throw new Error(`Duplicate permission in migration plan for account ${entry.user_id}.`);
    }
    seenUsers.add(entry.user_id);
  }
}

module.exports = { migrateStaffPermissionOverrides, validatePlan };
