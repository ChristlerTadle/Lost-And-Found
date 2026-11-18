const { MongoClient } = require('mongodb');
const config = require('../src/config');
const { createAuditLogService } = require('../src/services/audit-log');
const { migrateStaffPermissionOverrides } = require('../src/services/staff-permission-migration');

async function main() {
  let plan;
  const argument = process.argv[2];
  try {
    const raw = argument || Buffer.concat(await collectInput()).toString('utf8');
    plan = JSON.parse(raw);
  } catch {
    throw new Error('Pass the approved migration plan as a JSON argument or pipe it to this script.');
  }
  const client = new MongoClient(config.mongodbUri);
  try {
    await client.connect();
    const database = client.db(config.mongodbDatabase);
    const audit = createAuditLogService(database, client);
    const result = await migrateStaffPermissionOverrides(database, audit, plan);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

async function collectInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return chunks;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unable to migrate legacy staff permissions:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
