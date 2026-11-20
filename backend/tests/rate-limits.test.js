const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { MongoClient } = require('mongodb');
const { after, before, test } = require('node:test');
const config = require('../../src/config');
const { createAuditLogService, ACTIONS } = require('../../src/services/audit-log');
const {
  createRateLimitService,
  MemoryRateLimitStore,
  MongoRateLimitStore,
  normalizeIp,
} = require('../../src/services/rate-limits');
const { createAuthRoutes } = require('../routes/auth.routes');

const mongoClient = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 3000 });
const databaseName = `rate_limits_test_${process.pid}_${Date.now()}`;
let database;
let rateLimits;
let server;
let baseUrl;
const warnings = [];

before(async () => {
  await mongoClient.connect();
  database = mongoClient.db(databaseName);
  const audit = createAuditLogService(database, mongoClient);
  rateLimits = createRateLimitService({
    database,
    audit,
    secret: 'test-only-rate-limit-signing-key',
    timeoutMs: 2000,
    logger: { warn: (message) => warnings.push(message) },
  });
  await rateLimits.initialize();
  const app = createAuthTestApp(rateLimits);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test('TRUST_PROXY accepts false, hop counts, and CIDRs but not plain true', () => {
  const { parseTrustProxy } = require('../../src/config');
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('2'), 2);
  assert.deepEqual(parseTrustProxy('10.0.0.0/8,2001:db8::/32'), ['10.0.0.0/8', '2001:db8::/32']);
  assert.throws(() => parseTrustProxy('true'), /TRUST_PROXY/);
});

after(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (database) await database.dropDatabase();
  await mongoClient.close();
});

test('Mongo counters increment atomically under parallel requests', async () => {
  const store = mongoStore('parallel_test', 'ip', 60_000);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.increment('198.51.100.30')));
  assert.deepEqual(results.map(({ totalHits }) => totalHits).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1));
});

test('Mongo counters reset expired windows without waiting for TTL cleanup', async () => {
  const store = mongoStore('expiry_test', 'ip', 60_000);
  const identifier = '198.51.100.31';
  await database.collection('rate_limits').insertOne({
    _id: store.keyFor(identifier),
    type: 'expiry_test:ip',
    count: 99,
    expiresAt: new Date(0),
  });
  const result = await store.increment(identifier);
  assert.equal(result.totalHits, 1);
  assert.ok(result.resetTime.getTime() > Date.now());
});

test('memory counters start a fresh fixed window after expiry', async () => {
  let timestamp = 1000;
  const store = new MemoryRateLimitStore({
    group: 'memory_test',
    keyType: 'ip',
    hmacKey: Buffer.from('test-only-memory-key'),
    windowMs: 1000,
    now: () => timestamp,
  });
  assert.equal((await store.increment('198.51.100.32')).totalHits, 1);
  timestamp += 1000;
  const reset = await store.increment('198.51.100.32');
  assert.equal(reset.totalHits, 1);
  assert.equal(reset.resetTime.getTime(), timestamp + 1000);
});

test('Mongo store enforces its configured operation timeout', async () => {
  const store = new MongoRateLimitStore({
    collection: { findOneAndUpdate: () => new Promise(() => {}) },
    group: 'timeout_test',
    keyType: 'ip',
    hmacKey: Buffer.from('test-only-timeout-key'),
    windowMs: 1000,
    timeoutMs: 10,
  });
  await assert.rejects(store.increment('198.51.100.33'), /timed out/);
});

test('rate-limit TTL index creation is idempotent', async () => {
  await rateLimits.initialize();
  const indexes = await database.collection('rate_limits').listIndexes().toArray();
  const ttl = indexes.find(({ name }) => name === 'rate_limits_expiresAt_ttl');
  assert.deepEqual(ttl.key, { expiresAt: 1 });
  assert.equal(ttl.expireAfterSeconds, 0);
});

test('IPv4-mapped addresses and IPv6 clients in the same /64 share keys', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIp('::ffff:c000:201'), '192.0.2.1');
  assert.equal(
    normalizeIp('2001:db8:abcd:12::1'),
    normalizeIp('2001:db8:abcd:12:ffff:ffff:ffff:ffff'),
  );
});

