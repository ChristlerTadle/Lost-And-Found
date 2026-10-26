const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const pages = require('../src/routes/pages');

async function testAdminDashboardPage() {
  const app = express();
  const requiredRoles = [];
  app.use((req, _res, next) => {
    req.session = { user: { id: 'admin-1', role_name: 'admin' } };
    next();
  });
  app.use((req, res, next) => {
    res.render = (view, locals) => res.json({
      view,
      title: locals.title,
      active: locals.active,
      userCount: locals.userCount,
      activeUserCount: locals.activeUserCount,
      summary: locals.summary,
    });
    next();
  });
  const summary = {
    totalItems: 12,
    lostItems: 7,
    foundItems: 5,
    pendingClaims: 2,
    totalClaims: 4,
    returnedItems: 1,
    storedItems: 2,
    statusCounts: {
      lostActive: 6,
      foundUnverified: 1,
      foundVerified: 2,
      stored: 2,
      claimed: 1,
      returned: 1,
    },
    categoryCounts: [{ category: 'Bags & Luggage', count: 3 }],
    activity: [{ type: 'claim', label: 'Claim submitted', name: 'Blue backpack', detail: 'Ownership claim', date: '2026-10-26T10:00:00.000Z' }],
  };
  app.locals.services = {
    auth: {
      requireRole(user, roles) {
        requiredRoles.push(roles);
        if (!roles.includes(user.role_name)) {
          const error = new Error('Forbidden');
          error.status = 403;
          throw error;
        }
      },
      getAdminUserSummary: async () => ({ totalUsers: 8, activeUsers: 7 }),
    },
    email: {},
    items: { getAdminDashboardSummary: async () => summary },
    notifications: {},
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(error.status || 500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-dashboard`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(requiredRoles, [['admin']]);
    assert.equal(result.view, 'admin-dashboard');
    assert.equal(result.title, 'Admin Dashboard');
    assert.equal(result.active, 'admin-dashboard');
    assert.equal(result.userCount, 8);
    assert.equal(result.activeUserCount, 7);
    assert.deepEqual(result.summary, summary);

    const templatePath = path.resolve(__dirname, '..', 'views', 'admin-dashboard.ejs');
    const html = await ejs.renderFile(templatePath, {
      userCount: 8,
      activeUserCount: 7,
      summary,
      icon: () => '',
      formatDate: (value) => String(value).slice(0, 10),
    });
    assert.match(html, /Total users/);
    assert.match(html, /Items by category/);
    assert.match(html, /Item status breakdown/);
    assert.match(html, /Recent activity/);
    assert.match(html, /User Management/);
    assert.match(html, /Blue backpack/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

testAdminDashboardPage().then(
  () => console.log('Admin dashboard checks passed.'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
