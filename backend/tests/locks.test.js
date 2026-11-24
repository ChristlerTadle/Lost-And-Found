const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { MongoClient } = require('mongodb');
const {
  LockConflictError,
  LockServiceUnavailableError,
  createLockManager,
} = require('../../src/services/locks');

const mongoUri = process.env.MONGODB_TEST_URI;
const databaseName = process.env.MONGODB_TEST_DATABASE;
const testDatabaseConfigured = Boolean(mongoUri && databaseName);
if (testDatabaseConfigured
  && (databaseName === 'lost_and_found' || !/(^|[-_])test($|[-_])/i.test(databaseName))) {
  throw new Error('MONGODB_TEST_DATABASE must be a dedicated database name containing "test".');
}
if (Boolean(mongoUri) !== Boolean(databaseName)) {
  throw new Error('Set both MONGODB_TEST_URI and MONGODB_TEST_DATABASE to run lock tests.');
}

const settings = {
  leaseMs: 1_000,
  waitMs: 3_000,
  retryMinMs: 2,
  retryMaxMs: 15,
  maxPerRequest: 5,
  demoHoldMs: 0,
  isProduction: false,
};

test('MongoDB lock manager concurrency and lease behavior', {
  skip: !testDatabaseConfigured,
}, async (t) => {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3_000 });
  await client.connect();
  const database = client.db(databaseName);
  const auditEvents = [];
  const audit = { async logAction(event) { auditEvents.push(event); } };
  const locks = createLockManager(database, { audit, config: settings });
  const prefix = `locktest-${randomUUID()}`;
  const key = `item:${prefix}`;

  await locks.initialize();
  try {
    await t.test('creates a unique resource key index and TTL cleanup index', async () => {
      const indexes = await database.collection('resource_locks').listIndexes().toArray();
      assert.equal(indexes.find(({ name }) => name === 'resource_locks_key_unique')?.unique, true);
      assert.equal(
        indexes.find(({ name }) => name === 'resource_locks_expires_at_ttl')?.expireAfterSeconds,
        0,
      );
    });

    await t.test('sorts keys by the global order and id', () => {
      const sorted = locks.sortLockRequests([
        { key: `claim:${prefix}-a`, mode: 'X' },
        { key: `item:${prefix}-b`, mode: 'X' },
        { key: `account:${prefix}-a`, mode: 'X' },
        { key: 'role:admin', mode: 'X' },
        { key: 'roster', mode: 'X' },
      ]);
      assert.deepEqual(sorted.map(({ key: resourceKey }) => resourceKey), [
        'roster',
        'role:admin',
        `account:${prefix}-a`,
        `item:${prefix}-b`,
        `claim:${prefix}-a`,
      ]);
      assert.deepEqual(
        locks.sortLockRequests([
          { key: `account:${prefix}-b`, mode: 'S' },
          { key: `account:${prefix}-a`, mode: 'X' },
        ]).map(({ id }) => id),
        [`${prefix}-a`, `${prefix}-b`],
      );
      assert.deepEqual(
        locks.sortLockRequests([
          { key: `slot:${prefix}-later`, mode: 'X' },
          { key: `claim:${prefix}-a`, mode: 'X' },
        ]).map(({ type }) => type),
        ['claim', 'slot'],
      );
      assert.deepEqual(
        locks.sortLockRequests([
          { key, mode: 'S' },
          { key, mode: 'X' },
        ]).map(({ mode }) => mode),
        ['X'],
      );
    });

    await t.test('allows shared/shared and rejects every incompatible shared/exclusive pairing', async () => {
      const first = await locks.acquire(key, 'S', 'account-a');
      const second = await locks.acquire(key, 'S', 'account-b');
      await assert.rejects(
        locks.withLocks([{ key, mode: 'X' }], async () => {}, { owner: 'account-c', waitMs: 30 }),
        LockConflictError,
      );
      assert.equal(await locks.release(key, first), true);
      assert.equal(await locks.release(key, second), true);

      const exclusive = await locks.acquire(key, 'X', 'account-a');
      await assert.rejects(
        locks.withLocks([{ key, mode: 'S' }], async () => {}, { owner: 'account-b', waitMs: 30 }),
        LockConflictError,
      );
      await assert.rejects(
        locks.withLocks([{ key, mode: 'X' }], async () => {}, { owner: 'account-c', waitMs: 30 }),
        LockConflictError,
      );
      assert.equal(await locks.release(key, exclusive), true);
    });

    await t.test('waits for S before X and for X before S', async () => {
      const sharedToken = await locks.acquire(key, 'S', 'account-a');
      let exclusiveEntered = false;
      const exclusiveWait = locks.withLocks(
        [{ key, mode: 'X' }],
        async () => { exclusiveEntered = true; },
        { owner: 'account-b', waitMs: 1_000 },
      );
      await delay(40);
      assert.equal(exclusiveEntered, false);
      await locks.release(key, sharedToken);
      await exclusiveWait;
      assert.equal(exclusiveEntered, true);

      const exclusiveToken = await locks.acquire(key, 'X', 'account-a');
      let sharedEntered = false;
      const sharedWait = locks.withLocks(
        [{ key, mode: 'S' }],
        async () => { sharedEntered = true; },
        { owner: 'account-b', waitMs: 1_000 },
      );
      await delay(40);
      assert.equal(sharedEntered, false);
      await locks.release(key, exclusiveToken);
      await sharedWait;
      assert.equal(sharedEntered, true);
    });

    await t.test('nested withLocks is reentrant for the same request', async () => {
      const nestedLocks = createLockManager(database, {
        audit,
        config: { ...settings, waitMs: 30 },
      });
      await nestedLocks.initialize();
      let nestedEntered = false;
      await nestedLocks.withLocks(
        [{ key, mode: 'X' }],
        async () => {
          await nestedLocks.withLocks(
            [{ key, mode: 'X' }],
            async () => { nestedEntered = true; },
            { owner: 'account-a' },
          );
          await assert.rejects(nestedLocks.acquire(key, 'X', 'account-b'), LockConflictError);
        },
        { owner: 'account-a' },
      );
      assert.equal(nestedEntered, true);
      const token = await nestedLocks.acquire(key, 'X', 'account-b');
      assert.equal(await nestedLocks.release(key, token), true);
    });

    await t.test('a later timeout releases earlier acquisitions', async () => {
      const accountKey = `account:${prefix}-all-or-none`;
      const claimKey = `claim:${prefix}-all-or-none`;
      const claimToken = await locks.acquire(claimKey, 'X', 'account-a');
      await assert.rejects(
        locks.withLocks(
          [{ key: claimKey, mode: 'X' }, { key: accountKey, mode: 'X' }],
          async () => {},
          { owner: 'account-b', waitMs: 40 },
        ),
        LockConflictError,
      );
      const accountToken = await locks.acquire(accountKey, 'X', 'account-c');
      assert.equal(await locks.release(accountKey, accountToken), true);
      assert.equal(await locks.release(claimKey, claimToken), true);
    });

    await t.test('held edit-session tokens are validated and borrowed without reacquisition', async () => {
      const sessionKey = `item:${prefix}-edit-session`;
      const token = await locks.acquire(sessionKey, 'X', 'account-a');
      let entered = false;
      await locks.withLocks(
        [{ key: sessionKey, mode: 'X' }],
        async (lease) => {
          entered = true;
          assert.equal(lease.tokens[sessionKey], token);
        },
        { owner: 'account-a', heldTokens: { [sessionKey]: token } },
      );
      assert.equal(entered, true);
      await assert.rejects(
        locks.withLocks(
          [{ key: sessionKey, mode: 'X' }],
          async () => {},
          { owner: 'account-b', heldTokens: { [sessionKey]: 'invalid-token' }, waitMs: 20 },
        ),
        LockConflictError,
      );
      assert.equal(await locks.release(sessionKey, token), true);
    });

    await t.test('withLocks renews leases during long critical sections', async () => {
      const shortLeaseLocks = createLockManager(database, {
        audit,
        config: { ...settings, leaseMs: 120, waitMs: 30 },
      });
      await shortLeaseLocks.initialize();
      await shortLeaseLocks.withLocks(
        [{ key, mode: 'X' }],
        async (lease) => {
          await delay(220);
          await assert.rejects(
            shortLeaseLocks.acquire(key, 'X', 'account-b'),
            LockConflictError,
          );
          await lease.assertHeld(key);
        },
        { owner: 'account-a' },
      );
    });

    await t.test('twenty parallel exclusive sections never overlap', async () => {
      let active = 0;
      let maximumActive = 0;
      const runs = Array.from({ length: 20 }, (_, index) => locks.withLocks(
        [{ key, mode: 'X' }],
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await delay(5);
          active -= 1;
          return index;
        },
        { owner: `parallel-account-${index}`, waitMs: 5_000 },
      ));
      const results = await Promise.all(runs);
      assert.equal(results.length, 20);
      assert.equal(maximumActive, 1);
    });

    await t.test('only the token holder can release or renew', async () => {
      const token = await locks.acquire(key, 'X', 'account-a');
      assert.equal(await locks.renew(key, 'not-the-token'), false);
      assert.equal(await locks.release(key, 'not-the-token'), false);
      assert.equal(await locks.renew(key, token, 'X'), true);
      assert.equal(await locks.release(key, token), true);
    });

    await t.test('expired leases are taken over using database time before TTL cleanup', async () => {
      const shortLeaseLocks = createLockManager(database, {
        audit,
        config: { ...settings, leaseMs: 80 },
      });
      await shortLeaseLocks.initialize();
      const expiredKey = `item:${prefix}-expired`;
      const oldToken = await shortLeaseLocks.acquire(expiredKey, 'X', 'account-a');
      await delay(150);
      const newToken = await shortLeaseLocks.acquire(expiredKey, 'X', 'account-b');
      assert.notEqual(newToken, oldToken);
      assert.equal(await shortLeaseLocks.release(expiredKey, oldToken), false);
      assert.equal(await shortLeaseLocks.release(expiredKey, newToken), true);
      assert.equal(
        auditEvents.filter((event) => (
          event.action === 'lock.expired_takeover' && event.target_id === `${prefix}-expired`
        )).length,
        1,
      );
    });

    await t.test('withLocks releases every acquired key after a callback error', async () => {
      const accountKey = `account:${prefix}-error`;
      await assert.rejects(
        locks.withLocks(
          [{ key: `claim:${prefix}-error`, mode: 'X' }, { key: accountKey, mode: 'S' }],
          async () => { throw new Error('expected callback failure'); },
          { owner: 'account-a' },
        ),
        /expected callback failure/,
      );
      let entered = false;
      await locks.withLocks(
        [{ key: accountKey, mode: 'X' }, { key: `claim:${prefix}-error`, mode: 'X' }],
        async () => { entered = true; },
        { owner: 'account-b' },
      );
      assert.equal(entered, true);
    });

    await t.test('opposite input orders use the same global acquisition order', async () => {
      const accountKey = `account:${prefix}-ordered`;
      const itemKey = `item:${prefix}-ordered`;
      await Promise.all([
        locks.withLocks(
          [{ key: itemKey, mode: 'X' }, { key: accountKey, mode: 'X' }],
          () => delay(25),
          { owner: 'account-a' },
        ),
        locks.withLocks(
          [{ key: accountKey, mode: 'X' }, { key: itemKey, mode: 'X' }],
          () => delay(25),
          { owner: 'account-b' },
        ),
      ]);
    });

    await t.test('timeouts are bounded, typed, and audit contention once per operation', async () => {
      const timeoutKey = `item:${prefix}-timeout`;
      const heldToken = await locks.acquire(timeoutKey, 'X', 'account-a');
      const started = Date.now();
      await assert.rejects(
        locks.withLocks([{ key: timeoutKey, mode: 'X' }], async () => {}, { owner: 'account-b', waitMs: 60 }),
        (error) => error instanceof LockConflictError
          && error.status === 409
          && error.retryAfter === 1
          && error.message === 'This record is being processed by someone else. Try again in a moment.',
      );
      assert.ok(Date.now() - started < 1_000);
      assert.equal(await locks.release(timeoutKey, heldToken), true);
      assert.equal(
        auditEvents.filter((event) => (
          event.action === 'lock.conflict' && event.target_id === `${prefix}-timeout`
        )).length,
        1,
      );
      assert.equal(
        auditEvents.filter((event) => (
          event.action === 'lock.timeout' && event.target_id === `${prefix}-timeout`
        )).length,
        1,
      );
      assert.equal(auditEvents.some((event) => JSON.stringify(event).includes(heldToken)), false);
    });

    await t.test('MongoDB failures fail closed with a safe 503', async () => {
      const unavailableLocks = createLockManager({
        collection() {
          return {
            async createIndex() {},
            async findOneAndUpdate() { throw new Error('database details must not escape'); },
          };
        },
      }, { audit, config: settings });
      let criticalSectionEntered = false;
      await assert.rejects(
        unavailableLocks.withLocks(
          [{ key: `item:${prefix}-offline`, mode: 'X' }],
          async () => { criticalSectionEntered = true; },
          { owner: 'account-a' },
        ),
        (error) => error instanceof LockServiceUnavailableError
          && error.status === 503
          && !error.message.includes('database details'),
      );
      assert.equal(criticalSectionEntered, false);
    });
  } finally {
    await database.collection('resource_locks').deleteMany({ _id: { $regex: `^.+:${prefix}` } });
    await client.close();
  }
});

test('lock environment settings reject invalid values at startup', () => {
  const invalidLease = spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: process.cwd(),
    env: { ...process.env, LOCK_LEASE_MS: 'invalid' },
    stdio: 'ignore',
  });
  assert.notEqual(invalidLease.status, 0);

  const invalidBackoff = spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCK_RETRY_MIN_MS: '100',
      LOCK_RETRY_MAX_MS: '50',
    },
    stdio: 'ignore',
  });
  assert.notEqual(invalidBackoff.status, 0);
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
