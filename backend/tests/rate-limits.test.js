const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createApiRouteModules } = require('../routes/api');
const { createRateLimitService, normalizeIp } = require('../../src/services/rate-limits');
const { buildRateLimitRows } = require('../../src/services/rate-limit-catalog');
const { createIntegrationCaller } = require('../../src/services/integration-calls');
const { ACTIONS } = require('../../src/services/audit-log');
const appConfig = require('../../src/config');

const keyTypeLabels = {
  account: 'per account',
  'account+ip': 'per account and IP',
  'account+item': 'per account and item',
  'account+resource': 'per account and integration',
  email: 'per email',
  ip: 'per IP',
  'ip+email': 'per IP and email',
  resource: 'per integration',
  session: 'per settings session',
};

function requestFor(accountId, ip = '192.0.2.10') {
  return {
    method: 'GET',
    ip,
    socket: { remoteAddress: ip },
    session: accountId ? { user: { id: accountId } } : {},
  };
}

function responseFor() {
  return {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
  };
}

test('TRUST_PROXY accepts false, hop counts, and CIDRs but not plain true', () => {
  assert.equal(appConfig.parseTrustProxy(undefined), false);
  assert.equal(appConfig.parseTrustProxy('2'), 2);
  assert.deepEqual(appConfig.parseTrustProxy('10.0.0.0/8,2001:db8::/32'), [
    '10.0.0.0/8', '2001:db8::/32',
  ]);
  assert.throws(() => appConfig.parseTrustProxy('true'), /TRUST_PROXY/);
});

test('lock conflicts roll back every applied rate-limit counter', async () => {
  const conflictConfig = {
    global_api: { windowMs: 60_000, max: 1, keyType: 'ip', store: 'memory', sensitive: false },
    user_reads: { windowMs: 60_000, max: 1, keyType: 'account', store: 'memory', sensitive: false },
    item_images: { windowMs: 60_000, max: 1, keyType: 'account', store: 'memory', sensitive: false },
    admin_user_write: { windowMs: 60_000, max: 1, keyType: 'account+ip', store: 'memory', sensitive: false },
    role_permission_write: { windowMs: 60_000, max: 1, keyType: 'account+ip', store: 'memory', sensitive: false },
  };
  const service = createRateLimitService({ config: conflictConfig });
  const request = requestFor('account-a');
  const run = (middleware, req) => new Promise((resolve) => (
    middleware(req, responseFor(), (error) => resolve(error || null))
  ));
  const groups = [
    service.limit('global_api'),
    service.limit('user_reads'),
    service.limit('item_images'),
  ];
  for (const middleware of groups) assert.equal(await run(middleware, request), null);
  assert.equal(typeof request.rateLimitConflictRollback, 'function');
  await request.rateLimitConflictRollback();

  const retryRequest = requestFor('account-a');
  for (const middleware of groups) assert.equal(await run(middleware, retryRequest), null);
  await retryRequest.rateLimitConflictRollback();

  const together = service.limitTogether(['admin_user_write', 'role_permission_write']);
  const combinedRequest = requestFor('admin-a');
  assert.equal(await run(together, combinedRequest), null);
  await combinedRequest.rateLimitConflictRollback();
  const combinedRetry = requestFor('admin-a');
  assert.equal(await run(together, combinedRetry), null);
});

function assertRateLimitCoverage(registered, rateLimits, tableRows, exemptions, configuredControls = []) {
  const exemptionSet = new Set(exemptions.map(({ method, path }) => `${method} ${path}`));
  const ungroupedRoutes = [];
  const usedGroups = new Set(['global_api']);
  for (const { route, groups } of registered) {
    if (!groups.length) {
      ungroupedRoutes.push(route);
      continue;
    }
    for (const group of groups) {
      assert.ok(rateLimits[group], `${route} uses unknown limiter group ${group}`);
      usedGroups.add(group);
    }
  }
  assert.deepEqual(
    ungroupedRoutes.sort(),
    [...exemptionSet].sort(),
    'Ungrouped routes must match the explicit exemption list exactly.',
  );
  for (const group of Object.keys(rateLimits)) {
    assert.ok(usedGroups.has(group), `Rate-limit group ${group} is not used by a route`);
  }
  const tableGroups = new Set(tableRows
    .filter((row) => row.kind === 'route')
    .map((row) => row.configGroup));
  for (const group of Object.keys(rateLimits)) {
    assert.ok(tableGroups.has(group), `Settings table omits rate-limit group ${group}`);
  }
  const tableControlIds = new Set(tableRows
    .filter((row) => row.kind === 'control')
    .map((row) => row.controlId));
  for (const control of configuredControls) {
    assert.ok(tableControlIds.has(control.id), `Settings table omits control ${control.id}`);
  }
}