test('public auth groups return 429 with Retry-After and standard rate headers', async () => {
  const registerIp = uniqueIp(1);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await post('/auth/register', registerIp, { email: `reg-${attempt}@example.test` })).status, 201);
  }
  const registerLimited = await post('/auth/register', registerIp, { email: 'register@example.test' });
  await assertLimited(registerLimited, registerIp);

  const loginIp = uniqueIp(2);
  const loginEmail = 'login-limit@example.test';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await post('/auth/login', loginIp, { email: loginEmail, password: 'wrong' })).status, 401);
  }
  const loginLimited = await post('/auth/login', loginIp, { email: loginEmail, password: 'wrong' });
  await assertLimited(loginLimited, loginIp, loginEmail);

  const forgotIp = uniqueIp(3);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await post('/auth/forgot-password', forgotIp, { email: `forgot-${attempt}@example.test` });
    assert.equal(response.status, 200);
  }
  const forgotIpLimited = await post('/auth/forgot-password', forgotIp, { email: 'forgot-last@example.test' });
  await assertLimited(forgotIpLimited, forgotIp, 'forgot-last@example.test');
  assert.equal((await forgotIpLimited.json()).error,
    'If an active account uses that email, reset instructions have been sent.');

  const forgotEmail = 'forgot-email-limit@example.test';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await post('/auth/forgot-password', uniqueIp(4 + attempt), { email: forgotEmail })).status, 200);
  }
  const sharedForgotIp = uniqueIp(10);
  for (let attempt = 0; attempt < 9; attempt += 1) {
    assert.equal((await post('/auth/forgot-password', sharedForgotIp, {
      email: `before-email-limit-${attempt}@example.test`,
    })).status, 200);
  }
  const forgotEmailLimited = await post('/auth/forgot-password', sharedForgotIp, { email: forgotEmail });
  await assertLimited(forgotEmailLimited, sharedForgotIp, forgotEmail);
  assert.equal((await post('/auth/forgot-password', sharedForgotIp, { email: 'after-email-limit@example.test' })).status, 200);
  assert.equal((await post('/auth/forgot-password', sharedForgotIp, { email: 'ip-limit@example.test' })).status, 429);

  const resetIp = uniqueIp(11);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await fetchWithIp('/auth/reset-password/token', resetIp)).status, 200);
  }
  const resetLimited = await fetchWithIp('/auth/reset-password/token', resetIp);
  await assertLimited(resetLimited, resetIp);

  const googleIp = uniqueIp(12);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await fetchWithIp('/auth/google', googleIp)).status, 200);
  }
  const googleLimited = await fetchWithIp('/auth/google', googleIp);
  await assertLimited(googleLimited, googleIp);
});

test('login counts only failed attempts, resets on success, and separates emails', async () => {
  const ip = uniqueIp(13);
  const email = 'failed-login@example.test';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await post('/auth/login', ip, { email, password: 'wrong' })).status, 401);
  }
  assert.equal((await post('/auth/login', ip, { email: 'another@example.test', password: 'wrong' })).status, 401);
  assert.equal((await post('/auth/login', ip, { email, password: 'wrong' })).status, 429);

  const malformedEmail = 'malformed-login@example.test';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    assert.equal((await post('/auth/login', ip, { email: malformedEmail, password: 'malformed' })).status, 400);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await post('/auth/login', ip, { email: malformedEmail, password: 'wrong' })).status, 401);
  }
  assert.equal((await post('/auth/login', ip, { email: malformedEmail, password: 'wrong' })).status, 429);

  const resetEmail = 'reset-after-success@example.test';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await post('/auth/login', ip, { email: resetEmail, password: 'wrong' })).status, 401);
  }
  assert.equal((await post('/auth/login', ip, { email: resetEmail, password: 'valid' })).status, 200);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await post('/auth/login', ip, { email: resetEmail, password: 'wrong' })).status, 401);
  }
  assert.equal((await post('/auth/login', ip, { email: resetEmail, password: 'wrong' })).status, 429);
});

test('OPTIONS requests do not consume counters for any limiter group', async () => {
  const groups = ['global_api', 'register', 'login', 'forgot', 'reset', 'google_signin'];
  for (const group of groups) {
    const middleware = rateLimits.limit(group);
    const ip = uniqueIp(20 + groups.indexOf(group));
    for (let index = 0; index < 25; index += 1) {
      const request = makeRequest({ method: 'OPTIONS', ip, body: { email: 'options@example.test' } });
      let proceeded = false;
      await middleware(request, makeResponse(), () => { proceeded = true; });
      assert.equal(proceeded, true, `${group} should skip preflight`);
    }
    const request = makeRequest({
      method: group === 'global_api' ? 'GET' : 'POST',
      path: group === 'global_api' ? '/api/resource' : '/auth/request',
      ip,
      body: { email: `${group}@example.test` },
    });
    let error;
    await middleware(request, makeResponse(), (nextError) => { error = nextError; });
    assert.equal(error, undefined, `${group} should not count OPTIONS requests`);
    if (request.rateLimitFinalize) await request.rateLimitFinalize(401);
  }
});

