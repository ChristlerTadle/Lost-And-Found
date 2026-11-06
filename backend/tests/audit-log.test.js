const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAuditLogService } = require('../../src/services/audit-log');

function memoryAuditService({ transactions = false, insertFails = false } = {}) {
  const entries = [];
  const updates = [];
  const collection = {
    async insertOne(entry, options) {
      if (insertFails) throw new Error('audit storage unavailable');
      entries.push({ ...entry, session: options?.session });
    },
    async updateOne(filter, update) {
      updates.push({ filter, update });
      const entry = entries.find(({ _id, result }) => _id === filter._id && result === filter.result);
      if (entry) Object.assign(entry, update.$set);
    },
    async countDocuments(filter) {
      return entries.filter((entry) => matches(entry, filter)).length;
    },
    find(filter, options) {
      const found = entries.filter((entry) => matches(entry, filter))
        .sort((left, right) => right.created_at - left.created_at || String(right._id).localeCompare(String(left._id)));
      const cursor = {
        sort() { return this; },
        skip(count) { this.offset = count; return this; },
        limit(count) { this.max = count; return this; },
        async toArray() { return found.slice(this.offset || 0, (this.offset || 0) + (this.max || found.length)); },
      };
      return cursor;
    },
  };
  const session = {
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  };
  const database = {
    collection(name) {
      assert.equal(name, 'audit_log');
      return collection;
    },
    admin() {
      return { async command() { return transactions ? { setName: 'rs0' } : {}; } };
    },
  };
  const client = { startSession: () => session };
  return {
    service: createAuditLogService(database, client),
    entries,
    updates,
  };
}

function matches(entry, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'created_at') {
      if (value.$gte && entry.created_at < value.$gte) return false;
      if (value.$lte && entry.created_at > value.$lte) return false;
    } else if (entry[key] !== value) return false;
  }
  return true;
}

test('standalone Mongo fallback records attempted before action and finalizes success', async () => {
  const memory = memoryAuditService();
  let actionStarted = false;
  await memory.service.runAction({
    actor_id: 'admin-1',
    actor_role: 'admin',
    action: 'user.create',
    target_type: 'user',
    target_id: (result) => result.id,
    new_value: { email: 'safe@example.com' },
  }, async () => {
    assert.equal(memory.entries[0].result, 'attempted');
    actionStarted = true;
    return { id: 'user-2', password: 'must-not-be-logged' };
  });
  assert.equal(actionStarted, true);
  assert.equal(memory.entries[0].result, 'success');
  assert.equal(memory.entries[0].target_id, 'user-2');
  assert.equal(JSON.stringify(memory.entries[0]).includes('must-not-be-logged'), false);
  assert.equal(memory.updates.length, 1);
});

test('fallback marks a failed action without logging request data', async () => {
  const memory = memoryAuditService();
  await assert.rejects(memory.service.runAction({
    actor_id: null,
    actor_role: null,
    action: 'auth.login_failed',
    target_type: null,
    target_id: null,
    new_value: null,
  }, async () => {
    throw new Error('mutation failed');
  }), /mutation failed/);
  assert.equal(memory.entries[0].result, 'failed');
  assert.equal(memory.entries[0].actor_id, null);
  assert.equal(memory.entries[0].target_id, null);
  assert.equal(JSON.stringify(memory.entries[0]).includes('password'), false);
});

test('a failed audit insert prevents a critical fallback action', async () => {
  const memory = memoryAuditService({ insertFails: true });
  let actionRan = false;
  await assert.rejects(memory.service.runAction({
    action: 'user.disable',
    actor_id: 'admin-1',
    actor_role: 'admin',
  }, async () => {
    actionRan = true;
  }), /audit storage unavailable/);
  assert.equal(actionRan, false);
});

test('replica-set deployment commits the action and audit insert in one session', async () => {
  const memory = memoryAuditService({ transactions: true });
  let receivedSession;
  await memory.service.runAction({
    actor_id: 'staff-1',
    actor_role: 'staff',
    action: 'claim.approve',
    target_type: 'claim',
    target_id: 'claim-1',
  }, async (session) => {
    receivedSession = session;
    return 'approved';
  });
  assert.ok(receivedSession);
  assert.equal(memory.entries[0].session, receivedSession);
  assert.equal(memory.entries[0].result, 'success');
});

test('System Records filters are allowlisted and pages are capped at 25 rows', async () => {
  const memory = memoryAuditService();
  await memory.service.logAction({
    actor_id: 'admin-1',
    actor_role: 'admin',
    action: 'user.disable',
    target_type: 'user',
    target_id: 'user-1',
    result: 'success',
  });

  test('integration audit actions record integration IDs and field names without values', async () => {
    const memory = memoryAuditService();
    for (const [action, fields] of [
      ['integration.enable', []],
      ['integration.disable', []],
      ['integration.update', ['client_secret', 'callback_url']],
    ]) {
      await memory.service.logAction({
        actor_id: 'admin-1',
        actor_role: 'admin',
        action,
        target_type: 'integration',
        target_id: 'google_auth',
        new_value: { changed_fields: fields },
      });
    }
    const { records, total } = await memory.service.findRecords({
      target_type: 'integration',
      action: 'integration.update',
    });
    assert.equal(total, 1);
    assert.equal(records[0].target_id, 'google_auth');
    assert.deepEqual(records[0].new_value, { changed_fields: ['client_secret', 'callback_url'] });
  });
  await memory.service.logAction({
    actor_id: 'staff-1',
    actor_role: 'staff',
    action: 'access.denied',
    target_type: null,
    result: 'denied',
  });
  const results = await memory.service.findRecords({
    action: 'not-an-allowed-action',
    result: 'unknown',
    target_type: 'anything',
    page: '-2',
  });
  assert.equal(results.page_size, 25);
  assert.equal(results.page, 1);
  assert.equal(results.total, 2);

  const today = new Date().toISOString().slice(0, 10);
  const filtered = await memory.service.findRecords({
    actor_id: 'admin-1',
    actor_role: 'admin',
    action: 'user.disable',
    target_type: 'user',
    result: 'success',
    date_from: today,
    date_to: today,
    page: '1',
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.records[0].target_id, 'user-1');
});

test('System Records ignores future dates in audit filters', async () => {
  const memory = memoryAuditService();
  await memory.service.logAction({
    actor_id: 'admin-1',
    actor_role: 'admin',
    action: 'user.disable',
    target_type: 'user',
    target_id: 'user-1',
  });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const futureDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const fromFuture = await memory.service.findRecords({ date_from: futureDate });
  const toFuture = await memory.service.findRecords({ date_to: futureDate });
  assert.equal(fromFuture.total, 1);
  assert.equal(toFuture.total, 1);
});
