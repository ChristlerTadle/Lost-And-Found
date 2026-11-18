const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildStaffPermissionReport, formatReport } = require('../../scripts/preflight-staff-permissions');

test('staff permission preflight reports per-account missing and extra grants deterministically', () => {
  const report = buildStaffPermissionReport(
    [
      { _id: 'staff-b', role_name: 'staff' },
      { _id: 'user-1', role_name: 'user' },
      { _id: 'staff-a', role_name: 'staff' },
    ],
    [
      { staff_id: 'staff-b', permission_id: 'view_lost_reports' },
      { staff_id: 'staff-b', permission_id: 'legacy_extra' },
    ],
    ['view_lost_reports', 'view_claims'],
  );

  assert.deepEqual(report, [
    { user_id: 'staff-a', missing: ['view_claims', 'view_lost_reports'], extra: [] },
    { user_id: 'staff-b', missing: ['view_claims'], extra: ['legacy_extra'] },
  ]);
  assert.match(formatReport(report), /staff-a: missing \[view_claims, view_lost_reports\]; extra \[none\]/);
  assert.match(formatReport(report), /staff-b: missing \[view_claims\]; extra \[legacy_extra\]/);
});

test('staff permission preflight includes complete legacy grants without differences', () => {
  const report = buildStaffPermissionReport(
    [{ _id: 'staff-1', role_name: 'staff' }],
    [{ staff_id: 'staff-1', permission_id: 'view_lost_reports' }],
    ['view_lost_reports'],
  );
  assert.deepEqual(report, [{ user_id: 'staff-1', missing: [], extra: [] }]);
});
