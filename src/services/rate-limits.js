const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');
const config = require('../config');

const STORE_TIMEOUT_MS = 200;
const AUDIT_WINDOW_MS = 10 * 60 * 1000;
const AUDIT_RETENTION_MS = 24 * 60 * 60 * 1000;

class MemoryRateLimitStore {
  constructor({ group, keyType, hmacKey, windowMs, now = Date.now }) {
    this.group = group;
    this.keyType = keyType;
    this.hmacKey = hmacKey;
    this.windowMs = windowMs;
    this.now = now;
    this.counters = new Map();
    this.lastPrunedAt = 0;
  }

  init(options = {}) {
    if (Number.isFinite(options.windowMs)) this.windowMs = options.windowMs;
    return Promise.resolve();
  }

  async increment(identifier) {
    const key = this.keyFor(identifier);
    const now = this.now();
    if (now - this.lastPrunedAt >= 60_000) {
      for (const [counterKey, counter] of this.counters) {
        if (counter.expiresAt <= now) this.counters.delete(counterKey);
      }
      this.lastPrunedAt = now;
    }
    let counter = this.counters.get(key);
    if (!counter || counter.expiresAt <= now) {
      counter = { count: 0, expiresAt: now + this.windowMs };
      this.counters.set(key, counter);
    }
    counter.count += 1;
    return { totalHits: counter.count, resetTime: new Date(counter.expiresAt) };
  }

  async decrement(identifier) {
    const counter = this.counters.get(this.keyFor(identifier));
    if (counter && counter.expiresAt > this.now()) counter.count = Math.max(0, counter.count - 1);
  }

  async resetKey(identifier) {
    this.counters.delete(this.keyFor(identifier));
  }

  async resetAll() {
    this.counters.clear();
  }

  keyFor(identifier) {
    return makeCounterId(this.hmacKey, this.group, this.keyType, identifier);
  }
}

class MongoRateLimitStore {
  constructor({ collection, group, keyType, hmacKey, windowMs, now = Date.now, timeoutMs = STORE_TIMEOUT_MS }) {
    this.collection = collection;
    this.group = group;
    this.keyType = keyType;
    this.hmacKey = hmacKey;
    this.windowMs = windowMs;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.type = `${group}:${keyType}`;
  }

  init(options = {}) {
    if (Number.isFinite(options.windowMs)) this.windowMs = options.windowMs;
    return Promise.resolve();
  }

