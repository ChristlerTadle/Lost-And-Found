const assert = require('node:assert/strict');
const express = require('express');
const pages = require('../src/routes/pages');

async function run() {
  const assignedUsers = [];
  const createdNotifications = [];
  const admin = { id: 'admin-1', role_name: 'admin' };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = { user: admin };
    next();
  });
  app.locals.services = {
    auth: {
      requireRole(user, roles) {
        if (!roles.includes(user.role_name)) throw new Error('Forbidden');
      },
      assignStaffRole: async (userId) => assignedUsers.push(userId),
    },
    email: {},
    items: {},
    notifications: {
      create: async (userId, notification) => createdNotifications.push({ userId, ...notification }),
    },
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-dashboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'assign_staff', user_id: 'user-1' }),
      redirect: 'manual',
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/index.php?page=admin-users&updated=staff');
    assert.deepEqual(assignedUsers, ['user-1']);
    assert.equal(createdNotifications.length, 1);
    assert.equal(createdNotifications[0].userId, 'user-1');
    assert.equal(createdNotifications[0].type, 'status');
    console.log('Admin staff assignment route checks passed.');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
