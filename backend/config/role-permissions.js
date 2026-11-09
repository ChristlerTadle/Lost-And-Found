const ROLE_PERMISSIONS = [
  { key: 'report_lost_item', label: 'Report lost item', group: 'Reports', role: 'user', requires: [] },
  { key: 'report_found_item', label: 'Report found item', group: 'Reports', role: 'user', requires: [] },
  { key: 'view_items', label: 'View items', group: 'Browse items', role: 'user', requires: [] },
  { key: 'search_items', label: 'Search items', group: 'Browse items', role: 'user', requires: ['view_items'] },
  { key: 'filter_items', label: 'Filter items', group: 'Browse items', role: 'user', requires: ['search_items'] },
  { key: 'view_my_reports', label: 'View my reports', group: 'My reports', role: 'user', requires: [] },
  { key: 'edit_my_report', label: 'Edit my report', group: 'My reports', role: 'user', requires: ['view_my_reports'] },
  { key: 'cancel_my_report', label: 'Cancel my report', group: 'My reports', role: 'user', requires: ['view_my_reports'] },
  { key: 'submit_claim', label: 'Submit claim', group: 'Claims', role: 'user', requires: ['view_items'] },
  { key: 'view_claim_status', label: 'View claim status and history', group: 'Claims', role: 'user', requires: [] },
  { key: 'view_profile', label: 'View profile', group: 'Account', role: 'user', requires: [] },
  { key: 'edit_profile', label: 'Edit profile', group: 'Account', role: 'user', requires: ['view_profile'] },
  { key: 'receive_notifications', label: 'Receive notifications', group: 'Account', role: 'user', requires: [] },
  { key: 'view_lost_reports', label: 'View lost reports', group: 'Lost reports', role: 'staff', requires: [] },
  { key: 'review_lost_report', label: 'Review lost report', group: 'Lost reports', role: 'staff', requires: ['view_lost_reports'] },
  { key: 'view_found_items', label: 'View found items', group: 'Found items', role: 'staff', requires: [] },
  { key: 'verify_found_item', label: 'Verify found item', group: 'Found items', role: 'staff', requires: ['view_found_items'] },
  { key: 'update_item_status', label: 'Update item status', group: 'Found items', role: 'staff', requires: ['view_found_items'] },
  { key: 'mark_item_returned', label: 'Mark item returned', group: 'Found items', role: 'staff', requires: ['update_item_status'] },
  { key: 'view_claims', label: 'View claims', group: 'Claims', role: 'staff', requires: [] },
  { key: 'verify_item_ownership', label: 'Verify item ownership', group: 'Claims', role: 'staff', requires: ['view_claims'] },
  { key: 'approve_claim', label: 'Approve claim', group: 'Claims', role: 'staff', requires: ['verify_item_ownership'] },
  { key: 'schedule_pickup', label: 'Schedule pickup', group: 'Claims', role: 'staff', requires: ['approve_claim'] },
  { key: 'reject_claim', label: 'Reject claim', group: 'Claims', role: 'staff', requires: ['verify_item_ownership'] },
  { key: 'view_records', label: 'View records', group: 'Records and dashboard', role: 'staff', requires: [] },
  { key: 'view_staff_dashboard', label: 'View staff dashboard', group: 'Records and dashboard', role: 'staff', requires: [] },
  { key: 'view_profile', label: 'View profile', group: 'Account', role: 'staff', requires: [] },
  { key: 'edit_profile', label: 'Edit profile', group: 'Account', role: 'staff', requires: ['view_profile'] },
  { key: 'receive_notifications', label: 'Receive notifications', group: 'Account', role: 'staff', requires: [] },
];

const PERMISSIONS_BY_ROLE = Object.fromEntries(
  ['user', 'staff'].map((role) => [
    role,
    ROLE_PERMISSIONS.filter((permission) => permission.role === role),
  ]),
);

const ROLE_PERMISSION_EXEMPT_ROUTES = [
  { method: 'GET', path: '/health', reason: 'Health check' },
  { method: 'GET', path: '/auth/me', reason: 'Session and role-permission bootstrap' },
  { method: 'POST', path: '/auth/register', reason: 'Account registration' },
  { method: 'POST', path: '/auth/login', reason: 'Password login' },
  { method: 'POST', path: '/auth/logout', reason: 'Session logout' },
  { method: 'POST', path: '/auth/forgot-password', reason: 'Password-reset request' },
  { method: 'GET', path: '/auth/reset-password/:token', reason: 'Password-reset token check' },
  { method: 'POST', path: '/auth/reset-password', reason: 'Password reset' },
  { method: 'GET', path: '/auth/google', reason: 'Google sign-in start' },
  { method: 'POST', path: '/auth/google', reason: 'Google sign-in start' },
  { method: 'GET', path: '/auth/google/callback', reason: 'Google sign-in callback' },
];

function normalizeRolePermissions(role, submittedPermissions) {
  const definitions = PERMISSIONS_BY_ROLE[role];
  if (!definitions) {
    const error = new Error('Choose a valid role.');
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(submittedPermissions)
    || submittedPermissions.some((key) => typeof key !== 'string')) {
    const error = new Error('Choose a valid list of role permissions.');
    error.status = 400;
    throw error;
  }
  const allowed = new Set(definitions.map(({ key }) => key));
  const selected = new Set(submittedPermissions);
  for (const key of selected) {
    if (!allowed.has(key)) {
      const error = new Error(`Unknown ${role} permission: ${key}`);
      error.status = 400;
      throw error;
    }
    const permission = definitions.find((entry) => entry.key === key);
    for (const parent of permission.requires) selected.add(parent);
  }
  return definitions.filter(({ key }) => selected.has(key)).map(({ key }) => key);
}