  async increment(identifier) {
    const _id = this.keyFor(identifier);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const document = resultDocument(await withTimeout(
          this.collection.findOneAndUpdate(
            { _id },
            [{
              $set: {
                count: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] },
                    1,
                    { $add: [{ $ifNull: ['$count', 0] }, 1] },
                  ],
                },
                expiresAt: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] },
                    { $add: ['$$NOW', this.windowMs] },
                    '$expiresAt',
                  ],
                },
                type: this.type,
              },
            }],
            {
              upsert: true,
              returnDocument: 'after',
              includeResultMetadata: false,
              maxTimeMS: this.timeoutMs,
              timeoutMS: this.timeoutMs,
            },
          ),
          this.timeoutMs,
        ));
        if (!document) throw new Error('Rate limit counter update returned no document.');
        return { totalHits: document.count, resetTime: document.expiresAt };
      } catch (error) {
        if (error?.code === 11000 && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error('Rate limit counter update failed.');
  }

  async decrement(identifier) {
    await withTimeout(this.collection.updateOne(
      { _id: this.keyFor(identifier) },
      [{
        $set: {
          count: {
            $cond: [
              { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] },
              { $ifNull: ['$count', 0] },
              { $max: [0, { $subtract: [{ $ifNull: ['$count', 0] }, 1] }] },
            ],
          },
        },
      }],
      { maxTimeMS: this.timeoutMs, timeoutMS: this.timeoutMs },
    ), this.timeoutMs);
  }

  async resetKey(identifier) {
    await withTimeout(this.collection.deleteOne(
      { _id: this.keyFor(identifier) },
      { maxTimeMS: this.timeoutMs, timeoutMS: this.timeoutMs },
    ), this.timeoutMs);
  }

  async resetAll() {
    await withTimeout(this.collection.deleteMany(
      { type: this.type },
      { maxTimeMS: this.timeoutMs, timeoutMS: this.timeoutMs },
    ), this.timeoutMs);
  }

  async recordAudit(identifier) {
    const _id = this.keyFor(identifier);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const document = resultDocument(await withTimeout(
          this.collection.findOneAndUpdate(
            { _id },
            [{
              $set: {
                count: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$auditWindowExpiresAt', new Date(0)] }, '$$NOW'] },
                    1,
                    { $add: [{ $ifNull: ['$count', 0] }, 1] },
                  ],
                },
                suppressedCount: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$auditWindowExpiresAt', new Date(0)] }, '$$NOW'] },
                    0,
                    { $add: [{ $ifNull: ['$suppressedCount', 0] }, 1] },
                  ],
                },
                previousSuppressedCount: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$auditWindowExpiresAt', new Date(0)] }, '$$NOW'] },
                    { $ifNull: ['$suppressedCount', 0] },
                    '$previousSuppressedCount',
                  ],
                },
                auditWindowExpiresAt: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$auditWindowExpiresAt', new Date(0)] }, '$$NOW'] },
                    { $add: ['$$NOW', AUDIT_WINDOW_MS] },
                    '$auditWindowExpiresAt',
                  ],
                },
                expiresAt: {
                  $cond: [
                    { $lte: [{ $ifNull: ['$auditWindowExpiresAt', new Date(0)] }, '$$NOW'] },
                    { $add: ['$$NOW', AUDIT_WINDOW_MS + AUDIT_RETENTION_MS] },
                    '$expiresAt',
                  ],
                },
                type: 'rate_limited_audit',
              },
            }],
            {
              upsert: true,
              returnDocument: 'after',
              includeResultMetadata: false,
              maxTimeMS: this.timeoutMs,
              timeoutMS: this.timeoutMs,
            },
          ),
          this.timeoutMs,
        ));
        if (!document) throw new Error('Rate limit audit update returned no document.');
        return {
          totalHits: document.count,
          suppressedCount: document.suppressedCount,
          previousSuppressedCount: document.previousSuppressedCount || 0,
        };
      } catch (error) {
        if (error?.code === 11000 && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error('Rate limit audit update failed.');
  }

  keyFor(identifier) {
    return makeCounterId(this.hmacKey, this.group, this.keyType, identifier);
  }
}

