const API = window.API_BASE;
const app = document.querySelector('#app');
const sessionInfo = { user: null, rolePermissions: [], categories: [], locations: [], unreadNotifications: 0, csrfToken: '', googleAuth: { active: false }, recaptcha: { active: false }, pendingAdminMfa: false, adminMfaSetupRequired: false, adminMfaReauthRequired: false };

const h = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const date = (value) => value ? new Date(value).toLocaleDateString() : '—';
const param = (key) => new URLSearchParams(location.search).get(key) || '';
const link = (page, label, css = '') => `<a${css ? ` class="${h(css)}"` : ''} href="/?page=${encodeURIComponent(page)}">${h(label)}</a>`;
const buttonLink = (page, label, style = '') => `<a class="button ${style}" href="/?page=${encodeURIComponent(page)}">${h(label)}</a>`;
const badge = (value, label = value) => {
  const tone = value === 'stored' ? 'active' : value === 'returned' ? 'active'
    : value === 'claimed' ? 'claimed' : value === 'cancelled' ? 'cancelled'
      : ['lost', 'found', 'pending', 'approved', 'rejected'].includes(value) ? value : 'pending';
  return `<span class="badge badge-${tone}">${h(value === 'returned' ? 'Returned to owner' : label || 'unknown')}</span>`;
};
const field = (label, name, type = 'text', value = '', required = false, extra = '') => `
  <div class="field"><label for="${h(name)}">${h(label)}</label>
  <input class="input" id="${h(name)}" name="${h(name)}" type="${h(type)}" value="${h(value)}" ${required ? 'required' : ''} ${extra}></div>`;
const selectField = (label, name, options, value = '', required = false) => `
  <div class="field"><label for="${h(name)}">${h(label)}</label><select class="select" id="${h(name)}" name="${h(name)}" ${required ? 'required' : ''}>
  ${options.map(([option, text]) => `<option value="${h(option)}" ${option === value ? 'selected' : ''}>${h(text)}</option>`).join('')}</select></div>`;
const optionsFrom = (values, placeholder = 'All') => [['', placeholder], ...values.map((value) => [value, value])];

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())
    && sessionInfo.csrfToken && !headers['X-CSRF-Token']) {
    headers['X-CSRF-Token'] = sessionInfo.csrfToken;
  }
  const response = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      sessionInfo.user = null;
      sessionInfo.pendingAdminMfa = false;
      sessionInfo.adminMfaSetupRequired = false;
      sessionInfo.adminMfaReauthRequired = false;
    }
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('Retry-After') || data.retryAfter || 0);
    error.fieldErrors = data.fieldErrors;
    throw error;
  }
  return data;
}

function icon(name, size = 17) {
  const paths = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.02a1.7 1.7 0 0 0-1.77.5l-.06.06h-3.4l-.03-.08a1.7 1.7 0 0 0-1.28-1.18 1.7 1.7 0 0 0-1.37.27l-.07.05-2.94-1.7.02-.08a1.7 1.7 0 0 0-.5-1.77l-.06-.06v-3.4l.08-.03a1.7 1.7 0 0 0 1.18-1.28 1.7 1.7 0 0 0-.27-1.37l-.05-.07 1.7-2.94.08.02a1.7 1.7 0 0 0 1.77-.5l.06-.06h3.4l.03.08a1.7 1.7 0 0 0 1.28 1.18 1.7 1.7 0 0 0 1.37-.27l.07-.05 2.94 1.7-.02.08a1.7 1.7 0 0 0 .5 1.77l.06.06v3.4l-.08.03A1.7 1.7 0 0 0 19.4 15z"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function roleLabel(role) {
  return ({ user: 'Student', staff: 'Staff', admin: 'Administrator' })[role] || 'Member';
}

function hasPermission(permission) {
  return sessionInfo.user?.role_name === 'admin' || sessionInfo.rolePermissions.includes(permission);
}

function itemStatusLabel(status, itemType = '') {
  if (status === 'found') {
    return itemType === 'lost' ? 'Item recovered'
      : itemType === 'found' ? 'Awaiting handoff' : 'Recovered / awaiting handoff';
  }
  return ({
    lost: 'Reported lost',
    stored: 'In staff custody',
    claimed: 'Claimed',
    returned: 'Returned to owner',
    cancelled: 'Cancelled',
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
  })[status] || status;
}

function itemTypeLabel(type) {
  return type === 'found' ? 'Recovered' : type === 'lost' ? 'Lost' : type;
}

function frontendHref(href) {
  try {
    if (!href.startsWith('/') || href.startsWith('//')) return '/?page=notifications';
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return '/?page=notifications';
    if (url.pathname !== '/index.php') return `${url.pathname}${url.search}${url.hash}`;
    const pageMap = {
      'staff-item': 'staff-item',
      'staff-claim': 'staff-claim',
      'staff-claims': 'staff-claims',
      'admin-dashboard': 'admin-dashboard',
      dashboard: 'dashboard',
      reports: 'reports',
      claims: 'claims',
      items: 'items',
    };
    const page = pageMap[url.searchParams.get('page')] || 'dashboard';
    const destination = new URLSearchParams({ page });
    for (const key of ['id', 'item']) {
      if (url.searchParams.has(key)) destination.set('id', url.searchParams.get(key));
    }
    if (url.searchParams.has('highlight')) destination.set('highlight', url.searchParams.get('highlight'));
    return `/?${destination.toString()}`;
  } catch {
    return '/';
  }
}

