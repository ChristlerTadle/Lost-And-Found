import * as shared from '../shared.js';
const { API, sessionInfo, h, date, param, link, buttonLink, badge, itemStatusLabel, itemTypeLabel, field, selectField, optionsFrom, request, icon, pageHeader, table, formAction, hasPermission } = shared;

async function adminDashboard() {
  const { users, summary } = await request('/admin/dashboard');
  const adminStat = (name, style, title, value, note) => `<article class="card admin-overview-stat"><span class="admin-overview-icon ${style}">${icon(name, 17)}</span>
    <div><span class="stat-label">${title}</span><strong>${value}</strong><small>${note}</small></div></article>`;
  const canViewUsers = hasPermission('view_users');
  const shortcuts = [
    ...(hasPermission('view_users') || hasPermission('manage_permissions')
      ? [['user', canViewUsers ? 'User Management' : 'Role defaults', `${users.totalUsers} accounts`,
        canViewUsers ? 'admin-users' : 'admin-users&tab=role-defaults']] : []),
    ...(hasPermission('view_all_items') ? [['clipboard', 'All Items', `${summary.totalItems} items`, 'admin-items']] : []),
    ...(hasPermission('view_all_claims') ? [['file', 'All Claims', `${summary.totalClaims} total · ${summary.pendingClaims} pending`, 'admin-claims']] : []),
    ...(hasPermission('generate_inventory_report') ? [['file', 'Inventory Report', `${summary.storedItems} in custody`, 'admin-inventory']] : []),
    ...(hasPermission('view_system_records') ? [['file', 'System Records', 'Review administrative and staff actions', 'admin-system-records']] : []),
    ...(hasPermission('manage_integrations') ? [['settings', 'Settings', 'Sign-in integrations', 'admin-settings']] : []),
    ...(hasPermission('view_admin_dashboard') ? [['shield', 'Security', 'Set up an authenticator', 'admin-security']] : []),
  ];
  return `<main class="container admin-overview">${pageHeader('Admin Dashboard', 'System overview — Bukidnon State University Lost & Found')}
    <section class="admin-overview-stats" aria-label="System statistics">
      ${adminStat('user', 'users', 'Total users', users.totalUsers, `${users.activeUsers} active`)}
      ${adminStat('clipboard', 'items', 'Total items', summary.totalItems, `${summary.lostItems} lost, ${summary.foundItems} recovered`)}
      ${adminStat('file', 'claims', 'Pending claims', summary.pendingClaims, 'Needs review')}
      ${adminStat('check', 'returned', 'Items returned', summary.returnedItems, 'Resolved')}
      ${adminStat('clipboard', 'stored', 'Items in staff custody', summary.storedItems, 'Awaiting return to their owners')}
    </section><section class="admin-overview-middle">
      <section class="card admin-overview-panel admin-category-panel"><div class="admin-overview-panel-heading"><h2>Items by category</h2><span>All time</span></div>
        ${summary.categoryCounts.length ? `<div class="admin-category-list">${summary.categoryCounts.map((entry) => `<div class="admin-category-row"><span class="admin-category-name">${h(entry.category)}</span>
          <span class="admin-category-track"><span style="width:${Math.max(4, Math.round(entry.count / summary.categoryCounts[0].count * 100))}%"></span></span><strong>${entry.count}</strong></div>`).join('')}</div>` : '<p class="empty">No item records yet.</p>'}</section>
      <section class="card admin-overview-panel admin-shortcuts-panel"><h2>Administration</h2><div class="admin-shortcuts">
        ${shortcuts.map(([iconName, title, note, destination]) => `<a class="admin-shortcut" href="/?page=${destination}">${icon(iconName, 17)}<span><strong>${title}</strong><small>${note}</small></span></a>`).join('')}
      </div></section></section>
      <section class="admin-overview-bottom"><section class="card admin-overview-panel admin-status-panel"><h2>Item status breakdown</h2><ul class="admin-status-list">
        <li><span><i class="status-dot lost"></i>Lost (Active)</span><strong>${summary.statusCounts.lostActive}</strong></li>
        <li><span><i class="status-dot unverified"></i>Awaiting handoff</span><strong>${summary.statusCounts.foundUnverified}</strong></li>
        <li><span><i class="status-dot verified"></i>Verified</span><strong>${summary.statusCounts.foundVerified}</strong></li>
        <li><span><i class="status-dot stored"></i>In staff custody</span><strong>${summary.statusCounts.stored}</strong></li>
        <li><span><i class="status-dot claimed"></i>Claimed</span><strong>${summary.statusCounts.claimed}</strong></li>
        <li><span><i class="status-dot returned"></i>Returned</span><strong>${summary.statusCounts.returned}</strong></li></ul></section>
      <section class="card admin-overview-panel admin-recent-panel"><div class="admin-overview-panel-heading"><h2>Recent activity</h2>${link('admin-items', 'View items →')}</div>
        ${summary.activity.length ? `<div class="dashboard-activity">${summary.activity.map((entry) => `<div class="dashboard-activity-row">
          <span class="dashboard-activity-icon ${entry.type}">${icon(entry.type === 'claim' ? 'clipboard' : entry.type === 'found' ? 'check' : 'alert', 15)}</span>
          <div><strong>${h(entry.label)}</strong><span>${h(entry.name)} · ${h(entry.detail)}</span></div><time>${date(entry.date)}</time></div>`).join('')}</div>` : '<p class="empty">No recent system activity.</p>'}</section></section>
    </main>`;
}