function createRateLimitService({
  database,
  audit,
  secret = config.sessionSecret,
  definitions = config.rateLimits,
  now = Date.now,
  timeoutMs = STORE_TIMEOUT_MS,
  stores = {},
  logger = console,
} = {}) {
  const hmacKey = createHmac('sha256', String(secret)).update('rate-limits:v1').digest();
  const collection = database?.collection('rate_limits');
  const storeCache = new Map();
  let lastStoreWarningAt = -Infinity;

  function warnStoreUnavailable() {
    const timestamp = now();
    if (timestamp - lastStoreWarningAt < 60_000) return;
    lastStoreWarningAt = timestamp;
    logger.warn('Rate limit store unavailable; non-sensitive limits are temporarily fail-open.');
  }

  function createStore(rule) {
    if (stores[rule.group]) return stores[rule.group];
    const cacheKey = `${rule.store}:${rule.group}:${rule.keyType}`;
    if (storeCache.has(cacheKey)) return storeCache.get(cacheKey);
    let store;
    if (rule.store === 'memory') {
      store = new MemoryRateLimitStore({
        group: rule.group,
        keyType: rule.keyType,
        hmacKey,
        windowMs: rule.windowMs,
        now,
      });
    } else if (collection) {
      store = new MongoRateLimitStore({
        collection,
        group: rule.group,
        keyType: rule.keyType,
        hmacKey,
        windowMs: rule.windowMs,
        now,
        timeoutMs,
      });
    } else {
      store = {
        increment: async () => { throw new Error('Rate limit database is unavailable.'); },
        decrement: async () => {},
        resetKey: async () => {},
      };
    }
    storeCache.set(cacheKey, store);
    return store;
  }

  const auditStore = collection ? new MongoRateLimitStore({
    collection,
    group: 'rate_limited_audit',
    keyType: 'counter',
    hmacKey,
    windowMs: AUDIT_WINDOW_MS,
    now,
    timeoutMs,
  }) : null;

  async function recordRateLimitAudit({
    group,
    keyType,
    identifier,
    action = 'rate_limited',
    targetId = group,
    targetType = null,
  }) {
    try {
      if (!auditStore || !audit) return;
      const state = await auditStore.recordAudit(`${group}\0${keyType}\0${identifier}`);
      if (state.totalHits !== 1) return;
      await audit.logAction({
        action,
        target_type: targetType,
        target_id: targetId,
        new_value: {
          module: group,
          action_group: group,
          suppressed_count: state.previousSuppressedCount,
        },
        result: action === 'integration.rate_limited' ? 'failed' : 'denied',
      });
    } catch {
      warnStoreUnavailable();
    }
  }

  function limit(group) {
    const definition = definitions[group];
    if (!definition) throw new Error(`Unknown rate limit group: ${group}`);
    const rules = definition.rules || [{ ...definition, group }];
    return async function rateLimitMiddleware(req, res, next) {
      if (req.method === 'OPTIONS'
        || (group === 'global_api' && req.method === 'GET' && isHealthRequest(req))) {
        return next();
      }

      const applied = [];
      try {
        for (const rule of rules) {
          const identifier = keyIdentifier(req, rule.keyType);
          const store = createStore(rule);
          const result = await store.increment(identifier);
          applied.push({ rule, identifier, store });
          setRateLimitHeaders(res, rule, result, now);
          if (result.totalHits > rule.max) {
            await rollback(applied);
            const retryAfter = secondsUntil(result.resetTime, now());
            void recordRateLimitAudit({
              group: rule.group,
              keyType: rule.keyType,
              identifier,
              targetId: rule.group,
            });
            const error = new Error(definition.rateLimitedMessage || 'Too many requests. Please try again later.');
            error.status = 429;
            error.code = 'rate_limited';
            error.retryAfter = retryAfter;
            return next(error);
          }
        }

        if (group === 'login' && applied.length) attachLoginCounterFinalizer(req, applied[0]);
        if (group === 'global_api' && applied.length) attachGlobalCounterRollback(req, applied[0]);
        return next();
      } catch (error) {
        await rollback(applied);
        const sensitive = rules.some((rule) => rule.sensitive);
        if (sensitive) return next(storeUnavailableError());
        warnStoreUnavailable();
        return next();
      }
    };
  }

  async function initialize() {
    if (!collection) throw new Error('Rate limit database is not configured.');
    await collection.createIndex(
      { expiresAt: 1 },
      { name: 'rate_limits_expiresAt_ttl', expireAfterSeconds: 0 },
    );
    for (const [group, definition] of Object.entries(definitions)) {
      const rules = definition.rules || [{ ...definition, group }];
      for (const rule of rules) {
        const store = createStore(rule);
        if (typeof store.init === 'function') await store.init({ windowMs: rule.windowMs });
      }
    }
    return true;
  }

  return { limit, initialize, recordRateLimitAudit, stores: storeCache };

  async function rollback(applied) {
    await Promise.all(applied.map(async ({ identifier, store }) => {
      try {
        await store.decrement(identifier);
      } catch {
        warnStoreUnavailable();
      }
    }));
  }

  function attachLoginCounterFinalizer(req, counter) {
    let finalized = false;
    req.rateLimitReset = async () => {
      if (finalized) return;
      finalized = true;
      try {
        await counter.store.resetKey(counter.identifier);
      } catch {
        throw storeUnavailableError();
      }
    };
    req.rateLimitFinalize = async (status) => {
      if (finalized) return;
      finalized = true;
      if (status === counter.rule.failedStatus) return;
      try {
        if (status >= 200 && status < 400) await counter.store.resetKey(counter.identifier);
        else await counter.store.decrement(counter.identifier);
      } catch {
        throw storeUnavailableError();
      }
    };
  }

  function attachGlobalCounterRollback(req, counter) {
    let rolledBack = false;
    req.rateLimitGlobalRollback = async () => {
      if (rolledBack) return;
      rolledBack = true;
      try {
        await counter.store.decrement(counter.identifier);
      } catch {
        warnStoreUnavailable();
      }
    };
  }
}