test('global limiter exempts health and fails open when its store is unavailable', async () => {
  const limited = createRateLimitService({
    secret: 'test-only-global-key',
    definitions: {
      global_api: { windowMs: 60_000, max: 1, keyType: 'ip', store: 'memory', sensitive: false },
    },
  });
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { configurable: true, value: '198.51.100.90' });
    next();
  });
  app.use('/api', limited.limit('global_api'));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/other', (_req, res) => res.json({ status: 'ok' }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const listener = await new Promise((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const url = `http://127.0.0.1:${listener.address().port}/api`;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await fetch(`${url}/health`)).status, 200);
    }
    assert.equal((await fetch(`${url}/other`)).status, 200);
    assert.equal((await fetch(`${url}/other`)).status, 429);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }

  const failedStore = { increment: async () => { throw new Error('test outage'); } };
  const failOpen = createRateLimitService({
    secret: 'test-only-global-outage-key',
    stores: { global_api: failedStore },
    now: () => 10_000,
    logger: { warn: (message) => warnings.push(message) },
  });
  const warningStart = warnings.length;
  for (let index = 0; index < 2; index += 1) {
    const request = makeRequest({ method: 'GET', path: '/api/resource', ip: uniqueIp(30 + index) });
    let proceeded = false;
    await failOpen.limit('global_api')(request, makeResponse(), () => { proceeded = true; });
    assert.equal(proceeded, true);
  }
  assert.equal(warnings.length, warningStart + 1);
  assert.ok(warnings.every((message) => !message.includes('198.51.100.')));
});