const config = {
  user_reads: { windowMs: 60_000, max: 120, keyType: 'account', store: 'memory', sensitive: false },
  item_images: { windowMs: 60_000, max: 600, keyType: 'account', store: 'memory', sensitive: false },
  report_create: { windowMs: 60_000, max: 2, keyType: 'account+ip', store: 'memory', sensitive: false },
  claim_item: { windowMs: 86_400_000, max: 3, keyType: 'account+item', store: 'memory', sensitive: false },
  notification_write: { windowMs: 60_000, max: 60, keyType: 'account+ip', store: 'memory', sensitive: false },
  staff_reads: { windowMs: 60_000, max: 2, keyType: 'account', store: 'memory', sensitive: false },
  staff_item_images: { windowMs: 60_000, max: 3, keyType: 'account', store: 'memory', sensitive: false },
  admin_reads: { windowMs: 60_000, max: 2, keyType: 'account', store: 'memory', sensitive: false },
  admin_item_images: { windowMs: 60_000, max: 3, keyType: 'account', store: 'memory', sensitive: false },
  admin_user_write: { windowMs: 60_000, max: 1, keyType: 'account+ip', store: 'memory', sensitive: false },
  role_permission_write: { windowMs: 60_000, max: 1, keyType: 'account+ip', store: 'memory', sensitive: false },
};

const staffAdminGroups = [
  'staff_reads', 'staff_item_images', 'staff_writes', 'staff_calendar_retry',
  'admin_reads', 'admin_item_images', 'admin_user_write', 'role_permission_write',
  'admin_item_write', 'admin_inventory', 'admin_system_records',
];
const staffAdminTestConfig = Object.fromEntries(staffAdminGroups.map((group) => [
  group,
  {
    windowMs: 1000,
    max: 1,
    keyType: ['staff_reads', 'staff_item_images', 'admin_reads', 'admin_item_images', 'admin_inventory', 'admin_system_records'].includes(group)
      ? 'account'
      : 'account+ip',
    store: group.includes('reads') || group.includes('images') || group === 'admin_inventory' || group === 'admin_system_records'
      ? 'memory' : 'mongo',
    sensitive: false,
  },
]));

test('user module limiter returns 429 after the limit and resets', async () => {
  let timestamp = 0;
  const service = createRateLimitService({ config, now: () => timestamp });
  const limit = service.limit('report_create');
  let proceeded = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    limit(requestFor('user-a'), responseFor(), (error) => { if (!error) proceeded += 1; });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(proceeded, 2);
  timestamp += 60_000;
  limit(requestFor('user-a'), responseFor(), (error) => { if (!error) proceeded += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(proceeded, 3);
});

test('account and account-plus-IP groups isolate users', async () => {
  const service = createRateLimitService({ config, now: Date.now });
  const accountLimit = service.limit('user_reads');
  const ipLimit = service.limit('report_create');
  let accountProceed = 0;
  let ipProceed = 0;
  for (let attempt = 0; attempt < 121; attempt += 1) {
    accountLimit(requestFor('user-a'), responseFor(), (error) => { if (!error) accountProceed += 1; });
  }
  accountLimit(requestFor('user-b'), responseFor(), (error) => { if (!error) accountProceed += 1; });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ipLimit(requestFor('staff-a', '192.0.2.20'), responseFor(), (error) => { if (!error) ipProceed += 1; });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accountProceed, 121);
  assert.equal(ipProceed, 2);
});

test('claim item limit is per account and item', async () => {
  const service = createRateLimitService({ config, now: Date.now });
  const limit = service.limit('claim_item', { identifier: (req) => req.body?.item_id });
  let proceeded = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const req = requestFor('user-a');
    req.body = { item_id: 'item-a' };
    limit(req, responseFor(), (error) => { if (!error) proceeded += 1; });
  }
  const different = requestFor('user-a');
  different.body = { item_id: 'item-b' };
  limit(different, responseFor(), (error) => { if (!error) proceeded += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(proceeded, 4);
});

test('IPv4-mapped IPv6 and /64 normalization are stable', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeIp('2001:db8:1234:5678::1'), '2001:db8:1234:5678::/64');
});

