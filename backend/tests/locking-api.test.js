const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { test } = require('node:test');
const { MongoClient } = require('mongodb');
const { asyncRoute } = require('../middlewares/async-route');
const { createAdminController } = require('../controllers/admin-controller');
const { createClaimsController } = require('../controllers/claims-controller');
const { createStaffController } = require('../controllers/staff-controller');
const { createItemService } = require('../../src/services/items');
const { createAuthService } = require('../../src/services/auth');
const { createRateLimitService } = require('../../src/services/rate-limits');
const { LockConflictError, createLockManager } = require('../../src/services/locks');
const appConfig = require('../../src/config');
const { assertDedicatedLockTestDatabase } = require('./helpers/lock-test-database');

const mongoUri = process.env.MONGODB_TEST_URI;
const databaseName = process.env.MONGODB_TEST_DATABASE;
const testDatabaseConfigured = Boolean(mongoUri && databaseName);
if (testDatabaseConfigured) assertDedicatedLockTestDatabase(databaseName, appConfig.mongodbDatabase);
if (Boolean(mongoUri) !== Boolean(databaseName)) {
  throw new Error('Set both MONGODB_TEST_URI and MONGODB_TEST_DATABASE to run API lock tests.');
}

test('business API routes serialize concurrent record changes', {
  skip: !testDatabaseConfigured,
}, async (t) => {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3_000 });
  await client.connect();
  const database = client.db(databaseName);
  const prefix = `locking-api-${randomUUID()}`;
  const userIds = [
    `${prefix}-owner`,
    `${prefix}-claimant-a`,
    `${prefix}-claimant-b`,
    `${prefix}-staff-a`,
    `${prefix}-staff-b`,
    `${prefix}-admin-a`,
    `${prefix}-admin-b`,
  ];
  const itemIds = [];
  const claimIds = [];
  const lockEvents = [];
  const audit = {
    async logAction(event) { lockEvents.push(event); },
    async runAction(_events, action) { return action(undefined); },
  };
  const locks = createLockManager(database, {
    audit,
    config: { ...appConfig.locking, leaseMs: 1_000, waitMs: 1_000, demoHoldMs: 0 },
  });
  await locks.initialize();
  const notificationService = { async create() {} };
  const items = createItemService(database, notificationService);
  const auth = createAuthService(database);
  const rolePermissions = {
    async findEffectivePermissions(_id, role) {
      return role === 'admin'
        ? ['manage_permissions', 'view_users', 'manage_integrations', 'edit_user', 'assign_admin_role']
        : [];
    },
  };
  const googleCalendar = {
    async cleanupClaim() { return { status: 'skipped' }; },
    async cleanupForItem() { return { status: 'skipped' }; },
    async retryClaim() { return { status: 'skipped' }; },
  };
  const staff = createStaffController({ items, audit, googleCalendar, locks });
  const admin = createAdminController({
    auth,
    items,
    rolePermissions,
    roleChange: {},
    notifications: notificationService,
    integrationSettings: {},
    integrationSecurity: {},
    adminMfa: {},
    googleOAuth: {},
    recaptcha: {},
    googleCalendar,
    email: {},
    callIntegration: {},
    audit,
    frontendOrigin: 'http://localhost:5173',
    rateLimitConfig: {},
    locks,
  });
  const claims = createClaimsController({ items, googleCalendar, locks });

  await database.collection('users').insertMany(userIds.map((id) => ({
    _id: id,
    full_name: `Test ${id}`,
    email: `${id}@example.test`,
    student_id: id,
    role_name: id.includes('admin') ? 'admin' : id.includes('staff') ? 'staff' : 'user',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })));

  const actors = new Map(userIds.map((id) => {
    const role = id.includes('admin') ? 'admin' : id.includes('staff') ? 'staff' : 'user';
    const permissions = role === 'admin'
      ? ['manage_permissions', 'edit_user', 'assign_admin_role', 'manage_integrations', 'view_users']
      : role === 'staff'
        ? ['approve_claim', 'schedule_pickup', 'update_item_status', 'verify_found_item']
        : [];
    return [id, { id, role_name: role, full_name: `Test ${id}`, permissions }];
  }));
  const app = createApiHarness({ actors, locks, staff, admin, claims });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function createItem(suffix, status = 'stored') {
    const id = `${prefix}-${suffix}`;
    itemIds.push(id);
    await database.collection('lost_items').insertOne({
      _id: id,
      user_id: userIds[0],
      item_type: 'found',
      status,
      item_name: 'Wallet',
      description: 'Dark wallet',
      identifying_details: 'Distinctive stitching',
      category: 'Accessories',
      location: 'Library',
      date_lost: '2020-01-01',
      physical_verification_status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return id;
  }

  async function createClaim(suffix, itemId, claimantId = userIds[1]) {
    const id = `${prefix}-${suffix}`;
    claimIds.push(id);
    await database.collection('item_claims').insertOne({
      _id: id,
      item_id: itemId,
      user_id: claimantId,
      claim_details: 'I can identify the item.',
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return id;
  }

  const request = (path, actorId, method, body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-user': actorId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  try {
    await t.test('two approvals of one claim yield one success and one state conflict', async () => {
      const itemId = await createItem('same-claim');
      const claimId = await createClaim('same-claim', itemId);
      const responses = await Promise.all([
        request(`/staff/claims/${claimId}`, userIds[3], 'PATCH', { action: 'review', decision: 'approved' }),
        request(`/staff/claims/${claimId}`, userIds[4], 'PATCH', { action: 'review', decision: 'approved' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
      const conflict = await responses.find((response) => response.status === 409).json();
      assert.equal(conflict.code, 'state_conflict');
      assert.match(conflict.error, /already approved/i);
    });

    await t.test('approvals of separate claims for one item serialize to one winner', async () => {
      const itemId = await createItem('two-claims');
      const firstClaim = await createClaim('two-claims-a', itemId, userIds[1]);
      const secondClaim = await createClaim('two-claims-b', itemId, userIds[2]);
      const responses = await Promise.all([
        request(`/staff/claims/${firstClaim}`, userIds[3], 'PATCH', { action: 'review', decision: 'approved' }),
        request(`/staff/claims/${secondClaim}`, userIds[4], 'PATCH', { action: 'review', decision: 'approved' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
      assert.equal(await database.collection('item_claims').countDocuments({
        item_id: itemId,
        status: 'approved',
      }), 1);
    });

    await t.test('item removal and claim approval cannot both win', async () => {
      const itemId = await createItem('remove-versus-approve');
      const claimId = await createClaim('remove-versus-approve', itemId);
      const responses = await Promise.all([
        request(`/admin/items/${itemId}`, userIds[5], 'DELETE'),
        request(`/staff/claims/${claimId}`, userIds[3], 'PATCH', { action: 'review', decision: 'approved' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
      const [item, claim] = await Promise.all([
        database.collection('lost_items').findOne({ _id: itemId }),
        database.collection('item_claims').findOne({ _id: claimId }),
      ]);
      if (item.deleted_at) assert.notEqual(claim.status, 'approved');
      else assert.equal(item.status, 'claimed');
    });

    await t.test('admin item edit and staff status change serialize on the same item', async () => {
      const itemId = await createItem('edit-versus-status');
      const responses = await Promise.all([
        request(`/admin/items/${itemId}`, userIds[5], 'PATCH', {
          item_name: 'Updated wallet',
          description: 'Dark wallet',
          identifying_details: 'Distinctive stitching',
          category: 'Accessories',
          location: 'Library',
          date_lost: '2020-01-01',
        }),
        request(`/staff/items/${itemId}/status`, userIds[3], 'PATCH', { status: 'found' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
      const item = await database.collection('lost_items').findOne({ _id: itemId });
      assert.equal(item.item_name, 'Updated wallet');
      assert.equal(item.status, 'found');
    });

    await t.test('handler errors release every acquired claim lock', async () => {
      const itemId = await createItem('release-on-error');
      const claimId = await createClaim('release-on-error', itemId);
      const failed = await request(
        `/staff/claims/${claimId}`, userIds[3], 'PATCH',
        { action: 'review', decision: 'invalid' },
      );
      assert.equal(failed.status, 400);
      const succeeding = await request(
        `/staff/claims/${claimId}`, userIds[4], 'PATCH',
        { action: 'review', decision: 'approved' },
      );
      assert.equal(succeeding.status, 200);
    });

    await t.test('simultaneous admin disables leave a capable admin active', async () => {
      const responses = await Promise.all([
        request(`/admin/users/${userIds[6]}`, userIds[5], 'PATCH', { action: 'disable' }),
        request(`/admin/users/${userIds[5]}`, userIds[6], 'PATCH', { action: 'disable' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 403]);
      assert.equal(await database.collection('users').countDocuments({
        _id: { $in: [userIds[5], userIds[6]] },
        role_name: 'admin',
        status: 'active',
      }), 1);
    });

    await t.test('claim submissions serialize on an item without imposing capacity', async () => {
      const itemId = await createItem('claim-submit');
      const responses = await Promise.all([
        request('/claims', userIds[1], 'POST', { item_id: itemId, claim_details: 'Claim A details' }),
        request('/claims', userIds[2], 'POST', { item_id: itemId, claim_details: 'Claim B details' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status), [201, 201]);
      assert.equal(await database.collection('item_claims').countDocuments({ item_id: itemId }), 2);
    });

    await t.test('demo lock conflicts roll back global and route counters', async () => {
      const demoLocks = createLockManager(database, {
        audit,
        config: {
          ...appConfig.locking,
          leaseMs: 1_000,
          waitMs: 40,
          retryMinMs: 2,
          retryMaxMs: 5,
          demoHoldMs: 180,
          isProduction: false,
        },
      });
      await demoLocks.initialize();
      const rateLimits = createRateLimitService({
        config: {
          global_api: { windowMs: 60_000, max: 2, keyType: 'ip', store: 'memory', sensitive: false },
          staff_writes: { windowMs: 60_000, max: 2, keyType: 'account+ip', store: 'memory', sensitive: false },
        },
      });
      const demoStaff = createStaffController({ items, audit, googleCalendar, locks: demoLocks });
      const demoApp = createApiHarness({
        actors, locks: demoLocks, staff: demoStaff, admin, claims, rateLimits,
      });
      const demoServer = await listen(demoApp);
      const demoUrl = `http://127.0.0.1:${demoServer.address().port}`;
      const itemId = await createItem('demo-conflict');
      const limitedRequest = () => fetch(`${demoUrl}/limited/staff/items/${itemId}/status`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-test-user': userIds[3],
        },
        body: JSON.stringify({ status: 'found' }),
      });
      try {
        const firstRequest = limitedRequest();
        await delay(15);
        const conflict = await limitedRequest();
        assert.equal(conflict.status, 409);
        assert.equal(conflict.headers.get('Retry-After'), '1');
        assert.equal((await conflict.json()).code, 'lock_conflict');
        assert.equal((await firstRequest).status, 200);
        assert.equal((await limitedRequest()).status, 200);
        assert.equal(lockEvents.some(({ action }) => action === 'rate_limited'), false);
      } finally {
        await closeServer(demoServer);
      }
    });
  } finally {
    await closeServer(server);
    await database.collection('lost_items').deleteMany({ _id: { $in: itemIds } });
    await database.collection('item_claims').deleteMany({
      $or: [
        { _id: { $in: claimIds } },
        { item_id: { $in: itemIds } },
      ],
    });
    await database.collection('users').deleteMany({ _id: { $in: userIds } });
    await database.collection('resource_locks').deleteMany({ key: { $regex: `^account:${prefix}|^item:${prefix}|^claim:${prefix}` } });
    await client.close();
  }
});

function createApiHarness({ actors, locks, staff, admin, claims, rateLimits }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = actors.get(req.get('x-test-user'));
    req.user = actor;
    req.rolePermissions = actor?.permissions || [];
    req.session = { user: actor };
    next();
  });
  const limited = rateLimits
    ? [rateLimits.limit('global_api'), rateLimits.limit('staff_writes')]
    : [];
  app.patch('/staff/claims/:id', asyncRoute(staff.patchStaffClaimsById));
  app.patch('/staff/items/:id/status', asyncRoute(staff.patchStaffItemsByIdStatus));
  app.patch('/admin/items/:id', asyncRoute(admin.patchAdminItemsById));
  app.delete('/admin/items/:id', asyncRoute(admin.deleteAdminItemsById));
  app.patch('/admin/users/:id', asyncRoute(admin.patchAdminUsersById));
  app.post('/claims', asyncRoute(claims.postClaims));
  app.patch('/limited/staff/items/:id/status', ...limited, asyncRoute(staff.patchStaffItemsByIdStatus));
  app.use(async (error, req, res, _next) => {
    const conflict = error instanceof LockConflictError;
    if (conflict && req.rateLimitConflictRollback) await req.rateLimitConflictRollback();
    if (conflict && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    const status = Number.isInteger(error.status) ? error.status
      : error instanceof Error && error.constructor === Error ? 400 : 500;
    res.status(status).json({
      error: error.message,
      ...(conflict ? { code: 'lock_conflict' } : error.code ? { code: error.code } : {}),
    });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

