const assert = require('node:assert/strict');
const test = require('node:test');
const { createRateLimitService, normalizeIp } = require('../../src/services/rate-limits');

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