test('staff and admin image groups have separate per-account budgets', async () => {
  const service = createRateLimitService({ config, now: Date.now });
  let staffImages = 0;
  let staffReads = 0;
  let adminImages = 0;
  let adminReads = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    service.limit('staff_item_images')(requestFor('staff-a'), responseFor(), (error) => { if (!error) staffImages += 1; });
    service.limit('admin_item_images')(requestFor('admin-a'), responseFor(), (error) => { if (!error) adminImages += 1; });
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    service.limit('staff_reads')(requestFor('staff-a'), responseFor(), (error) => { if (!error) staffReads += 1; });
    service.limit('admin_reads')(requestFor('admin-a'), responseFor(), (error) => { if (!error) adminReads += 1; });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staffImages, 3);
  assert.equal(adminImages, 3);
  assert.equal(staffReads, 2);
  assert.equal(adminReads, 2);
});

test('combined role-change limits do not consume either counter when blocked', async () => {
  const service = createRateLimitService({ config, now: Date.now });
  const userWrite = service.limit('admin_user_write');
  const roleWrite = service.limit('role_permission_write');
  const both = service.limitTogether(['admin_user_write', 'role_permission_write']);
  const req = requestFor('admin-a');
  const run = (middleware) => new Promise((resolve) => middleware(req, responseFor(), (error) => resolve(error || null)));

  assert.equal(await run(roleWrite), null);
  assert.equal((await run(both))?.status, 429);
  assert.equal(await run(userWrite), null);
  assert.equal((await run(userWrite))?.status, 429);

  const secondService = createRateLimitService({ config, now: Date.now });
  const secondUserWrite = secondService.limit('admin_user_write');
  const secondRoleWrite = secondService.limit('role_permission_write');
  const secondBoth = secondService.limitTogether(['admin_user_write', 'role_permission_write']);
  const secondRun = (middleware) => new Promise((resolve) => middleware(req, responseFor(), (error) => resolve(error || null)));
  assert.equal(await secondRun(secondUserWrite), null);
  assert.equal((await secondRun(secondBoth))?.status, 429);
  assert.equal(await secondRun(secondRoleWrite), null);
  assert.equal((await secondRun(secondRoleWrite))?.status, 429);
});

test('each staff/admin group limits, returns 429, and resets its window', async () => {
  let timestamp = 10_000;
  const service = createRateLimitService({ config: staffAdminTestConfig, now: () => timestamp });
  const req = requestFor('account-a');
  for (const group of staffAdminGroups) {
    const middleware = service.limit(group);
    const run = () => new Promise((resolve) => middleware(req, responseFor(), (error) => resolve(error || null)));
    assert.equal(await run(), null, `${group} should allow the first request`);
    assert.equal((await run())?.status, 429, `${group} should reject over-limit requests`);
    timestamp += 1001;
    assert.equal(await run(), null, `${group} should reset after its window`);
  }
});

test('staff and admin accounts do not share counters, and missing sessions skip account limits', async () => {
  const service = createRateLimitService({ config, now: Date.now });
  const limiter = service.limit('staff_reads');
  const run = (req) => new Promise((resolve) => limiter(req, responseFor(), (error) => resolve(error || null)));
  assert.equal(await run(requestFor('staff-a')), null);
  assert.equal(await run(requestFor('staff-a')), null);
  assert.equal((await run(requestFor('staff-a')))?.status, 429);
  assert.equal(await run(requestFor('staff-b')), null);
  const noSession = { ...requestFor(null) };
  assert.equal(await run(noSession), null);
});

test('validation cooldown persists across service instances and clears on success', async () => {
  let timestamp = 20_000;
  const documents = new Map();
  const database = {
    collection() {
      return {
        async findOne({ _id }) {
          const entry = documents.get(_id);
          return entry ? structuredClone(entry) : null;
        },
        async findOneAndUpdate({ _id }, _pipeline, { upsert }) {
          const entry = documents.get(_id);
          if (!entry && !upsert) return null;
          const count = entry && entry.expiresAt > timestamp ? entry.count + 1 : 1;
          const result = {
            _id,
            count,
            expiresAt: new Date(timestamp + appConfig.rateLimitControls.validationCooldown.windowMs
              + appConfig.rateLimitControls.validationCooldown.cooldownMs),
            lockedUntil: count >= appConfig.rateLimitControls.validationCooldown.max
              ? new Date(timestamp + appConfig.rateLimitControls.validationCooldown.cooldownMs)
              : null,
            type: 'validation_cooldown',
          };
          documents.set(_id, result);
          return structuredClone(result);
        },
        async deleteOne({ _id }) {
          return { deletedCount: documents.delete(_id) ? 1 : 0 };
        },
        async createIndex() {},
      };
    },
  };
  const createService = () => createRateLimitService({
    database,
    secret: 'test-secret',
    config: appConfig.rateLimits,
    controls: appConfig.rateLimitControls,
    now: () => timestamp,
  });
  const firstService = createService();
  await firstService.initialize();
  for (let failure = 0; failure < appConfig.rateLimitControls.validationCooldown.max; failure += 1) {
    await firstService.recordValidationFailure('smtp');
  }
  assert.equal(documents.size, 1);
  assert.equal([...documents.keys()][0].includes('smtp'), false);

  const restartedService = createService();
  await assert.rejects(restartedService.checkValidationCooldown('smtp'), {
    status: 429,
    code: 'validation_cooldown',
  });
  timestamp += appConfig.rateLimitControls.validationCooldown.cooldownMs;
  await restartedService.checkValidationCooldown('smtp');
  await restartedService.clearValidationFailures('smtp');
  assert.equal(documents.size, 0);
});

