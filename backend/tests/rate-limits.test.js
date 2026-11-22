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
};

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
