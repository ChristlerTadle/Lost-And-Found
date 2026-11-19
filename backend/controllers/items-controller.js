const path = require('node:path');
const { saveItemImage } = require('../lib/save-item-image');
const { optionalUser } = require('../middlewares/session-auth');
const { requestAuditContext } = require('../../src/services/audit-log');

function createItemsController({ items, googleCalendar }) {
  return {
    getItems: async (req, res) => {
        const user = await optionalUser(req);
      const results = await items.search(req.query, user?.id || null);
      const publicItems = results.map(({ identifying_details, ...item }) => item);
      return res.json({ items: publicItems });
    },

    getItemsMine: async (req, res) => {
      const user = req.user;
      return res.json({ items: await items.findForUser(user.id) });
    },

    getItemsMineById: async (req, res) => {
      const user = req.user;
      return res.json({ item: await items.findOne(user.id, req.params.id) });
    },

    postItems: async (req, res) => {
      const user = req.user;
      const itemType = req.body.item_type === 'found' ? 'found' : 'lost';
      const imagePath = req.file ? await saveItemImage(req.file, itemType) : null;
      const item = await items.create(user.id, { ...req.body, item_type: itemType }, imagePath);
      return res.status(201).json({ item });
    },

    getItemsById: async (req, res) => {
        const user = await optionalUser(req);
      return res.json({ item: await items.findPublic(req.params.id, user?.id || null) });
    },

    getItemsByIdImage: async (req, res) => {
      const user = await optionalUser(req);
      const imagePath = await items.findPublicItemImage(req.params.id, user?.id || null);
      const prefix = 'uploads/lost/';
      const filename = imagePath?.startsWith(prefix) ? imagePath.slice(prefix.length) : '';
      if (!filename || !/^[0-9a-f-]+\.(jpg|png|webp)$/i.test(filename)) return res.sendStatus(404);
      res.set('Cache-Control', 'private, no-store');
      return res.sendFile(path.resolve(__dirname, '..', '..', 'uploads', 'lost', filename));
    },

    putItemsById: async (req, res) => {
      const user = req.user;
      const existing = await items.findOne(user.id, req.params.id);
      if (req.file && existing.item_type !== 'lost') {
        const error = new Error('Images can only be added to lost reports.');
        error.status = 400;
        throw error;
      }
      const imagePath = req.file ? await saveItemImage(req.file, 'lost') : null;
      const item = await items.update(user.id, req.params.id, req.body, imagePath);
      return res.json({ item });
    },

    deleteItemsById: async (req, res) => {
      const user = req.user;
      await items.cancel(user.id, req.params.id);
      await googleCalendar.cleanupForItem(req.params.id, requestAuditContext(req, null), { notify: true });
      return res.json({ message: 'Report cancelled.' });
    },

    resolveItemsById: async (req, res) => {
      await items.resolve(req.user.id, req.params.id);
      return res.json({ message: 'Lost report marked resolved.' });
    },
  };
}

module.exports = { createItemsController };