test('settings overall and shared groups are paired without spending blocked counters', async () => {
  const service = createRateLimitService({
    config: appConfig.rateLimits,
    secret: 'test-secret',
    now: Date.now,
  });
  const req = requestFor('admin-a');
  const run = (middleware) => new Promise((resolve) => (
    middleware(req, responseFor(), (error) => resolve(error || null))
  ));
  const save = service.limitTogether(['settings_overall', 'settings_save']);
  const testConnection = service.limitTogether(['settings_overall', 'settings_tests']);

  for (let attempt = 0; attempt < appConfig.rateLimits.settings_save.max; attempt += 1) {
    assert.equal(await run(save), null);
  }
  assert.equal((await run(save))?.status, 429);
  for (let attempt = appConfig.rateLimits.settings_save.max; attempt < 100; attempt += 1) {
    assert.equal(await run(service.limit('settings_overall')), null);
  }
  assert.equal((await run(testConnection))?.status, 429);
});

test('settings store failures fail closed for writes and open for reads', async () => {
  const database = {
    collection() {
      return {
        async findOneAndUpdate() { throw new Error('simulated outage'); },
        async findOne() { throw new Error('simulated outage'); },
      };
    },
  };
  const service = createRateLimitService({
    database,
    config: appConfig.rateLimits,
    secret: 'test-secret',
  });
  const req = requestFor('admin-a');
  const response = responseFor();
  const run = (middleware, res = response) => new Promise((resolve) => (
    middleware(req, res, (error) => resolve(error || null))
  ));

  const writeError = await run(service.limit('settings_save'));
  assert.equal(writeError?.status, 503);
  assert.equal(response.headers['Retry-After'], '1');
  assert.equal(await run(service.limit('settings_read')), null);
  assert.equal(await run(service.limitTogether(['settings_overall', 'settings_read'])), null);
});

test('global API limiter exempts OPTIONS and GET health only', async () => {
  const service = createRateLimitService({
    config: {
      global_api: { windowMs: 1000, max: 1, keyType: 'ip', store: 'memory', sensitive: false },
    },
    now: Date.now,
  });
  const limit = service.limit('global_api');
  const run = (method, path) => new Promise((resolve) => {
    const req = { ...requestFor(null), method, path };
    limit(req, responseFor(), (error) => resolve(error || null));
  });

  assert.equal(await run('OPTIONS', '/items'), null);
  assert.equal(await run('GET', '/health'), null);
  assert.equal(await run('GET', '/api/health'), null);
  assert.equal(await run('GET', '/items'), null);
  assert.equal((await run('GET', '/items'))?.status, 429);
});

test('route-level 429 does not consume the global counter', async () => {
  const service = createRateLimitService({
    secret: 'test-only-counter-rollback-key',
    config: {
      global_api: { windowMs: 60_000, max: 2, keyType: 'ip', store: 'memory', sensitive: false },
      route_write: { windowMs: 60_000, max: 1, keyType: 'ip', store: 'memory', sensitive: false },
    },
  });
  const run = (middleware, req) => new Promise((resolve) => (
    middleware(req, responseFor(), (error) => resolve(error || null))
  ));
  const request = async (write) => {
    const req = {
      ...requestFor(null, '198.51.100.91'),
      method: write ? 'POST' : 'GET',
      path: write ? '/api/write' : '/api/probe',
    };
    const globalError = await run(service.limit('global_api'), req);
    if (globalError) return globalError.status;
    const routeError = write ? await run(service.limit('route_write'), req) : null;
    if (routeError) {
      await req.rateLimitGlobalRollback();
      return routeError.status;
    }
    return 200;
  };

  assert.equal(await request(true), 200);
  assert.equal(await request(true), 429);
  assert.equal(await request(false), 200);
  assert.equal(await request(false), 429);
});

