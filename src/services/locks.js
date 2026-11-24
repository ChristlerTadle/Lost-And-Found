const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const defaultConfig = require('../config').locking;

const LOCK_ORDER = ['roster', 'role', 'account', 'item', 'claim', 'slot'];
const LOCK_CONFLICT_MESSAGE = 'This record is being processed by someone else. Try again in a moment.';
const LOCK_UNAVAILABLE_MESSAGE = 'Locking is temporarily unavailable. Please try again shortly.';

class LockConflictError extends Error {
  constructor(waitMs, message = LOCK_CONFLICT_MESSAGE, code = 'lock_conflict') {
    super(message);
    this.name = 'LockConflictError';
    this.status = 409;
    this.code = code;
    this.retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
  }
}

class LockServiceUnavailableError extends Error {
  constructor() {
    super(LOCK_UNAVAILABLE_MESSAGE);
    this.name = 'LockServiceUnavailableError';
    this.status = 503;
    this.code = 'lock_unavailable';
    this.retryAfter = 1;
  }
}

function parseLockKey(key) {
  if (key === 'roster') return { type: 'roster', id: '' };
  if (typeof key !== 'string' || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeError('A valid lock key is required.');
  }
  const separator = key.indexOf(':');
  if (separator < 1 || separator === key.length - 1) {
    throw new TypeError('A valid lock key is required.');
  }
  const type = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!LOCK_ORDER.includes(type) || type === 'roster') {
    throw new TypeError('A valid lock resource type is required.');
  }
  return { type, id };
}

function normalizeMode(mode) {
  if (mode === 'S' || mode === 'shared') return 'S';
  if (mode === 'X' || mode === 'exclusive') return 'X';
  throw new TypeError('Lock mode must be shared (S) or exclusive (X).');
}

