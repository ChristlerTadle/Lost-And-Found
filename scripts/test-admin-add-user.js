const assert = require('node:assert/strict');
const express = require('express');
const pages = require('../src/routes/pages');
const { createAuthService } = require('../src/services/auth');

async function testCreateAdminUser() {
  const savedUsers = [];
  const service = createAuthService({
    collection(name) {
      if (name === 'password_resets') return {};
      assert.equal(name, 'users');
      return {
        async insertOne(user) {
          if (savedUsers.some((saved) => saved.email === user.email
            || (user.student_id && saved.student_id === user.student_id))) {
            const error = new Error('Duplicate user');
            error.code = 11000;
            throw error;
          }
          savedUsers.push(user);
        },
      };
    },
  });

  const user = await service.createAdminUser({
    full_name: 'New Account',
    email: ' NEW.USER@example.test ',
    student_id: 'STUDENT-1',
    phone: '555-0100',
    password: 'temporary-password',
  });
  assert.equal(user.email, 'new.user@example.test');
  assert.equal(user.role_name, 'user');
  assert.equal(user.status, 'active');
  assert.equal('password_hash' in user, false);
  assert.notEqual(savedUsers[0].password_hash, 'temporary-password');
  await assert.rejects(service.createAdminUser({
    full_name: 'Duplicate Account',
    email: 'new.user@example.test',
    password: 'temporary-password',
  }), (error) => error.status === 400 && /already exists/.test(error.message));
  await assert.rejects(service.createAdminUser({
    full_name: '',
    email: 'invalid',
    password: 'short',
  }), (error) => error.status === 400);
}

async function testAdminCreationRoute() {
  const created = [];
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
      createAdminUser: async (input) => created.push(input),
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
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-add-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        full_name: 'New Account',
        email: 'new.user@example.test',
        password: 'temporary-password',
      }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/index.php?page=admin-add-user&created=1');
    assert.equal(created.length, 1);
    assert.equal(created[0].email, 'new.user@example.test');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testCreateAdminUser();
  await testAdminCreationRoute();
  console.log('Admin user creation checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