function shell(content, page) {
  const user = sessionInfo.user;
  if (user) {
    const navigation = user.role_name === 'admin'
      ? (sessionInfo.adminMfaSetupRequired
        ? [['admin-security', 'Security', 'shield']]
        : [['admin-dashboard', 'Dashboard', 'home'], ['admin-users', 'User Management', 'user'], ['admin-role-permissions', 'Role Permissions', 'shield'], ['admin-system-records', 'System Records', 'file'], ['admin-items', 'All Items', 'file'],
          ['admin-claims', 'All Claims', 'clipboard'], ['admin-inventory', 'Inventory Report', 'clipboard'],
          ['admin-add-user', 'Add User', 'user'], ['admin-settings', 'Settings', 'settings'], ['admin-security', 'Security', 'shield'], ['items', 'Browse Items', 'file'],
          ['notifications', 'Notifications', 'bell'], ['profile', 'Profile', 'user']])
      : user.role_name === 'staff'
        ? [
          ...(hasPermission('view_staff_dashboard') ? [['staff-dashboard', 'Dashboard', 'home']] : []),
          ...(hasPermission('view_records') ? [['staff-records', 'View Records', 'file']] : []),
          ...(hasPermission('view_lost_reports') ? [['staff-lost-reports', 'Lost Item Reports', 'file']] : []),
          ...(hasPermission('view_found_items') ? [
            ['staff-found-items', 'Recovered Items', 'check'],
            ['staff-stored-items', 'In Staff Custody', 'clipboard'],
            ['staff-returned-items', 'Returned Items', 'check'],
          ] : []),
          ...(hasPermission('view_claims') ? [['staff-claims', 'Ownership Claims', 'clipboard']] : []),
          ...(hasPermission('receive_notifications') ? [['notifications', 'Notifications', 'bell']] : []),
          ...(hasPermission('view_profile') ? [['profile', 'Profile', 'user']] : []),
        ]
        : [
          ['dashboard', 'Dashboard', 'home'],
          ...(hasPermission('report_lost_item') ? [['report', 'Report Lost Item', 'alert']] : []),
          ...(hasPermission('report_found_item') ? [['report-found', 'Report Found Item', 'check']] : []),
          ...(hasPermission('view_items') ? [['items', 'Browse Items', 'file']] : []),
          ...(hasPermission('view_my_reports') ? [['reports', 'My Reports', 'file']] : []),
          ...(hasPermission('view_claim_status') ? [['claims', 'My Claims', 'check']] : []),
          ...(hasPermission('receive_notifications') ? [['notifications', 'Notifications', 'bell']] : []),
          ...(hasPermission('view_profile') ? [['profile', 'Profile', 'user']] : []),
        ];
    const nav = navigation.map(([key, label, iconName]) => `<a class="sidebar-link${page === key ? ' active' : ''}" href="/?page=${key}">
      ${icon(iconName)}${h(label)}${key === 'notifications' && sessionInfo.unreadNotifications
        ? `<span class="notification-count">${sessionInfo.unreadNotifications > 99 ? '99+' : sessionInfo.unreadNotifications}</span>` : ''}</a>`).join('');
    const initial = h((user.full_name || '?').charAt(0).toUpperCase());
    return `<div class="app">
      <aside class="sidebar" id="sidebar">
        <a class="sidebar-brand" href="/?page=dashboard"><span class="brand-mark">${icon('shield', 22)}</span><span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></a>
        <nav class="sidebar-nav"><p class="sidebar-label">Navigation</p>${nav}</nav>
        <div class="sidebar-user"><div class="avatar-sm">${initial}</div><div><p class="sidebar-user-name">${h(user.full_name)}</p><p class="sidebar-user-role">${roleLabel(user.role_name)}</p></div></div>
      </aside>
      <div class="overlay" id="overlay"></div>
      <div class="main-col"><header class="app-topbar">
        <button class="menu-btn" id="menu-btn" type="button" aria-label="Open menu" aria-expanded="false">${icon('menu', 20)}</button>
        <p class="topbar-title">Bukidnon State University — Supreme Student Council</p>
        ${hasPermission('view_profile') ? `<a class="topbar-user" href="/?page=profile"><span class="avatar-sm">${initial}</span><span class="meta"><span class="name">${h(user.full_name)}</span><span class="role">${roleLabel(user.role_name)}</span></span></a>`
          : `<span class="topbar-user"><span class="avatar-sm">${initial}</span><span class="meta"><span class="name">${h(user.full_name)}</span><span class="role">${roleLabel(user.role_name)}</span></span></span>`}
        <button class="signout" type="button" data-action="logout">Sign Out</button>
      </header><main class="content">${content}</main></div>
    </div>`;
  }
  if (['login', 'forgot-password', 'reset-password'].includes(page)) return content;
  return `<header class="site-header"><a class="brand" href="/"><span class="brand-mark">${icon('shield', 22)}</span>
    <span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></a>
    <a class="btn btn-outline" href="/?page=login">Sign In</a></header>${content}`;
}