async function adminUsers() {
  const activeTab = param('tab') === 'role-defaults' && canManagePermissions() ? 'role-defaults' : 'accounts';
  const creatingAccount = activeTab === 'accounts' && param('create') === '1' && canAddUsers();
  const users = activeTab === 'accounts' && canViewUsers() ? (await request('/admin/users')).users : [];
  const needsRoleSettings = activeTab === 'role-defaults' || (creatingAccount && canManagePermissions());
  const roles = needsRoleSettings ? (await request('/admin/role-permissions')).roles : null;
  const rows = users.map((account) => `<tr><td class="item-name">${h(account.full_name)}</td><td>${h(account.email)}</td>
    <td><span class="badge badge-${account.role_name === 'staff' ? 'active' : account.role_name === 'admin' ? 'claimed' : 'pending'}">${roleName(account.role_name)}</span></td>
    <td><span class="badge badge-${account.status === 'active' ? 'active' : 'cancelled'}">${account.status === 'active' ? 'Active' : 'Disabled'}</span></td>
    <td class="right"><div class="admin-account-actions">
      ${canEditAccount() ? `<a class="button button-outline" href="/?page=admin-edit-user&amp;id=${encodeURIComponent(account.id)}">Edit</a>` : ''}
      ${canDisableUsers() && account.id !== sessionInfo.user?.id ? formAction('admin-user', account.id, account.status === 'active' ? 'Disable' : 'Enable', account.status === 'active' ? 'danger' : 'secondary',
        { action: account.status === 'active' ? 'disable' : 'enable' }) : ''}</div></td></tr>`);
  const tabLinks = `<nav class="user-management-tabs" aria-label="User Management sections">
    ${canViewUsers() ? `<a class="button ${activeTab === 'accounts' ? 'button-primary' : 'button-secondary'}" href="/?page=admin-users">Accounts</a>` : ''}
    ${canManagePermissions() ? `<a class="button ${activeTab === 'role-defaults' ? 'button-primary' : 'button-secondary'}" href="/?page=admin-users&amp;tab=role-defaults">Role defaults</a>` : ''}
  </nav>`;
  const roleDefaults = activeTab === 'role-defaults' ? renderRoleDefaults(roles, param('role')) : '';
  const createForm = creatingAccount ? renderAdminCreateUser(roles, canManagePermissions()) : '';
  const accountsPanel = activeTab === 'accounts' ? `${createForm}<section class="card admin-accounts"><div class="admin-accounts-heading"><h2>User accounts</h2><span>${users.length} accounts</span></div>
      ${users.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="right">Actions</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
        : '<p class="empty">There are no accounts to manage.</p>'}
    </section>` : roleDefaults;
  return `<main class="container admin-dashboard">${pageHeader('User Management', 'Edit an account to change its role and what it can do. Use Role defaults to turn a function on or off for every account of a role. Role changes apply on the account’s next request, and disabled accounts are signed out then.',
    canAddUsers() ? `<a class="button ${creatingAccount ? 'button-secondary' : 'button-primary'}" href="/?page=admin-users${creatingAccount ? '' : '&amp;create=1'}">${creatingAccount ? 'Close form' : 'Add account'}</a>` : '')}
    ${tabLinks}${accountsPanel}</main>`;
}

function renderAdminCreateUser(roles, canManage) {
  const roleOptions = roles?.filter(({ role }) => ['user', 'staff'].includes(role)) || [];
  return `<form class="card form-grid admin-create-user admin-create-user-form" data-form="admin-add-user"
    data-current-role="user" data-manage-permissions="${canManage}">
    <h2 class="field full">Create account</h2>${field('Full name', 'full_name', 'text', '', true)}
    ${field('Email address', 'email', 'email', '', true)}${field('Student ID', 'student_id')}
    ${field('Phone number', 'phone', 'tel')}<div class="field"><label for="password">Temporary password</label>
      <input class="input" id="password" name="password" type="password" required minlength="8"><small class="admin-password-hint">Use at least 8 characters.</small></div>
    ${canManage ? `<div class="field"><label for="new-account-role">Role</label>
      <select class="select" id="new-account-role" name="role_name" data-action="account-role">
        <option value="user" selected>User</option><option value="staff">Staff</option>
      </select></div>
      <section class="admin-account-permissions"><p class="muted">Choose account-only permissions. Role defaults always take precedence.</p>
        ${roleOptions.map((entry) => renderPermissionChecklist(entry.role, entry.permissions, entry.role === 'user')).join('')}
      </section>`
      : `<input type="hidden" name="role_name" value="user"><p class="muted field full">New accounts are created as Users. Creating a Staff account requires permission to manage permissions.</p>`}
    <div class="form-actions"><a class="button button-secondary" href="/?page=admin-users">Cancel</a>
      <button class="button button-primary" type="submit">Create account</button></div></form>`;
}

function renderRoleDefaults(roles, requestedRole = '') {
  const selectedRole = ['staff', 'admin'].includes(requestedRole) ? requestedRole : 'user';
  const selected = roles.find((entry) => entry.role === selectedRole);
  const permissions = selected.permissions;
  const groups = [...new Set(permissions.map(({ group }) => group))];
  const enabled = permissions.filter(({ enabled: isEnabled }) => isEnabled).map(({ key }) => key);
  const lockedAdminPermissions = new Set(['manage_permissions', 'view_users', 'manage_integrations']);
  return `<section class="admin-role-defaults">
    <header class="page-header"><div><h2>Role defaults</h2><p>Changes apply to every account with the selected role immediately.</p></div></header>
    <div class="card role-permission-selector"><div class="field"><label for="role-permission-role">Role</label>
      <select class="select" id="role-permission-role" data-action="role-permission-role">
        <option value="user" ${selectedRole === 'user' ? 'selected' : ''}>User</option>
        <option value="staff" ${selectedRole === 'staff' ? 'selected' : ''}>Staff</option>
        <option value="admin" ${selectedRole === 'admin' ? 'selected' : ''}>Admin</option>
      </select></div></div>
    <form class="card role-permission-form" data-form="admin-role-permissions" data-role="${selectedRole}" data-active-accounts="${selected.active_accounts}"
      data-saved-permissions="${h(JSON.stringify(enabled))}"
      data-dependencies="${h(JSON.stringify(Object.fromEntries(permissions.map(({ key, requires }) => [key, requires]))))}">
      <h2>${roleName(selectedRole)} checklist</h2>
      <p class="role-permission-warning">Turning off a permission disables that feature for every ${selectedRole} account.</p>
      <div class="role-permission-groups">${groups.map((group) => `<fieldset class="role-permission-group"><legend>${h(group)}</legend>
        ${permissions.filter((permission) => permission.group === group).map((permission) => {
          const locked = selectedRole === 'admin' && lockedAdminPermissions.has(permission.key);
          return `<label class="role-permission-option${locked ? ' permission-locked' : ''}">
            <input type="checkbox" name="permissions" value="${h(permission.key)}" ${permission.enabled || locked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            ${locked ? `<input type="hidden" name="permissions" value="${h(permission.key)}">` : ''}
            <span><strong>${h(permission.label)}</strong>${locked
              ? '<small>Required so admins cannot be locked out</small>'
              : permission.requires.length ? `<small>Requires: ${h(permission.requires.map((key) => permissions.find((entry) => entry.key === key)?.label || key).join(', '))}</small>` : ''}</span>
          </label>`;
        }).join('')}
      </fieldset>`).join('')}</div>
      <div class="form-actions"><button class="button button-secondary" type="button" data-action="cancel-role-permissions">Cancel</button>
        <button class="button button-primary" type="submit" disabled>Save Changes</button></div>
    </form>
  </section>`;
}