function resolvePermissionKeys(mapping, req, items) {
  if (typeof mapping === 'function') return mapping(req, items);
  if (mapping && typeof mapping === 'object') return mapping[req.user?.role_name] || null;
  return mapping;
}

const ROLE_PERMISSION_ROUTE_MAP = [
  {
    method: 'GET', path: '/items', roles: ['user'], allowAdmin: true,
    permission: (req) => {
      const permissions = ['view_items'];
      if (String(req.query.query || '').trim()) permissions.push('search_items');
      if (['item_type', 'category', 'location', 'status', 'date_from', 'date_to']
        .some((key) => String(req.query[key] || '').trim())) permissions.push('filter_items');
      return permissions;
    },
    note: 'Only route that checks multiple permissions: view_items always; search_items for query; filter_items for filters.',
  },
  { method: 'GET', path: '/items/:id', roles: ['user'], allowAdmin: true, permission: 'view_items' },
  { method: 'GET', path: '/items/:id/image', roles: ['user'], allowAdmin: true, permission: 'view_items' },
  {
    method: 'POST', path: '/items', roles: ['user'],
    permission: (req) => req.body?.item_type === 'found' ? 'report_found_item' : 'report_lost_item',
  },
  { method: 'GET', path: '/items/mine', roles: ['user'], permission: 'view_my_reports' },
  { method: 'GET', path: '/items/mine/:id', roles: ['user'], permission: 'view_my_reports' },
  { method: 'PUT', path: '/items/:id', roles: ['user'], permission: 'edit_my_report' },
  { method: 'DELETE', path: '/items/:id', roles: ['user'], permission: 'cancel_my_report' },
  { method: 'GET', path: '/claims/available/:id', roles: ['user'], permission: 'submit_claim' },
  { method: 'POST', path: '/claims', roles: ['user'], permission: 'submit_claim' },
  { method: 'GET', path: '/claims/mine', roles: ['user'], permission: 'view_claim_status' },
  { method: 'GET', path: '/claims/:id/calendar.ics', roles: ['user'], permission: 'view_claim_status' },
  { method: 'GET', path: '/profile', roles: ['user', 'staff', 'admin'], allowAdmin: true, permission: { user: 'view_profile', staff: 'view_profile' } },
  { method: 'PATCH', path: '/profile', roles: ['user', 'staff', 'admin'], allowAdmin: true, permission: { user: 'edit_profile', staff: 'edit_profile' } },
  { method: 'GET', path: '/notifications', roles: ['user', 'staff', 'admin'], allowAdmin: true, permission: { user: 'receive_notifications', staff: 'receive_notifications' } },
  { method: 'PATCH', path: '/notifications/read-all', roles: ['user', 'staff', 'admin'], allowAdmin: true, permission: { user: 'receive_notifications', staff: 'receive_notifications' } },
  { method: 'PATCH', path: '/notifications/:id/read', roles: ['user', 'staff', 'admin'], allowAdmin: true, permission: { user: 'receive_notifications', staff: 'receive_notifications' } },
  { method: 'GET', path: '/staff/dashboard', roles: ['staff'], permission: 'view_staff_dashboard' },
  { method: 'GET', path: '/staff/records', roles: ['staff'], permission: 'view_records' },
  {
    method: 'GET', path: '/staff/items', roles: ['staff'],
    permission: (req) => ['found', 'stored'].includes(req.query.type) ? 'view_found_items' : 'view_lost_reports',
  },
  {
    method: 'GET', path: '/staff/items/:id', roles: ['staff'],
    permission: async (req, items) => (
      await items.getStaffItemType(req.params.id) === 'lost' ? 'review_lost_report' : 'view_found_items'
    ),
  },
  {
    method: 'GET', path: '/staff/items/:id/image', roles: ['staff'], allowAdmin: true,
    permission: async (req, items) => (
      await items.getStaffItemType(req.params.id) === 'lost' ? 'view_lost_reports' : 'view_found_items'
    ),
  },
  { method: 'GET', path: '/staff/returned-items', roles: ['staff'], permission: 'view_found_items' },
  { method: 'GET', path: '/staff/claims', roles: ['staff'], permission: 'view_claims' },
  { method: 'GET', path: '/staff/claims/:id', roles: ['staff'], permission: 'view_claims' },
  { method: 'PATCH', path: '/staff/items/:id/status', roles: ['staff'], permission: 'update_item_status' },
  { method: 'POST', path: '/staff/items/:id/verify', roles: ['staff'], permission: 'verify_found_item' },
  {
    method: 'PATCH', path: '/staff/claims/:id', roles: ['staff'],
    permission: (req) => {
      if (req.body?.action === 'returned') return 'mark_item_returned';
      if (req.body?.action === 'review' && req.body?.decision === 'approved') {
        return req.body?.pickup_date || req.body?.pickup_time
          ? ['approve_claim', 'schedule_pickup'] : 'approve_claim';
      }
      if (req.body?.action === 'review' && req.body?.decision === 'rejected') return 'reject_claim';
      return null;
    },
    note: 'Decision resolves to approve_claim or reject_claim; supplied pickup times additionally require schedule_pickup; returned uses mark_item_returned.',
  },
  { method: 'PATCH', path: '/staff/claims/:id/pickup', roles: ['staff'], permission: 'schedule_pickup' },
  { method: 'POST', path: '/staff/claims/:id/calendar-sync', roles: ['staff'], permission: 'schedule_pickup' },
];

module.exports = {
  ROLE_PERMISSIONS,
  PERMISSIONS_BY_ROLE,
  ROLE_PERMISSION_EXEMPT_ROUTES,
  ROLE_PERMISSION_ROUTE_MAP,
  normalizeRolePermissions,
  resolvePermissionKeys,
};
