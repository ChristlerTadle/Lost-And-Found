const path = require('node:path');
const { requestAuditContext } = require('../../src/services/audit-log');

function createStaffController({ items, audit }) {
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
      const currentItem = await items.findStaffItem(req.params.id);
      const status = String(req.body.status || '');
      await audit.runAction(requestAuditContext(req, 'item.status_update', {
        target_type: 'item',
        target_id: req.params.id,
        old_value: { status: currentItem.status },
        new_value: { status },
      }), (session) => items.updateItemStatus(req.params.id, user.id, status, session));
      return res.json({ message: 'Item status updated.' });
    },

    postStaffItemsByIdVerify: async (req, res) => {
      const user = req.user;
      await items.verifyFoundItem(req.params.id, user.id);
      return res.json({ message: 'Item marked physically verified.' });
    },

    getStaffClaims: async (req, res) => {
      return res.json({ claims: await items.findStaffClaims() });
    },

    getStaffClaimsById: async (req, res) => {
      return res.json({ claim: await items.findStaffClaim(req.params.id) });
    },

    patchStaffClaimsById: async (req, res) => {
      const user = req.user;
      let claim;
      if (req.body.action === 'review') {
        const decision = String(req.body.decision || '');
        const action = decision === 'approved' ? 'claim.approve' : 'claim.reject';
        claim = await audit.runAction([
          requestAuditContext(req, 'ownership.verify', {
            target_type: 'claim',
            target_id: req.params.id,
            old_value: { ownership_verified: null },
            new_value: { ownership_verified: decision === 'approved' },
          }),
          requestAuditContext(req, action, {
            target_type: 'claim',
            target_id: req.params.id,
            old_value: { status: 'pending' },
            new_value: { status: decision },
          }),
        ], (session) => items.reviewClaim(req.params.id, user.id, decision, session));
      } else if (req.body.action === 'returned') {
        const currentClaim = await items.findStaffClaim(req.params.id);
        claim = await audit.runAction(requestAuditContext(req, 'item.mark_returned', {
          target_type: 'item',
          target_id: currentClaim.item.id,
          old_value: { status: currentClaim.item.status },
          new_value: { status: 'returned' },
        }), (session) => items.markItemReturned(req.params.id, user.id, session));
      } else {
        const error = new Error('Choose a valid claim action.');
        error.status = 400;
        throw error;
      }
      return res.json({ claim });
    },
  };
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