async function adminEditUser(id) {
  const { users } = await request('/admin/users');
  const user = users.find((account) => account.id === id);
  if (!user) throw new Error('User account was not found.');
  const isSelf = user.id === sessionInfo.user?.id;
  const canManage = canManagePermissions() && !isSelf;
  const canChangeRole = canManage && canEditUsers();
  const canAssignAdminRole = sessionInfo.rolePermissions.includes('assign_admin_role');
  const [accountSettings, roleSettings] = canManage
    ? await Promise.all([
      request(`/admin/users/${encodeURIComponent(id)}/permissions`),
      request('/admin/role-permissions'),
    ])
    : [null, null];
  const rolePanels = canManage ? roleSettings.roles.map((entry) => {
    const accountRole = entry.role === user.role_name;
    const currentPermissions = accountRole ? accountSettings.permissions : entry.permissions;
    return renderPermissionChecklist(entry.role, currentPermissions, accountRole);
  }).join('') : '';
  return `<main class="container admin-dashboard admin-edit-user">${pageHeader('Edit user')}
    <form class="card form-grid admin-create-user admin-create-user-form" data-form="admin-edit-user" data-id="${h(id)}" data-current-role="${h(user.role_name)}" data-full-name="${h(user.full_name)}">
    ${field('Full name', 'full_name', 'text', user.full_name, true, canEditUsers() ? '' : 'readonly')}${field('Email address', 'email', 'email', user.email, false, 'readonly')}
    ${field('Student ID', 'student_id', 'text', user.student_id || '', false, canEditUsers() ? '' : 'readonly')}${field('Phone number', 'phone', 'tel', user.phone || '', false, canEditUsers() ? '' : 'readonly')}
    <div class="field"><label>Account status</label><p>${h(user.status === 'active' ? 'Active' : 'Disabled')}</p></div>
    ${isSelf
      ? `<div class="field"><label>Role</label><p>${roleName(user.role_name)}</p><input type="hidden" name="role_name" value="${h(user.role_name)}"></div>`
      : `<div class="field"><label for="account-role">Role</label><select class="select" id="account-role" name="role_name" data-action="account-role" ${canChangeRole ? '' : 'disabled'}>
        <option value="user" ${user.role_name === 'user' ? 'selected' : ''} ${user.role_name === 'admin' && !canAssignAdminRole ? 'disabled' : ''}>User</option>
        <option value="staff" ${user.role_name === 'staff' ? 'selected' : ''} ${user.role_name === 'admin' && !canAssignAdminRole ? 'disabled' : ''}>Staff</option>
        <option value="admin" ${user.role_name === 'admin' ? 'selected' : ''} ${!canAssignAdminRole && user.role_name !== 'admin' ? 'disabled' : ''}>Admin</option>
      </select>${!canAssignAdminRole ? '<small>Assigning or demoting Admins requires the Assign admin role permission.</small>' : ''}</div>`}
    ${canManage ? `<section class="admin-account-permissions" data-current-role="${h(user.role_name)}">
      <p class="muted">Changes here apply to this account only. The role setting always wins.</p>
      ${rolePanels}
      <button class="button button-secondary" type="button" data-action="reset-account-permissions" data-id="${h(id)}">Reset to role defaults</button>
    </section>` : '<p class="muted">You do not have permission to manage this account’s permissions.</p>'}
    <div class="form-actions"><a class="button button-secondary" href="/?page=admin-users">Cancel</a><button class="button button-primary" type="submit">Save Changes</button></div></form>
    <dialog class="admin-role-change-code-dialog" data-role-change-code-dialog>
      <form class="form-grid" data-form="admin-role-change-code">
        <h2 class="field full">Verify Admin role change</h2>
        <p class="muted field full">A six-digit code was sent to SU_EMAIL. It expires in 10 minutes.</p>
        <div class="field full"><label for="admin-role-change-code">Verification code</label>
          <input class="input" id="admin-role-change-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        <p class="field full" data-role-change-code-error role="status"></p>
        <div class="form-actions full">
          <button class="button button-secondary" type="button" data-action="close-role-change-code">Close</button>
          <button class="button button-secondary" type="button" data-action="resend-role-change-code">Resend (60s)</button>
          <button class="button button-primary" type="submit">Verify and save</button>
        </div>
      </form>
    </dialog></main>`;
}

