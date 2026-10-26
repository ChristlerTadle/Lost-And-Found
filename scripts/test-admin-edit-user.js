const assert = require('node:assert/strict');
const express = require('express');
const pages = require('../src/routes/pages');
const { createAuthService } = require('../src/services/auth');

function createUserService(initialUsers) {
  const users = [...initialUsers];
  const service = createAuthService({
    collection(name) {
      if (name === 'password_resets') return {};
      assert.equal(name, 'users');
      return {
        async findOne(filter) {
          return users.find((candidate) => candidate._id === filter._id
            && filter.status === candidate.status
            && filter.role_name.$in.includes(candidate.role_name)) || null;
        },
        async updateOne(filter, update) {
          const user = users.find((candidate) => candidate._id === filter._id
            && filter.status === candidate.status
            && filter.role_name.$in.includes(candidate.role_name));
          if (!user) return { matchedCount: 0 };
          if (users.some((candidate) => candidate !== user
            && (candidate.email === update.$set.email
              || (update.$set.student_id && candidate.student_id === update.$set.student_id)))) {
            const error = new Error('Duplicate account field');
            error.code = 11000;
            throw error;
          }
          Object.assign(user, update.$set);
          return { matchedCount: 1 };
        },
      };
    },
  });
  return { service, users };
}

async function testAdminUserUpdate() {
  const { service, users } = createUserService([
    {
      _id: 'user-1',
      full_name: 'Original Name',
      email: 'original@example.test',
      student_id: 'STUDENT-1',
      phone: '555-0001',
      role_name: 'user',
      status: 'active',
    },
    {
      _id: 'user-2',
      full_name: 'Other User',
      email: 'other@example.test',
      student_id: 'STUDENT-2',
      role_name: 'user',
      status: 'active',
    },
    {
      _id: 'admin-1',
      full_name: 'Admin',
      email: 'admin@example.test',
      role_name: 'admin',
      status: 'active',
    },
  ]);

  const editable = await service.findAdminEditableUser('user-1');
  assert.equal(editable.id, 'user-1');
  assert.equal(editable.email, 'original@example.test');
  assert.equal('password_hash' in editable, false);

  await service.updateUserByAdmin('user-1', {
    full_name: 'Updated Name',
    email: ' UPDATED@example.test ',
    student_id: 'STUDENT-1A',
    phone: '555-0002',
  });
  assert.equal(users[0].full_name, 'Updated Name');
  assert.equal(users[0].email, 'updated@example.test');
  assert.equal(users[0].student_id, 'STUDENT-1A');
  assert.equal(users[0].phone, '555-0002');
  assert.equal(users[0].role_name, 'user');
  assert.equal(users[0].status, 'active');

  await assert.rejects(service.updateUserByAdmin('user-1', {
    full_name: 'Updated Name',
    email: 'other@example.test',
  }), (error) => error.status === 400 && /already exists/.test(error.message));
  await assert.rejects(service.updateUserByAdmin('user-1', {
    full_name: ' ',
    email: 'invalid',
  }), (error) => error.status === 400);
  await assert.rejects(service.findAdminEditableUser('admin-1'), (error) => error.status === 404);
}

async function testAdminEditRoute() {
  const updated = [];
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
      updateUserByAdmin: async (id, input) => updated.push({ id, input }),
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
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-edit-user&id=user-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ full_name: 'Changed', email: 'changed@example.test' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/index.php?page=admin-edit-user&id=user-1&saved=1');
    assert.equal(updated.length, 1);
    assert.equal(updated[0].id, 'user-1');
    assert.equal(updated[0].input.email, 'changed@example.test');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testAdminUserUpdate();
  await testAdminEditRoute();
  console.log('Admin user editing checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
