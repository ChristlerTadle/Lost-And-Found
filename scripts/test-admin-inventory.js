const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const pages = require('../src/routes/pages');
const { createItemService } = require('../src/services/items');

async function testInventoryService() {
  const documents = [
    {
      _id: 'stored-1',
      user_id: 'user-1',
      item_type: 'found',
      item_name: 'Blue backpack',
      category: 'Bags',
      location: 'Library',
      date_lost: '2026-10-20',
      status: 'stored',
      physical_verification_status: 'verified',
      created_at: '2026-10-20T10:00:00.000Z',
    },
    {
      _id: 'stored-2',
      user_id: 'user-2',
      item_type: 'found',
      item_name: 'Math notebook',
      category: 'Books',
      location: 'Room 101',
      date_lost: '2026-10-21',
      status: 'stored',
      physical_verification_status: 'pending',
      created_at: '2026-10-21T10:00:00.000Z',
    },
  ];
  const service = createItemService({
    collection(name) {
      if (name === 'lost_items') return {
        find: (filter) => {
          assert.deepEqual(filter, { item_type: 'found', status: 'stored' });
          return { sort: () => ({ toArray: async () => documents }) };
        },
      };
      if (name === 'users') return {
        findOne: async (filter) => ({ full_name: filter._id === 'user-1' ? 'Alex Staff' : 'Sam Staff' }),
      };
      assert.equal(name, 'item_claims');
      return {};
    },
  }, {});

  const items = await service.findInventoryReport();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.id), ['stored-1', 'stored-2']);
  assert.equal(items[0].reported_by, 'Alex Staff');
  assert.equal(items[0].physical_verification_status, 'verified');
}

async function testInventoryRouteAndTemplate() {
  const app = express();
  let requiredRole;
  app.use((req, _res, next) => {
    req.session = { user: { id: 'admin-1', role_name: 'admin' } };
    next();
  });
  app.use((req, res, next) => {
    res.render = (view, locals) => res.json({
      view,
      title: locals.title,
      active: locals.active,
      items: locals.items,
      categoryCounts: locals.categoryCounts,
      generatedAt: locals.generatedAt,
    });
    next();
  });
  const items = [
    { id: 'stored-1', category: 'Bags', item_name: 'Blue backpack' },
    { id: 'stored-2', category: 'Bags', item_name: 'Small pouch' },
    { id: 'stored-3', category: 'Books', item_name: 'Math notebook' },
  ];
  app.locals.services = {
    auth: {
      requireRole(user, roles) {
        requiredRole = roles;
        if (!roles.includes(user.role_name)) {
          const error = new Error('Forbidden');
          error.status = 403;
          throw error;
        }
      },
    },
    email: {},
    items: { findInventoryReport: async () => items },
    notifications: {},
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(error.status || 500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-inventory`);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.deepEqual(requiredRole, ['admin']);
    assert.equal(report.view, 'admin-inventory');
    assert.equal(report.title, 'Inventory Report');
    assert.equal(report.active, 'admin-inventory');
    assert.deepEqual(report.categoryCounts, { Bags: 2, Books: 1 });
    assert.ok(report.generatedAt);

    const templatePath = path.resolve(__dirname, '..', 'views', 'admin-inventory.ejs');
    const html = await ejs.renderFile(templatePath, {
      items: [
        {
          id: 'stored-1',
          item_name: 'Blue backpack',
          category: 'Bags',
          location: 'Library',
          date_lost: '2026-10-20',
          reported_by: 'Alex Staff',
          physical_verification_status: 'verified',
        },
      ],
      categoryCounts: { Bags: 1 },
      generatedAt: new Date('2026-10-26T00:00:00.000Z'),
      formatDate: (value) => String(value).slice(0, 10),
      icon: () => '',
    });
    assert.match(html, /Items in custody/);
    assert.match(html, /Blue backpack/);
    assert.match(html, /Alex Staff/);
    assert.match(html, /Print report/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testInventoryService();
  await testInventoryRouteAndTemplate();
  console.log('Admin inventory report checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