test('Mongo counters serialize parallel hits and reset expired windows without TTL cleanup', async () => {
  let timestamp = 10_000;
  const database = createMongoCounterDatabase(() => timestamp);
  const service = createRateLimitService({
    database,
    secret: 'test-secret',
    config: {
      register: { windowMs: 1000, max: 20, keyType: 'ip', store: 'mongo', sensitive: false },
    },
    now: () => timestamp,
  });
  const middleware = service.limit('register');
  const run = () => new Promise((resolve) => middleware(
    { ...requestFor(null), method: 'POST', body: {} },
    responseFor(),
    (error) => resolve(error || null),
  ));
  const parallel = await Promise.all(Array.from({ length: 20 }, run));
  assert.equal(parallel.filter(Boolean).length, 0);
  const [stored] = [...database.documents.values()];
  assert.equal(stored.count, 20);
  assert.equal((await run())?.status, 429);

  stored.expiresAt = new Date(timestamp - 1);
  timestamp += 1000;
  assert.equal(await run(), null);
  assert.equal([...database.documents.values()][0].count, 1);
});

test('Mongo store timeout fails sensitive limits with a retryable response', async () => {
  const database = {
    collection() {
      return {
        findOneAndUpdate() { return new Promise(() => {}); },
      };
    },
  };
  const service = createRateLimitService({
    database,
    secret: 'test-only-timeout-key',
    config: {
      login: { windowMs: 60_000, max: 10, keyType: 'ip+email', store: 'mongo', sensitive: true },
    },
  });
  const response = responseFor();
  const error = await new Promise((resolve) => service.limit('login')(
    { ...requestFor(null), method: 'POST', body: { email: 'member@example.test' } },
    response,
    resolve,
  ));

  assert.equal(error?.status, 503);
  assert.equal(response.headers['Retry-After'], '1');
});

test('integration rate-limit audits persist, dedupe, and keep identifiers hashed', async () => {
  let timestamp = 10_000;
  const database = createMongoCounterDatabase(() => timestamp);
  const auditEvents = [];
  const audit = { async logAction(event) { auditEvents.push(event); } };
  const rateLimits = createRateLimitService({
    database,
    audit,
    secret: 'test-only-audit-key',
    config: {},
  });
  const privateValue = 'private-rate-limit@example.test';
  const ip = '203.0.113.217';
  const rawIdentifier = `${ip}\0${privateValue}`;

  await rateLimits.recordAudit({
    group: 'privacy_test',
    keyType: 'ip+email',
    identifier: rawIdentifier,
  });
  await rateLimits.recordAudit({
    group: 'privacy_test',
    keyType: 'ip+email',
    identifier: rawIdentifier,
  });
  await rateLimits.recordAudit({
    group: 'integration',
    keyType: 'integration+account',
    identifier: `google_auth\0${ip}`,
    action: 'integration.rate_limited',
    targetId: 'google_auth',
    targetType: 'integration',
  });
  await rateLimits.recordAudit({
    group: 'integration',
    keyType: 'integration+account',
    identifier: `google_auth\0${ip}`,
    action: 'integration.rate_limited',
    targetId: 'google_auth',
    targetType: 'integration',
  });

  const integrationSettings = {
    async getIntegration() { return { settings: { rate_limit_per_minute: '1' } }; },
    async recordIntegrationSuccess() {},
  };
  const callIntegration = createIntegrationCaller({
    integrationSettings,
    audit,
    rateLimits,
    now: () => timestamp,
  });
  await callIntegration('smtp', async () => true, {}, { bucketKey: privateValue });
  await assert.rejects(
    callIntegration('smtp', async () => true, {}, { bucketKey: privateValue }),
    { code: 'rate_limited' },
  );
  await assert.rejects(
    callIntegration('smtp', async () => true, {}, { bucketKey: privateValue }),
    { code: 'rate_limited' },
  );

  const stored = JSON.stringify([...database.documents.values()]);
  const logged = JSON.stringify(auditEvents);
  assert.equal(stored.includes(ip), false);
  assert.equal(stored.includes(privateValue), false);
  assert.equal(logged.includes(ip), false);
  assert.equal(logged.includes(privateValue), false);
  assert.equal(auditEvents.filter(({ action, target_id }) => (
    action === 'integration.rate_limited' && target_id === 'google_auth'
  )).length, 1);
  assert.equal(auditEvents.filter(({ action, target_id }) => (
    action === 'integration.rate_limited' && target_id === 'smtp'
  )).length, 1);
});

