const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PERMISSIONS_BY_ROLE,
  ROLE_PERMISSION_ROUTE_MAP,
  normalizeRolePermissions,
  resolvePermissionKeys,
} = require('../config/role-permissions');
const { createRolePermissionService } = require('../../src/services/role-permissions');
const { createNotificationService } = require('../../src/services/notifications');

function createMemoryCollection(initial = []) {
  const rows = [...initial];
  return {
    rows,
    find(filter = {}) {
      return {
        async toArray() {
          return rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
        },
      };
    },
    async findOne(filter = {}) {
      return rows.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) || null;
    },
    async updateOne(filter, update, { upsert = false } = {}) {
      let row = rows.find((entry) => Object.entries(filter).every(([key, value]) => entry[key] === value));
      if (!row && upsert) {
        row = { ...filter, ...(update.$setOnInsert || {}) };
        rows.push(row);
      }
      if (row) Object.assign(row, update.$set || {});
      return { matchedCount: row ? 1 : 0 };
    },
    async insertOne(document) {
      rows.push(document);
      return { insertedId: document._id };
    },
    async deleteMany(filter = {}) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (Object.entries(filter).every(([key, value]) => rows[index][key] === value)) rows.splice(index, 1);
      }
      return { deletedCount: 0 };
    },
  };
}

function memoryDatabase(collections) {
  return { collection: (name) => collections[name] };
}

test('role permission dependencies expand parents and reject unknown keys for a role', () => {
  assert.deepEqual(normalizeRolePermissions('staff', ['approve_claim']), [
    'view_claims', 'verify_item_ownership', 'approve_claim',
  ]);
  assert.deepEqual(normalizeRolePermissions('staff', ['schedule_pickup']), [
    'view_claims', 'verify_item_ownership', 'approve_claim', 'schedule_pickup',
  ]);
  assert.deepEqual(normalizeRolePermissions('user', ['filter_items']), [
    'view_items', 'search_items', 'filter_items',
  ]);
  assert.throws(() => normalizeRolePermissions('user', ['view_claims']), { status: 400 });
  assert.deepEqual(normalizeRolePermissions('admin', ['view_users', 'edit_user', 'manage_permissions', 'manage_integrations']), [
    'view_users', 'edit_user', 'manage_permissions', 'manage_integrations',
  ]);
});

test('role permissions update globally and are checked from current storage on every request', async () => {
  const initial = ['user', 'staff'].flatMap((role) => PERMISSIONS_BY_ROLE[role].map(({ key }) => ({
    role,
    permission_key: key,
    enabled: true,
  })));
  const collection = createMemoryCollection(initial);
  const service = createRolePermissionService(memoryDatabase({ role_permissions: collection }));

  const saved = await service.replaceRolePermissions('user', ['edit_my_report']);
  assert.deepEqual(saved.permissions, ['view_my_reports', 'edit_my_report']);
  assert.equal(await service.isEnabled('user', 'view_my_reports'), true);
  assert.equal(await service.isEnabled('user', 'view_items'), false);
  assert.equal(await service.isEnabled('staff', 'view_items'), false);
  assert.deepEqual(await service.findRolePermissions('user'), ['view_my_reports', 'edit_my_report']);
  assert.equal(await service.isEnabled('admin', 'anything'), false);

  const parentDisabled = await service.replaceRolePermissions('user', []);
  assert.deepEqual(parentDisabled.permissions, []);
  assert.equal(await service.isEnabled('user', 'edit_my_report'), false);
});

test('effective permissions combine role and account settings with account inheritance', async () => {
  const initial = ['user', 'staff', 'admin'].flatMap((role) => PERMISSIONS_BY_ROLE[role].map(({ key }) => ({
    role,
    permission_key: key,
    enabled: true,
  })));
  const roleCollection = createMemoryCollection(initial);
  const accountCollection = createMemoryCollection([
    { user_id: 'staff-1', permission_key: 'update_item_status', enabled: false },
  ]);
  const service = createRolePermissionService(memoryDatabase({
    role_permissions: roleCollection,
    account_permissions: accountCollection,
  }));

  assert.ok((await service.findEffectivePermissions('staff-1', 'staff')).includes('view_found_items'));
  assert.ok(!(await service.findEffectivePermissions('staff-1', 'staff')).includes('update_item_status'));
  assert.ok((await service.findEffectivePermissions('staff-2', 'staff')).includes('update_item_status'));
  assert.ok((await service.findEffectivePermissions('admin-1', 'admin')).includes('manage_permissions'));
  assert.ok((await service.findEffectivePermissions('admin-1', 'admin')).includes('manage_integrations'));
});

