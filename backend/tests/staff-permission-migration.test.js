const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PERMISSIONS_BY_ROLE } = require('../config/role-permissions');
const { migrateStaffPermissionOverrides } = require('../../src/services/staff-permission-migration');

function createMemoryCollection(initial = []) {
  const rows = [...initial];
  return {
    rows,
    find(filter = {}) {
      return {
        async toArray() {
          return rows.filter((row) => matches(row, filter));
        },
      };
    },
    async findOne(filter = {}) {
      return rows.find((row) => matches(row, filter)) || null;
    },
    async updateOne(filter, update, { upsert = false } = {}) {
      let row = rows.find((entry) => matches(entry, filter));
      if (!row && upsert) {
        row = { ...filter, ...(update.$setOnInsert || {}) };
        rows.push(row);
      }
      if (row) Object.assign(row, update.$set || {});
      return { matchedCount: row ? 1 : 0 };
    },
  };
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    const actual = key.split('.').reduce((result, part) => result?.[part], row);
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(actual);
    return actual === value;
  });
}

function createMemoryDatabase() {
  const users = createMemoryCollection([
    { _id: 'staff-a', full_name: 'Staff A', role_name: 'staff' },
    { _id: 'staff-b', full_name: 'Staff B', role_name: 'staff' },
  ]);
  const rolePermissions = createMemoryCollection(
    PERMISSIONS_BY_ROLE.staff.map(({ key }) => ({ role: 'staff', permission_key: key, enabled: true })),
  );
  const accountPermissions = createMemoryCollection();
  const auditLog = createMemoryCollection();
  return {
    users,
    rolePermissions,
    accountPermissions,
    auditLog,
    database: {
      collection(name) {
        return {
          users,
          role_permissions: rolePermissions,
          account_permissions: accountPermissions,
          audit_log: auditLog,
        }[name];
      },
    },
  };
}

test('legacy staff migration writes only approved role-enabled overrides and is idempotent', async () => {
  const memory = createMemoryDatabase();
  const auditEvents = [];
  const audit = {
    async logAction(event) {
      auditEvents.push(event);
      memory.auditLog.rows.push({
        action: event.action,
        target_type: event.target_type,
        target_id: event.target_id,
        new_value: event.new_value,
      });
    },
  };
  const plan = [
    { user_id: 'staff-a', permissions: ['approve_claim', 'mark_item_returned'] },
    { user_id: 'staff-b', permissions: [] },
  ];

  const firstRun = await migrateStaffPermissionOverrides(memory.database, audit, plan);
  assert.deepEqual(memory.accountPermissions.rows.map(({ user_id, permission_key, enabled }) => ({
    user_id, permission_key, enabled,
  })), [
    { user_id: 'staff-a', permission_key: 'mark_item_returned', enabled: false },
    { user_id: 'staff-a', permission_key: 'approve_claim', enabled: false },
    { user_id: 'staff-a', permission_key: 'schedule_pickup', enabled: false },
  ]);
  assert.equal(firstRun[0].schedule_pickup_effective, false);
  assert.ok(!firstRun[0].effective_permissions.includes('schedule_pickup'));
  assert.equal(firstRun[1].schedule_pickup_effective, true);
  assert.ok(firstRun[1].effective_permissions.includes('schedule_pickup'));
  assert.equal(auditEvents.length, 2);
  assert.deepEqual(auditEvents[0].new_value, {
    account_name: 'Staff A',
    permission_keys: ['mark_item_returned', 'approve_claim', 'schedule_pickup'],
    source: 'legacy migration',
  });
  assert.deepEqual(auditEvents[1].new_value, {
    account_name: 'Staff B',
    permission_keys: [],
    source: 'legacy migration',
  });

  const secondRun = await migrateStaffPermissionOverrides(memory.database, audit, plan);
  assert.deepEqual(secondRun.map(({ changed_permissions }) => changed_permissions), [[], []]);
  assert.equal(memory.accountPermissions.rows.length, 3);
  assert.equal(auditEvents.length, 2);
});

test('legacy staff migration does not write role-disabled permissions', async () => {
  const memory = createMemoryDatabase();
  await memory.rolePermissions.updateOne(
    { role: 'staff', permission_key: 'mark_item_returned' },
    { $set: { enabled: false } },
  );
  const audit = {
    async logAction() {},
  };
  const result = await migrateStaffPermissionOverrides(memory.database, audit, [
    { user_id: 'staff-a', permissions: ['mark_item_returned'] },
  ]);
  assert.deepEqual(memory.accountPermissions.rows, []);
  assert.ok(result[0].effective_permissions.includes('schedule_pickup'));
});
