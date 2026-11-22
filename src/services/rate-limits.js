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
    async peek(_id, windowMs) {
      const entry = entries.get(_id);
      if (!entry || entry.resetTime <= now()) return { totalHits: 0, resetTime: new Date(now() + windowMs) };
      return { totalHits: entry.count, resetTime: new Date(entry.resetTime) };
    },
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

  function getIdentity(req, group, options = {}) {
    const rule = groupConfig(group);
    const accountId = req.session?.user?.id ? String(req.session.user.id) : null;
    if ((rule.keyType === 'account' || rule.keyType === 'account+ip'
      || rule.keyType === 'account+item' || rule.keyType === 'account+resource') && !accountId) {
      return null;
    }
    let identifier = accountId || '';
    if (rule.keyType === 'ip') identifier = normalizeIp(req.ip || req.socket?.remoteAddress);
    if (rule.keyType === 'account+ip') identifier = `${accountId}\0${normalizeIp(req.ip || req.socket?.remoteAddress)}`;
    if (rule.keyType === 'account+item' || rule.keyType === 'account+resource') {
      const resourceId = typeof options.identifier === 'function' ? options.identifier(req) : req.params?.id;
      if (typeof resourceId !== 'string' || !resourceId || resourceId.length > 128) return null;
      identifier = `${accountId}\0${resourceId}`;
    }
    if (rule.keyType === 'resource') {
      const resourceId = typeof options.identifier === 'function' ? options.identifier(req) : options.identifier;
      if (typeof resourceId !== 'string' || !resourceId || resourceId.length > 128) return null;
      identifier = resourceId;
    }
    return { rule, id: hashIdentifier(group, rule.keyType, identifier) };
  }

  function getStore(group, rule) {
    if (rule.store === 'memory' || !database) {
      if (!memoryStores.has(group)) memoryStores.set(group, createMemoryStore(now));
      return memoryStores.get(group);
    }
    return null;
  }

  async function incrementGroup(group, rule, id) {
    if (rule.store === 'mongo' && database) {
      return withStoreTimeout(incrementMongo(id, group, rule.windowMs));
    }
    return getStore(group, rule).increment(id, rule.windowMs);
  }

  async function decrementGroup(group, rule, id) {
    if (rule.store === 'mongo' && database) {
      await collection().updateOne({ _id: id, count: { $gt: 0 } }, { $inc: { count: -1 } });
      return;
    }
    await getStore(group, rule).decrement(id);
  }

  function rateLimitError(req, res, group, rule, value) {
    const resetTime = value.resetTime instanceof Date ? value.resetTime : new Date(value.resetTime);
    const retryAfter = Math.max(1, Math.ceil((resetTime.getTime() - now()) / 1000));
    res.set('RateLimit-Limit', String(rule.max));
    res.set('RateLimit-Remaining', String(Math.max(0, rule.max - value.totalHits)));
    res.set('RateLimit-Reset', String(retryAfter));
    if (value.totalHits <= rule.max) return null;
    res.set('Retry-After', String(retryAfter));
    void recordRateLimitAudit(req, group).catch(() => {});
    const message = rule.rateLimitedMessage === true
      ? `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${Math.ceil(retryAfter / 60) === 1 ? '' : 's'}.`
      : 'Please try again shortly';
    const error = new Error(message);
    error.status = 429;
    error.code = 'rate_limited';
    error.retryAfter = retryAfter;
    return error;
  }

  function failOpen(req, res, next, rule) {
    if (rule.store === 'mongo' && rule.sensitive) {
      res.set('Retry-After', '1');
      const error = new Error('Please try again shortly');
      error.status = 503;
      error.retryAfter = 1;
      return next(error);
    }
    warnStoreFailure();
    return next();
  }

  function limit(group, options = {}) {
    const rule = groupConfig(group);
    if (!rule?.windowMs || !rule?.max) throw new TypeError(`Unknown rate-limit group: ${group}`);
    const middleware = function rateLimit(req, res, next) {
      if (req.method === 'OPTIONS' || options.skip?.(req)) return next();
      const identity = getIdentity(req, group, options);
      if (!identity) return next();
      return incrementGroup(group, identity.rule, identity.id).then((value) => {
        const error = rateLimitError(req, res, group, identity.rule, value);
        return error ? next(error) : next();
      }).catch(() => failOpen(req, res, next, identity.rule));
    };
    middleware.rateLimitGroup = group;
    return middleware;
  }
  function parseGroups(groups) {
    if (!Array.isArray(groups) || groups.length < 2) throw new TypeError('At least two rate-limit groups are required.');
    return groups.map((entry) => {
      const group = typeof entry === 'string' ? entry : entry.group;
      const options = typeof entry === 'string' ? {} : entry;
      const rule = groupConfig(group);
      if (!rule?.windowMs || !rule?.max) throw new TypeError(`Unknown rate-limit group: ${group}`);
      return { group, rule, options };
    });
  }

  function limitTogether(groups, condition = () => true) {
    const rules = parseGroups(groups);
    const taggedGroups = rules.map(({ group }) => group);
    const middleware = async function rateLimitTogether(req, res, next) {
      if (req.method === 'OPTIONS' || !condition(req)) return next();
      const identities = rules.map(({ group, options }) => ({
        group,
        options,
        ...getIdentity(req, group, options),
      }));
      if (identities.some(({ rule }) => !rule)) return next();
      if (identities[0].options?.skip?.(req) || identities[1].options?.skip?.(req)) return next();
      try {
        const previews = await Promise.all(identities.map(async ({ group, rule, id }) => {
          if (rule.store === 'mongo' && database) {
            const record = await withStoreTimeout(collection().findOne({ _id: id }));
            const live = record && record.expiresAt > new Date(now());
            return { group, rule, id, totalHits: live ? record.count : 0, resetTime: live ? record.expiresAt : new Date(now() + rule.windowMs) };
          }
          const value = await getStore(group, rule).peek(id, rule.windowMs);
          return { group, rule, id, ...value };
        }));
        const blocked = previews.find((entry) => entry.totalHits >= entry.rule.max);
        if (blocked) {
          const error = rateLimitError(req, res, blocked.group, blocked.rule, {
            totalHits: blocked.totalHits + 1,
            resetTime: blocked.resetTime,
          });
          return next(error);
        }
        const values = [];
        try {
          for (const { group, rule, id } of identities) {
            values.push(await incrementGroup(group, rule, id));
          }
        } catch (error) {
          await Promise.all(identities.slice(0, values.length)
            .map(({ group, rule, id }) => decrementGroup(group, rule, id).catch(() => {})));
          throw error;
        }
        const blockedAfterRace = values
          .map((value, index) => ({ ...identities[index], value }))
          .find(({ rule, value }) => value.totalHits > rule.max);
        if (blockedAfterRace) {
          await Promise.all(identities.map(({ group, rule, id }) => (
            decrementGroup(group, rule, id).catch(() => {})
          )));
          return next(rateLimitError(req, res, blockedAfterRace.group, blockedAfterRace.rule, blockedAfterRace.value));
        }
        return next();
      } catch {
        const closed = identities.find(({ rule }) => rule.store === 'mongo' && rule.sensitive);
        if (closed) {
          res.set('Retry-After', '1');
          const error = new Error('Please try again shortly');
          error.status = 503;
          error.retryAfter = 1;
          error.rateLimitGroups = taggedGroups;
          return next(error);
        }
        warnStoreFailure();
        return next();
      }
    };
    middleware.rateLimitGroups = taggedGroups;
    return middleware;
  }

  const validationRule = groupConfig('validation_cooldown');
  const validationId = (integrationId) => hashIdentifier('validation_cooldown', 'resource', integrationId);

  function validationStoreError() {
    const error = new Error('Please try again shortly');
    error.status = 503;
    error.retryAfter = 1;
    error.code = 'rate_limited';
    return error;
  }

  async function checkValidationCooldown(integrationId) {
    if (!database || !validationRule?.sensitive) throw validationStoreError();
    const record = await withStoreTimeout(collection().findOne({ _id: validationId(integrationId) }))
      .catch(() => { throw validationStoreError(); });
    if (record?.lockedUntil && new Date(record.lockedUntil).getTime() > now()) {
      const error = new Error('Could not verify, try again');
      error.status = 429;
      error.code = 'validation_cooldown';
      error.retryAfter = Math.max(1, Math.ceil((new Date(record.lockedUntil).getTime() - now()) / 1000));
      throw error;
    }
  }

  async function recordValidationFailure(integrationId) {
    if (!database || !validationRule?.sensitive) throw validationStoreError();
    const id = validationId(integrationId);
    const expired = {
      $or: [{ $lte: ['$expiresAt', '$$NOW'] }, { $not: ['$expiresAt'] }],
    };
    const count = {
      $cond: [
        expired,
        1,
        { $add: [{ $ifNull: ['$count', 0] }, 1] },
      ],
    };
    try {
      await withStoreTimeout(collection().findOneAndUpdate(
        { _id: id },
        [{
          $set: {
            count,
            windowStartedAt: {
              $cond: [expired, '$$NOW', '$windowStartedAt'],
            },
            lockedUntil: {
              $cond: [
                { $gte: [count, validationRule.max] },
                { $add: ['$$NOW', validationRule.cooldownMs] },
                {
                  $cond: [
                    expired,
                    null,
                    '$lockedUntil',
                  ],
                },
              ],
            },
            expiresAt: {
              $cond: [
                expired,
                { $add: ['$$NOW', validationRule.windowMs + validationRule.cooldownMs] },
                '$expiresAt',
              ],
            },
            type: 'validation_cooldown',
          },
        }],
        { upsert: true, returnDocument: 'after' },
      ));
    } catch {
      throw validationStoreError();
    }
  }

  async function clearValidationFailures(integrationId) {
    if (!database || !validationRule?.sensitive) throw validationStoreError();
    await withStoreTimeout(collection().deleteOne({ _id: validationId(integrationId) }))
      .catch(() => { throw validationStoreError(); });
  }

  return {
    initialize,
    limit,
    limitTogether,
    recordRateLimitAudit,
    checkValidationCooldown,
    recordValidationFailure,
    clearValidationFailures,
  };
}

module.exports = { createRateLimitService, createMemoryStore, normalizeIp };
