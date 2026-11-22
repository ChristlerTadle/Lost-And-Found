const express = require('express');
const multer = require('multer');
const { asyncRoute } = require('../middlewares/async-route');
const { requireCsrf } = require('../middlewares/csrf');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

function createItemsRoutes({ controllers, guards, frontendOrigin, limit }) {
  const accountRead = limit ? limit('user_reads') : (_req, _res, next) => next();
  const itemImages = limit ? limit('item_images') : (_req, _res, next) => next();
  const reportCreate = limit ? limit('report_create') : (_req, _res, next) => next();
  const reportEdit = limit ? limit('report_edit') : (_req, _res, next) => next();
  const reportCancel = limit ? limit('report_cancel') : (_req, _res, next) => next();
  const imageUpload = limit ? limit('image_upload') : (_req, _res, next) => next();
  const multipartImageUpload = (req, res, next) => (
    /^multipart\/form-data(?:;|$)/i.test(req.get('content-type') || '')
      ? imageUpload(req, res, next)
      : next()
  );
  multipartImageUpload.rateLimitGroup = 'image_upload';
  const rejectOversizedUpload = (req, res, next) => {
    const contentLength = Number(req.get('content-length') || 0);
    if (/^multipart\/form-data(?:;|$)/i.test(req.get('content-type') || '')
      && contentLength > (5 * 1024 * 1024 + 100 * 1024)) {
      return res.status(413).json({ error: 'The image upload is too large.' });
    }
    return next();
  };
  const router = express.Router();
  router.get('/', accountRead, guards.requirePermission('GET', '/items'), asyncRoute(controllers.items.getItems));
  router.get('/:id/image', itemImages, guards.requirePermission('GET', '/items/:id/image'), asyncRoute(controllers.items.getItemsByIdImage));
  router.get('/mine', accountRead, guards.requirePermission('GET', '/items/mine'), asyncRoute(controllers.items.getItemsMine));
  router.get('/mine/:id', accountRead, guards.requirePermission('GET', '/items/mine/:id'), asyncRoute(controllers.items.getItemsMineById));
  router.post('/', rejectOversizedUpload, multipartImageUpload, reportCreate, guards.requirePermission('POST', '/items'), upload.single('image'), asyncRoute(controllers.items.postItems));
  router.get('/:id', accountRead, guards.requirePermission('GET', '/items/:id'), asyncRoute(controllers.items.getItemsById));
  router.put('/:id', rejectOversizedUpload, multipartImageUpload, reportEdit, guards.requirePermission('PUT', '/items/:id'), upload.single('image'), asyncRoute(controllers.items.putItemsById));
  router.delete('/:id', reportCancel, requireCsrf(frontendOrigin), guards.requirePermission('DELETE', '/items/:id'), asyncRoute(controllers.items.deleteItemsById));
  router.post('/:id/resolve', reportCancel, requireCsrf(frontendOrigin), guards.requirePermission('POST', '/items/:id/resolve'), asyncRoute(controllers.items.resolveItemsById));
  return router;
}

module.exports = { createItemsRoutes };
