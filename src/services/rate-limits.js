const crypto = require('node:crypto');
const net = require('node:net');

function normalizeIp(ipAddress) {
  const ip = String(ipAddress || '').trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return ip || 'unknown';
  const words = ipv6Words(ip);
  if (!words) return ip;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [
      (words[6] >> 8) & 0xff, words[6] & 0xff,
      (words[7] >> 8) & 0xff, words[7] & 0xff,
    ].join('.');
  }
  return `${words.slice(0, 4).map((word) => word.toString(16)).join(':')}::/64`;
}

function ipv6Words(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const words = [];
    for (const part of half.split(':')) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
          return null;
        }
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[\da-f]{1,4}$/i.test(part)) return null;
        words.push(Number.parseInt(part, 16));
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

function isHealthRequest(req) {
  const path = req.path || req.url || '';
  return path === '/health' || path === '/api/health';
}

function resultDocument(result) {
  return result?.value && !result._id ? result.value : result;
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
    const rateLimitCollection = collection();
    try {
      await rateLimitCollection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'rate_limits_expiresAt_ttl' },
      );
    } catch (error) {
      const indexes = await rateLimitCollection.listIndexes().toArray();
      const existingTtlIndex = indexes.some((index) => (
        Object.keys(index.key || {}).length === 1
        && index.key.expiresAt === 1
        && index.expireAfterSeconds === 0
      ));
      if (!existingTtlIndex) throw error;
    }
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
      {
        upsert: true,
        returnDocument: 'after',
        includeResultMetadata: false,
        maxTimeMS: 200,
        timeoutMS: 200,
      },
    );
    const result = resultDocument(await withStoreTimeout(operation));
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

  async function recordRateLimitAudit(req, group, keyType, suppliedIdentifier) {
    if (!database || !audit) return;
    if (keyType && suppliedIdentifier !== undefined) {
      return recordAudit({
        group,
        keyType,
        identifier: suppliedIdentifier,
        targetId: group,
      });
    }
    const accountId = req.session?.user?.id ? String(req.session.user.id) : '';
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress);
    const identifier = `${accountId || 'anonymous'}\0${ip}`;
    return recordAudit({
      group,
      keyType: 'account+ip',
      identifier,
      action: 'rate_limited',
      targetId: group,
    });
  }

  async function recordAudit({
    group,
    keyType,
    identifier,
    action = 'rate_limited',
    targetId = group,
    targetType = null,
  }) {
    if (!database || !audit) return;
    const dedupeIdentifier = `${group}\0${keyType}\0${identifier}`;
    const id = hashIdentifier('rate_limited_audit', 'dedupe', dedupeIdentifier);
    if (!auditCollection) auditCollection = collection();
    try {
      const expired = { $lte: [{ $ifNull: ['$auditWindowExpiresAt', new Date(0)] }, '$$NOW'] };
      const result = resultDocument(await withStoreTimeout(auditCollection.findOneAndUpdate(
        { _id: id },
        [{
          $set: {
            count: {
              $cond: [expired, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }],
            },
            suppressedCount: {
              $cond: [expired, 0, { $add: [{ $ifNull: ['$suppressedCount', 0] }, 1] }],
            },
            previousSuppressedCount: {
              $cond: [expired, { $ifNull: ['$suppressedCount', 0] }, '$previousSuppressedCount'],
            },
            auditWindowExpiresAt: {
              $cond: [expired, { $add: ['$$NOW', 10 * 60 * 1000] }, '$auditWindowExpiresAt'],
            },
            expiresAt: {
              $cond: [expired, { $add: ['$$NOW', 24 * 60 * 60 * 1000] }, '$expiresAt'],
            },
            type: 'rate_limited_audit',
          },
        }],
        {
          upsert: true,
          returnDocument: 'after',
          includeResultMetadata: false,
          maxTimeMS: 200,
          timeoutMS: 200,
        },
      )));
      if (result?.count !== 1 || typeof audit.logAction !== 'function') return;
      await audit.logAction({
        actor_id: null,
        actor_role: null,
        action,
        target_type: targetType,
        target_id: targetId,
        new_value: {
          module: group,
          action_group: group,
          suppressed_count: result.previousSuppressedCount || 0,
        },
        result: action === 'integration.rate_limited' ? 'failed' : 'denied',
      });
    } catch {
      warnStoreFailure();
    }
  }

  function groupConfig(group) {
    return config[group] || {};
  }

  function getIdentity(req, group, options = {}, configuredRule) {
    const rule = configuredRule || groupConfig(group);
    const accountId = req.session?.user?.id ? String(req.session.user.id) : null;
    if ((rule.keyType === 'account' || rule.keyType === 'account+ip'
      || rule.keyType === 'account+item' || rule.keyType === 'account+resource') && !accountId) {
      return null;
    }
    let identifier = accountId || '';
    if (rule.keyType === 'ip') identifier = normalizeIp(req.ip || req.socket?.remoteAddress);
    if (rule.keyType === 'email') {
      identifier = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
    }
    if (rule.keyType === 'ip+email') {
      const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
      identifier = `${normalizeIp(req.ip || req.socket?.remoteAddress)}\0${email}`;
    }
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
    const identityGroup = rule.group || group;
    return {
      rule,
      group: identityGroup,
      identifier,
      id: hashIdentifier(identityGroup, rule.keyType, identifier),
    };
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
      await withStoreTimeout(collection().updateOne(
        { _id: id, count: { $gt: 0 } },
        { $inc: { count: -1 } },
        { maxTimeMS: 200, timeoutMS: 200 },
      ));
      return;
    }
    await getStore(group, rule).decrement(id);
  }

  async function resetGroup(group, rule, id) {
    if (rule.store === 'mongo' && database) {
      await withStoreTimeout(collection().deleteOne(
        { _id: id },
        { maxTimeMS: 200, timeoutMS: 200 },
      ));
      return;
    }
    await getStore(group, rule).resetKey(id);
  }

  function attachLoginCounterFinalizer(req, counter) {
    let finalized = false;
    req.rateLimitReset = async () => {
      if (finalized) return;
      finalized = true;
      try {
        await resetGroup(counter.group, counter.rule, counter.id);
      } catch {
        throw storeUnavailableError();
      }
    };
    req.rateLimitFinalize = async (status) => {
      if (finalized) return;
      finalized = true;
      if (status === counter.rule.failedStatus) return;
      try {
        if (status >= 200 && status < 400) {
          await resetGroup(counter.group, counter.rule, counter.id);
        } else {
          await decrementGroup(counter.group, counter.rule, counter.id);
        }
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
        await decrementGroup(counter.group, counter.rule, counter.id);
      } catch {
        warnStoreFailure();
      }
    };
  }

  function rateLimitError(req, res, group, rule, value, messageOverride, auditIdentifier) {
    const resetTime = value.resetTime instanceof Date ? value.resetTime : new Date(value.resetTime);
    const retryAfter = Math.max(1, Math.ceil((resetTime.getTime() - now()) / 1000));
    res.set('RateLimit-Limit', String(rule.max));
    res.set('RateLimit-Remaining', String(Math.max(0, rule.max - value.totalHits)));
    res.set('RateLimit-Reset', String(retryAfter));
    if (value.totalHits <= rule.max) return null;
    res.set('Retry-After', String(retryAfter));
    void recordRateLimitAudit(req, group, rule.keyType, auditIdentifier).catch(() => {});
    const message = messageOverride || (rule.rateLimitedMessage === true
      ? `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${Math.ceil(retryAfter / 60) === 1 ? '' : 's'}.`
      : 'Please try again shortly');
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
    const definition = groupConfig(group);
    const rules = definition?.rules
      ? definition.rules.map((rule) => ({ ...rule, group: rule.group || group }))
      : [{ ...definition, group }];
    if (!definition || rules.some((rule) => !rule.windowMs || !rule.max || !rule.keyType)) {
      throw new TypeError(`Unknown rate-limit group: ${group}`);
    }
    const middleware = async function rateLimit(req, res, next) {
      if (req.method === 'OPTIONS'
        || (group === 'global_api' && req.method === 'GET' && isHealthRequest(req))
        || options.skip?.(req)) return next();
      const applied = [];
      try {
        for (const rule of rules) {
          const identity = getIdentity(req, group, options, rule);
          if (!identity) continue;
          const value = await incrementGroup(identity.group, rule, identity.id);
          applied.push({ ...identity, id: identity.id });
          const error = rateLimitError(
            req,
            res,
            identity.group,
            rule,
            value,
            definition.rateLimitedMessage,
            identity.identifier,
          );
          if (error) {
            await Promise.all(applied.map((entry) => (
              decrementGroup(entry.group, entry.rule, entry.id).catch(() => {})
            )));
            return next(error);
          }
        }
        if (group === 'login' && applied.length) attachLoginCounterFinalizer(req, applied[0]);
        if (group === 'global_api' && applied.length) attachGlobalCounterRollback(req, applied[0]);
        return next();
      } catch {
        await Promise.all(applied.map((entry) => (
          decrementGroup(entry.group, entry.rule, entry.id).catch(() => {})
        )));
        const sensitive = rules.some((rule) => rule.sensitive);
        if (sensitive) {
          res.set('Retry-After', '1');
          const error = new Error('Please try again shortly');
          error.status = 503;
          error.retryAfter = 1;
          return next(error);
        }
        warnStoreFailure();
        return next();
      }
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
    recordAudit,
    checkValidationCooldown,
    recordValidationFailure,
    clearValidationFailures,
  };
}

module.exports = { createRateLimitService, createMemoryStore, normalizeIp };
