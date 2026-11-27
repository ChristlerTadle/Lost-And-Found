const express = require('express');

function createHealthRoutes() {
  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok', version: 'v1' }));
  return router;
}

module.exports = { createHealthRoutes };
