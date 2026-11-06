const express = require('express');

function createHealthRoutes() {
  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  return router;
}

module.exports = { createHealthRoutes };
