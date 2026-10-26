const assert = require('node:assert/strict');
const { createItemService } = require('../src/services/items');

function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(document, clause));
    if (key === '$and') return value.every((clause) => matches(document, clause));
    if (value && Array.isArray(value.$in)) return value.$in.includes(document[key]);
    if (value && Object.hasOwn(value, '$ne')) return document[key] !== value.$ne;
    return document[key] === value;
  });
}

function createCollection(documents) {
  return {
    async insertOne(document) {
      documents.push({ ...document });
    },
    find(filter) {
      return {
        sort() {
          return this;
        },
        toArray: async () => documents.filter((document) => matches(document, filter)),
      };
    },
    async findOne(filter) {
      return documents.find((document) => matches(document, filter)) || null;
    },
    async countDocuments(filter) {
      return documents.filter((document) => matches(document, filter)).length;
    },
    async updateOne(filter, update) {
      const document = documents.find((candidate) => matches(candidate, filter));
      if (!document) return { matchedCount: 0 };
      Object.assign(document, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete document[key];
      return { matchedCount: 1 };
    },
    async updateMany(filter, update) {
      const matched = documents.filter((document) => matches(document, filter));
      for (const document of matched) Object.assign(document, update.$set || {});
      return { matchedCount: matched.length };
    },
    async deleteOne(filter) {
      const index = documents.findIndex((document) => matches(document, filter));
      if (index < 0) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

async function run() {
  const users = [
    { _id: 'reporter-1', full_name: 'Reporter', email: 'reporter@example.test', student_id: 'S-1' },
    { _id: 'claimant-1', full_name: 'Claimant', email: 'claimant@example.test', student_id: 'S-2', department: 'Engineering' },
    { _id: 'claimant-2', full_name: 'Second Claimant', email: 'second@example.test', student_id: 'S-3' },
    { _id: 'staff-1', full_name: 'Staff Member', role_name: 'staff', status: 'active' },
  ];
  const itemDocuments = [];
  const claimDocuments = [];
  const notifications = [];
  const collections = {
    lost_items: createCollection(itemDocuments),
    item_claims: createCollection(claimDocuments),
    users: createCollection(users),
  };
  const service = createItemService(
    { collection: (name) => collections[name] },
    { create: async (userId, notification) => notifications.push({ userId, ...notification }) },
  );

  const item = await service.create('reporter-1', {
    item_type: 'found',
    item_name: 'Blue wallet',
    description: 'Blue leather wallet.',
    identifying_details: 'Contains a library card.',
    category: 'Accessories',
    location: 'Library',
    date_lost: '2026-10-14',
  }, 'a1b2c3d4-e5f6-4789-a123-456789abcdef.png');
  assert.equal(item.physical_verification_status, 'pending');
  assert.equal(item.image_path, 'a1b2c3d4-e5f6-4789-a123-456789abcdef.png');
  assert.equal(notifications.at(-1).href, `/index.php?page=reports&highlight=item-${item.id}`);
  assert.equal((await service.findStaffItems('found')).length, 1);
  assert.equal((await service.findStaffItems('found'))[0].image_path, 'a1b2c3d4-e5f6-4789-a123-456789abcdef.png');
  assert.equal((await service.findStaffItem(item.id)).image_path, 'a1b2c3d4-e5f6-4789-a123-456789abcdef.png');
  assert.equal('image_path' in (await service.findForUser('reporter-1'))[0], false);
  assert.equal('image_path' in (await service.findPublic(item.id, 'claimant-1')), false);
  assert.equal('image_path' in (await service.findOne('reporter-1', item.id)), false);
  assert.equal('image_path' in (await service.search({}, 'claimant-1'))[0], false);
  await assert.rejects(service.findAvailable(item.id, 'claimant-1'), /not yet stored/);
  await assert.rejects(
    service.createClaim('claimant-1', { item_id: item.id, claim_details: 'Trying before storage.' }),
    /no longer available for claims/,
  );
  assert.equal(claimDocuments.length, 0);
  const reviewedItem = await service.findStaffItem(item.id);
  assert.equal(reviewedItem.identifying_details, 'Contains a library card.');
  assert.equal(reviewedItem.reporter_email, 'reporter@example.test');

  await service.verifyFoundItem(item.id, 'staff-1');
  assert.equal(itemDocuments[0].physical_verification_status, 'verified');
  assert.equal(itemDocuments[0].physical_verified_by, 'staff-1');
  assert.equal(notifications.some((notification) => notification.userId === 'reporter-1'
    && notification.title === 'Found item verified'), true);
  await service.updateItemStatus(item.id, 'staff-1', 'stored');
  assert.equal(itemDocuments[0].status, 'stored');
  assert.equal((await service.findStaffItems('found'))[0].status, 'stored');
  const storedItems = await service.findStaffItems('stored');
  assert.equal(storedItems.length, 1);
  assert.equal(storedItems[0].id, item.id);
  assert.equal((await service.findAvailable(item.id, 'claimant-1')).status, 'stored');
  assert.equal('image_path' in (await service.findAvailable(item.id, 'claimant-1')), false);
  assert.deepEqual(await service.findStaffItems('lost'), []);
  const storedSearch = await service.search({ status: 'stored' });
  assert.equal(storedSearch.length, 1);
  assert.equal(storedSearch[0].status, 'stored');
  assert.equal(notifications.some((notification) => notification.userId === 'reporter-1'
    && notification.title === 'Item status updated'
    && notification.message.includes('stored')), true);
  await service.updateItemStatus(item.id, 'staff-1', 'found');
  assert.equal(itemDocuments[0].status, 'found');
  await assert.rejects(service.findAvailable(item.id, 'claimant-1'), /not yet stored/);
  await assert.rejects(service.updateItemStatus(item.id, 'staff-1', 'returned'), /valid status/);

  await service.update('reporter-1', item.id, {
    item_name: 'Blue wallet',
    description: 'Updated description.',
    identifying_details: 'Contains a library card.',
    category: 'Accessories',
    location: 'Library',
    date_lost: '2026-10-14',
  });
  assert.equal(itemDocuments[0].physical_verification_status, 'pending');
  assert.equal('physical_verified_by' in itemDocuments[0], false);
  await service.updateItemStatus(item.id, 'staff-1', 'stored');

  await service.createClaim('claimant-1', { item_id: item.id, claim_details: 'My initials are inside.' });
  await service.createClaim('claimant-2', { item_id: item.id, claim_details: 'It has my keychain.' });
  const searchedClaims = await service.findStaffRecords({
    record_type: 'claims',
    item_type: 'found',
    status: 'pending',
    query: 'keychain',
  });
  assert.equal(searchedClaims.items.length, 0);
  assert.equal(searchedClaims.claims.length, 1);
  assert.equal(searchedClaims.claims[0].claimant.full_name, 'Second Claimant');
  assert.equal((await service.findStaffRecords({ status: 'stored', record_type: 'items' })).items.length, 1);
  assert.equal(notifications.filter((notification) => notification.userId === 'staff-1'
    && notification.title === 'Ownership claim needs review').length, 2);
  const claims = await service.findStaffClaims();
  assert.equal(claims.length, 2);
  assert.equal(claims[0].claimant.student_id, 'S-2');
  assert.equal(claims[0].item.reported_by, 'Reporter');
  assert.equal(claims[0].item.identifying_details, 'Contains a library card.');
  await service.reviewClaim(claims[0].id, 'staff-1', 'approved');
  assert.equal(claimDocuments.find((claim) => claim.id === claims[0].id || claim._id === claims[0].id).status, 'approved');
  assert.equal(itemDocuments[0].status, 'claimed');
  assert.equal(itemDocuments[0].claimed_by, 'claimant-1');
  assert.equal((await service.findStaffItems('found')).length, 0);
  assert.equal((await service.findForUser('reporter-1'))[0].status, 'claimed');
  const claimedPublicItem = await service.findPublic(item.id, 'claimant-1');
  assert.equal(claimedPublicItem.status, 'claimed');
  assert.equal(claimedPublicItem.user_claim_status, 'approved');
  assert.equal('identifying_details' in claimedPublicItem, false);
  assert.equal(claimDocuments.find((claim) => claim.user_id === 'claimant-2').status, 'rejected');
  assert.equal((await service.findPublic(item.id, 'claimant-2')).user_claim_status, 'rejected');
  assert.equal(notifications.some((notification) => notification.userId === 'claimant-1'
    && notification.title === 'Claim approved'
    && notification.message.includes('Please collect your item from Lost and Found staff.')
    && notification.message.includes('mark it as returned after you receive it')
    && notification.href === `/index.php?page=claims&highlight=claim-${claims[0].id}`), true);
  assert.equal(notifications.some((notification) => notification.userId === 'staff-1'
    && notification.title === 'Ownership claim needs review'
    && notification.href === `/index.php?page=staff-claim&id=${claims[0].id}&highlight=claim-${claims[0].id}`), true);
  assert.equal(notifications.some((notification) => notification.userId === 'reporter-1'
    && notification.title === 'Found item claimed'), true);
  assert.equal(notifications.some((notification) => notification.userId === 'claimant-2'
    && notification.title === 'Claim rejected'), true);
  assert.equal(notifications.some((notification) => notification.userId === 'claimant-1'
    && notification.title === 'Claim submitted'), true);
  assert.equal(notifications.some((notification) => notification.userId === 'reporter-1'
    && notification.title === 'New claim received'), true);
  await service.markItemReturned(claims[0].id, 'staff-1');
  assert.equal(itemDocuments[0].status, 'returned');
  assert.equal(itemDocuments[0].returned_by, 'staff-1');
  const returnedItems = await service.findStaffReturnedItems();
  assert.equal(returnedItems.length, 1);
  assert.equal(returnedItems[0].id, item.id);
  assert.equal(returnedItems[0].claimant.full_name, 'Claimant');
  assert.equal((await service.findStaffReturnedItems({ query: 'claimant' })).length, 1);
  assert.equal((await service.findStaffReturnedItems({ query: 'no match' })).length, 0);
  assert.equal((await service.findStaffReturnedItems({ category: 'Accessories' })).length, 1);
  assert.equal((await service.findStaffReturnedItems({ category: 'Documents & IDs' })).length, 0);
  const returnDate = new Date().toISOString().slice(0, 10);
  const nextDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  assert.equal((await service.findStaffReturnedItems({ date_from: nextDate })).length, 0);
  assert.equal((await service.findStaffReturnedItems({ date_from: returnDate, date_to: returnDate })).length, 1);
  assert.equal((await service.findClaimsForUser('claimant-1'))[0].item_status, 'returned');
  assert.equal((await service.findPublic(item.id, 'claimant-1')).status, 'returned');
  const staffRecords = await service.findStaffRecords();
  assert.equal(staffRecords.items.find((record) => record.id === item.id).status, 'returned');
  assert.equal(staffRecords.claims.find((claim) => claim.id === claims[0].id).item.status, 'returned');
  assert.equal(notifications.some((notification) => notification.userId === 'claimant-1'
    && notification.title === 'Item returned'), true);
  assert.equal(notifications.some((notification) => notification.userId === 'reporter-1'
    && notification.title === 'Item return recorded'), true);
  await assert.rejects(service.markItemReturned(claims[0].id, 'staff-1'), /awaiting return/);
  itemDocuments[0].status = 'found';
  assert.equal((await service.search({}, 'claimant-2')).length, 0);
  assert.equal((await service.findForUser('reporter-1'))[0].status, 'claimed');
  assert.equal((await service.findPublic(item.id, 'claimant-1')).status, 'claimed');
  itemDocuments[0].status = 'stored';
  await assert.rejects(service.findAvailable(item.id, 'claimant-2'), /already been claimed/);
  await assert.rejects(
    service.createClaim('claimant-2', { item_id: item.id, claim_details: 'Trying after approval.' }),
    /already been claimed/,
  );
  assert.equal(claimDocuments.length, 2);
  await assert.rejects(service.findAvailable(item.id, 'claimant-2'), /already been claimed/);
  await assert.rejects(service.reviewClaim(claims[0].id, 'staff-1', 'rejected'), /Only pending claims/);

  claimDocuments.push({
    _id: 'orphan-claim',
    item_id: 'deleted-item',
    user_id: 'claimant-1',
    status: 'pending',
    claim_details: 'Claim linked to an item that no longer exists.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (warning) => warnings.push(warning);
  try {
    const recordsWithOrphan = await service.findStaffRecords();
    const claimsWithOrphan = await service.findStaffClaims();
    assert.equal(recordsWithOrphan.claims.some((claim) => claim.id === 'orphan-claim'), false);
    assert.equal(claimsWithOrphan.some((claim) => claim.id === 'orphan-claim'), false);
    assert.equal(warnings.some((warning) => warning.includes('orphan-claim')
      && warning.includes('deleted-item')), true);
  } finally {
    console.warn = originalWarn;
  }
  console.log('Staff item verification and claim-review service checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
