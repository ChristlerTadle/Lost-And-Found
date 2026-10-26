const assert = require('node:assert/strict');
const express = require('express');
const { categories } = require('../src/data');
const pages = require('../src/routes/pages');
const { createItemService } = require('../src/services/items');

async function testAdminItemFiltering() {
  const documents = [
    {
      _id: 'item-1',
      user_id: 'user-1',
      item_type: 'lost',
      item_name: 'Blue wallet',
      description: 'Blue leather wallet',
      category: 'Accessories',
      location: 'Library',
      status: 'lost',
      created_at: '2026-05-10T10:00:00.000Z',
    },
    {
      _id: 'item-2',
      user_id: 'user-2',
      item_type: 'found',
      item_name: 'Red umbrella',
      description: 'Umbrella near cafeteria',
      category: 'Accessories',
      location: 'Cafeteria',
      status: 'returned',
      created_at: '2026-05-12T10:00:00.000Z',
    },
    {
      _id: 'item-3',
      user_id: 'user-3',
      item_type: 'found',
      item_name: 'Math notebook',
      description: 'Notebook left in class',
      category: 'Books',
      location: 'Classroom',
      status: 'stored',
      created_at: '2026-05-14T10:00:00.000Z',
    },
  ];
  const reporters = {
    'user-1': { full_name: 'Alex Reporter' },
    'user-2': { full_name: 'Sam Reporter' },
    'user-3': { full_name: 'Jamie Reporter' },
  };
  const service = createItemService({
    collection(name) {
      if (name === 'lost_items') return {
        find: () => ({
          sort: () => ({ toArray: async () => documents }),
        }),
      };
      if (name === 'users') return {
        findOne: async (filter) => reporters[filter._id] || null,
      };
      assert.equal(name, 'item_claims');
      return {};
    },
  }, {});

  const results = await service.findAdminItems({
    query: 'reporter',
    item_type: 'found',
    category: 'Accessories',
    status: 'returned',
    date_from: '2026-05-11',
    date_to: '2026-05-13',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'item-2');
  assert.equal(results[0].reported_by, 'Sam Reporter');
  const all = await service.findAdminItems();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((item) => item.id), ['item-1', 'item-2', 'item-3']);
}