function renderPermissionChecklist(role, permissions, currentRole) {
  const groups = [...new Set(permissions.map(({ group }) => group))];
  const saved = permissions.filter(({ enabled }) => enabled).map(({ key }) => key);
  const dependencies = Object.fromEntries(permissions.map(({ key, requires }) => [key, requires]));
  return `<div class="admin-account-permission-role" data-role-panel="${role}" ${currentRole ? '' : 'hidden'}>
    <h2>${roleName(role)} permissions</h2>
    <div class="role-permission-groups">${groups.map((group) => `<fieldset class="role-permission-group"><legend>${h(group)}</legend>
      ${permissions.filter((permission) => permission.group === group).map((permission) => {
        const roleEnabled = permission.role_enabled === undefined ? permission.enabled : permission.role_enabled;
        const dependenciesEnabled = permission.requires.every((key) => (
          permissions.find((entry) => entry.key === key)?.role_enabled
            ?? permissions.find((entry) => entry.key === key)?.enabled
        ));
        const available = roleEnabled && dependenciesEnabled;
        const checked = roleEnabled && permission.enabled;
        return `<label class="role-permission-option${roleEnabled ? '' : ' permission-disabled'}">
          <input type="checkbox" name="permissions" value="${h(permission.key)}" data-role-enabled="${available}" ${checked ? 'checked' : ''} ${available && currentRole ? '' : 'disabled'}>
          <span><strong>${h(permission.label)}</strong>${roleEnabled
            ? permission.requires.length ? `<small>Requires: ${h(permission.requires.map((key) => permissions.find((entry) => entry.key === key)?.label || key).join(', '))}</small>` : ''
            : `<small>Turned off for all ${roleName(role)} accounts. <a href="/?page=admin-users&amp;tab=role-defaults&amp;role=${encodeURIComponent(role)}" data-discard-aware>Role defaults</a></small>`}</span>
        </label>`;
      }).join('')}
    </fieldset>`).join('')}</div>
    <input type="hidden" data-saved-permissions="${h(JSON.stringify(saved))}" data-dependencies="${h(JSON.stringify(dependencies))}">
  </div>`;
}

function roleName(role) {
  return ({ user: 'User', staff: 'Staff', admin: 'Admin' })[role] || 'Unknown';
}

function canManagePermissions() {
  return sessionInfo.rolePermissions.includes('manage_permissions');
}

function canViewUsers() {
  return sessionInfo.rolePermissions.includes('view_users');
}

function canEditUsers() {
  return sessionInfo.rolePermissions.includes('edit_user');
}

function canEditAccount() {
  return canEditUsers() || canManagePermissions();
}

function canAddUsers() {
  return sessionInfo.rolePermissions.includes('add_user');
}

function canDisableUsers() {
  return sessionInfo.rolePermissions.includes('disable_user');
}

async function adminItems() {
  const query = new URLSearchParams(location.search);
  const search = new URLSearchParams();
  ['query', 'item_type', 'status', 'category', 'date_from', 'date_to'].forEach((key) => {
    if (query.get(key)) search.set(key, query.get(key));
  });
  const { items } = await request(`/admin/items?${search}`);
  const rows = items.map((item) => `<article class="admin-item-row"><div class="admin-item-summary">
      <h3>${h(item.item_name)}</h3><p>${itemTypeLabel(item.item_type)} report · ${h(item.category)} · ${h(item.location)}</p>
      <p>Reported by ${h(item.reported_by || 'Unknown')} · ${date(item.created_at)}</p><p class="admin-item-description">${h(item.description)}</p>
    </div><div class="admin-item-actions">${badge(item.status, itemStatusLabel(item.status, item.item_type))}
      <a class="button button-outline" href="/?page=admin-edit-item&amp;id=${encodeURIComponent(item.id)}">Edit record</a>
      ${formAction('admin-item-remove', item.id, 'Remove', 'danger')}</div></article>`);
  return `<main class="container admin-dashboard admin-items-page"><header class="page-header browse-header"><div><h1>All Items</h1><p>${items.length} item records found</p></div>
    ${buttonLink('admin-dashboard', 'Admin dashboard', 'button-secondary')}</header>
    <form method="get" class="browse-filter-form"><input type="hidden" name="page" value="admin-items"><div class="card browse-toolbar">
      <label class="browse-search" for="query">${icon('search', 17)}<input id="query" name="query" value="${h(query.get('query') || '')}" placeholder="Search item, description, location, reporter..."></label>
      <select class="select" name="item_type" aria-label="Filter by item type"><option value="">All Types</option>${['lost', 'found'].map((value) => `<option value="${value}" ${query.get('item_type') === value ? 'selected' : ''}>${itemTypeLabel(value)}</option>`).join('')}</select>
      <select class="select" name="status" aria-label="Filter by status"><option value="">All Statuses</option>${['lost', 'found', 'stored', 'claimed', 'returned', 'cancelled'].map((value) => `<option value="${value}" ${query.get('status') === value ? 'selected' : ''}>${itemStatusLabel(value)}</option>`).join('')}</select>
      <select class="select" name="category" aria-label="Filter by category">${optionsFrom(sessionInfo.categories).map(([value, label]) => `<option value="${value}" ${query.get('category') === value ? 'selected' : ''}>${h(label)}</option>`).join('')}</select>
      <button class="button button-primary browse-search-submit" type="submit">Search</button></div>
      <details class="browse-more-filters" ${query.get('date_from') || query.get('date_to') ? 'open' : ''}><summary>Filter by date</summary><div class="browse-more-grid">
        <div class="field"><label for="date_from">From date</label><input class="input" id="date_from" name="date_from" type="date" value="${h(query.get('date_from') || '')}"></div>
        <div class="field"><label for="date_to">To date</label><input class="input" id="date_to" name="date_to" type="date" value="${h(query.get('date_to') || '')}"></div>
        <div class="browse-more-actions"><button class="button button-primary" type="submit">Apply filters</button><a class="button button-secondary" href="/?page=admin-items">Clear filters</a></div>
      </div></details>
    </form><section class="card admin-items-list"><div class="admin-items-list-heading"><h2>Item records</h2><span>${items.length} ${items.length === 1 ? 'item' : 'items'}</span></div>
      ${rows.length ? rows.join('') : '<p class="empty">No item records match these filters.</p>'}
    </section></main>`;
}

