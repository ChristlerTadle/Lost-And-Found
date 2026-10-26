const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const pages = require('../src/routes/pages');
const { createItemService } = require('../src/services/items');

async function testAdminClaimFiltering() {
  const claimDocuments = [
    { _id: 'claim-1', item_id: 'item-1', user_id: 'user-1', status: 'pending', claim_details: 'Blue initials on the tag', created_at: '2026-10-20T10:00:00.000Z' },
    { _id: 'claim-2', item_id: 'item-2', user_id: 'user-2', status: 'approved', claim_details: 'Has my name inside', created_at: '2026-10-21T10:00:00.000Z' },
    { _id: 'claim-3', item_id: 'missing-item', user_id: 'user-1', status: 'rejected', claim_details: 'Orphan claim', created_at: '2026-10-22T10:00:00.000Z' },
  ];
  const itemDocuments = {
    'item-1': { _id: 'item-1', user_id: 'reporter-1', item_name: 'Blue backpack', category: 'Bags & Luggage', location: 'Library', date_lost: '2026-10-19', status: 'stored', item_type: 'found' },
    'item-2': { _id: 'item-2', user_id: 'reporter-2', item_name: 'Math notebook', category: 'Books & School Supplies', location: 'Room 101', date_lost: '2026-10-18', status: 'returned', item_type: 'found' },
  };
  const userDocuments = {
    'user-1': { _id: 'user-1', full_name: 'Alex Claimant', email: 'alex@example.test' },
    'user-2': { _id: 'user-2', full_name: 'Sam Claimant', email: 'sam@example.test' },
    'reporter-1': { _id: 'reporter-1', full_name: 'Reporter One' },
    'reporter-2': { _id: 'reporter-2', full_name: 'Reporter Two' },
  };
  const service = createItemService({
    collection(name) {
      if (name === 'item_claims') return {
        find: () => ({ sort: () => ({ toArray: async () => claimDocuments }) }),
      };
      if (name === 'lost_items') return {
        findOne: async (filter) => itemDocuments[filter._id] || null,
      };
      if (name === 'users') return {
        findOne: async (filter) => userDocuments[filter._id] || null,
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  }, {});

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (warning) => warnings.push(warning);
  try {
    const allClaims = await service.findAdminClaims();
    assert.equal(allClaims.length, 2);
    assert.equal(allClaims[0].id, 'claim-1');
    assert.equal(allClaims[0].claimant.full_name, 'Alex Claimant');
    assert.equal(allClaims[0].item.reported_by, 'Reporter One');
    assert.equal(allClaims.some((claim) => claim.id === 'claim-3'), false);
    assert.equal(warnings.some((warning) => warning.includes('claim-3')), true);

    const filtered = await service.findAdminClaims({ query: 'alex', status: 'pending' });
    assert.deepEqual(filtered.map((claim) => claim.id), ['claim-1']);
    assert.deepEqual(await service.findAdminClaims({ status: 'approved' }).then((claims) => claims.map((claim) => claim.id)), ['claim-2']);
    assert.deepEqual(await service.findAdminClaims({ query: 'no match' }), []);
  } finally {
    console.warn = originalWarn;
  }
}

async function testAdminClaimsRouteAndTemplate() {
  const captured = [];
  const app = express();
  app.use((req, _res, next) => {
    req.session = { user: { id: 'admin-1', role_name: 'admin' } };
    next();
  });
  app.use((req, res, next) => {
    res.render = (view, locals) => res.json({
      view,
      title: locals.title,
      active: locals.active,
      claims: locals.claims,
      filters: locals.filters,
    });
    next();
  });
  const claim = {
    id: 'claim-1',
    item_name: 'Blue backpack',
    status: 'pending',
    claim_details: 'Blue initials on the tag',
    created_at: '2026-10-20T10:00:00.000Z',
    claimant: { full_name: 'Alex Claimant', email: 'alex@example.test' },
    item: { category: 'Bags & Luggage', location: 'Library', reported_by: 'Reporter One' },
  };
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
      findAdminClaims: async (filters) => {
        captured.push(filters);
        return [claim];
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
    const response = await fetch(`http://127.0.0.1:${port}/index.php?page=admin-claims&query=Alex&status=pending`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.view, 'admin-claims');
    assert.equal(page.title, 'All Claims');
    assert.equal(page.active, 'admin-claims');
    assert.deepEqual(page.filters, { query: 'Alex', status: 'pending' });
    assert.deepEqual(captured, [{ query: 'Alex', status: 'pending' }]);

    const templatePath = path.resolve(__dirname, '..', 'views', 'admin-claims.ejs');
    const html = await ejs.renderFile(templatePath, {
      claims: [claim],
      filters: { query: '', status: '' },
      icon: () => '',
      formatDate: (value) => String(value).slice(0, 10),
    });
    assert.match(html, /All Claims/);
    assert.match(html, /Blue backpack/);
    assert.match(html, /Alex Claimant/);
    assert.match(html, /Blue initials on the tag/);
    assert.doesNotMatch(html, /name="action" value="review_claim"/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function run() {
  await testAdminClaimFiltering();
  await testAdminClaimsRouteAndTemplate();
  console.log('Admin all-claims checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
