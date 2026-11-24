const path = require('node:path');
const { requestAuditContext } = require('../../src/services/audit-log');
const { deterministicEventId } = require('../../src/services/calendar-links');
const { stateConflict } = require('../../src/services/state-conflict');
const { syncApprovedClaimUnderLock, withCalendarClaimLock } = require('../lib/calendar-locks');
const { heldEditTokens } = require('../lib/held-edit-session');

function createStaffController({ items, audit, googleCalendar, locks }) {
  return {
    getStaffDashboard: async (req, res) => {
      return res.json(await items.findStaffDashboardSummary(req.rolePermissions));
    },

    getStaffRecords: async (req, res) => {
      return res.json(await items.findStaffRecords(req.query));
    },

    getStaffReturneditems: async (req, res) => {
      return res.json({ items: (await items.findStaffReturnedItems(req.query)).map(staffListItem) });
    },

    getStaffItems: async (req, res) => {
      const type = ['lost', 'found', 'stored'].includes(req.query.type) ? req.query.type : 'lost';
      return res.json({ items: (await items.findStaffItems(type)).map(staffListItem) });
    },

    getStaffItemsById: async (req, res) => {
      return res.json({ item: await items.findStaffItem(req.params.id) });
    },

    getStaffItemsByIdImage: async (req, res) => {
      const item = await items.findStaffItem(req.params.id);
      const filename = item.item_type === 'found'
        ? item.image_path
        : item.image_path?.startsWith('uploads/lost/')
          ? item.image_path.slice('uploads/lost/'.length) : '';
      if (!filename || !/^[0-9a-f-]+\.(jpg|png|webp)$/i.test(filename)) {
        return res.sendStatus(404);
      }
      res.set('Cache-Control', 'private, no-store');
      const directory = item.item_type === 'found' ? 'private_uploads/found' : 'uploads/lost';
      return res.sendFile(path.resolve(__dirname, '..', '..', directory, filename));
    },

    patchStaffItemsByIdStatus: async (req, res) => {
      const user = req.user;
      const status = String(req.body.status || '');
      const requests = [{ key: `item:${req.params.id}`, mode: 'X' }];
      const heldTokens = heldEditTokens(req, requests, [`item:${req.params.id}`]);
      await locks.withLocks(
        requests,
        async (lease) => {
          const currentItem = await items.findItemLockState(req.params.id);
          if (currentItem.deleted) throw stateConflict('This item was removed. Reload the record.');
          await items.findStaffItem(req.params.id);
          await audit.runAction(requestAuditContext(req, 'item.status_update', {
            target_type: 'item',
            target_id: req.params.id,
            old_value: { status: currentItem.status },
            new_value: { status },
          }), async (session) => {
            await lease.assertHeld(`item:${req.params.id}`);
            return items.updateItemStatus(req.params.id, user.id, status, session);
          });
        },
        { owner: String(user.id), heldTokens },
      );
      return res.json({ message: 'Item status updated.' });
    },

    postStaffItemsByIdVerify: async (req, res) => {
      const user = req.user;
      const requests = [{ key: `item:${req.params.id}`, mode: 'X' }];
      const heldTokens = heldEditTokens(req, requests, [`item:${req.params.id}`]);
      await locks.withLocks(
        requests,
        async (lease) => {
          const currentItem = await items.findItemLockState(req.params.id);
          if (currentItem.deleted
            || currentItem.itemType !== 'found'
            || !['found', 'stored'].includes(currentItem.status)) {
            throw stateConflict('This item is no longer available for verification.');
          }
          await lease.assertHeld(`item:${req.params.id}`);
          await items.verifyFoundItem(req.params.id, user.id);
        },
        { owner: String(user.id), heldTokens },
      );
      return res.json({ message: 'Item marked physically verified.' });
    },

    getStaffClaims: async (req, res) => {
      return res.json({ claims: await items.findStaffClaims() });
    },

    getStaffClaimsById: async (req, res) => {
      return res.json({
        claim: await items.findStaffClaim(req.params.id),
        pickupDefaults: await googleCalendar.getPickupFormDefaults(),
      });
    },

    patchStaffClaimsById: async (req, res) => {
      const user = req.user;
      let claim;
      if (req.body.action === 'review') {
        const decision = String(req.body.decision || '');
        let pickup = null;
        if (decision === 'approved' && (req.body.pickup_date || req.body.pickup_time)) {
          requireSchedulePermission(req);
          pickup = {
            ...await googleCalendar.validatePickup(req.body),
            calendar_event_id: deterministicEventId(req.params.id),
          };
        }
        const action = decision === 'approved' ? 'claim.approve' : 'claim.reject';
        const targets = await items.findClaimLockTargets(req.params.id);
        const requests = claimActionLocks(targets);
        if (pickup) requests.push({ key: slotLockKey(pickup.pickup_at), mode: 'X' });
        const heldTokens = heldEditTokens(req, requests, [
          `item:${targets.itemId}`,
          `claim:${targets.claimId}`,
        ]);
        claim = await locks.withLocks(requests, async (lease) => {
          const state = await items.findClaimLockState(req.params.id);
          verifyClaimLockTargets(state, targets);
          if (state.item.deleted) throw stateConflict('The item was removed and this claim can no longer be reviewed.');
          if (state.claim.status !== 'pending') {
            throw stateConflict(state.claim.status === 'approved'
              ? 'This claim was already approved.'
              : 'This claim is no longer pending review.');
          }
          if (decision === 'approved'
            && (state.item.itemType !== 'found' || state.item.status !== 'stored')) {
            throw stateConflict('This item is no longer available to approve another claim.');
          }
          return audit.runAction([
            requestAuditContext(req, 'ownership.verify', {
              target_type: 'claim',
              target_id: req.params.id,
              old_value: { ownership_verified: null },
              new_value: { ownership_verified: decision === 'approved' },
            }),
            requestAuditContext(req, action, {
              target_type: 'claim',
              target_id: req.params.id,
              old_value: { status: state.claim.status },
              new_value: { status: decision, pickup_scheduled: Boolean(pickup) },
            }),
          ], async (session) => {
            await lease.assertHeld();
            return items.reviewClaim(req.params.id, user.id, decision, session, pickup);
          });
        }, { owner: String(user.id), heldTokens });
        const context = requestAuditContext(req, null);
        if (decision === 'approved' && pickup) {
          await withCalendarClaimLock({
            items, locks, claimId: req.params.id, owner: user.id,
            heldTokens: heldTokens && { [`claim:${targets.claimId}`]: heldTokens[`claim:${targets.claimId}`] },
            operation: (lease, state) => syncApprovedClaimUnderLock({
              items,
              googleCalendar,
              claimId: req.params.id,
              state,
              lease,
              auditContext: context,
            }),
          });
          await googleCalendar.sendApprovalEmail(claim, context);
          claim = await items.findStaffClaim(req.params.id);
        } else if (decision === 'rejected' && claim.pickup_at) {
          await withCalendarClaimLock({
            items, locks, claimId: req.params.id, owner: user.id,
            heldTokens: heldTokens && { [`claim:${targets.claimId}`]: heldTokens[`claim:${targets.claimId}`] },
            operation: async (lease) => googleCalendar.cleanupClaim(
              await items.findCalendarClaim(req.params.id),
              context,
              { notify: true, assertLockHeld: lease.assertHeld },
            ),
          });
          claim = await items.findStaffClaim(req.params.id);
        }
      } else if (req.body.action === 'returned') {
        const targets = await items.findClaimLockTargets(req.params.id);
        const requests = claimActionLocks(targets);
        const heldTokens = heldEditTokens(req, requests, [
          `item:${targets.itemId}`,
          `claim:${targets.claimId}`,
        ]);
        claim = await locks.withLocks(requests, async (lease) => {
          const state = await items.findClaimLockState(req.params.id);
          verifyClaimLockTargets(state, targets);
          if (!state.item || state.item.deleted
            || state.claim.status !== 'approved'
            || state.item.status !== 'claimed'
            || state.item.claimedClaimId !== state.claim.id) {
            throw stateConflict('This claim is no longer attached to an item awaiting return.');
          }
          return audit.runAction(requestAuditContext(req, 'item.mark_returned', {
            target_type: 'item',
            target_id: state.item.id,
            old_value: { status: state.item.status },
            new_value: { status: 'returned' },
          }), async (session) => {
            await lease.assertHeld();
            return items.markItemReturned(req.params.id, user.id, session);
          });
        }, { owner: String(user.id), heldTokens });
        await withCalendarClaimLock({
          items, locks, claimId: req.params.id, owner: user.id,
          heldTokens: heldTokens && { [`claim:${targets.claimId}`]: heldTokens[`claim:${targets.claimId}`] },
          operation: async (lease) => googleCalendar.cleanupClaim(
            await items.findCalendarClaim(req.params.id),
            requestAuditContext(req, null),
            { assertLockHeld: lease.assertHeld },
          ),
        });
        claim = await items.findStaffClaim(req.params.id);
      } else {
        const error = new Error('Choose a valid claim action.');
        error.status = 400;
        throw error;
      }
      return res.json({ claim });
    },

    patchStaffClaimsByIdPickup: async (req, res) => {
      requireSchedulePermission(req);
      const pickup = await googleCalendar.validatePickup(req.body);
      const targets = await items.findClaimLockTargets(req.params.id);
      const requests = claimActionLocks(targets);
      requests.push({ key: slotLockKey(pickup.pickup_at), mode: 'X' });
      const heldTokens = heldEditTokens(req, requests, [
        `item:${targets.itemId}`,
        `claim:${targets.claimId}`,
      ]);
      let claim = await locks.withLocks(requests, async (lease) => {
        const state = await items.findClaimLockState(req.params.id);
        verifyClaimLockTargets(state, targets);
        if (!state.item || state.item.deleted
          || state.claim.status !== 'approved'
          || state.item.status !== 'claimed'
          || state.item.claimedClaimId !== state.claim.id) {
          throw stateConflict('This approved claim is no longer attached to an item awaiting return.');
        }
        await lease.assertHeld();
        return items.updateClaimPickup(req.params.id, pickup);
      }, { owner: String(req.user.id), heldTokens });
      const context = requestAuditContext(req, null);
      await withCalendarClaimLock({
        items, locks, claimId: req.params.id, owner: req.user.id,
        heldTokens: heldTokens && { [`claim:${targets.claimId}`]: heldTokens[`claim:${targets.claimId}`] },
        operation: (lease, state) => syncApprovedClaimUnderLock({
          items,
          googleCalendar,
          claimId: req.params.id,
          state,
          lease,
          auditContext: context,
        }),
      });
      await googleCalendar.notifyRescheduled(claim, context);
      claim = await items.findStaffClaim(req.params.id);
      return res.json({ claim });
    },

    postStaffClaimsByIdCalendarSync: async (req, res) => {
      requireSchedulePermission(req);
      const targets = await items.findClaimLockTargets(req.params.id);
      const claimKey = `claim:${targets.claimId}`;
      const heldTokens = heldEditTokens(
        req,
        [{ key: claimKey, mode: 'X' }],
        [claimKey],
        [`item:${targets.itemId}`],
      );
      const result = await withCalendarClaimLock({
        items,
        locks,
        claimId: req.params.id,
        owner: req.user.id,
        heldTokens: heldTokens && { [claimKey]: heldTokens[claimKey] },
        operation: (lease) => googleCalendar.retryClaim(
          req.params.id,
          requestAuditContext(req, null),
          { assertLockHeld: lease.assertHeld },
        ),
      });
      return res.json({ status: result.status });
    },
  };
}