async function adminEditItem(id) {
  const { item } = await request(`/admin/items/${encodeURIComponent(id)}`);
  const dateLabel = item.item_type === 'found' ? 'Date found' : 'Date lost';
  const imageUrl = item.item_type === 'found' && item.image_path
    ? `${API}/admin/items/${encodeURIComponent(item.id)}/image`
    : '';
  return `<main class="container admin-edit-item-page">
    <a class="back-link" href="/?page=admin-items">← Back to All Items</a>
    <header class="admin-edit-item-heading"><div><h1>Edit Item Record</h1>
      <p>Correct item details reported by ${h(item.reported_by || 'Unknown')}.</p></div>
      ${badge(item.item_type, itemTypeLabel(item.item_type))}</header>
    <div class="tip admin-edit-item-notice">Editing the record does not change its owner, item type, or workflow status. If verified found-item details are changed, staff verification will need to be repeated.</div>
    <div class="admin-edit-item-layout${imageUrl ? ' has-image' : ''}">
    <form class="card form-grid admin-edit-item-form" data-form="admin-edit-item" data-id="${h(id)}">
      ${field('Item name', 'item_name', 'text', item.item_name, true)}
      ${selectField('Category', 'category', sessionInfo.categories.map((value) => [value, value]), item.category, true)}
      ${field('Location', 'location', 'text', item.location, true)}
      ${field(dateLabel, 'date_lost', 'date', String(item.date_lost).slice(0, 10), true)}
      <div class="field full"><label for="description">Description</label><textarea class="textarea" id="description" name="description" required>${h(item.description)}</textarea></div>
      <div class="field full"><label for="identifying_details">Private identifying details</label><textarea class="textarea" id="identifying_details" name="identifying_details" required>${h(item.identifying_details)}</textarea>
        <p class="admin-edit-item-hint">Only authorized staff can use these details to verify ownership claims.</p></div>
      <div class="admin-edit-item-actions field full"><a class="button button-secondary" href="/?page=admin-items">Cancel</a>
        <button class="button button-primary" type="submit">Save changes</button></div>
    </form>
    ${imageUrl ? `<figure class="admin-edit-item-media"><img alt="${h(item.item_name)}" src="${h(imageUrl)}"><figcaption>Photo provided with the report</figcaption></figure>` : ''}
    </div></main>`;
}

async function adminClaims() {
  const query = new URLSearchParams(location.search);
  const filters = new URLSearchParams();
  ['query', 'status'].forEach((key) => { if (query.get(key)) filters.set(key, query.get(key)); });
  const { claims } = await request(`/admin/claims?${filters}`);
  return `<main class="container staff-workspace admin-claims-page"><header class="page-header browse-header"><div><h1>All Claims</h1><p>${claims.length} ${claims.length === 1 ? 'claim' : 'claims'} found</p></div>
    ${buttonLink('admin-dashboard', 'Admin dashboard', 'button-secondary')}</header>
    <form method="get" class="browse-filter-form"><input type="hidden" name="page" value="admin-claims"><div class="card browse-toolbar">
      <label class="browse-search" for="admin-claims-search">${icon('search', 17)}<input id="admin-claims-search" name="query" value="${h(query.get('query') || '')}" placeholder="Search item, claimant, or claim details..."></label>
      <select class="select" name="status" aria-label="Filter by claim status">${optionsFrom(['pending', 'approved', 'rejected']).map(([value, label]) => `<option value="${value}" ${query.get('status') === value ? 'selected' : ''}>${label ? label[0].toUpperCase() + label.slice(1) : 'All statuses'}</option>`).join('')}</select>
      <button class="button button-primary browse-search-submit" type="submit">Search</button><a class="button button-secondary" href="/?page=admin-claims">Clear</a>
    </div></form><section class="card staff-record-list staff-claims-list"><div class="staff-list-heading"><h2>Claim records</h2><span>${claims.length} claims</span></div>
      ${claims.length ? claims.map((claim) => `<article class="admin-claim-record"><div class="admin-claim-record-main"><h3>${h(claim.item_name)}</h3>
        <p>${h(claim.item.category)} · ${h(claim.item.location)} · Reported by ${h(claim.item.reported_by || 'Unknown')}</p>
        <p>Claimant: <strong>${h(claim.claimant?.full_name || 'Account unavailable')}</strong>${claim.claimant?.email ? ` · ${h(claim.claimant.email)}` : ''}</p>
        <p class="admin-claim-details">${h(claim.claim_details)}</p></div><div class="admin-claim-record-meta">${badge(claim.status)}<time>Submitted ${date(claim.created_at)}</time></div></article>`).join('')
        : `<div class="staff-claims-empty"><span class="staff-empty-icon">${icon('clipboard', 22)}</span><h3>No claims found</h3><p>Claims matching your filters will appear here.</p></div>`}
    </section></main>`;
}

