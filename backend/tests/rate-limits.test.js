const assert = require('node:assert/strict');
const test = require('node:test');
const { createAuthRoutes } = require('../routes/auth.routes');
const { createItemsRoutes } = require('../routes/items.routes');
const { createClaimsRoutes } = require('../routes/claims.routes');
const { createProfileRoutes } = require('../routes/profile.routes');
const { createNotificationsRoutes } = require('../routes/notifications.routes');
const { createStaffRoutes } = require('../routes/staff.routes');
const { createAdminDashboardRoutes } = require('../routes/admin/dashboard.routes');
const { createAdminUsersRoutes } = require('../routes/admin/users.routes');
const { createAdminItemsRoutes } = require('../routes/admin/items.routes');
const { createAdminClaimsRoutes } = require('../routes/admin/claims.routes');
const { createAdminSettingsRoutes } = require('../routes/admin/settings.routes');
const { createAdminMfaRoutes } = require('../routes/admin/mfa.routes');
const { createAdminSystemRecordsRoutes } = require('../routes/admin/system-records.routes');
const { createAdminRolePermissionsRoutes } = require('../routes/admin/role-permissions.routes');
const { createHealthRoutes } = require('../routes/health.routes');
const { createRateLimitService, normalizeIp } = require('../../src/services/rate-limits');
const appConfig = require('../../src/config');

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
            expiresAt: new Date(timestamp + appConfig.rateLimits.validation_cooldown.windowMs
              + appConfig.rateLimits.validation_cooldown.cooldownMs),
            lockedUntil: count >= appConfig.rateLimits.validation_cooldown.max
              ? new Date(timestamp + appConfig.rateLimits.validation_cooldown.cooldownMs)
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
    now: () => timestamp,
  });
  const firstService = createService();
  await firstService.initialize();
  for (let failure = 0; failure < appConfig.rateLimits.validation_cooldown.max; failure += 1) {
    await firstService.recordValidationFailure('smtp');
  }
  assert.equal(documents.size, 1);
  assert.equal([...documents.keys()][0].includes('smtp'), false);

  const restartedService = createService();
  await assert.rejects(restartedService.checkValidationCooldown('smtp'), {
    status: 429,
    code: 'validation_cooldown',
  });
  timestamp += appConfig.rateLimits.validation_cooldown.cooldownMs;
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

test('all registered API routes have a limiter except the three explicit exemptions', () => {
  const service = createRateLimitService({ config: appConfig.rateLimits });
  const noop = (_req, _res, next) => next?.();
  const controllers = new Proxy({}, { get: () => new Proxy({}, { get: () => noop }) });
  const guards = new Proxy({}, {
    get: (_target, key) => key === 'requirePermission' || key === 'requireRole' ? () => noop : noop,
  });
  const factories = [
    ['', createHealthRoutes, {}],
    ['/auth', createAuthRoutes, { controllers: controllers, auth: controllers.auth, frontendOrigin: 'http://localhost' }],
    ['/items', createItemsRoutes, {}],
    ['/claims', createClaimsRoutes, {}],
    ['/profile', createProfileRoutes, {}],
    ['/notifications', createNotificationsRoutes, {}],
    ['/staff', createStaffRoutes, { frontendOrigin: 'http://localhost' }],
    ['/admin', createAdminDashboardRoutes, {}],
    ['/admin', createAdminUsersRoutes, { auth: {} }],
    ['/admin', createAdminItemsRoutes, { frontendOrigin: 'http://localhost' }],
    ['/admin', createAdminClaimsRoutes, {}],
    ['/admin', createAdminSettingsRoutes, { frontendOrigin: 'http://localhost', integrationSecurity: {} }],
    ['/admin/mfa', createAdminMfaRoutes, { frontendOrigin: 'http://localhost' }],
    ['/admin', createAdminSystemRecordsRoutes, {}],
    ['/admin', createAdminRolePermissionsRoutes, {}],
  ];
  const registered = factories.flatMap(([prefix, factory, extra]) => {
    const router = factory({
      controllers,
      guards,
      limit: service.limit,
      rateLimits: service,
      frontendOrigin: 'http://localhost',
      integrationSecurity: {},
      auth: {},
      ...extra,
    });
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
  const exemptions = ['GET /health', 'GET /auth/me', 'POST /auth/logout'];
  assert.deepEqual(registered.filter(({ groups }) => groups.length === 0)
    .map(({ route }) => route).sort(), exemptions.sort());
  for (const { route, groups } of registered) {
    assert.ok(groups.every((group) => appConfig.rateLimits[group]), `${route} has an unknown limiter group`);
  }
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
