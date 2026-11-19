const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createItemService } = require('../../src/services/items');

function createItemServiceWithRecords(records) {
  const database = {
    collection(name) {
      if (name === 'lost_items') {
        return {
          find(filter = {}) {
            const statusClause = filter.$and?.find((clause) => clause.status?.$in);
            const matchingRecords = records.filter((record) => (
              !record.deleted_at && (!statusClause || statusClause.status.$in.includes(record.status))
            ));
            return {
              sort() {
                return this;
              },
              async toArray() {
                return matchingRecords;
              },
            };
          },
        };
      }
      if (name === 'users') {
        return {
          async findOne({ _id }) {
            return { _id, full_name: 'Item Reporter' };
          },
        };
      }
      if (name === 'item_claims') return { async findOne() { return null; } };
      return {};
    },
  };
  return createItemService(database, {});
}

function createResolvableItemService(record) {
  const notifications = [];
  const itemCollection = {
    async updateOne(filter, update) {
      const matches = filter._id === record._id
        && filter.user_id === record.user_id
        && filter.item_type === record.item_type
        && filter.status === record.status
        && record.status === 'lost'
        && !record.deleted_at;
      if (matches) Object.assign(record, update.$set);
      return { matchedCount: matches ? 1 : 0 };
    },
    async findOne(filter) {
      return filter._id === record._id && filter.user_id === record.user_id && !record.deleted_at
        ? record : null;
    },
  };
  const database = {
    collection(name) {
      return name === 'lost_items' ? itemCollection : {};
    },
  };
  const service = createItemService(database, {
    async create(userId, notification) {
      notifications.push({ userId, ...notification });
    },
  });
  return { service, notifications };
}

test('admin item location filter returns only records at the selected location', async () => {
  const items = createItemServiceWithRecords([
    {
      _id: 'gymnasium-item',
      user_id: 'reporter-1',
      item_name: 'Water bottle',
      description: 'Blue bottle',
      category: 'Personal Items',
      location: 'Gymnasium',
      item_type: 'lost',
      status: 'lost',
      created_at: '2026-11-18T00:00:00.000Z',
    },
    {
      _id: 'library-item',
      user_id: 'reporter-1',
      item_name: 'Notebook',
      description: 'Black notebook',
      category: 'Books & School Supplies',
      location: 'Library',
      item_type: 'found',
      status: 'stored',
      created_at: '2026-11-18T00:00:00.000Z',
    },
  ]);

  const matches = await items.findAdminItems({ location: 'Gymnasium' });
  assert.deepEqual(matches.map((item) => item.id), ['gymnasium-item']);
  assert.deepEqual(await items.findAdminItems({ location: 'Old CAS Building' }), []);
});

test('users can resolve only their own active lost reports', async () => {
  const report = {
    _id: 'lost-report',
    user_id: 'report-owner',
    item_type: 'lost',
    status: 'lost',
    item_name: 'Wallet',
  };
  const { service, notifications } = createResolvableItemService(report);

  await service.resolve('report-owner', report._id);

  assert.equal(report.status, 'resolved');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].userId, 'report-owner');
  assert.equal(notifications[0].title, 'Lost report resolved');
});

test('resolving another user’s report or a found-item report is rejected', async () => {
  const report = {
    _id: 'lost-report',
    user_id: 'report-owner',
    item_type: 'lost',
    status: 'lost',
    item_name: 'Wallet',
  };
  const { service } = createResolvableItemService(report);

  await assert.rejects(service.resolve('another-user', report._id), /Only your active lost report/);
  assert.equal(report.status, 'lost');

  report.item_type = 'found';
  report.status = 'found';
  await assert.rejects(service.resolve('report-owner', report._id), /Only your active lost report/);
  assert.equal(report.status, 'found');
});

test('resolved lost reports are excluded from browse results', async () => {
  const items = createItemServiceWithRecords([
    {
      _id: 'active-lost-report',
      user_id: 'report-owner',
      item_name: 'Wallet',
      description: 'Brown leather wallet',
      category: 'Personal Items',
      location: 'Library',
      item_type: 'lost',
      status: 'lost',
      created_at: '2026-11-18T00:00:00.000Z',
    },
    {
      _id: 'resolved-lost-report',
      user_id: 'report-owner',
      item_name: 'Keys',
      description: 'Set of keys',
      category: 'Personal Items',
      location: 'Library',
      item_type: 'lost',
      status: 'resolved',
      created_at: '2026-11-18T00:00:00.000Z',
    },
  ]);

  const results = await items.search({});
  assert.deepEqual(results.map((item) => item.id), ['active-lost-report']);
});
