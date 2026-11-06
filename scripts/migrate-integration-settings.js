const config = require('../src/config');
const { connectDatabase, closeDatabase, getMongoClient } = require('../src/db');
const { createIntegrationSettings, parseEncryptionKey } = require('../src/services/integration-settings');
const { createAuditLogService } = require('../src/services/audit-log');

async function main() {
  parseEncryptionKey(config.integrationEncryptionKey);
  const database = await connectDatabase();
  const settings = createIntegrationSettings(database, {
    encryptionKey: config.integrationEncryptionKey,
  });
  const audit = createAuditLogService(database, getMongoClient());
  const results = await settings.migrateEnvironmentValues();

  for (const result of results) {
    if (result.fieldsMigrated.length) {
      await audit.logAction({
        actor_id: null,
        actor_role: null,
        action: 'integration.update',
        target_type: 'integration',
        target_id: result.id,
        new_value: { changed_fields: result.fieldsMigrated },
      });
    }
    if (result.enabledInitialized) {
      await audit.logAction({
        actor_id: null,
        actor_role: null,
        action: result.enabled ? 'integration.enable' : 'integration.disable',
        target_type: 'integration',
        target_id: result.id,
        new_value: { changed_fields: [] },
      });
    }
  }

  console.log('Integration environment migration completed:');
  for (const result of results) {
    console.log(`${result.id}: fields migrated [${result.fieldsMigrated.join(', ')}]; `
      + `${result.enabledPreserved ? 'existing enabled state preserved' : `enabled=${result.enabled}`}`);
  }
}

main()
  .catch(() => {
    console.error('Integration settings migration failed. Check the encryption key and database connection.');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDatabase();
    } catch {
      process.exitCode = 1;
    }
  });
