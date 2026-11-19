const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const {
  PERMISSIONS_BY_ROLE,
  ROLE_PERMISSION_ROUTE_MAP,
  normalizeRolePermissions,
  resolvePermissionKeys,
} = require('../config/role-permissions');
const { createRolePermissionService } = require('../../src/services/role-permissions');
const { createRoleChangeService } = require('../../src/services/role-change');
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
  assert.ok(PERMISSIONS_BY_ROLE.admin.some(({ key, label, requires }) => (
    key === 'assign_admin_role' && label === 'Assign admin role' && requires.includes('manage_permissions')
  )));
  assert.ok(normalizeRolePermissions('admin', [
    'manage_permissions', 'view_users', 'manage_integrations', 'assign_admin_role',
  ]).includes('assign_admin_role'));
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
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, permission }) =>
    method === 'POST' && path === '/admin/settings/:integrationId/verify'
    && permission === 'manage_integrations'));
  assert.ok(ROLE_PERMISSION_ROUTE_MAP.some(({ method, path, permission }) =>
    method === 'POST' && path === '/admin/settings/verification-email/test'
    && permission === 'manage_integrations'));
});

test('admin account status actions require disable_user while edits require edit_user', () => {
  const mapping = ROLE_PERMISSION_ROUTE_MAP.find(({ method, path }) =>
    method === 'PATCH' && path === '/admin/users/:id');
  assert.equal(resolvePermissionKeys(mapping.permission, { body: { action: 'disable' } }), 'disable_user');
  assert.equal(resolvePermissionKeys(mapping.permission, { body: { action: 'enable' } }), 'disable_user');
  assert.equal(resolvePermissionKeys(mapping.permission, { body: { action: 'edit' } }), 'edit_user');
  assert.deepEqual(resolvePermissionKeys(mapping.permission, {
    body: { action: 'edit', role_change: true, admin_role_change: true },
  }), ['edit_user', 'manage_permissions', 'assign_admin_role']);
  assert.deepEqual(resolvePermissionKeys(mapping.permission, {
    body: { action: 'edit', role_change: true, role_name: 'admin' },
  }), ['edit_user', 'manage_permissions', 'assign_admin_role']);
  assert.deepEqual(resolvePermissionKeys(mapping.permission, {
    body: { action: 'edit', role_change: true },
  }), ['edit_user', 'manage_permissions']);
});

test('shared role changes validate active targets and new-role permissions and preserve an active capable Admin', async () => {
  const users = createMemoryCollection([
    { _id: 'admin-1', role_name: 'admin', status: 'active' },
    { _id: 'admin-2', role_name: 'admin', status: 'active' },
    { _id: 'user-1', role_name: 'user', status: 'active' },
    { _id: 'disabled-user', role_name: 'user', status: 'disabled' },
  ]);
  const accountPermissions = createMemoryCollection([
    { user_id: 'user-1', permission_key: 'view_profile', enabled: false },
  ]);
  const enabledByRole = new Map(Object.entries(PERMISSIONS_BY_ROLE)
    .map(([role, definitions]) => [role, definitions.map(({ key }) => key)]));
  const rolePermissions = {
    async findRolePermissions(role) { return [...(enabledByRole.get(role) || [])]; },
    async findEffectivePermissions(_userId, role) { return this.findRolePermissions(role); },
  };
  const audited = [];
  const audit = {
    async runAction(events, action) {
      const result = await action();
      audited.push(...events);
      return result;
    },
  };
  const service = createRoleChangeService(memoryDatabase({
    users,
    account_permissions: accountPermissions,
  }), {
    rolePermissions,
    notifications: { async create() {} },
    audit,
  });
  const adminPermissions = PERMISSIONS_BY_ROLE.admin.map(({ key }) => key);

  await assert.rejects(service.validateRoleChange('admin-1', 'disabled-user', 'admin', adminPermissions), { status: 404 });
  enabledByRole.set('admin', enabledByRole.get('admin').filter((key) => key !== 'view_all_claims'));
  await assert.rejects(service.validateRoleChange('admin-1', 'user-1', 'admin', adminPermissions), { status: 403 });
  enabledByRole.set('admin', PERMISSIONS_BY_ROLE.admin.map(({ key }) => key));

  const promoted = await service.changeRole({
    actorId: 'admin-1',
    targetId: 'user-1',
    newRole: 'admin',
    permissions: adminPermissions,
    auditContext: {},
  });
  assert.equal(promoted.role_name, 'admin');
  assert.deepEqual(accountPermissions.rows.filter(({ user_id }) => user_id === 'user-1'), []);
  assert.equal(audited.at(-2).action, 'account.role_change');
  assert.equal(audited.at(-2).new_value.privilege_change, true);

  const demoted = await service.changeRole({
    actorId: 'admin-1',
    targetId: 'admin-2',
    newRole: 'user',
    permissions: PERMISSIONS_BY_ROLE.user.map(({ key }) => key),
    auditContext: {},
  });
  assert.equal(demoted.role_name, 'user');

  const onlyAdminUsers = createMemoryCollection([
    { _id: 'sole-admin', role_name: 'admin', status: 'active' },
  ]);
  const soleAdminService = createRoleChangeService(memoryDatabase({
    users: onlyAdminUsers,
    account_permissions: createMemoryCollection(),
  }), {
    rolePermissions,
    notifications: { async create() {} },
    audit,
  });
  await assert.rejects(
    soleAdminService.validateRoleChange('manager', 'sole-admin', 'user', PERMISSIONS_BY_ROLE.user.map(({ key }) => key)),
    { status: 403 },
  );
});

