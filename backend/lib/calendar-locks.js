const { stateConflict } = require('../../src/services/state-conflict');

async function syncApprovedClaimUnderLock({
  items, googleCalendar, claimId, state, lease, auditContext,
}) {
  if (!state.item || state.item.deleted
    || state.claim.status !== 'approved'
    || state.item.status !== 'claimed'
    || state.item.claimedClaimId !== state.claim.id) {
    throw stateConflict('This claim is no longer attached to an item awaiting return.');
  }
  const claim = await items.findCalendarClaim(claimId);
  if (!claim || claim.status !== 'approved'
    || claim.item_deleted || claim.item_status !== 'claimed'
    || claim.item_claim_id !== claim.id) {
    throw stateConflict('This claim is no longer attached to an item awaiting return.');
  }
  return googleCalendar.syncApprovedClaim(claim, auditContext, {
    assertLockHeld: lease.assertHeld,
  });
}

async function withCalendarClaimLock({ items, locks, claimId, owner, operation }) {
  const targets = await items.findClaimLockTargets(claimId);
  return locks.withLocks(
    [{ key: `claim:${targets.claimId}`, mode: 'X' }],
    async (lease) => {
      const state = await items.findClaimLockState(claimId);
      verifyClaimLockTargets(state, targets);
      return operation(lease, state);
    },
    { owner: String(owner) },
  );
}

async function cleanupCalendarForItem({
  items, locks, googleCalendar, itemId, owner, auditContext, notify = false,
}) {
  const targets = await items.findCalendarClaimLockTargetsByItem(itemId);
  if (!targets) return { status: 'skipped' };
  return withCalendarClaimLock({
    items,
    locks,
    claimId: targets.claimId,
    owner,
    operation: async (lease, state) => {
      if (state.claim.itemId !== String(itemId)) {
        throw stateConflict('This record changed before its Calendar status could be updated.');
      }
      const claim = await items.findCalendarClaim(targets.claimId);
      return googleCalendar.cleanupClaim(claim, auditContext, {
        notify,
        assertLockHeld: lease.assertHeld,
      });
    },
  });
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

module.exports = {
  cleanupCalendarForItem,
  syncApprovedClaimUnderLock,
  withCalendarClaimLock,
};