test('a route-level 429 does not consume the global counter', async () => {
  const service = createRateLimitService({
    secret: 'test-only-counter-rollback-key',
    definitions: {
      global_api: { windowMs: 60_000, max: 2, keyType: 'ip', store: 'memory', sensitive: false },
      route_write: { windowMs: 60_000, max: 1, keyType: 'ip', store: 'memory', sensitive: false },
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { configurable: true, value: '198.51.100.91' });
    next();
  });
  app.use('/api', service.limit('global_api'));
  app.post('/api/write', service.limit('route_write'), (_req, res) => res.json({ ok: true }));
  app.get('/api/probe', (_req, res) => res.json({ ok: true }));
  app.use(async (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if ((error.status === 429 || error.status === 503) && req.rateLimitGlobalRollback) {
      await req.rateLimitGlobalRollback();
    }
    if (error.status === 429) res.set('Retry-After', '1');
    return res.status(error.status || 500).json({ error: error.message });
  });
  const listener = await new Promise((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const url = `http://127.0.0.1:${listener.address().port}/api`;
  try {
    assert.equal((await fetch(`${url}/write`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${url}/write`, { method: 'POST' })).status, 429);
    assert.equal((await fetch(`${url}/probe`)).status, 200);
    assert.equal((await fetch(`${url}/probe`)).status, 429);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
});

test('sensitive auth groups fail closed with a safe 503 when Mongo is unavailable', async () => {
  const failedStore = { increment: async () => { throw new Error('test outage'); } };
  const failClosed = createRateLimitService({
    database,
    secret: 'test-only-fail-closed-key',
    stores: { login: failedStore, forgot_ip: failedStore, forgot_email: failedStore },
  });
  const app = createAuthTestApp(failClosed);
  const listener = await new Promise((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const url = `http://127.0.0.1:${listener.address().port}`;
  try {
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-ip': uniqueIp(31) },
      body: JSON.stringify({ email: 'outage@example.test', password: 'wrong' }),
    });
    assert.equal(login.status, 503);
    assert.equal(login.headers.get('retry-after'), '1');
    assert.equal((await login.json()).error, 'Service temporarily unavailable. Please try again shortly.');
    const forgot = await fetch(`${url}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-ip': uniqueIp(32) },
      body: JSON.stringify({ email: 'outage@example.test' }),
    });
    assert.equal(forgot.status, 503);
    assert.equal(forgot.headers.get('retry-after'), '1');
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
});

test('rate-limit storage and audit entries contain no raw IP or email', async () => {
  const ip = '203.0.113.217';
  const email = 'private-rate-limit@example.test';
  const store = mongoStore('privacy_test', 'ip+email', 60_000);
  await store.increment(`${ip}\0${email}`);
  await rateLimits.recordRateLimitAudit({
    group: 'privacy_test',
    keyType: 'ip+email',
    identifier: `${ip}\0${email}`,
  });
  await rateLimits.recordRateLimitAudit({
    group: 'privacy_test',
    keyType: 'ip+email',
    identifier: `${ip}\0${email}`,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stored = JSON.stringify(await database.collection('rate_limits').find({}).toArray());
  const auditRows = await database.collection('audit_log')
    .find({ action: 'rate_limited', target_id: 'privacy_test' }).toArray();
  assert.equal(stored.includes(ip), false);
  assert.equal(stored.includes(email), false);
  assert.equal(JSON.stringify(auditRows).includes(ip), false);
  assert.equal(JSON.stringify(auditRows).includes(email), false);
  assert.equal(auditRows.length, 1);
  await rateLimits.recordRateLimitAudit({
    group: 'integration',
    keyType: 'integration+account',
    identifier: `google_auth\0${ip}`,
    action: 'integration.rate_limited',
    targetId: 'google_auth',
    targetType: 'integration',
  });
  await rateLimits.recordRateLimitAudit({
    group: 'integration',
    keyType: 'integration+account',
    identifier: `google_auth\0${ip}`,
    action: 'integration.rate_limited',
    targetId: 'google_auth',
    targetType: 'integration',
  });
  const integrationAudit = await database.collection('audit_log')
    .find({ action: 'integration.rate_limited', target_id: 'google_auth' }).toArray();
  assert.equal(integrationAudit.length, 1);
  assert.equal(JSON.stringify(integrationAudit).includes(ip), false);
  const limited = await post('/auth/register', uniqueIp(40), { email });
  assert.equal(limited.status, 201);
  const response = await post('/auth/register', uniqueIp(41), { email });
  assert.equal(JSON.stringify(await response.json()).includes(ip), false);
  assert.equal(JSON.stringify(warnings).includes(email), false);
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

function createAuthTestApp(limits) {
  const controllers = {
    auth: {
      getAuthMe: (_req, res) => res.json({ user: null }),
      postAuthRegister: (_req, res) => res.status(201).json({ created: true }),
      postAuthLogin: async (req, res) => {
        if (req.body.password === 'valid') {
          await req.rateLimitReset();
          return res.json({ signedIn: true });
        }
        if (req.body.password === 'malformed') {
          const error = new Error('Invalid request.');
          error.status = 400;
          throw error;
        }
        const error = new Error('Invalid credentials.');
        error.status = 401;
        throw error;
      },
      postAuthMfaVerify: (_req, res) => res.json({ verified: true }),
      postAuthLogout: (_req, res) => res.json({ signedOut: true }),
      postAuthForgotpassword: (_req, res) => res.json({
        message: 'If an active account uses that email, reset instructions have been sent.',
      }),
      getAuthResetpasswordByToken: (_req, res) => res.json({ valid: true }),
      postAuthResetpassword: (_req, res) => res.json({ reset: true }),
      getAuthGoogle: (_req, res) => res.json({ url: 'https://accounts.example.test' }),
      postAuthGoogle: (_req, res) => res.json({ url: 'https://accounts.example.test' }),
      getAuthGoogleCallback: (_req, res) => res.json({ signedIn: true }),
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      configurable: true,
      value: req.get('x-test-ip') || '198.51.100.1',
    });
    next();
  });
  app.use('/auth', createAuthRoutes({
    controllers,
    frontendOrigin: 'http://localhost',
    limit: limits.limit,
  }));
  app.use(async (error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = Number.isInteger(error.status) ? error.status : 500;
    if (req.rateLimitFinalize) {
      try {
        await req.rateLimitFinalize(status);
      } catch {
        status = 503;
        error = new Error('Service temporarily unavailable. Please try again shortly.');
        error.retryAfter = 1;
      }
    }
    if (status === 429 || status === 503) res.set('Retry-After', String(error.retryAfter || 1));
    return res.status(status).json({ error: error.message });
  });
  return app;
}

function mongoStore(group, keyType, windowMs) {
  const { createHmac } = require('node:crypto');
  return new MongoRateLimitStore({
    collection: database.collection('rate_limits'),
    group,
    keyType,
    hmacKey: createHmac('sha256', 'test-only-rate-limit-signing-key').update('rate-limits:v1').digest(),
    windowMs,
    timeoutMs: 2000,
  });
}

function makeRequest({ method = 'POST', path: requestPath = '/', ip, body = {} }) {
  return {
    method,
    path: requestPath,
    originalUrl: requestPath,
    ip,
    body,
    query: {},
    params: {},
    headers: {},
  };
}

function makeResponse() {
  return {
    headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function post(route, ip, body) {
  return fetchWithIp(route, ip, body);
}

async function fetchWithIp(route, ip, body) {
  return fetch(`${baseUrl}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-test-ip': ip,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function assertLimited(response, ...privateValues) {
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.ok(response.headers.get('ratelimit-limit'));
  assert.ok(response.headers.get('ratelimit-remaining'));
  const serialized = JSON.stringify(await response.clone().json());
  for (const privateValue of privateValues) assert.equal(serialized.includes(privateValue), false);
}

function uniqueIp(index) {
  return `198.51.100.${(index % 200) + 1}`;
}

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'archived'].includes(entry.name)) return [];
      return sourceFiles(file);
    }
    return entry.isFile() && file.endsWith('.js') ? [file] : [];
  });
}