function pageHeader(title, description = '', right = '') {
  return `<header class="page-header"><div><h1>${h(title)}</h1>${description ? `<p>${h(description)}</p>` : ''}</div>${right ? `<div class="head-actions">${right}</div>` : ''}</header>`;
}
function alert(message, error = false) {
  return message ? `<div class="alert ${error ? 'alert-error' : 'alert-success'}" role="status">${h(message)}</div>` : '';
}
function empty(message) { return `<div class="empty">${h(message)}</div>`; }
function reportRows(items, staff = false) {
  if (!items.length) return `<p class="empty">${staff ? 'No item records match these filters.' : 'No reports submitted yet.'}</p>`;
  return `<div class="report-list">${items.map((item) => {
    const editable = !staff && sessionInfo.user?.id === item.user_id && item.status === item.item_type
      && hasPermission('edit_my_report');
    const cancellable = !staff && sessionInfo.user?.id === item.user_id && item.status === item.item_type
      && hasPermission('cancel_my_report');
    const canReviewStaffItem = staff && (item.item_type === 'lost'
      ? hasPermission('review_lost_report')
      : hasPermission('view_found_items'));
    const detailPage = staff ? canReviewStaffItem ? 'staff-item' : ''
      : hasPermission('view_items') ? 'item' : editable ? 'edit-report' : '';
    const typeLabel = `${staff ? itemTypeLabel(item.item_type) : item.item_type === 'found' ? 'Found' : 'Lost'} report`;
    const imageUrl = item.image_path && (staff || hasPermission('view_items'))
      ? staff
        ? `${API}/staff/items/${encodeURIComponent(item.id)}/image`
        : `${API}/items/${encodeURIComponent(item.id)}/image`
      : '';
    return `<article class="report staff-record" id="item-${h(item.id)}">
      ${imageUrl ? `<img class="item-image${staff ? ' staff-record-image' : ''}" src="${h(imageUrl)}" alt="${h(item.item_name)} image" loading="lazy">` : ''}
      <div class="${staff ? 'staff-record-info' : ''}"><h3>${detailPage ? `<a href="/?page=${detailPage}&amp;id=${encodeURIComponent(item.id)}">${h(item.item_name)}</a>` : h(item.item_name)}</h3>
        <p>${typeLabel} · ${h(item.category)} · ${h(item.location)} · ${date(item.date_lost)}</p>
        ${staff ? `<p>Reported by ${h(item.reported_by || 'Unknown')}</p>` : ''}
        <div class="report-statuses">${badge(item.status, itemStatusLabel(item.status, item.item_type))}
          ${item.item_type === 'found' && item.status !== 'cancelled'
            ? `<span class="badge ${item.physical_verification_status === 'verified' ? 'badge-verified' : 'badge-not-verified'}">${item.physical_verification_status === 'verified' ? 'Verified by staff' : 'Not verified by staff'}</span>` : ''}
        </div></div>
      ${staff
        ? canReviewStaffItem ? `<a class="button button-outline" href="/?page=staff-item&amp;id=${encodeURIComponent(item.id)}">Review report</a>` : ''
        : `<div class="nav-actions">${editable
              ? `<a class="button button-outline" href="/?page=edit-report&amp;id=${encodeURIComponent(item.id)}">Edit</a>` : ''}
          ${cancellable ? formAction('cancel-report', item.id, 'Cancel report', 'secondary') : ''}</div>`}
    </article>`;
  }).join('')}</div>`;
}
function table(headers, rows) {
  if (!rows.length) return empty('No records found.');
  return `<div class="card table-wrap"><table><thead><tr>${headers.map((value) => `<th>${h(value)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function statCards(data) {
  return `<div class="stats">${Object.entries(data).map(([label, value]) => `<div class="stat"><strong>${h(value)}</strong><span>${h(label)}</span></div>`).join('')}</div>`;
}
function formAction(action, id, label, css = 'secondary', values = {}) {
  const buttonStyle = css.split(/\s+/).includes('button') ? css : `button-${css || 'primary'}`;
  return `<form class="front-action-form" data-action="${h(action)}" data-id="${h(id)}" data-values="${h(JSON.stringify(values))}"><button class="button ${buttonStyle}" type="submit">${h(label)}</button></form>`;
}

function setSessionInfo(value) {
  Object.assign(sessionInfo, value);
}

export { API, app, sessionInfo, h, date, param, link, buttonLink, badge, field, selectField, optionsFrom, request, icon, roleLabel, hasPermission, itemStatusLabel, itemTypeLabel, frontendHref, shell, pageHeader, alert, empty, reportRows, table, statCards, formAction, setSessionInfo };
