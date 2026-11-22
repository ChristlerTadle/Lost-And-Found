const crypto = require('node:crypto');
const net = require('node:net');

function normalizeIp(ipAddress) {
  let ip = String(ipAddress || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIP(ip) === 6) {
    const parts = ip.toLowerCase().split(':');
    if (parts.length >= 4) return `${parts.slice(0, 4).join(':')}::/64`;
  }
  return ip || 'unknown';
}

function createMemoryStore(now = Date.now) {
  const entries = new Map();
  return {
    async increment(_id, windowMs) {
      const timestamp = now();
      let entry = entries.get(_id);
      if (!entry || entry.resetTime <= timestamp) {
        entry = { count: 0, resetTime: timestamp + windowMs };
      }
      entry.count += 1;
      entries.set(_id, entry);
      return { totalHits: entry.count, resetTime: new Date(entry.resetTime) };
    },
    async decrement(_id) {
      const entry = entries.get(_id);
      if (entry) entry.count = Math.max(0, entry.count - 1);
    },
    async resetKey(_id) { entries.delete(_id); },
    async resetAll() { entries.clear(); },
  };
}

function createRateLimitService({ database, audit, secret = '', config = {}, now = Date.now } = {}) {
  const memoryStore = createMemoryStore(now);
  const memoryStores = new Map();
  let warnedAt = 0;
  let auditCollection;
  let ttlInitialized = false;
  const collection = () => database?.collection('rate_limits');

  function hashIdentifier(group, keyType, identifier) {
    return crypto.createHmac('sha256', secret || 'replace-this-session-secret-before-deployment')
      .update(`${group}\0${keyType}\0${identifier}`)
      .digest('hex');
  }

  async function initialize() {
    if (!database || ttlInitialized) return;
    await collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_ttl' });
    ttlInitialized = true;
  }

  async function mongoIncrement(id, group, windowMs) {
    const operation = collection().findOneAndUpdate(
      { _id: id },
      [{
        $set: {
          count: {
            $cond: [
              { $or: [{ $lte: ['$expiresAt', '$$NOW'] }, { $not: ['$expiresAt'] }] },
              1,
              { $add: [{ $ifNull: ['$count', 0] }, 1] },
            ],
          },
          expiresAt: {
            $cond: [
              { $or: [{ $lte: ['$expiresAt', '$$NOW'] }, { $not: ['$expiresAt'] }] },
              { $add: ['$$NOW', windowMs] },
              '$expiresAt',
            ],
          },
          type: group,
        },
      }],
      { upsert: true, returnDocument: 'after' },
    );
    const result = await operation;
    if (!result) throw new Error('Rate-limit store did not return a counter.');
    return { totalHits: result.count, resetTime: result.expiresAt };
  }

  async function incrementMongo(id, group, windowMs) {
    try {
      return await mongoIncrement(id, group, windowMs);
    } catch (error) {
      if (error?.code === 11000) return mongoIncrement(id, group, windowMs);
      throw error;
    }
  }

  function withStoreTimeout(promise) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Rate-limit store timeout')), 200);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function warnStoreFailure() {
    const timestamp = now();
    if (timestamp - warnedAt >= 60_000) {
      warnedAt = timestamp;
      console.warn('WARNING: rate-limit store unavailable; this group is failing open.');
    }
  }

  async function recordRateLimitAudit(req, group) {
    if (!database || !audit) return;
    const accountId = req.session?.user?.id ? String(req.session.user.id) : '';
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress);
    const identifier = `${accountId || 'anonymous'}\0${ip}`;
    const id = hashIdentifier('rate_limited', 'audit_dedupe', identifier);
    if (!auditCollection) auditCollection = collection();
    const expiresAt = new Date(now() + 10 * 60 * 1000);
    const result = await auditCollection.findOneAndUpdate(
      { _id: id },
      [{
        $set: {
          count: { $cond: [{ $lte: ['$expiresAt', '$$NOW'] }, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] },
          expiresAt: { $cond: [{ $lte: ['$expiresAt', '$$NOW'] }, expiresAt, '$expiresAt'] },
          type: 'audit_dedupe',
          audit_group: group,
        },
      }],
      { upsert: true, returnDocument: 'after' },
    );
    if (result?.count === 1 && typeof audit.logAction === 'function') {
      await audit.logAction({
        actor_id: null,
        actor_role: null,
        action: 'rate_limited',
        target_type: null,
        target_id: null,
        new_value: { group },
        result: 'denied',
      }).catch(() => {});
    }
  }

  function groupConfig(group) {
    return config[group] || {};
  }

  function limit(group, options = {}) {
    const rule = groupConfig(group);
    if (!rule?.windowMs || !rule?.max) throw new TypeError(`Unknown rate-limit group: ${group}`);
    return function rateLimit(req, res, next) {
      if (req.method === 'OPTIONS') return next();
      const accountId = req.session?.user?.id ? String(req.session.user.id) : null;
      if ((rule.keyType === 'account' || rule.keyType === 'account+ip' || rule.keyType === 'account+item') && !accountId) {
        return next();
      }
      let identifier = accountId || '';
      if (rule.keyType === 'account+ip') identifier = `${accountId}\0${normalizeIp(req.ip || req.socket?.remoteAddress)}`;
      if (rule.keyType === 'account+item') {
        const itemId = typeof options.identifier === 'function' ? options.identifier(req) : req.params?.id;
        if (typeof itemId !== 'string' || !itemId || itemId.length > 128) return next();
        identifier = `${accountId}\0${itemId}`;
      }
      const id = hashIdentifier(group, rule.keyType, identifier);
      let store = memoryStore;
      if (rule.store === 'memory') {
        if (!memoryStores.has(group)) memoryStores.set(group, createMemoryStore(now));
        store = memoryStores.get(group);
      }
      const run = rule.store === 'mongo' && database
        ? withStoreTimeout(incrementMongo(id, group, rule.windowMs))
        : store.increment(id, rule.windowMs);
      return Promise.resolve(run).then((value) => {
        const resetTime = value.resetTime instanceof Date ? value.resetTime : new Date(value.resetTime);
        const retryAfter = Math.max(1, Math.ceil((resetTime.getTime() - now()) / 1000));
        res.set('RateLimit-Limit', String(rule.max));
        res.set('RateLimit-Remaining', String(Math.max(0, rule.max - value.totalHits)));
        res.set('RateLimit-Reset', String(retryAfter));
        if (value.totalHits <= rule.max) return next();
        res.set('Retry-After', String(retryAfter));
        void recordRateLimitAudit(req, group).catch(() => {});
        const error = new Error('Please try again shortly');
        error.status = 429;
        error.code = 'rate_limited';
        error.retryAfter = retryAfter;
        return next(error);
      }).catch(() => {
        if (rule.store === 'mongo' && rule.sensitive) {
          res.set('Retry-After', '1');
          const error = new Error('Please try again shortly');
          error.status = 503;
          error.retryAfter = 1;
          return next(error);
        }
        warnStoreFailure();
        return next();
      });
    };
  }

  return { initialize, limit, recordRateLimitAudit };
}

module.exports = { createRateLimitService, createMemoryStore, normalizeIp };
