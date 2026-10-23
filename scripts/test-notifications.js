const assert = require('node:assert/strict');
const { createNotificationService } = require('../src/services/notifications');

function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) => document[key] === value);
}

async function run() {
  const records = [];
  const collection = {
    insertOne: async (document) => records.push(document),
    find: (filter) => ({
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      toArray: async () => records.filter((record) => matches(record, filter)),
    }),
    countDocuments: async (filter) => records.filter((record) => matches(record, filter)).length,
    updateOne: async (filter, update) => {
      const record = records.find((candidate) => matches(candidate, filter));
      if (record) Object.assign(record, update.$set);
    },
    updateMany: async (filter, update) => {
      records.filter((record) => matches(record, filter)).forEach((record) => Object.assign(record, update.$set));
    },
  };
  const service = createNotificationService({ collection: () => collection });

  const first = await service.create('user-1', {
    type: 'report',
    title: 'Report submitted',
    message: 'Your report is active.',
    href: '/index.php?page=reports',
  });
  await service.create('user-2', {
    type: 'claim',
    title: 'Claim submitted',
    message: 'Your claim is pending.',
    href: '/index.php?page=claims',
  });

  assert.equal(await service.countUnread('user-1'), 1);
  assert.equal((await service.findForUser('user-1')).length, 1);
  await service.markRead('user-1', first.id);
  assert.equal(await service.countUnread('user-1'), 0);
  assert.ok((await service.findForUser('user-1'))[0].read_at);

  await service.create('user-1', {
    type: 'status',
    title: 'Report status changed',
    message: 'Your report was cancelled.',
    href: '/index.php?page=reports',
  });
  await service.markAllRead('user-1');
  assert.equal(await service.countUnread('user-1'), 0);
  assert.equal((await service.findForUser('user-2')).length, 1);
  console.log('Notification service checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