async function testAdminItemUpdate() {
  const original = {
    _id: 'item-1',
    user_id: 'reporter-1',
    item_type: 'found',
    item_name: 'Old name',
    description: 'Old description',
    identifying_details: 'Private detail',
    category: 'Accessories',
    location: 'Old location',
    date_lost: '2026-05-10',
    status: 'stored',
    claimed_by: 'claimant-1',
    claimed_claim_id: 'claim-1',
    claimed_at: '2026-05-11T10:00:00.000Z',
    physical_verification_status: 'verified',
    physical_verified_by: 'staff-1',
    physical_verified_at: '2026-05-11T11:00:00.000Z',
    updated_at: '2026-05-11T12:00:00.000Z',
    created_at: '2026-05-10T10:00:00.000Z',
  };
  const documents = [{ ...original }];
  const notifications = [];
  const itemCollection = {
    findOne: async (filter) => documents.find((document) => document._id === filter._id) || null,
    updateOne: async (filter, update) => {
      const document = documents.find((candidate) => candidate._id === filter._id
        && candidate.updated_at === filter.updated_at);
      if (!document) return { matchedCount: 0 };
      Object.assign(document, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete document[key];
      return { matchedCount: 1 };
    },
  };
  const service = createItemService({
    collection(name) {
      if (name === 'lost_items') return itemCollection;
      if (name === 'users') return { findOne: async () => null };
      assert.equal(name, 'item_claims');
      return {};
    },
  }, {
    create: async (userId, notification) => notifications.push({ userId, notification }),
  });

  const updated = await service.updateAdminItem('item-1', {
    item_name: 'Corrected name',
    description: 'Corrected description',
    identifying_details: 'Corrected private detail',
    category: 'Books',
    location: 'New location',
    date_lost: '2026-05-12',
    item_type: 'lost',
    status: 'returned',
    user_id: 'attacker',
  });
  assert.equal(updated.item_name, 'Corrected name');
  assert.equal(updated.item_type, 'found');
  assert.equal(updated.status, 'stored');
  assert.equal(updated.user_id, 'reporter-1');
  assert.equal(updated.claimed_by, 'claimant-1');
  assert.equal(updated.claimed_claim_id, 'claim-1');
  assert.equal(updated.claimed_at, original.claimed_at);
  assert.equal(updated.physical_verification_status, 'pending');
  assert.equal('physical_verified_by' in updated, false);
  assert.notEqual(updated.updated_at, original.updated_at);
  assert.deepEqual(notifications, [{
    userId: 'reporter-1',
    notification: {
      type: 'report',
      title: 'Item report updated by an administrator',
      message: 'An administrator corrected the details for "Corrected name".',
      href: '/index.php?page=reports&highlight=item-item-1',
    },
  }]);

  await assert.rejects(
    service.updateAdminItem('item-1', { item_name: '', description: 'x' }),
    { status: 400, message: 'All item details are required.' },
  );
  await assert.rejects(service.updateAdminItem('missing', {}), {
    status: 404,
    message: 'Item record was not found.',
  });
}

async function testAdminItemsRoute() {
  const captured = [];
  const app = express();
  app.use((req, _res, next) => {
    req.session = { user: { id: 'admin-1', role_name: 'admin' } };
    next();
  });
  app.use((req, res, next) => {
    res.render = (view, locals) => res.json({ view, locals });
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
    },
    email: {},
    items: {
      findAdminItems: async (filters) => {
        captured.push(filters);
        return [];
      },
    },
    notifications: {},
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(error.status || 500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const response = await fetch(
      `http://127.0.0.1:${port}/index.php?page=admin-items&query=bag&item_type=found&status=stored&category=${encodeURIComponent(categories[0])}`,
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.view, 'admin-items');
    assert.equal(page.locals.title, 'All Items');
    assert.equal(page.locals.active, 'admin-items');
    assert.deepEqual(captured[0], {
      query: 'bag',
      item_type: 'found',
      status: 'stored',
      category: categories[0],
      date_from: '',
      date_to: '',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testAdminEditItemRoute() {
  const updates = [];
  const editItem = {
    id: 'item-1',
    item_type: 'found',
    item_name: 'Wallet',
    description: 'Blue wallet',
    identifying_details: 'Initials inside',
    category: categories[0],
    location: 'Library',
    date_lost: '2026-05-12',
    status: 'stored',
    reported_by: 'Alex Reporter',
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = { user: { id: 'admin-1', role_name: req.headers['x-user-role'] || 'admin' } };
    next();
  });
  app.use((req, res, next) => {
    res.render = (view, locals) => res.json({ view, locals });
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
    },
    email: {},
    items: {
      findAdminItem: async (id) => {
        assert.equal(id, 'item-1');
        return editItem;
      },
      updateAdminItem: async (id, input) => {
        if (!input.item_name) {
          const error = new Error('All item details are required.');
          error.status = 400;
          throw error;
        }
        updates.push({ id, input });
      },
    },
    notifications: {},
  };
  app.use(pages);
  app.use((error, _req, res, _next) => res.status(error.status || 500).send(error.message));

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const pageResponse = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-edit-item&id=item-1`);
    const page = await pageResponse.json();
    assert.equal(page.view, 'admin-edit-item');
    assert.equal(page.locals.active, 'admin-items');
    assert.equal(page.locals.editItem.id, 'item-1');
    assert.ok(page.locals.today);

    const forbidden = await fetch(
      `http://127.0.0.1:${port}/index.php?page=admin-edit-item&id=item-1`,
      { headers: { 'x-user-role': 'user' } },
    );
    assert.equal(forbidden.status, 403);

    const invalid = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-edit-item&id=item-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ description: 'Missing item name' }),
    });
    assert.equal(invalid.status, 400);
    const invalidPage = await invalid.json();
    assert.equal(invalidPage.view, 'admin-edit-item');
    assert.equal(invalidPage.locals.error, 'All item details are required.');

    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-edit-item&id=item-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ item_name: 'Corrected name' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/index.php?page=admin-edit-item&id=item-1&saved=1');
    assert.deepEqual(updates, [{ id: 'item-1', input: { item_name: 'Corrected name' } }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testAdminItemFiltering();
  await testAdminItemUpdate();
  await testAdminItemsRoute();
  await testAdminEditItemRoute();
  console.log('Admin all-items checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