function makeCounterId(hmacKey, group, keyType, identifier) {
  return createHmac('sha256', hmacKey)
    .update(`${group}\0${keyType}\0${String(identifier)}`)
    .digest('hex');
}

function keyIdentifier(req, keyType) {
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '');
  const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
  const account = String(req.user?.id || req.session?.userId || req.session?.user?.id || '');
  if (keyType === 'ip') return ip;
  if (keyType === 'email') return email;
  if (keyType === 'ip+email') return `${ip}\0${email}`;
  if (keyType === 'account') return account;
  if (keyType === 'account+ip') return `${account}\0${ip}`;
  if (keyType === 'account+resource') {
    const resource = String(req.params?.resourceId || req.params?.itemId || req.body?.item_id || '');
    return `${account}\0${resource}`;
  }
  throw new Error(`Unsupported rate limit key type: ${keyType}`);
}

function normalizeIp(value) {
  const address = String(value).trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return address || 'unknown';
  const words = ipv6Words(address);
  if (words && words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [
      (words[6] >> 8) & 0xff, words[6] & 0xff,
      (words[7] >> 8) & 0xff, words[7] & 0xff,
    ].join('.');
  }
  return words ? `${words.slice(0, 4).map((word) => word.toString(16).padStart(4, '0')).join(':')}::/64` : address;
}

function ipv6Words(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const parts = half.split(':');
    const words = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
          return null;
        }
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        const word = Number.parseInt(part, 16);
        if (!/^[\da-f]{1,4}$/i.test(part) || !Number.isInteger(word)) return null;
        words.push(word);
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function isHealthRequest(req) {
  const path = req.path || req.url || '';
  return path === '/health' || path === '/api/health';
}

function setRateLimitHeaders(res, rule, result, now) {
  const remaining = Math.max(0, rule.max - result.totalHits);
  const resetSeconds = secondsUntil(result.resetTime, now());
  const headers = {
    'RateLimit-Policy': `${rule.max};w=${Math.ceil(rule.windowMs / 1000)}`,
    'RateLimit-Limit': String(rule.max),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(resetSeconds),
  };
  for (const [name, value] of Object.entries(headers)) {
    if (typeof res.set === 'function') res.set(name, value);
    else if (typeof res.setHeader === 'function') res.setHeader(name, value);
  }
}

function secondsUntil(resetTime, now) {
  const timestamp = resetTime instanceof Date ? resetTime.getTime() : Number(resetTime);
  return Math.max(1, Math.ceil((timestamp - now) / 1000));
}

function resultDocument(result) {
  return result?.value && !result._id ? result.value : result;
}

function withTimeout(operation, timeoutMs) {
  let timeout;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Rate limit store request timed out.')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function storeUnavailableError() {
  const error = new Error('Service temporarily unavailable. Please try again shortly.');
  error.status = 503;
  error.code = 'rate_limit_store_unavailable';
  error.retryAfter = 1;
  return error;
}

module.exports = {
  MemoryRateLimitStore,
  MongoRateLimitStore,
  createRateLimitService,
  keyIdentifier,
  normalizeIp,
};