async function adminInventory() {
  const { items } = await request('/admin/inventory');
  const categories = new Set(items.map((item) => item.category).filter(Boolean));
  const generatedOn = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const inventoryTable = items.map((item) => `<tr><td class="item-name">${h(item.item_name)}</td><td>${h(item.category)}</td>
    <td>${h(item.location)}</td><td>${date(item.date_lost)}</td><td>${h(item.reported_by || 'Unknown')}</td>
    <td><span class="badge ${item.physical_verification_status === 'verified' ? 'badge-active' : 'badge-not-verified'}">${item.physical_verification_status === 'verified' ? 'Verified' : 'Pending'}</span></td></tr>`);
  return `<main class="container admin-dashboard admin-inventory-page">
    <header class="page-header admin-inventory-header"><div><h1>Inventory Report</h1><p>Found items currently stored in Lost and Found custody.</p></div>
      <div class="admin-inventory-actions">${buttonLink('admin-dashboard', 'Admin dashboard', 'button-secondary')}
        <button class="button button-primary" type="button" data-action="print-inventory">Print report</button></div></header>
    <section class="admin-inventory-summary" aria-label="Inventory summary">
      <article class="card admin-inventory-stat"><span class="stat-label">Items in custody</span><strong>${items.length}</strong></article>
      <article class="card admin-inventory-stat"><span class="stat-label">Categories represented</span><strong>${categories.size}</strong></article>
      <article class="card admin-inventory-stat"><span class="stat-label">Report generated</span><strong>${generatedOn}</strong></article>
    </section>
    <section class="card admin-inventory-table"><div class="admin-inventory-table-heading"><h2>Stored found items</h2><span>${items.length} ${items.length === 1 ? 'item' : 'items'}</span></div>
      ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th>Location found</th><th>Date found</th><th>Reported by</th><th>Verification</th></tr></thead><tbody>${inventoryTable.join('')}</tbody></table></div>`
        : '<p class="empty">There are no found items currently in staff custody.</p>'}
    </section>
    <p class="admin-inventory-footnote">This report includes found-item records currently marked as stored. Returned, claimed, and other records are excluded.</p>
  </main>`;
}

async function adminSettings() {
  const access = await request('/admin/settings/access');
  if (!access.accessReady) {
    return `<main class="container admin-dashboard admin-settings">
      ${pageHeader('Settings', 'Manage optional sign-in integrations for the system.', buttonLink('admin-dashboard', 'Back to dashboard', 'button-secondary'))}
      <section class="card integration-pin-gate"><h2>Integration Settings are locked</h2>
        <p>${h(access.accessError)}</p><p>Configure the required server environment values, then restart the API.</p></section>
    </main>`;
  }
  if (!access.unlocked) {
    return `<main class="container admin-dashboard admin-settings">
      ${pageHeader('Settings', 'Manage optional sign-in integrations for the system.', buttonLink('admin-dashboard', 'Back to dashboard', 'button-secondary'))}
      <p class="integration-settings-note">Enter the server-configured PIN to view integration settings.</p>
      <dialog class="integration-pin-dialog" data-integration-pin-dialog aria-labelledby="integration-pin-title">
        <form data-form="integration-pin" data-csrf-token="${h(access.csrfToken)}">
          <h2 id="integration-pin-title">Unlock Integration Settings</h2>
          <p>Enter the server-configured PIN to continue.</p>
          <div class="field"><label for="integration-settings-pin">PIN</label>
            <input class="input" id="integration-settings-pin" name="pin" type="password" autocomplete="current-password" required></div>
          <small class="integration-pin-error" data-integration-pin-error role="alert"></small>
          <div class="integration-pin-actions">
            <a class="button button-secondary" href="/?page=admin-dashboard">Back</a>
            <button class="button button-primary" type="submit">Unlock</button>
          </div>
        </form>
      </dialog>
    </main>`;
  }
  const { integrations } = await request('/admin/settings');
  const csrfToken = access.csrfToken;
  const descriptions = {
    google_auth: 'Allow users to sign in or create an account using a verified Google account.',
    recaptcha: 'Require users to complete a reCAPTCHA challenge before signing in or creating an account.',
    smtp: 'Send password reset messages using this SMTP server.',
    google_calendar: 'Schedule item pickups on one shared organization calendar. Share only the dedicated pickup calendar with the service account.',
    admin_mfa: 'Require administrator sign-in codes from an authenticator app. Users and Staff are not affected.',
  };
  const verificationLabels = {
    real_sign_in: 'with a real sign-in',
    real_challenge: 'with a real challenge',
    test_email_sent: 'test email sent',
    test_event_created_and_removed: 'test event created and removed',
    authenticator_code_accepted: 'authenticator code accepted',
  };
  const cards = Object.values(integrations).map((integration) => `<section class="card integration-setting" data-integration="${h(integration.id)}"
    data-using-default="${integration.usingDefault}" data-has-default="${integration.hasDefault}"
    data-active="${integration.active}"
    data-current-verification="${integration.isCurrentVerification}"
    data-verification-proof="${h(integration.verification?.proofType || '')}"
    data-verification-label="${h(verificationLabels[integration.verification?.proofType] || '')}"
    data-verification-at="${h(integration.verification?.verifiedAt || '')}"
    data-failing="${integration.status === 'Failing'}">
    <div class="integration-setting-main">
      <div class="integration-setting-copy"><div class="integration-setting-heading"><h2>${h(integration.label)}</h2></div>
        <p>${h(descriptions[integration.id] || '')}</p>
        <p class="integration-config-status">Status: <span class="badge ${integration.status === 'Failing' ? 'badge-failing' : integration.active ? 'badge-active' : integration.configured ? 'badge-cancelled' : 'badge-pending'}" data-integration-status>${h(integration.status)}</span></p>
        <p class="integration-health-status" data-integration-health ${integration.status === 'Failing' ? '' : 'hidden'}>
          ${integration.status === 'Failing' && integration.health?.last_error_at ? `Last failure: ${h(new Date(integration.health.last_error_at).toLocaleString())} · ` : ''}
          ${integration.status === 'Failing' ? h(integration.health?.last_error_message || '') : ''}
          ${integration.status === 'Failing' && integration.health?.consecutive_failures ? ` (${integration.health.consecutive_failures} consecutive)` : ''}
        </p>
        <p class="integration-default-status">Default: <span data-default-status>${integration.usingDefault ? 'Using default' : integration.hasDefault ? 'Modified' : 'No default saved'}</span></p>
        <p class="integration-validation-status" data-integration-validation>
          ${integration.verification
            ? `Verified at ${h(new Date(integration.verification.verifiedAt).toLocaleString())} · ${h(verificationLabels[integration.verification.proofType] || 'proof recorded')}`
            : 'Not verified'}
        </p>
        <p class="integration-missing-fields" data-integration-missing>${integration.missingFields.length
          ? `Missing: ${integration.missingFields.map((name) => {
            const field = integration.fields.find((entry) => entry.name === name);
            return h(field?.label || name);
          }).join(', ')}` : ''}</p>
      </div>
      <div class="integration-setting-actions">
        <button class="button button-outline" type="button" data-action="integration-toggle" data-enabled="${integration.enabled}">
          ${integration.enabled ? 'Disable' : 'Enable'}</button>
        ${['google_auth', 'recaptcha', 'admin_mfa'].includes(integration.id)
          ? '<button class="button button-outline" type="button" data-action="integration-verify">Verify</button>' : ''}
        ${integration.id === 'smtp' ? '<button class="button button-outline" type="button" data-action="smtp-test">Test Connection</button>' : ''}
        ${integration.id === 'google_calendar' ? '<button class="button button-outline" type="button" data-action="calendar-test">Test Connection</button>' : ''}
      </div>
    </div>
    ${integration.id === 'recaptcha' ? `<div class="integration-recaptcha-verification"
      data-recaptcha-verification hidden>
      <p data-recaptcha-verification-prompt>Complete this challenge to verify the candidate keys.</p>
      <div data-recaptcha-verification-widget></div>
    </div>` : ''}
    ${integration.id === 'admin_mfa' ? `<div class="field integration-verification-code">
      <label for="integration-admin-mfa-code">Current authenticator code</label>
      <input class="input" id="integration-admin-mfa-code" data-verification-code inputmode="numeric" autocomplete="one-time-code" maxlength="6">
    </div>` : ''}
    ${integration.id === 'admin_mfa' ? `<p class="admin-mfa-enrollment-count">${integration.enrollmentSummary?.enrolledAdmins || 0} of ${integration.enrollmentSummary?.totalAdmins || 0} administrators enrolled</p>
      <p class="admin-mfa-fixed-settings">Authenticator codes: 6 digits · 30-second period · SHA-1 (fixed)</p>` : ''}
    <details class="integration-fields-disclosure">
      <summary class="button button-outline">Change keys / settings</summary>
      <div class="integration-fields">${integration.fields.map((field) => `<div class="field">
        <label for="integration-${h(integration.id)}-${h(field.name)}">${h(field.label)}${field.required ? ' <span aria-hidden="true">*</span>' : ''}</label>
        ${field.type === 'checkbox'
          ? `<input id="integration-${h(integration.id)}-${h(field.name)}" name="${h(field.name)}" type="checkbox" ${field.value ? 'checked' : ''}>`
          : field.type === 'textarea'
            ? `<textarea class="input" id="integration-${h(integration.id)}-${h(field.name)}" name="${h(field.name)}" rows="4"
              placeholder="${field.secret && field.hasValue ? h(field.value) : ''}"
              ${field.required ? 'data-required="true" required' : ''} autocomplete="off"></textarea>`
            : `<input class="input" id="integration-${h(integration.id)}-${h(field.name)}" name="${h(field.name)}" type="${h(field.secret ? 'password' : field.type)}"
              value="${field.secret ? '' : h(field.value)}" placeholder="${field.secret && field.hasValue ? h(field.value) : ''}"
              ${field.required ? 'data-required="true"' : ''} ${field.type === 'number' ? `inputmode="numeric" min="${field.name === 'window' && integration.id === 'admin_mfa' ? '0' : ''}" max="${field.name === 'window' && integration.id === 'admin_mfa' ? '1' : ''}" step="${field.name === 'window' && integration.id === 'admin_mfa' ? '1' : ''}"` : ''} autocomplete="off">`}
        <small class="integration-field-error" data-field-error="${h(field.name)}" role="alert"></small>
      </div>`).join('')}</div>
    </details>
    <div class="integration-default-actions">
      <button class="button button-outline" type="button" data-action="set-integration-default"
        ${integration.active && integration.isCurrentVerification && !integration.usingDefault ? '' : 'disabled'}>
        Set current as default</button>
      <button class="button button-outline" type="button" data-action="restore-integration-default" ${integration.hasDefault && !integration.usingDefault ? '' : 'disabled'}>
        Restore default</button>
    </div>
    <div class="integration-card-actions" hidden>
      <button class="button button-primary" type="button" data-action="save-integration">Save Changes</button>
      <button class="button button-outline" type="button" data-action="cancel-integration">Cancel</button>
    </div>
  </section>`).join('');
  return `<main class="container admin-dashboard admin-settings" data-csrf-token="${h(csrfToken)}">
    ${pageHeader('Settings', 'Manage system integrations and pickup scheduling.', buttonLink('admin-dashboard', 'Back to dashboard', 'button-secondary'))}
    ${access.verificationEmailConfigured ? '' : `<p class="integration-settings-note integration-verification-warning">${h(access.verificationEmailError)} Credential changes are unavailable until it is configured.</p>`}
    <form data-form="integration-settings" novalidate>${cards}
      <p class="integration-settings-note">Changes stay pending until you save that card. Credential changes require an emailed verification code. Secret values remain masked; leave a secret field empty to keep its saved value.</p>
    </form>
    <dialog class="integration-code-dialog" data-integration-code-dialog aria-labelledby="integration-code-title">
      <form data-form="integration-code" novalidate>
        <h2 id="integration-code-title">Verify credential changes</h2>
        <p>Enter the 6-digit code sent to the configured administrator email.</p>
        <div class="field"><label for="integration-verification-code">Verification code</label>
          <input class="input" id="integration-verification-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>
        <small class="integration-code-error" data-integration-code-error role="alert"></small>
        <div class="integration-card-actions">
          <button class="button button-primary" type="submit" data-action="verify-integration-code">Verify and save</button>
          <button class="button button-outline" type="button" data-action="resend-integration-code">Resend</button>
          <button class="button button-secondary" type="button" data-action="cancel-integration-code">Cancel</button>
        </div>
      </form>
    </dialog>
  </main>`;
}

async function adminSystemRecords() {
  const query = new URLSearchParams(location.search);
  const now = new Date();
  const maxDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dateFrom = query.get('date_from') || '';
  const dateTo = query.get('date_to') || '';
  const safeDateFrom = dateFrom <= maxDate ? dateFrom : '';
  const safeDateTo = dateTo <= maxDate ? dateTo : '';
  const filters = new URLSearchParams();
  for (const key of ['date_from', 'date_to', 'actor_id', 'actor_role', 'action', 'target_type', 'result']) {
    if (query.get(key)) filters.set(key, query.get(key));
  }
  if (dateFrom > maxDate) filters.delete('date_from');
  if (dateTo > maxDate) filters.delete('date_to');
  filters.set('page', query.get('audit_page') || '1');
  const { records, page, total, total_pages: totalPages } = await request(`/admin/system-records?${filters}`);
  const actions = [
    'user.create', 'user.update', 'user.disable', 'staff_permissions.update', 'role_permissions.update',
    'item.update', 'item.remove', 'report.generate', 'claim.approve',
    'claim.reject', 'ownership.verify', 'item.status_update', 'item.mark_returned',
    'auth.login', 'auth.login_failed', 'access.denied',
    'integration.enable', 'integration.disable', 'integration.update',
    'integration.unlock', 'integration.unlock_failed', 'integration.unlock_locked',
    'integration.code_sent', 'integration.code_failed', 'integration.restore_default',
    'integration.set_default', 'integration.validate_failed', 'integration.verify_success',
    'integration.verify_failed', 'integration.rate_limited', 'integration.failure',
    'calendar.event_create', 'calendar.event_update', 'calendar.event_delete', 'calendar.sync_failed',
    'admin.mfa_enroll_start', 'admin.mfa_enrolled', 'admin.mfa_verify_success',
    'admin.mfa_verify_failed', 'admin.mfa_locked', 'admin.mfa_recovery_used',
    'admin.mfa_recovery_regenerated', 'admin.mfa_reset',
  ];
  const rows = records.map((record) => {
    const result = ['integration.unlock_failed', 'integration.code_failed'].includes(record.action)
      ? 'failed' : record.action === 'integration.unlock_locked' ? 'denied' : record.result;
    return `<tr>
    <td data-label="Date"><time class="audit-date" datetime="${h(record.created_at)}">
      <span>${h(new Date(record.created_at).toLocaleDateString())}</span>
      <small>${h(new Date(record.created_at).toLocaleTimeString())}</small>
    </time></td>
    <td class="audit-actor" data-label="Actor">
      <div class="audit-cell-content">
        <span class="audit-role audit-role-${record.actor_role === 'admin' ? 'admin' : record.actor_role === 'staff' ? 'staff' : 'unknown'}">${h(record.actor_role || 'Unauthenticated')}</span>
        <code>${h(record.actor_role ? record.actor_id || 'ID unavailable' : 'No account ID')}</code>
      </div>
    </td>
    <td class="audit-action" data-label="Action / result"><div class="audit-cell-content"><strong>${h(record.action)}</strong><span class="audit-result audit-result-${h(result)}">${h(result)}</span></div></td>
    <td class="audit-target" data-label="Target"><div class="audit-cell-content"><span>${h(record.target_type || 'No target')}</span>
      ${record.target_id ? `<code>${h(record.target_id)}</code>` : ''}
    </div>
    </td>
    <td data-label="Changes"><details class="audit-details"><summary>View details</summary><pre>${h(JSON.stringify({
      ...(record.old_value ? { old: record.old_value } : {}),
      ...(record.new_value ? { new: record.new_value } : {}),
      ...(record.ip_address ? { ip_address: record.ip_address } : {}),
    }, null, 2))}</pre></details></td></tr>`;
  });
  const pageLink = (target) => {
    const params = new URLSearchParams(filters);
    params.delete('page');
    params.set('audit_page', String(target));
    const urlParams = new URLSearchParams({ page: 'admin-system-records' });
    for (const [key, value] of params) urlParams.set(key, value);
    return `/?${urlParams.toString()}`;
  };
  return `<main class="container admin-dashboard admin-system-records">
    <header class="audit-page-header"><div><span class="audit-eyebrow">ADMINISTRATION / AUDIT TRAIL</span>
      <h1>System Records</h1><p>Review important administrative and staff activity across your system.</p></div>
      <div class="audit-page-badge"><span aria-hidden="true">●</span> Read-only log</div>
    </header>
    <form method="get" class="card system-record-filters"><input type="hidden" name="page" value="admin-system-records">
      <div class="audit-filter-heading"><div><h2>Filter records</h2><p>Choose criteria to narrow the audit history.</p></div></div>
      <div class="field"><label for="audit-from">From</label><input class="input" id="audit-from" name="date_from" type="date" max="${maxDate}" value="${h(safeDateFrom)}"></div>
      <div class="field"><label for="audit-to">To</label><input class="input" id="audit-to" name="date_to" type="date" max="${maxDate}" value="${h(safeDateTo)}"></div>
      <div class="field"><label for="audit-actor">Actor ID</label><input class="input" id="audit-actor" name="actor_id" placeholder="Enter an account ID" value="${h(query.get('actor_id') || '')}"></div>
      <div class="field"><label for="audit-actor-role">Actor role</label><select class="select" id="audit-actor-role" name="actor_role">
        ${['', 'admin', 'staff'].map((value) => `<option value="${value}" ${query.get('actor_role') === value ? 'selected' : ''}>${value || 'All roles'}</option>`).join('')}</select></div>
      <div class="field"><label for="audit-action">Action</label><select class="select" id="audit-action" name="action"><option value="">All actions</option>
        ${actions.map((action) => `<option value="${action}" ${query.get('action') === action ? 'selected' : ''}>${action}</option>`).join('')}</select></div>
      <div class="field"><label for="audit-target">Target type</label><select class="select" id="audit-target" name="target_type">
        ${['', 'user', 'staff', 'item', 'claim', 'report', 'integration'].map((value) => `<option value="${value}" ${query.get('target_type') === value ? 'selected' : ''}>${value || 'All types'}</option>`).join('')}</select></div>
      <div class="field"><label for="audit-result">Result</label><select class="select" id="audit-result" name="result">
        ${['', 'success', 'denied', 'failed', 'attempted'].map((value) => `<option value="${value}" ${query.get('result') === value ? 'selected' : ''}>${value || 'All results'}</option>`).join('')}</select></div>
      <button class="button button-primary" type="submit">Apply filters</button>
      <a class="button button-secondary" href="/?page=admin-system-records">Clear</a>
    </form>
    <section class="card system-record-table"><div class="admin-items-list-heading"><div><h2>Audit events</h2><p>Newest activity appears first.</p></div><span>${total} ${total === 1 ? 'record' : 'records'}</span></div>
      ${rows.length ? `<div class="table-wrap"><table class="system-records-grid"><thead><tr><th>Date</th><th>Actor</th><th>Action / result</th><th>Target</th><th>Changes</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
        : '<p class="empty">No records match these filters.</p>'}
      <nav class="system-record-pagination" aria-label="System records pages">
        <span>Page ${page} of ${Math.max(1, totalPages)}</span>
        ${page > 1 ? `<a class="button button-outline" href="${pageLink(page - 1)}">Previous</a>` : ''}
        ${page < totalPages ? `<a class="button button-outline" href="${pageLink(page + 1)}">Next</a>` : ''}
      </nav>
    </section>
  </main>`;
}

export { adminDashboard, adminUsers, adminEditUser, adminItems, adminEditItem, adminClaims, adminInventory, adminSettings, adminSystemRecords };
