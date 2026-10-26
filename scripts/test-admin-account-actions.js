const assert = require('node:assert/strict');
const express = require('express');
const pages = require('../src/routes/pages');
const { createAuthService } = require('../src/services/auth');

function createService() {
  const users = [
    { _id: 'user-1', role_name: 'user', status: 'active' },
    { _id: 'staff-1', role_name: 'staff', status: 'active' },
    { _id: 'disabled-1', role_name: 'user', status: 'disabled' },
    { _id: 'admin-1', role_name: 'admin', status: 'active' },
  ];
  const service = createAuthService({
    collection(name) {
      if (name === 'password_resets') return {};
      assert.equal(name, 'users');
      return {
        async findOne(filter) {
          return users.find((account) => account._id === filter._id
            && (!filter.status || account.status === filter.status)) || null;
        },
        async updateOne(filter, update) {
          const account = users.find((candidate) => candidate._id === filter._id
            && (typeof filter.role_name === 'string'
              ? candidate.role_name === filter.role_name
              : filter.role_name.$in.includes(candidate.role_name))
            && candidate.status === filter.status);
          if (!account) return { matchedCount: 0 };
          Object.assign(account, update.$set);
          return { matchedCount: 1 };
        },
      };
    },
  });
  return { service, users };
}

async function testAccountActions() {
  const { service, users } = createService();
  await service.revertStaffRole('staff-1');
  assert.equal(users[1].role_name, 'user');
  await assert.rejects(service.revertStaffRole('user-1'), (error) => error.status === 404);
  await service.setUserAccountStatus('user-1', 'disabled');
  assert.equal(users[0].status, 'disabled');
  assert.equal(await service.findActiveSessionUser('user-1'), null);
  await service.setUserAccountStatus('user-1', 'active');
  assert.equal(users[0].status, 'active');
  assert.equal((await service.findActiveSessionUser('user-1')).role_name, 'user');
  await assert.rejects(service.setUserAccountStatus('admin-1', 'disabled'), (error) => error.status === 404);
}

async function testAdminActionRoutes() {
  const actions = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = { user: { id: 'admin-1', role_name: 'admin' } };
    next();
  });
  app.locals.services = {
    auth: {
      requireRole(user, roles) {
        if (!roles.includes(user.role_name)) {
          const error = new Error('Forbidden');
          error.status = 403;
          throw error;
        }
      },
      revertStaffRole: async (id) => actions.push(['revert_staff', id]),
      setUserAccountStatus: async (id, status) => actions.push([status, id]),
    },
    email: {},
    items: {},
    notifications: {},
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(error.status || 500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    for (const [action, userId, expected] of [
      ['revert_staff', 'staff-1', 'user'],
      ['disable_user', 'user-1', 'disabled'],
      ['enable_user', 'user-1', 'enabled'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action, user_id: userId }),
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `/index.php?page=admin-users&updated=${expected}`);
    }
    assert.deepEqual(actions, [
      ['revert_staff', 'staff-1'],
      ['disabled', 'user-1'],
      ['active', 'user-1'],
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testAccountActions();
  await testAdminActionRoutes();
  console.log('Admin account access action checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