test('rate-limit initialization accepts an existing TTL index under a different name', async () => {
  let createIndexCalls = 0;
  const database = {
    collection() {
      return {
        async createIndex() {
          createIndexCalls += 1;
          throw new Error('Index already exists with a different name');
        },
        listIndexes() {
          return {
            async toArray() {
              return [{
                name: 'rate_limits_expiresAt_ttl',
                key: { expiresAt: 1 },
                expireAfterSeconds: 0,
              }];
            },
          };
        },
      };
    },
  };
  const service = createRateLimitService({ database });

  await service.initialize();
  await service.initialize();

  assert.equal(createIndexCalls, 1);
});

test('login counts failures, resets after success, and separates email keys', async () => {
  let timestamp = 5000;
  const service = createRateLimitService({
    config: {
      login: { windowMs: 1000, max: 2, keyType: 'ip+email', store: 'memory', sensitive: true, failedStatus: 401 },
    },
    now: () => timestamp,
  });
  const middleware = service.limit('login');
  const run = async (email, resultStatus) => {
    const req = { ...requestFor(null), method: 'POST', body: { email } };
    const error = await new Promise((resolve) => middleware(req, responseFor(), resolve));
    if (!error) await req.rateLimitFinalize(resultStatus);
    return error || null;
  };

  assert.equal(await run('Member@example.test', 401), null);
  assert.equal(await run('member@example.test', 401), null);
  assert.equal((await run('member@example.test', 401))?.status, 429);
  assert.equal(await run('other@example.test', 401), null);
  timestamp += 1000;
  const successful = { ...requestFor(null), method: 'POST', body: { email: 'member@example.test' } };
  await new Promise((resolve) => middleware(successful, responseFor(), resolve));
  await successful.rateLimitReset();
  assert.equal(await run('member@example.test', 401), null);

  timestamp += 1000;
  assert.equal(await run('member@example.test', 401), null);
});

test('auth groups return safe limits and fail closed or open per their policy', async () => {
  let timestamp = 100;
  const forgottenResponse = 'If an active account uses that email, reset instructions have been sent.';
  const definitions = {
    register: { windowMs: 1000, max: 1, keyType: 'ip', store: 'memory', sensitive: false },
    forgot: {
      rateLimitedMessage: forgottenResponse,
      rules: [
        { group: 'forgot_ip', windowMs: 1000, max: 2, keyType: 'ip', store: 'memory', sensitive: true },
        { group: 'forgot_email', windowMs: 1000, max: 1, keyType: 'email', store: 'memory', sensitive: true },
      ],
    },
    reset: { windowMs: 1000, max: 1, keyType: 'ip', store: 'memory', sensitive: true },
    google_signin: { windowMs: 1000, max: 1, keyType: 'ip', store: 'mongo', sensitive: false },
    mfa_login: { windowMs: 1000, max: 1, keyType: 'ip', store: 'memory', sensitive: true },
  };
  const service = createRateLimitService({ config: definitions, now: () => timestamp });
  const run = async (group, req) => new Promise((resolve) => (
    service.limit(group)(req, responseFor(), (error) => resolve(error || null))
  ));
  const request = (ip, email) => ({
    ...requestFor(null, ip), method: 'POST', body: email ? { email } : {},
  });

  assert.equal(await run('register', request('198.51.100.40')), null);
  assert.equal((await run('register', request('198.51.100.40')))?.status, 429);
  const forgotReq = request('198.51.100.41', 'private@example.test');
  assert.equal(await run('forgot', forgotReq), null);
  const forgotError = await run('forgot', forgotReq);
  assert.equal(forgotError.status, 429);
  assert.equal(forgotError.message, forgottenResponse);
  for (const group of ['reset', 'google_signin', 'mfa_login']) {
    const req = request(`198.51.100.${group === 'reset' ? 42 : group === 'google_signin' ? 43 : 44}`);
    assert.equal(await run(group, req), null);
    assert.equal((await run(group, req))?.status, 429);
  }
  timestamp += 1000;
  assert.equal(await run('register', request('198.51.100.40')), null);
});