function claimActionLocks(targets) {
  return [
    { key: `account:${targets.claimantId}`, mode: 'S' },
    { key: `item:${targets.itemId}`, mode: 'X' },
    { key: `claim:${targets.claimId}`, mode: 'X' },
  ];
}

function slotLockKey(pickupAt) {
  const bucket = new Date(pickupAt).toISOString().slice(0, 13);
  return `slot:${bucket}`;
}

function verifyClaimLockTargets(state, targets) {
  if (state.claim.id !== targets.claimId
    || state.claim.itemId !== targets.itemId
    || state.claim.claimantId !== targets.claimantId
    || !state.item
    || state.item.id !== targets.itemId) {
    throw stateConflict('This record changed before the action could be completed. Reload and try again.');
  }
}

function requireSchedulePermission(req) {
  if (!req.rolePermissions?.includes('schedule_pickup')) {
    const error = new Error('You do not have permission to schedule or sync pickups.');
    error.status = 403;
    throw error;
  }
}

function staffListItem(item) {
  return {
    id: item.id,
    item_name: item.item_name,
    item_type: item.item_type,
    category: item.category,
    location: item.location,
    date_lost: item.date_lost,
    status: item.status,
    image_path: item.image_path,
    reported_by: item.reported_by,
    physical_verification_status: item.physical_verification_status,
  };
}

module.exports = { createStaffController };
