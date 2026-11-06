const { connectDatabase, closeDatabase } = require('../src/db');

const sourceNames = ['permission_audit_log', 'access_denied_log'];
async function migrate(database = undefined) {
  const sourceCounts = {};
  const targetDatabase = database || await connectDatabase();
  const audit = targetDatabase.collection('audit_log');
  await audit.createIndex(
    { migration_source_collection: 1, migration_source_id: 1 },
    { unique: true, partialFilterExpression: { migration_source_collection: { $exists: true } } },
  );
  const collections = new Set((await targetDatabase.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name));

  for (const sourceName of sourceNames) {
    if (!collections.has(sourceName)) {
      sourceCounts[sourceName] = 0;
      continue;
    }
    const source = targetDatabase.collection(sourceName);
    const expected = await source.countDocuments({});
    sourceCounts[sourceName] = expected;
    const cursor = source.find({});
    for await (const document of cursor) {
      const event = sourceName === 'permission_audit_log'
        ? permissionEvent(document)
        : deniedEvent(document);
      try {
        await audit.insertOne({
          _id: `legacy:${sourceName}:${String(document._id)}`,
          ...event,
          migration_source_collection: sourceName,
          migration_source_id: String(document._id),
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await audit.findOne({
          migration_source_collection: sourceName,
          migration_source_id: String(document._id),
        });
        if (!existing) throw error;
      }
    }
    const migrated = await audit.countDocuments({ migration_source_collection: sourceName });
    if (migrated !== expected) {
      throw new Error(`Count verification failed for ${sourceName}: source=${expected}, audit_log=${migrated}. Old collections were retained.`);
    }
  }

  for (const sourceName of sourceNames) {
    if (collections.has(sourceName)) await targetDatabase.collection(sourceName).drop();
  }
  console.log('General audit migration verified. Migrated rows:');
  for (const [source, count] of Object.entries(sourceCounts)) console.log(`  ${source}: ${count}`);
  console.log('Both legacy collections were removed after count verification.');
}

function permissionEvent(document) {
  return {
    actor_id: document.admin_id ? String(document.admin_id) : null,
    actor_role: 'admin',
    action: 'staff_permissions.update',
    target_type: 'user',
    target_id: document.staff_id ? String(document.staff_id) : null,
    old_value: { permissions: Array.isArray(document.old_permissions) ? document.old_permissions : [] },
    new_value: {
      permissions: Array.isArray(document.new_permissions) ? document.new_permissions : [],
      change_source: document.change_source || 'legacy',
    },
    result: 'success',
    ip_address: null,
    created_at: convertTimestamp(document.created_at),
  };
}

function deniedEvent(document) {
  return {
    actor_id: document.staff_id ? String(document.staff_id) : null,
    actor_role: document.staff_id ? 'staff' : null,
    action: 'access.denied',
    target_type: null,
    target_id: null,
    old_value: null,
    new_value: {
      route: document.route || null,
      http_method: document.http_method || null,
      required_permission: document.required_permission || null,
    },
    result: 'denied',
    ip_address: null,
    created_at: convertTimestamp(document.created_at),
  };
}

function convertTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('A legacy audit row has an invalid timestamp. Old collections were retained.');
  }
  return timestamp;
}

if (require.main === module) {
  migrate()
    .catch((error) => {
      console.error('Unable to migrate general audit log:', error);
      process.exitCode = 1;
    })
    .finally(closeDatabase);
}

module.exports = { migrate, permissionEvent, deniedEvent, convertTimestamp };