test('sensitive auth store outages fail closed while global and Google limits fail open', async () => {
  const database = {
    collection() {
      return {
        async findOneAndUpdate() { throw new Error('simulated outage'); },
      };
    },
  };
  const groups = {
    login: { windowMs: 1000, max: 10, keyType: 'ip+email', store: 'mongo', sensitive: true, failedStatus: 401 },
    forgot: {
      rules: [{ group: 'forgot_ip', windowMs: 1000, max: 10, keyType: 'ip', store: 'mongo', sensitive: true }],
    },
    reset: { windowMs: 1000, max: 10, keyType: 'ip', store: 'mongo', sensitive: true },
    mfa_login: { windowMs: 1000, max: 10, keyType: 'ip', store: 'mongo', sensitive: true },
    google_signin: { windowMs: 1000, max: 10, keyType: 'ip', store: 'mongo', sensitive: false },
    global_api: { windowMs: 1000, max: 10, keyType: 'ip', store: 'memory', sensitive: false },
  };
  const service = createRateLimitService({ database, config: groups });
  for (const group of ['login', 'forgot', 'reset', 'mfa_login']) {
    const res = responseFor();
    const error = await new Promise((resolve) => service.limit(group)(
      { ...requestFor(null), method: 'POST', body: { email: 'private@example.test' } },
      res,
      resolve,
    ));
    assert.equal(error?.status, 503, group);
    assert.equal(error?.message, 'Please try again shortly');
    assert.equal(res.headers['Retry-After'], '1');
  }
  for (const group of ['google_signin', 'global_api']) {
    const error = await new Promise((resolve) => service.limit(group)(
      { ...requestFor(null), method: 'GET', body: {} },
      responseFor(),
      (nextError) => resolve(nextError || null),
    ));
    assert.equal(error, null, group);
  }
});

test('all registered API routes and Settings table entries have configured limiters', async (t) => {
  const service = createRateLimitService({ config: appConfig.rateLimits });
  const noop = (_req, _res, next) => next?.();
  const controllers = new Proxy({}, { get: () => new Proxy({}, { get: () => noop }) });
  const guards = new Proxy({}, {
    get: (_target, key) => key === 'requirePermission' || key === 'requireRole' ? () => noop : noop,
  });
  const routeModules = createApiRouteModules({
    services: { auth: {}, integrationSecurity: {} },
    controllers,
    guards,
    limit: service.limit,
    rateLimits: service,
    frontendOrigin: 'http://localhost',
  });
  const registered = routeModules.flatMap(({ prefix, router }) => {
    return router.stack.flatMap((layer) => {
      if (!layer.route) return [];
      const path = layer.route.path === '/' ? prefix : `${prefix}${layer.route.path}`;
      const groups = layer.route.stack.flatMap(({ handle }) => (
        handle.rateLimitGroup ? [handle.rateLimitGroup] : handle.rateLimitGroups || []
      ));
      return Object.keys(layer.route.methods)
        .filter((method) => method !== '_all')
        .map((method) => ({ route: `${method.toUpperCase()} ${path}`, groups }));
    });
  });
  const tableRows = buildRateLimitRows(appConfig);
  assertRateLimitCoverage(
    registered,
    appConfig.rateLimits,
    tableRows,
    appConfig.rateLimitRouteExemptions,
    appConfig.rateLimitControlRows,
  );
  for (const [configGroup, definition] of Object.entries(appConfig.rateLimits)) {
    const expectedRules = definition.rules || [definition];
    const actualRows = tableRows.filter((row) => row.kind === 'route' && row.configGroup === configGroup);
    assert.equal(actualRows.length, expectedRules.length, `${configGroup} row count`);
    for (const expected of expectedRules) {
      assert.ok(actualRows.some((row) => (
        row.max === expected.max
        && row.windowSeconds === expected.windowMs / 1000
        && row.keyType === keyTypeLabels[expected.keyType]
        && row.store === expected.store
        && row.failureMode === (expected.store === 'mongo' && expected.sensitive ? 'Fail closed' : 'Fail open')
      )), `${configGroup} table values match config`);
    }
  }
  for (const expected of appConfig.rateLimitControlRows) {
    const actual = tableRows.find((row) => row.controlId === expected.id);
    assert.ok(actual, `Settings table includes control ${expected.id}`);
    assert.equal(actual.max, expected.max);
    assert.equal(actual.windowSeconds, expected.windowMs / 1000);
    assert.equal(actual.keyType, keyTypeLabels[expected.keyType]);
    assert.equal(actual.store, expected.store);
    assert.equal(actual.failureMode, expected.store === 'mongo' && expected.sensitive ? 'Fail closed' : 'Fail open');
    assert.equal(actual.source, expected.source || 'default');
  }
  await t.test('rejects a route without a limiter', () => {
    assert.throws(() => assertRateLimitCoverage(
      [...registered, { route: 'GET /fixture/unlimited', groups: [] }],
      appConfig.rateLimits,
      tableRows,
      appConfig.rateLimitRouteExemptions,
      appConfig.rateLimitControlRows,
    ), /explicit exemption/);
  });
  await t.test('rejects an orphaned configuration group', () => {
    assert.throws(() => assertRateLimitCoverage(
      registered,
      { ...appConfig.rateLimits, fixture_orphan: { windowMs: 1000, max: 1 } },
      tableRows,
      appConfig.rateLimitRouteExemptions,
      appConfig.rateLimitControlRows,
    ), /not used by a route/);
  });
  await t.test('rejects a route with an unknown group', () => {
    assert.throws(() => assertRateLimitCoverage(
      [...registered, { route: 'GET /fixture/unknown', groups: ['fixture_unknown'] }],
      appConfig.rateLimits,
      tableRows,
      appConfig.rateLimitRouteExemptions,
      appConfig.rateLimitControlRows,
    ), /unknown limiter group/);
  });
  await t.test('rejects a Settings table missing a configured group', () => {
    assert.throws(() => assertRateLimitCoverage(
      registered,
      appConfig.rateLimits,
      tableRows.filter((row) => row.configGroup !== 'settings_save'),
      appConfig.rateLimitRouteExemptions,
      appConfig.rateLimitControlRows,
    ), /Settings table omits/);
  });
  await t.test('rejects a Settings table missing a non-route control', () => {
    assert.throws(() => assertRateLimitCoverage(
      registered,
      appConfig.rateLimits,
      tableRows.filter((row) => row.controlId !== 'test_email'),
      appConfig.rateLimitRouteExemptions,
      appConfig.rateLimitControlRows,
    ), /Settings table omits control/);
  });
  await t.test('rejects missing catalog metadata', () => {
    assert.throws(() => buildRateLimitRows({
      ...appConfig,
      rateLimitMetadata: Object.fromEntries(
        Object.entries(appConfig.rateLimitMetadata).filter(([group]) => group !== 'settings_save'),
      ),
    }), /Missing rate-limit catalog metadata/);
  });
});