function sortLockRequests(requests, maxPerRequest = defaultConfig.maxPerRequest) {
  if (!Array.isArray(requests)) throw new TypeError('Lock requests must be an array.');
  const merged = new Map();
  for (const request of requests) {
    if (!request || typeof request !== 'object') throw new TypeError('Each lock request must include a key and mode.');
    const resource = parseLockKey(request.key);
    const mode = normalizeMode(request.mode);
    const existing = merged.get(request.key);
    merged.set(request.key, {
      key: request.key,
      mode: existing?.mode === 'X' || mode === 'X' ? 'X' : 'S',
      ...resource,
    });
  }
  if (merged.size > maxPerRequest) {
    throw new RangeError(`A request may acquire at most ${maxPerRequest} locks.`);
  }
  return [...merged.values()].sort((left, right) => {
    const rank = LOCK_ORDER.indexOf(left.type) - LOCK_ORDER.indexOf(right.type);
    if (rank !== 0) return rank;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function createLockManager(database, { audit, config = defaultConfig, random = Math.random } = {}) {
  if (!database || typeof database.collection !== 'function') {
    throw new TypeError('A MongoDB database is required for locking.');
  }
  if (!audit || typeof audit.logAction !== 'function') {
    throw new TypeError('An audit service is required for locking.');
  }

  const settings = validateLockSettings(config);
  const collection = database.collection('resource_locks');
  const asyncContext = new AsyncLocalStorage();
  let initializePromise;

  async function initialize() {
    if (!initializePromise) {
      initializePromise = Promise.all([
        collection.createIndex(
          { key: 1 },
          {
            unique: true,
            partialFilterExpression: { key: { $type: 'string' } },
            name: 'resource_locks_key_unique',
          },
        ),
        collection.createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: 'resource_locks_expires_at_ttl' },
        ),
      ]).catch((error) => {
        initializePromise = undefined;
        throw unavailable(error);
      });
    }
    return initializePromise;
  }

  async function auditOnce(context, action, key, owner, result) {
    const dedupeKey = `${action}:${key}`;
    if (context?.auditEvents?.has(dedupeKey)) return;
    context?.auditEvents?.add(dedupeKey);
    const resource = parseLockKey(key);
    try {
      await audit.logAction({
        actor_id: owner || null,
        action,
        target_type: resource.type === 'roster' ? 'role' : resource.type,
        target_id: resource.id || 'roster',
        result,
      });
    } catch (error) {
      throw unavailable(error);
    }
  }

  async function findOneAndUpdateWithDuplicateRetry(key, pipeline, options) {
    await initialize();
    for (let duplicateAttempt = 0; duplicateAttempt < 2; duplicateAttempt += 1) {
      try {
        return await collection.findOneAndUpdate({ _id: key }, pipeline, {
          ...options,
          returnDocument: 'after',
          upsert: options.upsert === true,
          includeResultMetadata: false,
        });
      } catch (error) {
        if (error?.code === 11000 && duplicateAttempt === 0) continue;
        throw unavailable(error);
      }
    }
    throw new LockServiceUnavailableError();
  }

  async function acquireAtomic(key, mode, owner, requestId, token) {
    const outcome = acquisitionOutcome(mode, owner, requestId, token, settings.leaseMs);
    const pipeline = [
      { $set: { key: { $literal: key }, _lockOutcome: outcome } },
      {
        $set: {
          holders: '$_lockOutcome.holders',
          _lockAcquired: '$_lockOutcome.acquired',
          _lockTakeover: '$_lockOutcome.takeover',
        },
      },
      { $unset: '_lockOutcome' },
      { $set: { expiresAt: maxExpiryExpression() } },
    ];
    return findOneAndUpdateWithDuplicateRetry(key, pipeline, { upsert: true });
  }

  async function acquireInContext(key, mode, owner, context, waitMs) {
    parseLockKey(key);
    const normalizedMode = normalizeMode(mode);
    const ownerId = normalizeOwner(owner);
    let held = context.held.get(key);
    let token = held?.token || randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    let attempts = 0;
    let conflictAudited = false;

    while (true) {
      const document = await acquireAtomic(key, normalizedMode, ownerId, context.requestId, token);
      const acquired = Boolean(document?._lockAcquired
        && document.holders?.some((holder) => holder.token === token
          && holder.requestId === context.requestId));
      if (acquired) {
        if (document._lockTakeover) {
          try {
            await auditOnce(context, 'lock.expired_takeover', key, ownerId, 'success');
          } catch (error) {
            await release(key, token);
            throw error;
          }
        }
        if (held) held.mode = normalizedMode === 'X' || held.mode === 'X' ? 'X' : 'S';
        return token;
      }

      if (!conflictAudited) {
        await auditOnce(context, 'lock.conflict', key, ownerId, 'denied');
        conflictAudited = true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await auditOnce(context, 'lock.timeout', key, ownerId, 'failed');
        throw new LockConflictError(waitMs);
      }
      const cap = Math.min(settings.retryMaxMs, settings.retryMinMs * (2 ** Math.min(attempts, 20)));
      const delayMs = Math.floor(settings.retryMinMs + random() * Math.max(0, cap - settings.retryMinMs));
      await delay(Math.min(remaining, Math.max(1, delayMs)));
      attempts += 1;
    }
  }

  async function acquire(key, mode, owner) {
    const context = {
      requestId: randomUUID(),
      owner: normalizeOwner(owner),
      held: new Map(),
      auditEvents: new Set(),
    };
    return asyncContext.run(context, () => acquireInContext(
      key,
      mode,
      context.owner,
      context,
      settings.waitMs,
    ));
  }

  async function updateHeld(key, token, operation, expectedMode) {
    parseLockKey(key);
    if (typeof token !== 'string' || !token) return false;
    const normalizedExpectedMode = expectedMode === undefined ? undefined : normalizeMode(expectedMode);
    const holders = liveHoldersExpression();
    const tokenFilter = {
      $and: [
        { $eq: ['$$holder.token', { $literal: token }] },
        ...(normalizedExpectedMode ? [{ $eq: ['$$holder.mode', { $literal: normalizedExpectedMode }] }] : []),
      ],
    };
    const matching = {
      $filter: { input: holders, as: 'holder', cond: tokenFilter },
    };
    const nextHolders = operation === 'release'
      ? {
          $filter: {
            input: holders,
            as: 'holder',
            cond: { $ne: ['$$holder.token', { $literal: token }] },
          },
        }
      : {
          $map: {
            input: holders,
            as: 'holder',
            in: {
              $cond: [
                tokenFilter,
                { $mergeObjects: ['$$holder', { expiresAt: { $add: ['$$NOW', settings.leaseMs] } }] },
                '$$holder',
              ],
            },
          },
        };
    const outcome = {
      holders: nextHolders,
      succeeded: { $gt: [{ $size: matching }, 0] },
    };
    const pipeline = [
      { $set: { _lockOutcome: outcome } },
      {
        $set: {
          holders: '$_lockOutcome.holders',
          _lockOperationSucceeded: '$_lockOutcome.succeeded',
        },
      },
      { $unset: '_lockOutcome' },
      { $set: { expiresAt: maxExpiryExpression() } },
    ];
    const document = await findOneAndUpdateWithDuplicateRetry(key, pipeline, { upsert: false });
    return Boolean(document?._lockOperationSucceeded);
  }

  async function release(key, token) {
    return updateHeld(key, token, 'release');
  }

  async function renew(key, token, expectedMode) {
    return updateHeld(key, token, 'renew', expectedMode);
  }

  async function withLocks(requests, fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('withLocks requires a callback.');
    const requestOwners = new Set(requests
      .filter((request) => request && request.owner !== undefined)
      .map((request) => normalizeOwner(request.owner)));
    if (options.owner !== undefined) requestOwners.add(normalizeOwner(options.owner));
    if (requestOwners.size > 1) throw new TypeError('All locks in a request must have the same owner.');
    const inheritedContext = asyncContext.getStore();
    const owner = inheritedContext?.owner || [...requestOwners][0];
    if (!owner) throw new TypeError('withLocks requires an owner account id.');
    if (inheritedContext?.owner && requestOwners.size && !requestOwners.has(inheritedContext.owner)) {
      throw new TypeError('Nested lock owner does not match the request owner.');
    }
    const context = inheritedContext || {
      requestId: randomUUID(),
      owner,
      held: new Map(),
      auditEvents: new Set(),
    };
    const ordered = sortLockRequests(requests, settings.maxPerRequest);
    const waitMs = normalizeWaitMs(options.waitMs, settings.waitMs);
    const deadline = Date.now() + waitMs;
    const requestedKeys = new Set(ordered.map(({ key }) => key));
    const heldTokens = options.heldTokens || {};
    const unionSize = new Set([...context.held.keys(), ...requestedKeys]).size;
    if (unionSize > settings.maxPerRequest) {
      throw new RangeError(`A request may acquire at most ${settings.maxPerRequest} locks.`);
    }
    verifyNestedLockOrder(ordered, context.held);

    return asyncContext.run(context, async () => {
      const references = [];
      let callbackError;
      let heartbeatError;
      let heartbeatRunning = false;
      let heartbeatStopped = false;
      let heartbeatTimer;
      try {
        for (const request of ordered) {
          const borrowedToken = heldTokens[request.key];
          if (borrowedToken) {
            const existing = context.held.get(request.key);
            if (existing && existing.token !== borrowedToken) {
              throw new LockConflictError(waitMs);
            }
            if (!await renew(request.key, borrowedToken, request.mode)) {
              await auditOnce(context, 'lock.conflict', request.key, context.owner, 'denied');
              throw new LockConflictError(
                waitMs,
                'This record lock is no longer held. Reload and try again.',
                'lock_lost',
              );
            }
            context.held.set(request.key, {
              token: borrowedToken,
              owner: context.owner,
              mode: request.mode,
              refs: (existing?.refs || 0) + 1,
              borrowed: true,
            });
            references.push(request.key);
            continue;
          }

          const existing = context.held.get(request.key);
          if (existing) {
            if (existing.owner !== context.owner) throw new TypeError('Nested lock owner does not match the request owner.');
            const valid = await renew(request.key, existing.token);
            if (!valid) {
              await auditOnce(context, 'lock.conflict', request.key, context.owner, 'denied');
              throw new LockConflictError(
                waitMs,
                'This record lock is no longer held. Reload and try again.',
                'lock_lost',
              );
            }
            if (request.mode === 'X' && existing.mode === 'S') {
              const remaining = Math.max(0, deadline - Date.now());
              await acquireInContext(request.key, 'X', context.owner, context, remaining);
              existing.mode = 'X';
            }
            existing.refs += 1;
            references.push(request.key);
            continue;
          }

          const remaining = Math.max(0, deadline - Date.now());
          const token = await acquireInContext(
            request.key,
            request.mode,
            context.owner,
            context,
            remaining,
          );
          context.held.set(request.key, {
            token,
            owner: context.owner,
            mode: request.mode,
            refs: 1,
            borrowed: false,
          });
          references.push(request.key);
        }

        const lease = {
          tokens: Object.fromEntries([...new Set(references)].map((key) => [key, context.held.get(key).token])),
          assertHeld: async (key) => {
            const keys = key ? [key] : [...new Set(references)];
            for (const heldKey of keys) {
              const held = context.held.get(heldKey);
              if (!held || !await renew(heldKey, held.token, held.mode)) {
                await auditOnce(context, 'lock.conflict', heldKey, context.owner, 'denied');
                throw new LockConflictError(
                  waitMs,
                  'This record lock is no longer held. Reload and try again.',
                  'lock_lost',
                );
              }
            }
          },
        };
        lease.renew = lease.assertHeld;

        heartbeatTimer = setInterval(async () => {
          if (heartbeatStopped || heartbeatRunning) return;
          heartbeatRunning = true;
          try {
            await lease.assertHeld();
          } catch (error) {
            heartbeatError = error;
            heartbeatStopped = true;
          } finally {
            heartbeatRunning = false;
          }
        }, Math.max(1, Math.floor(settings.leaseMs / 3)));
        heartbeatTimer.unref?.();

        if (settings.demoHoldMs > 0) await delay(settings.demoHoldMs);
        const result = await fn(lease);
        if (heartbeatError) throw heartbeatError;
        return result;
      } catch (error) {
        callbackError = error;
        throw error;
      } finally {
        heartbeatStopped = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        while (heartbeatRunning) await delay(1);
        let releaseError;
        for (const key of references.reverse()) {
          const held = context.held.get(key);
          if (!held) continue;
          held.refs -= 1;
          if (held.refs > 0) continue;
          context.held.delete(key);
          if (held.borrowed) continue;
          try {
            await release(key, held.token);
          } catch (error) {
            releaseError = releaseError || error;
          }
        }
        if (releaseError) {
          if (!callbackError) throw releaseError;
          console.error('Lock release failed; the lease will expire automatically.');
        }
      }
    });
  }

  return {
    acquire,
    release,
    renew,
    withLocks,
    initialize,
    sortLockRequests: (requests) => sortLockRequests(requests, settings.maxPerRequest),
  };
}

function acquisitionOutcome(mode, owner, requestId, token, leaseMs) {
  const current = { $ifNull: ['$holders', []] };
  const live = liveHoldersExpression();
  const mine = {
    $filter: {
      input: live,
      as: 'holder',
      cond: { $eq: ['$$holder.requestId', { $literal: requestId }] },
    },
  };
  const others = {
    $filter: {
      input: live,
      as: 'holder',
      cond: { $ne: ['$$holder.requestId', { $literal: requestId }] },
    },
  };
  const blockingHolders = mode === 'S'
    ? {
        $filter: {
          input: others,
          as: 'holder',
          cond: { $eq: ['$$holder.mode', 'X'] },
        },
      }
    : others;
  const newHolder = {
    token: {
      $cond: [
        { $gt: [{ $size: '$$mine' }, 0] },
        { $arrayElemAt: ['$$mine.token', 0] },
        { $literal: token },
      ],
    },
    owner: { $literal: owner },
    mode: {
      $cond: [
        {
          $and: [
            { $gt: [{ $size: '$$mine' }, 0] },
            { $in: ['X', '$$mine.mode'] },
          ],
        },
        'X',
        { $literal: mode },
      ],
    },
    expiresAt: { $add: ['$$NOW', leaseMs] },
    requestId: { $literal: requestId },
  };
  return {
    $let: {
      vars: { current, live, mine, others, blockingHolders },
      in: {
        $let: {
          vars: {
            allowed: { $eq: [{ $size: '$$blockingHolders' }, 0] },
            holder: newHolder,
          },
          in: {
            holders: {
              $cond: [
                '$$allowed',
                {
                  $concatArrays: [
                    {
                      $filter: {
                        input: '$$live',
                        as: 'holder',
                        cond: { $ne: ['$$holder.requestId', { $literal: requestId }] },
                      },
                    },
                    ['$$holder'],
                  ],
                },
                '$$live',
              ],
            },
            acquired: '$$allowed',
            takeover: {
              $and: [
                '$$allowed',
                { $gt: [{ $size: '$$current' }, { $size: '$$live' }] },
              ],
            },
          },
        },
      },
    },
  };
}

function liveHoldersExpression() {
  return {
    $filter: {
      input: { $ifNull: ['$holders', []] },
      as: 'holder',
      cond: { $gt: ['$$holder.expiresAt', '$$NOW'] },
    },
  };
}

function maxExpiryExpression() {
  return {
    $reduce: {
      input: { $ifNull: ['$holders', []] },
      initialValue: '$$NOW',
      in: { $max: ['$$value', '$$this.expiresAt'] },
    },
  };
}

function validateLockSettings(config) {
  const settings = {
    leaseMs: config?.leaseMs,
    waitMs: config?.waitMs,
    retryMinMs: config?.retryMinMs,
    retryMaxMs: config?.retryMaxMs,
    maxPerRequest: config?.maxPerRequest,
    demoHoldMs: config?.demoHoldMs,
    isProduction: config?.isProduction === true,
  };
  for (const name of ['leaseMs', 'waitMs', 'retryMinMs', 'retryMaxMs', 'maxPerRequest']) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < 1) {
      throw new TypeError(`Lock setting ${name} must be a positive safe integer.`);
    }
  }
  if (!Number.isSafeInteger(settings.demoHoldMs) || settings.demoHoldMs < 0) {
    throw new TypeError('Lock setting demoHoldMs must be a non-negative safe integer.');
  }
  if (settings.retryMinMs > settings.retryMaxMs) {
    throw new TypeError('Lock retry minimum must not exceed its maximum.');
  }
  if (settings.isProduction) settings.demoHoldMs = 0;
  return settings;
}

function normalizeOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 128) {
    throw new TypeError('A valid owner account id is required.');
  }
  return owner.trim();
}

function normalizeWaitMs(value, fallback) {
  const waitMs = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new TypeError('waitMs must be a non-negative safe integer.');
  }
  return waitMs;
}

function verifyNestedLockOrder(requests, held) {
  if (!held.size) return;
  const newKeys = requests.filter(({ key }) => !held.has(key));
  if (!newKeys.length) return;
  const current = sortLockRequests([...held].map(([key, value]) => ({ key, mode: value.mode })));
  const lastHeld = current[current.length - 1];
  if (newKeys.some((request) => compareLockOrder(request, lastHeld) < 0)) {
    throw new TypeError('Nested locks must follow the global lock order.');
  }
}

function compareLockOrder(left, right) {
  const typeDifference = LOCK_ORDER.indexOf(left.type) - LOCK_ORDER.indexOf(right.type);
  if (typeDifference !== 0) return typeDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function unavailable() {
  return new LockServiceUnavailableError();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  LOCK_CONFLICT_MESSAGE,
  LockConflictError,
  LockServiceUnavailableError,
  createLockManager,
  sortLockRequests,
};