test('account permission saves expand dependencies and reject role-disabled permissions', async () => {
  const roleCollection = createMemoryCollection(['user', 'staff', 'admin'].flatMap((role) =>
    PERMISSIONS_BY_ROLE[role].map(({ key }) => ({ role, permission_key: key, enabled: true }))));
  const accountCollection = createMemoryCollection();
  const service = createRolePermissionService(memoryDatabase({
    role_permissions: roleCollection,
    account_permissions: accountCollection,
  }));

  await service.replaceRolePermissions('staff', []);
  await assert.rejects(
    service.prepareAccountPermissions('staff', { permissions: ['view_lost_reports'] }),
  );
  await assert.rejects(
    service.replaceAccountPermissions('staff-1', 'staff', ['unknown']),
  );

  await service.replaceRolePermissions(
    'staff',
    PERMISSIONS_BY_ROLE.staff.map(({ key }) => key),
  );

  const saved = await service.replaceAccountPermissions('staff-1', 'staff', ['approve_claim']);
  assert.deepEqual(saved.permissions, ['view_claims', 'verify_item_ownership', 'approve_claim']);
  assert.ok(!(await service.findEffectivePermissions('staff-1', 'staff')).includes('schedule_pickup'));

  await service.replaceRolePermissions('staff', ['view_claims']);
  await assert.rejects(
    service.prepareAccountPermissions('staff', { permissions: ['approve_claim'] }),
  );
});

test('route permission map has unique method/path entries and records both dynamic routes', () => {
  const routeKeys = ROLE_PERMISSION_ROUTE_MAP.map(({ method, path }) => `${method} ${path}`);
  assert.equal(new Set(routeKeys).size, routeKeys.length);
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, note }) =>
    method === 'GET' && path === '/items' && note?.includes('multiple permissions')));
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, note }) =>
    method === 'PATCH' && path === '/staff/claims/:id' && note?.includes('approve_claim')));
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, permission }) =>
    method === 'PATCH' && path === '/staff/claims/:id/pickup' && permission === 'schedule_pickup'));
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, permission }) =>
    method === 'POST' && path === '/staff/claims/:id/calendar-sync' && permission === 'schedule_pickup'));
});

test('admin account status actions require disable_user while edits require edit_user', () => {
  const mapping = ROLE_PERMISSION_ROUTE_MAP.find(({ method, path }) =>
    method === 'PATCH' && path === '/admin/users/:id');
  assert.equal(resolvePermissionKeys(mapping.permission, { body: { action: 'disable' } }), 'disable_user');
  assert.equal(resolvePermissionKeys(mapping.permission, { body: { action: 'enable' } }), 'disable_user');
  assert.equal(resolvePermissionKeys(mapping.permission, { body: { action: 'edit' } }), 'edit_user');
});

test('notifications are suppressed for roles without receive_notifications', async () => {
  const users = createMemoryCollection([
    { _id: 'user-1', role_name: 'user' },
    { _id: 'staff-1', role_name: 'staff' },
    { _id: 'admin-1', role_name: 'admin' },
  ]);
  const rolePermissions = createMemoryCollection([
    { role: 'user', permission_key: 'receive_notifications', enabled: false },
    { role: 'staff', permission_key: 'receive_notifications', enabled: true },
  ]);
  const notifications = createMemoryCollection();
  const service = createNotificationService(memoryDatabase({
    users,
    role_permissions: rolePermissions,
    notifications,
  }));
  const content = { type: 'status', title: 'Update', message: 'Status changed', href: '/' };

  assert.equal(await service.create('user-1', content), null);
  assert.equal(notifications.rows.length, 0);
  assert.ok(await service.create('staff-1', content));
  assert.ok(await service.create('admin-1', content));
  assert.equal(notifications.rows.length, 2);
});