test('all literal audit actions used by runtime code are allowlisted', () => {
  const roots = [
    path.resolve(__dirname, '../../src'),
    path.resolve(__dirname, '../'),
    path.resolve(__dirname, '../../scripts'),
  ];
  const files = roots.flatMap((root) => sourceFiles(root)).filter((file) => (
    !file.includes(`${path.sep}tests${path.sep}`)
    && !file.endsWith(`${path.sep}services${path.sep}audit-log.js`)
    && !path.basename(file).startsWith('test-')
  ));
  const used = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!/\baction\s*:|\b(?:requestAuditContext|authAuditContext|auditEvent|logMfa)\(/.test(line)) continue;
      for (const match of line.matchAll(/['"]([a-z][a-z0-9_.]*)['"]/gi)) {
        if (match[1].includes('.') || match[1] === 'rate_limited') used.add(match[1]);
      }
    }
  }
  assert.deepEqual([...used].filter((action) => !ACTIONS.has(action)).sort(), []);
});

function createMongoCounterDatabase(now) {
  const documents = new Map();
  let queue = Promise.resolve();
  const serial = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const collection = {
    findOne({ _id }) {
      return serial(() => {
        const document = documents.get(_id);
        return document ? structuredClone(document) : null;
      });
    },
    findOneAndUpdate({ _id }, pipeline) {
      const windowMs = pipeline[0].$set.expiresAt.$cond[1].$add[1];
      return serial(() => {
        const previous = documents.get(_id);
        const expired = !previous || new Date(previous.expiresAt).getTime() <= now();
        const document = {
          _id,
          count: expired ? 1 : previous.count + 1,
          expiresAt: expired ? new Date(now() + windowMs) : previous.expiresAt,
          type: pipeline[0].$set.type,
        };
        documents.set(_id, document);
        return structuredClone(document);
      });
    },
    updateOne({ _id, count }, update) {
      return serial(() => {
        const document = documents.get(_id);
        if (!document || document.count <= (count?.$gt ?? -Infinity)) return { modifiedCount: 0 };
        document.count += update.$inc.count;
        return { modifiedCount: 1 };
      });
    },
    deleteOne({ _id }) {
      return serial(() => ({ deletedCount: documents.delete(_id) ? 1 : 0 }));
    },
    async createIndex() {},
  };
  return {
    documents,
    collection() { return collection; },
  };
}

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'archived'].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return file.endsWith('.js') ? [file] : [];
  });
}
