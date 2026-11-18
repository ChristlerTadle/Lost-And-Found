const { connectDatabase, closeDatabase } = require('../src/db');
const { PERMISSIONS_BY_ROLE } = require('../backend/config/role-permissions');

const LEGACY_STAFF_PERMISSIONS = [
  'view_lost_reports', 'review_lost_report', 'view_found_items', 'verify_found_item',
  'update_item_status', 'mark_item_returned', 'view_claims', 'verify_item_ownership',
  'approve_claim', 'schedule_pickup', 'reject_claim', 'view_records', 'view_staff_dashboard',
];

async function seedRole(database, role, permissions) {
  const collection = database.collection('role_permissions');
  for (const permission of permissions) {
    await collection.updateOne(
      { role, permission_key: permission.key },
      {
        $setOnInsert: {
          role,
          permission_key: permission.key,
          enabled: true,
          created_at: new Date(),
        },
        $set: { label: permission.label, group: permission.group },
      },
      { upsert: true },
    );
  }
}

async function migrate() {
  const database = await connectDatabase();
  const users = await database.collection('users').find(
    { role_name: 'staff' },
    { projection: { _id: 1 } },
  ).toArray();
  const oldRows = await database.collection('staff_permissions').find(
    {},
    { projection: { staff_id: 1, permission_id: 1 } },
  ).toArray();
  const assignments = new Map(users.map(({ _id }) => [String(_id), new Set()]));
  for (const row of oldRows) {
    assignments.get(String(row.staff_id))?.add(row.permission_id);
  }
  const differences = new Map();
  for (const [staffId, enabled] of assignments) {
    const missing = LEGACY_STAFF_PERMISSIONS.filter((key) => !enabled.has(key)).sort();
    const extra = [...enabled].filter((key) => !LEGACY_STAFF_PERMISSIONS.includes(key)).sort();
    const signature = `missing=${missing.join(',')};extra=${extra.join(',')}`;
    differences.set(signature, (differences.get(signature) || 0) + 1);
    void staffId;
  }
  console.log(`Legacy staff accounts: ${users.length}`);
  console.log('Legacy assignment differences (account identities omitted):');
  if (!differences.size) console.log('  none');
  for (const [pattern, count] of differences) console.log(`  ${count}: ${pattern}`);
  console.log('Seeding role_permissions as enabled on insert only; existing role settings are preserved.');
  await Promise.all(['user', 'staff', 'admin'].map((role) => seedRole(database, role, PERMISSIONS_BY_ROLE[role])));
  console.log(`Seeded ${PERMISSIONS_BY_ROLE.user.length} User, ${PERMISSIONS_BY_ROLE.staff.length} Staff, and ${PERMISSIONS_BY_ROLE.admin.length} Admin role permission entries.`);
  console.log('The legacy staff_permissions collection was not modified or removed.');
}

migrate()
  .catch((error) => {
    console.error('Unable to migrate role permissions:', error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