test('Edit user renders all role choices and an Admin checklist using role defaults', async () => {
  const account = {
    id: 'target-user',
    full_name: 'Target User',
    email: 'target@example.test',
    role_name: 'user',
    status: 'active',
  };
  const roles = ['user', 'staff', 'admin'].map((role) => ({
    role,
    permissions: PERMISSIONS_BY_ROLE[role].map((permission) => ({ ...permission, enabled: true })),
  }));
  const shared = {
    API: '',
    sessionInfo: {
      user: { id: 'editor' },
      rolePermissions: ['edit_user', 'manage_permissions'],
    },
    h: (value) => String(value ?? ''),
    date: () => '',
    param: () => '',
    link: () => '',
    buttonLink: () => '',
    badge: () => '',
    itemStatusLabel: () => '',
    itemTypeLabel: () => '',
    field: () => '<input>',
    selectField: () => '<select>',
    optionsFrom: () => [],
    request: async (route) => {
      if (route === '/admin/users') return { users: [account] };
      if (route.endsWith('/permissions')) {
        return {
          role: 'user',
          permissions: PERMISSIONS_BY_ROLE.user.map((permission) => ({
            ...permission,
            enabled: true,
            role_enabled: true,
          })),
        };
      }
      if (route === '/admin/role-permissions') return { roles };
      throw new Error(`Unexpected request: ${route}`);
    },
    icon: () => '',
    pageHeader: (title) => `<header>${title}</header>`,
    table: () => '',
    formAction: () => '',
    hasPermission: () => true,
  };
  const file = path.join(__dirname, '../../frontend/public/js/pages/admin.js');
  const source = readFileSync(file, 'utf8')
    .replace("import * as shared from '../shared.js';", 'const shared = globalThis.__shared;')
    .replace(/export \{[^}]+\};\s*$/, '');
  const context = vm.createContext({ __shared: shared });
  vm.runInContext(source, context);
  const html = await context.adminEditUser(account.id);

  for (const role of ['user', 'staff', 'admin']) {
    assert.match(html, new RegExp(`<option value="${role}"`));
    assert.match(html, new RegExp(`data-role-panel="${role}"`));
    assert.match(html, new RegExp(`${role[0].toUpperCase()}${role.slice(1)} permissions`));
  }
  assert.match(html, /value="assign_admin_role"/);
  assert.match(html, /Assign admin role/);
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
