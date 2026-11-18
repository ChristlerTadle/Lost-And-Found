const { MongoClient } = require('mongodb');
const config = require('../src/config');

const LEGACY_STAFF_PERMISSIONS = [
  'view_lost_reports', 'review_lost_report', 'view_found_items', 'verify_found_item',
  'update_item_status', 'mark_item_returned', 'view_claims', 'verify_item_ownership',
  'approve_claim', 'schedule_pickup', 'reject_claim', 'view_records', 'view_staff_dashboard',
];

function buildStaffPermissionReport(users, legacyRows, permissionKeys = LEGACY_STAFF_PERMISSIONS) {
  const expected = new Set(permissionKeys);
  const grantsByUser = new Map();
  for (const row of legacyRows) {
    const userId = String(row.staff_id);
    if (!grantsByUser.has(userId)) grantsByUser.set(userId, new Set());
    grantsByUser.get(userId).add(String(row.permission_id));
  }

  return users
    .filter(({ role_name }) => role_name === 'staff')
    .map(({ _id }) => {
      const userId = String(_id);
      const grants = grantsByUser.get(userId) || new Set();
      return {
        user_id: userId,
        missing: [...expected].filter((key) => !grants.has(key)).sort(),
        extra: [...grants].filter((key) => !expected.has(key)).sort(),
      };
    })
    .sort((left, right) => left.user_id.localeCompare(right.user_id));
}

function formatReport(report) {
  const lines = [
    'Legacy staff permission preflight (read-only)',
    `Staff accounts: ${report.length}`,
  ];
  if (!report.length) lines.push('No staff accounts found.');
  for (const { user_id: userId, missing, extra } of report) {
    lines.push(
      `${userId}: missing [${missing.join(', ') || 'none'}]; extra [${extra.join(', ') || 'none'}]`,
    );
  }
  return lines.join('\n');
}

async function preflight(database) {
  const collectionNames = new Set((await database.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name));
  if (!collectionNames.has('users')) throw new Error('The users collection is unavailable.');
  if (!collectionNames.has('staff_permissions')) {
    throw new Error('The legacy staff_permissions collection is unavailable; no comparison was run.');
  }

  const [users, legacyRows] = await Promise.all([
    database.collection('users').find(
      { role_name: 'staff' },
      { projection: { _id: 1, role_name: 1 } },
    ).toArray(),
    database.collection('staff_permissions').find(
      {},
      { projection: { staff_id: 1, permission_id: 1 } },
    ).toArray(),
  ]);
  return buildStaffPermissionReport(users, legacyRows);
}

async function main() {
  const client = new MongoClient(config.mongodbUri, { readPreference: 'secondaryPreferred' });
  try {
    await client.connect();
    const report = await preflight(client.db(config.mongodbDatabase));
    console.log(formatReport(report));
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unable to run the read-only staff-permission preflight:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  LEGACY_STAFF_PERMISSIONS,
  buildStaffPermissionReport,
  formatReport,
  preflight,
};
