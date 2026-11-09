import * as shared from '../shared.js';
const { API, sessionInfo, h, date, param, link, buttonLink, badge, hasPermission, itemStatusLabel, field, selectField, request, icon, roleLabel, frontendHref, pageHeader, reportRows, formAction } = shared;

async function dashboardPage(user) {
  const [reports, claimData, storedData] = await Promise.all([
    hasPermission('view_my_reports') ? request('/items/mine') : { items: [] },
    hasPermission('view_claim_status') ? request('/claims/mine') : { claims: [] },
    hasPermission('filter_items') ? request('/items?status=stored') : { items: [] },
  ]);
  const claims = claimData.claims;
  const items = reports.items;
  const activity = [
    ...items.map((item) => ({
      type: item.item_type,
      label: item.status === 'stored' ? 'Found item stored'
        : item.status === 'returned' ? 'Returned to owner' : `${item.item_type[0].toUpperCase()}${item.item_type.slice(1)} report submitted`,
      name: item.item_name,
      date: item.updated_at || item.created_at,
    })),
    ...claims.map((claim) => ({ type: 'claim', label: `Claim ${claim.status}`, name: claim.item_name, date: claim.created_at })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  const stat = (iconName, style, label, count, sub, destination) => `<a class="card dashboard-stat" href="/?page=${destination}">
    <span class="dashboard-stat-icon ${style}">${icon(iconName)}</span><span><span class="stat-label">${label}</span>
    <strong>${count}</strong><small>${sub}</small></span></a>`;
  return `<main class="container dashboard-page">
    ${pageHeader('My Dashboard', `Welcome back, ${user.full_name}. Here's your overview.`,
    `${hasPermission('report_lost_item') ? buttonLink('report', 'Report lost', 'button-outline') : ''}${hasPermission('report_found_item') ? buttonLink('report-found', 'Report found', 'button-primary') : ''}`)}
    <div class="dashboard-stats">
      ${hasPermission('view_my_reports') ? stat('alert', 'lost', 'My lost reports', items.filter((item) => item.item_type === 'lost').length, 'View my reports', 'reports') : ''}
      ${hasPermission('view_my_reports') ? stat('check', 'found', 'Found reports', items.filter((item) => item.item_type === 'found').length, 'Submitted by me', 'reports') : ''}
      ${hasPermission('filter_items') ? stat('clipboard', 'found', 'Stored items', storedData.items.length, 'Currently in staff custody', 'items&amp;status_tab=stored') : ''}
      ${hasPermission('view_claim_status') ? stat('clipboard', 'claim', 'My claims', claims.length, `${claims.filter((claim) => claim.status === 'pending').length} pending`, 'claims') : ''}
    </div>
    <div class="dashboard-grid"><section class="card dashboard-panel"><div class="dashboard-panel-head"><h3>Recent activity</h3>${hasPermission('view_my_reports') ? link('reports', 'View reports', 'link-sm') : ''}</div>
      <div class="dashboard-activity">${activity.length ? activity.map((entry) => `<div class="dashboard-activity-row">
        <span class="dashboard-activity-icon ${entry.type}">${icon(entry.type === 'claim' ? 'clipboard' : entry.type === 'found' ? 'check' : 'alert', 15)}</span>
        <div><strong>${h(entry.label)}</strong><span>${h(entry.name)}</span></div><time>${date(entry.date)}</time></div>`).join('') : '<p class="empty">No activity yet.</p>'}</div>
    </section><aside class="dashboard-side"><section class="card dashboard-panel"><div class="dashboard-panel-head"><h3>Quick actions</h3></div><div class="quick-actions">
      ${hasPermission('view_items') ? `<a class="quick" href="/?page=items">${icon('file', 16)}Browse lost &amp; found items</a>` : ''}
      ${hasPermission('view_claim_status') ? `<a class="quick" href="/?page=claims">${icon('clipboard', 16)}Check my claims</a>` : ''}
      ${hasPermission('view_my_reports') ? `<a class="quick" href="/?page=reports">${icon('file', 16)}Manage my reports</a>` : ''}</div></section></aside></div>
  </main>`;
}

async function browsePage() {
  const query = new URLSearchParams(location.search);
  const filters = new URLSearchParams();
  const canSearch = hasPermission('search_items');
  const canFilter = hasPermission('filter_items');
  const storedOnly = query.get('status_tab') === 'stored';
  if (canFilter && query.has('type_tab')) query.set('item_type', query.get('type_tab'));
  if (canFilter && query.has('status_tab')) query.set('status', storedOnly ? 'stored' : '');
  if (canSearch && query.get('query')) filters.set('query', query.get('query'));
  if (canFilter) {
    ['category', 'location', 'item_type', 'status', 'date_from', 'date_to'].forEach((key) => {
      const value = query.get(key);
      if (value) filters.set(key, value);
    });
  }
  const [{ items }, { items: allItems }] = await Promise.all([
    request(`/items?${filters}`), request('/items'),
  ]);
  const counts = {
    all: allItems.length,
    lost: allItems.filter((item) => item.item_type === 'lost').length,
    found: allItems.filter((item) => item.item_type === 'found').length,
    stored: allItems.filter((item) => item.status === 'stored').length,
  };
  const categories = sessionInfo.categories.map((category) => `<option value="${h(category)}" ${query.get('category') === category ? 'selected' : ''}>${h(category)}</option>`).join('');
  return `<main class="container browse-page">
    <header class="page-header browse-header"><div><h1>Browse Lost &amp; Found Items</h1><p>${items.length} items found</p></div>
      <div class="head-actions">${hasPermission('report_found_item') ? buttonLink('report-found', 'Report found item', 'button-primary') : ''}</div></header>
    <form method="get" class="browse-filter-form"><input type="hidden" name="page" value="items">
      <div class="card browse-toolbar">${canSearch ? `<label class="browse-search" for="query">${icon('search', 17)}
        <input id="query" name="query" value="${h(query.get('query') || '')}" placeholder="Search items by name, description..." aria-label="Search items"></label>` : ''}
        ${canFilter ? `<select class="select" id="item_type" name="item_type" aria-label="Filter by type">
          <option value="">All Types</option><option value="lost" ${query.get('item_type') === 'lost' ? 'selected' : ''}>Lost</option>
          <option value="found" ${query.get('item_type') === 'found' ? 'selected' : ''}>Found</option></select>
        <select class="select" id="category" name="category" aria-label="Filter by category"><option value="">All Categories</option>${categories}</select>` : ''}
        ${canSearch || canFilter ? '<button class="button button-primary browse-search-submit" type="submit">Search</button>' : ''}</div>
      ${canFilter ? `<nav class="browse-tabs" aria-label="Filter items by type or status">
        <button class="browse-tab ${!query.get('item_type') && !storedOnly ? 'active' : ''}" type="submit" name="type_tab" value="">All Items <span>(${counts.all})</span></button>
        <button class="browse-tab ${query.get('item_type') === 'lost' && !storedOnly ? 'active' : ''}" type="submit" name="type_tab" value="lost">Lost <span>(${counts.lost})</span></button>
        <button class="browse-tab ${query.get('item_type') === 'found' && !storedOnly ? 'active' : ''}" type="submit" name="type_tab" value="found">Found <span>(${counts.found})</span></button>
        <button class="browse-tab ${storedOnly ? 'active' : ''}" type="submit" name="status_tab" value="stored">In staff custody <span>(${counts.stored})</span></button>
      </nav>
      <details class="browse-more-filters" ${query.get('location') || query.get('date_from') || query.get('date_to') ? 'open' : ''}>
        <summary>More filters</summary><div class="browse-more-grid">
          <div class="field"><label for="location">Location</label><input class="input" id="location" name="location" value="${h(query.get('location') || '')}"></div>
          <div class="field"><label for="date_from">Date from</label><input class="input" id="date_from" name="date_from" type="date" value="${h(query.get('date_from') || '')}"></div>
          <div class="field"><label for="date_to">Date to</label><input class="input" id="date_to" name="date_to" type="date" value="${h(query.get('date_to') || '')}"></div>
          <div class="browse-more-actions"><a class="button button-secondary" href="/?page=items">Clear all</a><button class="button button-primary" type="submit">Apply filters</button></div>
        </div>        </details>` : ''}
    </form>
    <section class="browse-grid">${items.length ? items.map((item) => `<article class="card browse-card">
      <div class="browse-card-top"><span class="browse-type ${item.item_type === 'found' ? 'found' : 'lost'}">${item.item_type === 'found' ? 'Found' : 'Lost'}</span>
        ${item.item_type === 'found' ? `${item.status === 'stored' ? '<span class="badge badge-active">Stored</span>' : ''}
          <span class="badge ${item.physical_verification_status === 'verified' ? 'badge-verified' : 'badge-not-verified'}">${item.physical_verification_status === 'verified' ? 'Verified by staff' : 'Not verified by staff'}</span>` : ''}</div>
      ${item.item_type === 'lost' && item.image_path ? `<img class="browse-card-image" src="${h(API)}/items/${encodeURIComponent(item.id)}/image" alt="${h(item.item_name)} image">` : ''}
      <h2>${h(item.item_name)}</h2><p class="browse-description">${h(item.description)}</p>
      <div class="browse-meta"><span>${h(item.category)}</span><span>${h(item.location)}</span><span>${date(item.date_lost)}</span></div>
      <div class="browse-card-footer"><span>By ${h(item.reported_by || 'Unknown')}</span><a class="button button-outline" href="/?page=item&amp;id=${encodeURIComponent(item.id)}">View details</a></div>
    </article>`).join('') : '<div class="card empty browse-empty">No matching items found.</div>'}</section>
  </main>`;
}

async function itemPage(id) {
  const role = sessionInfo.user?.role_name;
  let item;
  if (role === 'staff') {
    ({ item } = await request(`/staff/items/${encodeURIComponent(id)}`));
  } else if (role === 'admin') {
    ({ item } = await request(`/admin/items/${encodeURIComponent(id)}`));
  } else {
    ({ item } = await request(`/items/${encodeURIComponent(id)}`));
  }
  const found = item.item_type === 'found';
  const imageUrl = item.image_path
    ? role === 'staff' || role === 'admin'
      ? `${API}/staff/items/${encodeURIComponent(item.id)}/image`
      : `${API}/items/${encodeURIComponent(item.id)}/image`
    : '';
  const formattedDate = (value) => {
    if (!value) return 'Not available';
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return Number.isNaN(parsedDate.getTime())
      ? 'Not available'
      : parsedDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  };
  const canClaim = found && item.status === 'stored' && role === 'user'
    && hasPermission('submit_claim') && item.user_id !== sessionInfo.user.id;
  const verified = item.physical_verification_status === 'verified';
  return `<main class="container item-detail-page public-item-page"><a class="back-link" href="/?page=items">&larr; Back to Browse</a>
    <div class="public-item-layout">
      <article class="card public-item-main">
        <div class="public-item-heading"><span class="type-banner ${found ? 'found' : 'lost'}">${found ? 'Found' : 'Lost'} item report</span><h1>${h(item.item_name)}</h1></div>
        ${imageUrl ? `<figure class="public-item-image-wrap"><img class="public-item-image" src="${h(imageUrl)}" alt="${h(item.item_name)}"><figcaption>${found ? 'Photo provided with the report' : 'Photo submitted with the report'}</figcaption></figure>` : ''}
        <dl class="public-item-facts">
          <div><dt>Category</dt><dd>${h(item.category)}</dd></div>
          <div><dt>Location</dt><dd>${h(item.location)}</dd></div>
          <div><dt>Date</dt><dd>${formattedDate(item.date_lost)}</dd></div>
        </dl>
        ${found ? `<section class="public-verification-status"><div><strong>Staff verification</strong>
          <p>${verified ? 'Staff has checked this found item against the physical item.' : 'Staff has not yet checked this found item against the physical item.'}</p></div>
          <span class="badge ${verified ? 'badge-verified' : 'badge-not-verified'}">${verified ? 'Verified' : 'Pending'}</span></section>` : ''}
        <section class="item-detail-description"><h2>Description</h2><p>${h(item.description)}</p></section>
        ${canClaim ? `<div class="item-detail-actions"><a class="button button-primary" href="/?page=claim&amp;id=${encodeURIComponent(item.id)}">Claim item</a></div>` : ''}
      </article>
      <aside class="public-item-sidebar">
        <section class="card item-info-card"><h2>Report info</h2><dl>
          <dt>Reported by</dt><dd>${h(item.reported_by || 'Unknown')}</dd>
          <dt>Report ID</dt><dd>${h(item.id)}</dd>
          <dt>Total claims</dt><dd>${Number(item.total_claims) || 0}</dd>
        </dl></section>
        <section class="card item-notice"><h2>Notice</h2><p>Only the written description is shown publicly. Identifying details are kept private so staff can verify ownership and reduce false claims.</p></section>
      </aside>
    </div>
  </main>`;
}

function reportPage(type) {
  const isFound = type === 'found';
  const today = new Date().toISOString().slice(0, 10);
  const locationOptions = sessionInfo.locations.map((place) => `<option>${h(place)}</option>`).join('');
  return `<main class="container edit-report-page"><a class="back-link" href="/?page=dashboard">&larr; Back to dashboard</a>
    ${pageHeader(`Report a ${isFound ? 'found' : 'lost'} item`, 'Add accurate details so the report can be reviewed.')}
    <section class="card edit-report-card"><form class="form-grid" data-form="report" data-type="${type}" enctype="multipart/form-data">
      <div class="edit-report-fields">${field('Item name', 'item_name', 'text', '', true)}
      ${selectField('Category', 'category', [['', 'Choose category'], ...sessionInfo.categories.map((value) => [value, value])], '', true)}
      <div class="field"><label for="location">Location ${isFound ? 'found' : 'lost'}</label><select class="select" id="location" name="location" required><option value="">Choose location</option>${locationOptions}</select></div>
      ${field(`Date ${isFound ? 'found' : 'lost'}`, 'date_lost', 'date', '', true, `max="${today}"`)}
      <div class="field"><label for="description">Description</label><textarea class="textarea" id="description" name="description" required></textarea></div>
      <div class="field"><label for="identifying_details">Private identifying details</label><textarea class="textarea" id="identifying_details" name="identifying_details" required></textarea></div>
      <div class="field edit-report-image-field"><label for="image">${isFound ? 'Found item photo' : 'Item image'} <span class="hint">Optional · JPG, PNG, or WEBP up to 5 MB${isFound ? ' · Only staff and admins can view this photo' : ''}</span></label>
        <input class="input" id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp"></div>
      </div><div class="form-actions"><a class="button button-secondary" href="/?page=dashboard">Cancel</a>
      <button class="button button-primary" type="submit">Submit report</button></div></form></section></main>`;
}

async function reportsPage() {
  const { items } = await request('/items/mine');
  return `<main class="page"><header class="topbar"><div><h1>My Reports</h1><p>Track, edit, or cancel your submitted reports.</p></div>
    <div class="nav-actions">${buttonLink('report', 'Report lost item', 'button-primary')}${buttonLink('report-found', 'Report found item', 'button-outline')}</div></header>
    <section class="card">${reportRows(items)}</section></main>`;
}

async function editReportPage(id) {
  const { item } = await request(`/items/mine/${encodeURIComponent(id)}`);
  const today = new Date().toISOString().slice(0, 10);
  return `<main class="container edit-report-page"><a class="back-link" href="/?page=reports">&larr; Back to My Reports</a>
    <header class="page-header"><div><h1>Edit report</h1><p>Update the details for your ${h(item.item_type)} item report.</p></div>
      <span class="badge badge-${h(item.item_type)}">${h(item.item_type[0].toUpperCase() + item.item_type.slice(1))}</span></header>
    <section class="card edit-report-card"><form class="form-grid" data-form="edit-report" data-id="${h(id)}">
      <div class="edit-report-fields">${field('Item name', 'item_name', 'text', item.item_name, true)}
      ${selectField('Category', 'category', sessionInfo.categories.map((value) => [value, value]), item.category, true)}
      ${field('Location', 'location', 'text', item.location, true)}
      ${field('Date', 'date_lost', 'date', String(item.date_lost).slice(0, 10), true, `max="${today}"`)}
      <div class="field"><label for="description">Description</label><textarea class="textarea" id="description" name="description" required>${h(item.description)}</textarea></div>
      <div class="field"><label for="identifying_details">Identifying details</label><textarea class="textarea" id="identifying_details" name="identifying_details" required>${h(item.identifying_details)}</textarea></div>
      ${item.item_type === 'lost' ? `<div class="field edit-report-image-field"><label for="image">Item image <span class="hint">Optional · JPG, PNG, or WEBP up to 5 MB</span></label>
        ${item.image_path ? `<img class="item-image" src="${h(API)}/items/${encodeURIComponent(item.id)}/image" alt="Current ${h(item.item_name)} image">` : ''}
        <input class="input" id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp"></div>` : ''}
      </div><div class="form-actions"><a class="button button-secondary" href="/?page=reports">Cancel</a><button class="button button-primary" type="submit">Save changes</button></div>
    </form></section></main>`;
}

async function claimPage(itemId) {
  const { item } = await request(`/claims/available/${encodeURIComponent(itemId)}`);
  return `<main class="container claim-page">
    ${pageHeader('Submit Item Claim', 'Provide unique details so staff can verify your ownership.')}
    <section class="card edit-report-card claim-card">
      <header class="claim-item-summary"><h2>${h(item.item_name)}</h2><p>${h(item.category)} · ${h(item.location)} · ${h(String(item.date_lost).slice(0, 10))}</p></header>
      <form class="form-grid claim-form" data-form="claim"><input type="hidden" name="item_id" value="${h(item.id)}">
        <div class="field"><label for="claim_details">Ownership details</label>
          <textarea class="textarea" id="claim_details" name="claim_details" required
            placeholder="Describe marks, contents, serial numbers, or other private details."></textarea></div>
        <div class="form-actions"><a class="button button-secondary" href="/?page=item&amp;id=${encodeURIComponent(item.id)}">Back</a><button class="button button-primary" type="submit">Submit claim</button></div>
      </form>
    </section></main>`;
}

async function claimsPage() {
  const { claims } = await request('/claims/mine');
  return `<main class="container">${pageHeader('My Claims', 'Follow the status of your item return requests.')}${claimTable(claims)}</main>`;
}

function claimTable(claims) {
  if (!claims.length) return `<section class="card"><div class="report-list"><p class="empty">You have not submitted any claims.</p></div></section>`;
  return `<section class="card"><div class="report-list">${claims.map((claim) => `<article class="report" id="claim-${h(claim.id)}"><div>
    <h3>${h(claim.item_name || claim.item?.item_name)}</h3><p>${h(claim.category || claim.item?.category || '')} · ${h(claim.location || claim.item?.location || '')}</p>
    <p>${h(claim.claim_details)}</p>${claim.status === 'approved' && claim.item_status === 'claimed'
      ? '<p class="claim-outcome">Your claim was approved. Please collect your item from Lost and Found staff.</p>'
      : claim.status === 'approved' && claim.item_status === 'returned' ? '<p class="claim-outcome">Returned to you by staff.</p>' : ''}
    ${claim.status === 'approved' && claim.pickup_at ? `<section class="claim-pickup-details">
      <h4>Pickup appointment</h4><p>${h(formatClaimPickup(claim.pickup_at, claim.pickup_time_zone))}</p>
      <p>Location: ${h(claim.pickup_location)}</p>
      <div class="nav-actions">${claim.calendar_url ? `<a class="button button-outline" href="${h(claim.calendar_url)}" target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>` : ''}
        <a class="button button-outline" href="${h(API)}/claims/${encodeURIComponent(claim.id)}/calendar.ics" download>Download .ics</a>
      </div></section>` : ''}
    </div>${badge(claim.status)}</article>`).join('')}</div></section>`;
}

function formatClaimPickup(value, timeZone = 'Asia/Manila') {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

async function profilePage() {
  const { user, reports, claims } = await request('/profile');
  return `<main class="container profile-page">${pageHeader('My Profile', 'Manage your account information.',
    hasPermission('edit_profile') ? '<button class="button button-outline" id="edit-profile" data-action="edit-profile" type="button">Edit profile</button>' : '')}
    <div class="profile-grid"><section class="card profile-summary"><div class="avatar">${h(user.full_name.charAt(0).toUpperCase())}</div>
      <h2>${h(user.full_name)}</h2><span class="pill">${roleLabel(user.role_name)}</span>
      <div class="profile-meta"><p>${user.role_name === 'staff' ? 'Employee ID' : 'Student ID'}: <b>${h(user.student_id || user.employee_id || 'Not provided')}</b></p>
      <p>Member since ${date(user.created_at)}</p></div></section>
      <section class="card profile-details"><h2>Personal Information</h2><form class="form-grid" data-form="profile" id="profile-form"><div class="profile-fields">
        <div class="form-field full"><label for="full_name">Full name</label><input class="input" id="full_name" name="full_name" data-editable value="${h(user.full_name)}" required disabled></div>
        <div class="form-field"><label for="email">Email address</label><input class="input" id="email" value="${h(user.email)}" disabled></div>
        <div class="form-field"><label for="phone">Phone number</label><input class="input" id="phone" name="phone" data-editable value="${h(user.phone || '')}" disabled></div>
        <div class="form-field"><label for="student_id">${user.role_name === 'staff' ? 'Employee ID' : 'Student ID'}</label><input class="input" id="student_id" value="${h(user.student_id || user.employee_id || '')}" disabled></div>
      </div><div class="form-actions" hidden><button class="button button-secondary" data-action="cancel-profile" type="button">Cancel</button>
        <button class="button button-primary" type="submit">Save changes</button></div></form></section></div>
      ${hasPermission('view_my_reports') || hasPermission('view_claim_status') ? `<section class="card account-summary"><h2>Account Summary</h2><div class="account-summary-grid">
        ${hasPermission('view_my_reports') ? `<a href="/?page=reports"><strong>${reports.filter((item) => item.item_type === 'lost').length}</strong><span>Lost reports</span></a>
        <a href="/?page=reports"><strong>${reports.filter((item) => item.item_type === 'found').length}</strong><span>Found reports</span></a>` : ''}
        ${hasPermission('view_claim_status') ? `<a href="/?page=claims"><strong>${claims.length}</strong><span>Claims filed</span></a>` : ''}
      </div></section>` : ''}</main>`;
}

async function notificationsPage() {
  const { notifications } = await request('/notifications');
  const unread = notifications.filter((notice) => !notice.read_at).length;
  const content = notifications.length ? notifications.map((notice) => {
    const formattedDate = notice.created_at
      ? new Date(notice.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const isUnread = !notice.read_at;
    return `<article class="notification${isUnread ? ' unread' : ''}">
      <span class="notification-icon ${h(notice.type)}">${icon(notice.type === 'status' || notice.type === 'verification' ? 'check' : notice.type === 'claim' ? 'clipboard' : 'file', 17)}</span>
      <div class="notification-content"><div class="notification-heading"><h2>${h(notice.title)}</h2></div>
        <p>${h(notice.message)}</p>${notice.calendar_url ? `<a class="link-sm" href="${h(notice.calendar_url)}" target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>` : ''}
        ${notice.href ? `<a class="link-sm" href="${h(frontendHref(notice.href))}">View update</a>` : ''}
      </div>
      <div class="notification-meta"><time>${formattedDate}</time>
        ${isUnread ? `<form class="front-action-form notification-mark-read" data-action="read-notice" data-id="${h(notice.id)}" data-values="{}"><button class="notification-read" type="submit">Mark read</button></form>` : ''}
      </div>
    </article>`;
  }).join('')
    : '<div class="empty">You’re all caught up. New report and claim updates will appear here.</div>';
  return `<main class="container notifications-page"><header class="page-header"><div><h1>Notifications</h1><p>Updates about your reports, claims, and item status.</p></div>
    ${unread ? '<button class="notification-mark-all" data-action="read-all">Mark all as read</button>' : ''}</header>
    <section class="card notification-list">${content}</section></main>`;
}

export { dashboardPage, browsePage, itemPage, reportPage, reportsPage, editReportPage, claimPage, claimsPage, profilePage, notificationsPage };
