const { randomUUID } = require('node:crypto');

const activeStatuses = ['lost', 'found'];
const activeFoundItemStatuses = ['found', 'stored'];
const claimableItemStatuses = ['stored'];
const browseableStatuses = [...activeStatuses, 'stored'];

function createItemService(database, notificationService) {
  const items = database.collection('lost_items');
  const claims = database.collection('item_claims');
  const users = database.collection('users');

  return {
    async create(userId, input, imagePath = null) {
      const data = validateReport(input);
      const now = new Date().toISOString();
      const document = {
        _id: randomUUID(),
        user_id: userId,
        ...data,
        image_path: imagePath,
        status: data.item_type,
        ...(data.item_type === 'found' ? { physical_verification_status: 'pending' } : {}),
        created_at: now,
        updated_at: now,
      };
      await items.insertOne(document);
      await notificationService.create(userId, {
        type: 'report',
        title: 'Report submitted',
        message: `Your ${data.item_type} item report for "${data.item_name}" is now active.`,
        href: `/index.php?page=reports&highlight=item-${document._id}`,
      });
      return normalizeItem(document);
    },

    async findForUser(userId) {
      const documents = await items.find({ user_id: userId }).sort({ created_at: -1 }).toArray();
      return Promise.all(documents.map(async (document) => {
        const item = normalizeItem(document);
        if (item.item_type === 'found' && item.status === 'found' && await this.hasApprovedClaim(item.id)) {
          item.status = 'claimed';
        }
        if (item.item_type === 'found') delete item.image_path;
        return item;
      }));
    },

    async hasApprovedClaim(itemId) {
      return Boolean(await claims.findOne(
        { item_id: itemId, status: 'approved' },
        { projection: { _id: 1 } },
      ));
    },

    async findStaffItems(itemType) {
      if (!['lost', 'found', 'stored'].includes(itemType)) throw new Error('Choose lost, found, or stored items.');
      const filter = itemType === 'stored'
        ? { item_type: 'found', status: 'stored' }
        : {
          item_type: itemType,
          status: itemType === 'found' ? { $in: ['found', 'stored'] } : { $in: ['lost', 'found'] },
        };
      const documents = await items.find(filter).sort({ created_at: -1 }).toArray();
      return Promise.all(documents.map(async (document) => {
        const item = normalizeItem(document);
        const reporter = await users.findOne({ _id: item.user_id }, {
          projection: { full_name: 1, email: 1, student_id: 1, employee_id: 1 },
        });
        item.reported_by = reporter?.full_name || 'Unknown';
        return item;
      }));
    },

    async findAdminItems(filters = {}) {
      const documents = await items.find({}).sort({ created_at: -1 }).toArray();
      const records = await Promise.all(documents.map(async (document) => {
        const item = normalizeItem(document);
        const reporter = await users.findOne({ _id: item.user_id }, {
          projection: { full_name: 1 },
        });
        item.reported_by = reporter?.full_name || 'Unknown';
        return item;
      }));
      const query = String(filters.query || '').trim().toLocaleLowerCase();
      const itemType = ['lost', 'found'].includes(filters.item_type) ? filters.item_type : '';
      const status = String(filters.status || '');
      const category = String(filters.category || '');
      const dateFrom = isDate(String(filters.date_from || '')) ? String(filters.date_from) : '';
      const dateTo = isDate(String(filters.date_to || '')) ? String(filters.date_to) : '';
      return records.filter((item) => {
        const recordDate = String(item.created_at || '').slice(0, 10);
        const matchesQuery = !query || [
          item.item_name, item.description, item.category, item.location, item.reported_by,
        ].some((value) => String(value || '').toLocaleLowerCase().includes(query));
        return matchesQuery
          && (!itemType || item.item_type === itemType)
          && (!status || item.status === status)
          && (!category || item.category === category)
          && (!dateFrom || recordDate >= dateFrom)
          && (!dateTo || recordDate <= dateTo);
      });
    },

    async findInventoryReport() {
      const documents = await items.find({ item_type: 'found', status: 'stored' })
        .sort({ category: 1, item_name: 1 }).toArray();
      return Promise.all(documents.map(async (document) => {
        const item = normalizeItem(document);
        const reporter = await users.findOne({ _id: item.user_id }, {
          projection: { full_name: 1 },
        });
        item.reported_by = reporter?.full_name || 'Unknown';
        return item;
      }));
    },

    async findAdminClaims(filters = {}) {
      const documents = await claims.find({}).sort({ created_at: -1 }).toArray();
      const records = await this.enrichExistingStaffClaims(documents);
      const query = String(filters.query || '').trim().toLocaleLowerCase();
      const status = ['pending', 'approved', 'rejected'].includes(filters.status) ? filters.status : '';
      return records.filter((claim) => (
        (!status || claim.status === status)
        && (!query || [
          claim.item_name,
          claim.claimant?.full_name,
          claim.claimant?.email,
          claim.claim_details,
          claim.item.category,
          claim.item.location,
        ].some((value) => String(value || '').toLocaleLowerCase().includes(query)))
      ));
    },

    async getAdminDashboardSummary() {
      const [
        totalItems,
        lostItems,
        foundItems,
        pendingClaims,
        totalClaims,
        returnedItems,
        storedItems,
        lostActive,
        foundUnverified,
        foundVerified,
        claimedItems,
        categories,
        recentItems,
        recentClaims,
      ] = await Promise.all([
        items.countDocuments({}),
        items.countDocuments({ item_type: 'lost' }),
        items.countDocuments({ item_type: 'found' }),
        claims.countDocuments({ status: 'pending' }),
        claims.countDocuments({}),
        items.countDocuments({ item_type: 'found', status: 'returned' }),
        items.countDocuments({ item_type: 'found', status: 'stored' }),
        items.countDocuments({ item_type: 'lost', status: { $in: ['lost', 'found'] } }),
        items.countDocuments({
          item_type: 'found',
          status: { $in: ['found', 'stored'] },
          physical_verification_status: { $ne: 'verified' },
        }),
        items.countDocuments({
          item_type: 'found',
          status: { $in: ['found', 'stored'] },
          physical_verification_status: 'verified',
        }),
        items.countDocuments({ item_type: 'found', status: 'claimed' }),
        items.aggregate([
          { $group: { _id: '$category', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
        ]).toArray(),
        items.find({}, {
          projection: {
            item_type: 1, item_name: 1, status: 1, created_at: 1, updated_at: 1,
            physical_verification_status: 1, physical_verified_at: 1,
          },
        }).sort({ updated_at: -1, created_at: -1 }).limit(8).toArray(),
        claims.find({}, {
          projection: { item_id: 1, user_id: 1, status: 1, created_at: 1, updated_at: 1, reviewed_at: 1 },
        }).sort({ updated_at: -1, created_at: -1 }).limit(8).toArray(),
      ]);

      const activity = [];
      for (const document of recentItems) {
        const item = normalizeItem(document);
        const createdAt = item.created_at;
        activity.push({
          type: item.item_type,
          label: `${capitalize(item.item_type)} report submitted`,
          name: item.item_name,
          detail: 'Item report',
          date: createdAt,
        });
        if (item.physical_verified_at) {
          activity.push({
            type: 'found',
            label: 'Found item verified',
            name: item.item_name,
            detail: 'Physical verification',
            date: item.physical_verified_at,
          });
        } else if (item.updated_at && item.updated_at !== createdAt && item.status !== item.item_type) {
          activity.push({
            type: item.item_type,
            label: item.status === 'stored' ? 'Found item stored'
              : item.status === 'claimed' ? 'Found item claimed'
                : item.status === 'returned' ? 'Item returned'
                  : `${capitalize(item.item_type)} item updated`,
            name: item.item_name,
            detail: 'Item status',
            date: item.updated_at,
          });
        }
      }
      for (const claim of recentClaims) {
        const item = await items.findOne({ _id: claim.item_id }, { projection: { item_name: 1 } });
        activity.push({
          type: 'claim',
          label: claim.status === 'pending' ? 'Claim submitted' : `Claim ${claim.status}`,
          name: item?.item_name || 'Item record unavailable',
          detail: 'Ownership claim',
          date: claim.reviewed_at || claim.created_at,
        });
      }

      return {
        totalItems,
        lostItems,
        foundItems,
        pendingClaims,
        totalClaims,
        returnedItems,
        storedItems,
        statusCounts: {
          lostActive,
          foundUnverified,
          foundVerified,
          stored: storedItems,
          claimed: claimedItems,
          returned: returnedItems,
        },
        categoryCounts: categories.map(({ _id, count }) => ({ category: _id || 'Uncategorized', count })),
        activity: activity
          .filter((entry) => entry.date)
          .sort((left, right) => String(right.date).localeCompare(String(left.date)))
          .slice(0, 8),
      };
    },

    async findStaffRecords(filters = {}) {
      const [itemDocuments, claimDocuments] = await Promise.all([
        items.find({}).sort({ created_at: -1 }).toArray(),
        claims.find({}).sort({ created_at: -1 }).toArray(),
      ]);
      const itemRecords = await Promise.all(itemDocuments.map(async (document) => {
        const item = normalizeItem(document);
        const reporter = await users.findOne({ _id: item.user_id }, {
          projection: { full_name: 1 },
        });
        item.reported_by = reporter?.full_name || 'Unknown';
        return item;
      }));
      const claimRecords = await this.enrichExistingStaffClaims(claimDocuments);
      const query = String(filters.query || '').trim().toLocaleLowerCase();
      const recordType = ['items', 'claims'].includes(filters.record_type) ? filters.record_type : 'all';
      const itemType = ['lost', 'found'].includes(filters.item_type) ? filters.item_type : '';
      const status = String(filters.status || '');
      const category = String(filters.category || '');
      const dateFrom = isDate(String(filters.date_from || '')) ? String(filters.date_from) : '';
      const dateTo = isDate(String(filters.date_to || '')) ? String(filters.date_to) : '';
      const matchesDate = (date) => {
        const recordDate = String(date || '').slice(0, 10);
        return (!dateFrom || recordDate >= dateFrom) && (!dateTo || recordDate <= dateTo);
      };
      const matchesQuery = (...values) => !query
        || values.some((value) => String(value || '').toLocaleLowerCase().includes(query));
      const filteredItems = recordType === 'claims' ? [] : itemRecords.filter((item) => (
        (!itemType || item.item_type === itemType)
        && (!status || item.status === status)
        && (!category || item.category === category)
        && matchesDate(item.created_at)
        && matchesQuery(item.item_name, item.description, item.category, item.location, item.reported_by)
      ));
      const filteredClaims = recordType === 'items' ? [] : claimRecords.filter((claim) => (
        (!itemType || claim.item.item_type === itemType)
        && (!status || claim.status === status)
        && (!category || claim.item.category === category)
        && matchesDate(claim.created_at)
        && matchesQuery(
          claim.item_name, claim.claim_details, claim.claimant?.full_name,
          claim.claimant?.email, claim.item.category, claim.item.location, claim.item.reported_by,
        )
      ));
      return { items: filteredItems, claims: filteredClaims };
    },

    async findStaffReturnedItems(filters = {}) {
      const documents = await items.find({ item_type: 'found', status: 'returned' })
        .sort({ returned_at: -1, updated_at: -1 }).toArray();
      const query = String(filters.query || '').trim().toLocaleLowerCase();
      const category = String(filters.category || '');
      const dateFrom = isDate(String(filters.date_from || '')) ? String(filters.date_from) : '';
      const dateTo = isDate(String(filters.date_to || '')) ? String(filters.date_to) : '';
      const records = await Promise.all(documents.map(async (document) => {
        const item = normalizeItem(document);
        const [reporter, claimant] = await Promise.all([
          users.findOne({ _id: item.user_id }, { projection: { full_name: 1 } }),
          item.claimed_by
            ? users.findOne({ _id: item.claimed_by }, { projection: { full_name: 1, email: 1 } })
            : null,
        ]);
        item.reported_by = reporter?.full_name || 'Unknown';
        item.claimant = claimant ? documentToRecord(claimant) : null;
        return item;
      }));
      return records.filter((item) => {
        const returnedDate = String(item.returned_at || item.updated_at || '').slice(0, 10);
        const matchesQuery = !query || [
          item.item_name, item.category, item.location, item.reported_by,
          item.claimant?.full_name, item.claimant?.email,
        ].some((value) => String(value || '').toLocaleLowerCase().includes(query));
        return matchesQuery
          && (!category || item.category === category)
          && (!dateFrom || returnedDate >= dateFrom)
          && (!dateTo || returnedDate <= dateTo);
      });
    },

    async findStaffItem(itemId) {
      const document = await items.findOne({ _id: itemId });
      if (!document) throw new Error('Item record was not found.');
      const item = normalizeItem(document);
      const reporter = await users.findOne({ _id: item.user_id }, {
        projection: { full_name: 1, email: 1, student_id: 1, employee_id: 1 },
      });
      item.reported_by = reporter?.full_name || 'Unknown';
      item.reporter_email = reporter?.email || '';
      item.reporter_student_id = reporter?.student_id || '';
      item.reporter_employee_id = reporter?.employee_id || '';
      return item;
    },

    async findAdminItem(itemId) {
      const document = await items.findOne({ _id: String(itemId) });
      if (!document) {
        const error = new Error('Item record was not found.');
        error.status = 404;
        throw error;
      }
      const item = normalizeItem(document);
      const reporter = await users.findOne({ _id: item.user_id }, {
        projection: { full_name: 1 },
      });
      item.reported_by = reporter?.full_name || 'Unknown';
      return item;
    },

    async updateAdminItem(itemId, input) {
      const existing = await items.findOne({ _id: String(itemId) });
      if (!existing) {
        const error = new Error('Item record was not found.');
        error.status = 404;
        throw error;
      }

      let data;
      try {
        data = validateReport({ ...input, item_type: existing.item_type });
      } catch (error) {
        error.status = 400;
        throw error;
      }
      delete data.item_type;

      const now = new Date().toISOString();
      const update = {
        $set: {
          ...data,
          updated_at: now,
        },
      };
      if (existing.item_type === 'found' && existing.physical_verification_status === 'verified') {
        update.$set.physical_verification_status = 'pending';
        update.$unset = { physical_verified_by: '', physical_verified_at: '' };
      }
      const result = await items.updateOne(
        { _id: String(itemId), updated_at: existing.updated_at },
        update,
      );
      if (!result.matchedCount) {
        const error = new Error('The item changed before your update. Reload the record and try again.');
        error.status = 409;
        throw error;
      }

      await notificationService.create(String(existing.user_id), {
        type: 'report',
        title: 'Item report updated by an administrator',
        message: `An administrator corrected the details for "${data.item_name}".`,
        href: `/index.php?page=reports&highlight=item-${encodeURIComponent(String(itemId))}`,
      });
      return this.findAdminItem(itemId);
    },

    async updateItemStatus(itemId, staffId, status) {
      const document = await items.findOne({ _id: itemId });
      if (!document) throw new Error('Item record was not found.');
      const allowedStatuses = document.item_type === 'found'
        ? ['found', 'stored']
        : ['lost', 'found'];
      if (!allowedStatuses.includes(status)) throw new Error('Choose a valid status for this item.');
      if (!allowedStatuses.includes(document.status)) {
        throw new Error('Only active item records can have their status updated.');
      }
      const now = new Date().toISOString();
      const result = await items.updateOne(
        { _id: itemId, status: document.status },
        { $set: { status, status_updated_by: staffId, updated_at: now } },
      );
      if (!result.matchedCount) throw new Error('The item status changed before your update. Reload and try again.');
      await notificationService.create(String(document.user_id), {
        type: 'status',
        title: 'Item status updated',
        message: `The status of "${document.item_name}" was updated to ${status}.`,
        href: `/index.php?page=reports&highlight=item-${itemId}`,
      });
      return this.findStaffItem(itemId);
    },

    async verifyFoundItem(itemId, staffId) {
      const now = new Date().toISOString();
      const result = await items.updateOne(
        { _id: itemId, item_type: 'found', status: { $in: activeFoundItemStatuses } },
        { $set: {
          physical_verification_status: 'verified',
          physical_verified_by: staffId,
          physical_verified_at: now,
          updated_at: now,
        } },
      );
      if (!result.matchedCount) throw new Error('Active found item was not found.');
      const item = await items.findOne({ _id: itemId });
      if (!item) throw new Error('The verified found item record could not be loaded.');
      await notificationService.create(String(item.user_id), {
        type: 'status',
        title: 'Found item verified',
        message: `Staff physically verified your found item report for "${item.item_name}".`,
        href: `/index.php?page=reports&highlight=item-${itemId}`,
      });
      return this.findStaffItem(itemId);
    },

    async findStaffClaims() {
      const documents = await claims.find({}).sort({ created_at: -1 }).toArray();
      return this.enrichExistingStaffClaims(documents);
    },

    async findStaffClaim(claimId) {
      const document = await claims.findOne({ _id: claimId });
      if (!document) throw new Error('Claim was not found.');
      return this.enrichStaffClaim(document);
    },

    async reviewClaim(claimId, staffId, decision) {
      if (!['approved', 'rejected'].includes(decision)) throw new Error('Choose approve or reject for this claim.');
      const now = new Date().toISOString();
      const pendingClaim = await claims.findOne({ _id: claimId, status: 'pending' });
      if (!pendingClaim) throw new Error('Only pending claims can be reviewed.');
      let otherPendingClaims = [];
      let previousItemStatus = null;
      if (decision === 'approved') {
        if (await this.hasApprovedClaim(pendingClaim.item_id)) {
          throw new Error('This item already has an approved claim.');
        }
        const availableItem = await items.findOne({
          _id: pendingClaim.item_id,
          item_type: 'found',
          status: { $in: claimableItemStatuses },
        });
        if (!availableItem) throw new Error('This item is no longer available to approve another claim.');
        previousItemStatus = availableItem.status;
        const result = await items.updateOne(
          { _id: pendingClaim.item_id, item_type: 'found', status: availableItem.status },
          { $set: {
            status: 'claimed',
            claimed_by: pendingClaim.user_id,
            claimed_claim_id: pendingClaim._id,
            claimed_at: now,
            updated_at: now,
          } },
        );
        if (!result.matchedCount) throw new Error('This item is no longer available to approve another claim.');
      }
      const result = await claims.updateOne(
        { _id: claimId, status: 'pending' },
        { $set: { status: decision, reviewed_by: staffId, reviewed_at: now, updated_at: now } },
      );
      if (!result.matchedCount) {
        if (decision === 'approved') {
          await items.updateOne(
            { _id: pendingClaim.item_id, status: 'claimed', claimed_claim_id: pendingClaim._id },
            { $set: { status: previousItemStatus, updated_at: new Date().toISOString() },
              $unset: { claimed_by: '', claimed_claim_id: '', claimed_at: '' } },
          );
        }
        throw new Error('Only pending claims can be reviewed.');
      }
      if (decision === 'approved') {
        const otherClaims = await claims.find({
          item_id: pendingClaim.item_id,
          status: 'pending',
          _id: { $ne: pendingClaim._id },
        }).toArray();
        otherPendingClaims = otherClaims;
        await claims.updateMany(
          { item_id: pendingClaim.item_id, status: 'pending', _id: { $ne: pendingClaim._id } },
          { $set: {
            status: 'rejected',
            reviewed_by: staffId,
            reviewed_at: now,
            updated_at: now,
          } },
        );
      }
      const claim = await this.findStaffClaim(claimId);
      const notifications = [
        notificationService.create(claim.user_id, {
          type: 'claim',
          title: `Claim ${decision}`,
          message: decision === 'approved'
            ? `Your claim for "${claim.item_name}" was approved. Please collect your item from Lost and Found staff. Staff will mark it as returned after you receive it.`
            : `Your claim for "${claim.item_name}" was rejected.`,
          href: `/index.php?page=claims&highlight=claim-${claim.id}`,
        }),
      ];
      if (decision === 'approved') {
        notifications.push(notificationService.create(String(claim.item.user_id), {
          type: 'status',
          title: 'Found item claimed',
          message: `The found item "${claim.item_name}" has been claimed by its verified owner.`,
          href: `/index.php?page=reports&highlight=item-${claim.item.id}`,
        }));
        notifications.push(...otherPendingClaims.map((otherClaim) => notificationService.create(String(otherClaim.user_id), {
          type: 'claim',
          title: 'Claim rejected',
          message: `Your claim for "${claim.item_name}" was closed because the item was approved for another claimant.`,
          href: `/index.php?page=claims&highlight=claim-${otherClaim._id}`,
        })));
      }
      await Promise.all(notifications);
      return claim;
    },

    async markItemReturned(claimId, staffId) {
      const claim = await claims.findOne({ _id: claimId, status: 'approved' });
      if (!claim) throw new Error('Only an approved claim can be marked as returned.');
      const now = new Date().toISOString();
      const result = await items.updateOne(
        {
          _id: claim.item_id,
          item_type: 'found',
          status: 'claimed',
          claimed_claim_id: claim._id,
          claimed_by: claim.user_id,
        },
        { $set: {
          status: 'returned',
          returned_by: staffId,
          returned_at: now,
          updated_at: now,
        } },
      );
      if (!result.matchedCount) throw new Error('This approved claim is not attached to an item awaiting return.');
      const item = await items.findOne({ _id: claim.item_id });
      await Promise.all([
        notificationService.create(String(claim.user_id), {
          type: 'status',
          title: 'Item returned',
          message: `The item "${item.item_name}" has been marked as returned to you.`,
          href: `/index.php?page=claims&highlight=claim-${claim._id}`,
        }),
        notificationService.create(String(item.user_id), {
          type: 'status',
          title: 'Item return recorded',
          message: `The item "${item.item_name}" has been marked as returned to its owner.`,
          href: `/index.php?page=reports&highlight=item-${item._id}`,
        }),
      ]);
      return this.findStaffClaim(claimId);
    },

    async enrichStaffClaim(document, knownItemDocument = null) {
      const [itemDocument, claimant] = await Promise.all([
        knownItemDocument || items.findOne({ _id: document.item_id }),
        users.findOne({ _id: document.user_id }, {
          projection: { full_name: 1, email: 1, student_id: 1, phone: 1 },
        }),
      ]);
      if (!itemDocument) throw new Error('The item for this claim was not found.');
      const reporter = await users.findOne(
        { _id: itemDocument.user_id },
        { projection: { full_name: 1 } },
      );
      const item = normalizeItem(itemDocument);
      item.reported_by = reporter?.full_name || 'Unknown';
      return {
        ...documentToRecord(document),
        item,
        item_name: itemDocument.item_name,
        claimant: claimant ? {
          ...documentToRecord(claimant),
        } : null,
      };
    },

    async enrichExistingStaffClaims(documents) {
      const records = await Promise.all(documents.map(async (document) => {
        const itemDocument = await items.findOne({ _id: document.item_id });
        if (!itemDocument) {
          console.warn(`Skipping claim ${document._id} because item ${document.item_id} was not found.`);
          return null;
        }
        return this.enrichStaffClaim(document, itemDocument);
      }));
      return records.filter(Boolean);
    },

    async update(userId, itemId, input, imagePath = null) {
      const existing = await items.findOne(
        { _id: itemId, user_id: userId, status: { $in: activeStatuses } },
        { projection: { item_type: 1 } },
      );
      if (!existing) throw new Error('Editable report was not found.');
      if (imagePath && existing.item_type !== 'lost') throw new Error('Images can only be added to lost reports.');
      const data = validateReport({ ...input, item_type: existing.item_type });
      delete data.item_type;
      const updates = { ...data, updated_at: new Date().toISOString() };
      if (imagePath) updates.image_path = imagePath;
      const update = { $set: updates };
      if (existing.item_type === 'found') {
        update.$set.physical_verification_status = 'pending';
        update.$unset = { physical_verified_by: '', physical_verified_at: '' };
      }
      const result = await items.updateOne(
        { _id: itemId, user_id: userId, status: { $in: activeStatuses } },
        update,
      );
      if (!result.matchedCount) throw new Error('Editable report was not found.');
      await notificationService.create(userId, {
        type: 'report',
        title: 'Report updated',
        message: `Your report for "${data.item_name}" has been updated.`,
        href: `/index.php?page=reports&highlight=item-${itemId}`,
      });
      return this.findOne(userId, itemId);
    },

    async cancel(userId, itemId) {
      const result = await items.updateOne(
        { _id: itemId, user_id: userId, status: { $in: activeStatuses } },
        { $set: { status: 'cancelled', updated_at: new Date().toISOString() } },
      );
      if (!result.matchedCount) throw new Error('Only an active report can be cancelled.');
      const item = await this.findOne(userId, itemId);
      await notificationService.create(userId, {
        type: 'status',
        title: 'Report status changed',
        message: `Your report for "${item.item_name}" is now cancelled.`,
        href: `/index.php?page=reports&highlight=item-${item.id}`,
      });
    },

    async search(filters, userId = null) {
      const clauses = [{ status: { $in: browseableStatuses } }];
      const searchText = String(filters.query || '').trim();
      if (searchText) {
        const regex = new RegExp(escapeRegex(searchText), 'i');
        clauses.push({ $or: ['item_name', 'description', 'identifying_details', 'category', 'location'].map((field) => ({ [field]: regex })) });
      }
      for (const field of ['category', 'location']) {
        const value = String(filters[field] || '').trim();
        if (value) clauses.push({ [field]: new RegExp(escapeRegex(value), 'i') });
      }
      if (['lost', 'found'].includes(filters.item_type)) clauses.push({ item_type: filters.item_type });
      if (filters.status === 'stored') clauses.push({ item_type: 'found', status: 'stored' });
      const dateFilter = {};
      if (isDate(filters.date_from)) dateFilter.$gte = filters.date_from;
      if (isDate(filters.date_to)) dateFilter.$lte = filters.date_to;
      if (Object.keys(dateFilter).length) clauses.push({ date_lost: dateFilter });

      const foundItems = await items.find({ $and: clauses }).sort({ date_lost: -1, created_at: -1 }).toArray();
      const results = await Promise.all(foundItems.map(async (document) => {
        const item = normalizeItem(document);
        const [reporter, claim, approvedClaim] = await Promise.all([
          users.findOne({ _id: item.user_id }, { projection: { full_name: 1 } }),
          userId ? claims.findOne({ item_id: item.id, user_id: userId }, { projection: { _id: 1 } }) : null,
          this.hasApprovedClaim(item.id),
        ]);
        if (approvedClaim) return null;
        item.reported_by = reporter?.full_name || 'Unknown';
        if (item.item_type === 'found') delete item.image_path;
        item.user_claim_id = claim ? String(claim._id) : null;
        return item;
      }));
      return results.filter(Boolean);
    },

    async createClaim(userId, input) {
      const itemId = String(input.item_id || '').trim();
      const details = String(input.claim_details || '').trim();
      if (!itemId || !details) throw new Error('Select an item and provide ownership details.');
      const item = await items.findOne(
        { _id: itemId, status: { $in: claimableItemStatuses } },
        { projection: { user_id: 1, item_type: 1, item_name: 1 } },
      );
      if (!item) throw new Error('That item is no longer available for claims.');
      if (item.item_type !== 'found') throw new Error('Only found items can be claimed.');
      if (await this.hasApprovedClaim(itemId)) throw new Error('That item has already been claimed.');
      if (String(item.user_id) === userId) throw new Error('You cannot claim your own report.');
      const now = new Date().toISOString();
      const claimId = randomUUID();
      try {
        await claims.insertOne({
          _id: claimId,
          item_id: itemId,
          user_id: userId,
          claim_details: details,
          status: 'pending',
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        if (error.code === 11000) throw new Error('You have already submitted a claim for this item.');
        throw error;
      }
      const [stillAvailable, approvedClaim] = await Promise.all([
        items.findOne({ _id: itemId, item_type: 'found', status: { $in: claimableItemStatuses } }),
        this.hasApprovedClaim(itemId),
      ]);
      if (!stillAvailable || approvedClaim) {
        await claims.deleteOne({ _id: claimId, status: 'pending' });
        throw new Error('That item is no longer available for claims.');
      }
      const staffUsers = await users.find(
        { role_name: 'staff', status: 'active' },
        { projection: { _id: 1 } },
      ).toArray();
      await Promise.all([
        notificationService.create(userId, {
          type: 'claim',
          title: 'Claim submitted',
          message: `Your claim for "${item.item_name}" is pending review.`,
          href: `/index.php?page=claims&highlight=claim-${claimId}`,
        }),
        notificationService.create(String(item.user_id), {
          type: 'claim',
          title: 'New claim received',
          message: `Someone submitted a claim for your found item "${item.item_name}".`,
          href: `/index.php?page=reports&highlight=item-${itemId}`,
        }),
        ...staffUsers.map((staffUser) => notificationService.create(String(staffUser._id), {
          type: 'claim',
          title: 'Ownership claim needs review',
          message: `A new ownership claim was submitted for "${item.item_name}".`,
          href: `/index.php?page=staff-claim&id=${encodeURIComponent(claimId)}&highlight=claim-${claimId}`,
        })),
      ]);
    },

    async findClaimsForUser(userId) {
      const userClaims = await claims.find({ user_id: userId }).sort({ created_at: -1 }).toArray();
      return Promise.all(userClaims.map(async (claim) => {
        const item = await items.findOne({ _id: claim.item_id });
        if (!item) return null;
        return {
          ...documentToRecord(claim),
          item_name: item.item_name,
          item_type: item.item_type,
          item_status: item.status,
          category: item.category,
          location: item.location,
        };
      })).then((results) => results.filter(Boolean));
    },

    async findPublic(itemId, userId) {
      const document = await items.findOne({
        _id: itemId,
        $or: [{ status: { $in: browseableStatuses } }, { status: { $in: ['claimed', 'returned'] } }],
      });
      if (!document) throw new Error('Item was not found or is no longer available.');
      const item = normalizeItem(document);
      const [reporter, totalClaims, userClaim, approvedClaim] = await Promise.all([
        users.findOne({ _id: item.user_id }, { projection: { full_name: 1 } }),
        claims.countDocuments({ item_id: itemId }),
        claims.findOne({ item_id: itemId, user_id: userId }, { projection: { _id: 1, status: 1 } }),
        this.hasApprovedClaim(itemId),
      ]);
      item.reported_by = reporter?.full_name || 'Unknown';
      item.total_claims = totalClaims;
      item.user_claim_id = userClaim ? String(userClaim._id) : null;
      item.user_claim_status = userClaim?.status || null;
      if (approvedClaim && item.status !== 'returned') item.status = 'claimed';
      if (item.item_type === 'found') delete item.image_path;
      delete item.identifying_details;
      return item;
    },

    async findOne(userId, itemId) {
      const document = await items.findOne({ _id: itemId, user_id: userId });
      if (!document) throw new Error('Report was not found.');
      const item = normalizeItem(document);
      if (item.item_type === 'found') delete item.image_path;
      return item;
    },

    async findAvailable(itemId, userId) {
      const document = await items.findOne({ _id: itemId, item_type: 'found', status: { $in: claimableItemStatuses } });
      if (!document) throw new Error('Item was not found or is not yet stored for claims.');
       if (await this.hasApprovedClaim(itemId)) throw new Error('Item has already been claimed.');
       if (String(document.user_id) === userId) throw new Error('You cannot claim your own report.');
      const item = normalizeItem(document);
      delete item.image_path;
      delete item.identifying_details;
      return item;
    },
  };
}

function validateReport(input) {
  const dateLost = String(input.date_lost || '').trim();
  const values = {
    item_type: ['lost', 'found'].includes(input.item_type) ? input.item_type : 'lost',
    item_name: String(input.item_name || '').trim(),
    description: String(input.description || '').trim(),
    identifying_details: String(input.identifying_details || '').trim(),
    category: String(input.category || '').trim(),
    location: String(input.location || '').trim(),
    date_lost: dateLost,
  };
  if (Object.values(values).some((value) => !value)) throw new Error('All item details are required.');
  if (!isDate(dateLost) || dateLost > localToday()) throw new Error('The item date must be today or an earlier date.');
  return values;
}

function normalizeItem(document) {
  const item = documentToRecord(document);
  if (activeStatuses.includes(item.status)) item.status = item.item_type;
  return item;
}

function documentToRecord(document) {
  const { _id, ...fields } = document;
  return { ...fields, id: String(_id) };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function capitalize(value) {
  return value ? value[0].toLocaleUpperCase() + value.slice(1) : value;
}

function localToday() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

module.exports = { createItemService };
