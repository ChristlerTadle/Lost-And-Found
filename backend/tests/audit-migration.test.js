const assert = require('node:assert/strict');
const { test } = require('node:test');
const { migrate } = require('../../scripts/migrate-general-audit-log');

function createMigrationDatabase({ mismatch = false } = {}) {
  const sources = {
    permission_audit_log: [{
      _id: 'perm-old-1',
      admin_id: 'admin-1',
      staff_id: 'staff-1',
      old_permissions: ['view_records'],
      new_permissions: ['view_claims'],
      change_source: 'manual',
      created_at: '2026-10-10T12:34:56.789Z',
    }],
    access_denied_log: [{
      _id: 'denied-old-1',
      staff_id: 'staff-1',
      route: '/staff/claims/:id',
      http_method: 'PATCH',
      required_permission: 'approve_claim',
      created_at: '2026-10-11T12:34:56.789Z',
    }],
  };
  const auditRows = [];
  const dropped = new Set();
  const audit = {
    async createIndex() {},
    async insertOne(row) {
      if (auditRows.some(({ _id }) => _id === row._id)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      auditRows.push(row);
    },
    async findOne(filter) {
      return auditRows.find((row) => row.migration_source_collection === filter.migration_source_collection
        && row.migration_source_id === filter.migration_source_id) || null;
    },
    async countDocuments(filter) {
      if (mismatch && filter.migration_source_collection === 'permission_audit_log') return 0;
      return auditRows.filter((row) => row.migration_source_collection === filter.migration_source_collection).length;
    },
  };
  const database = {
    collection(name) {
      if (name === 'audit_log') return audit;
      return {
        async countDocuments() { return sources[name].length; },
        find() {
          return {
            async *[Symbol.asyncIterator]() {
              yield* sources[name];
            },
          };
        },
        async drop() { dropped.add(name); },
      };
    },
    listCollections() {
      return {
        async toArray() {
          return Object.keys(sources).filter((name) => !dropped.has(name)).map((name) => ({ name }));
        },
      };
    },
  };
  return { database, auditRows, dropped };
}

test('legacy audit migration preserves timestamps, verifies counts, and is rerunnable', async () => {
  const memory = createMigrationDatabase();
  const originalLog = console.log;
  console.log = () => {};
  try {
    await migrate(memory.database);
    assert.equal(memory.auditRows.length, 2);
    assert.equal(memory.auditRows[0].created_at.toISOString(), '2026-10-10T12:34:56.789Z');
    assert.equal(memory.auditRows[1].created_at.toISOString(), '2026-10-11T12:34:56.789Z');
    assert.deepEqual(memory.dropped, new Set(['permission_audit_log', 'access_denied_log']));
    await migrate(memory.database);
    assert.equal(memory.auditRows.length, 2);
  } finally {
    console.log = originalLog;
  }
});

test('legacy collections are retained when migrated counts do not match', async () => {
  const memory = createMigrationDatabase({ mismatch: true });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(migrate(memory.database), /Count verification failed/);
    assert.deepEqual(memory.dropped, new Set());
  } finally {
    console.log = originalLog;
  }
});
