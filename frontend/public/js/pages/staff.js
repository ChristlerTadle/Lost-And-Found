import * as shared from '../shared.js';
const { API, sessionInfo, h, date, param, link, buttonLink, badge, hasPermission, itemStatusLabel, selectField, request, icon, pageHeader, reportRows, formAction } = shared;

async function staffDashboard() {
  const { stats, activity } = await request('/staff/dashboard');
  const has = hasPermission;
  const stat = (name, style, label, value, note) => `<article class="card dashboard-stat"><span class="dashboard-stat-icon ${style}">${icon(name, 17)}</span>
    <span><span class="stat-label">${label}</span><strong>${value}</strong><small>${note}</small></span></article>`;
  return `<main class="container staff-dashboard">${pageHeader('Staff Dashboard', `Welcome back, ${sessionInfo.user.full_name}. Here's your overview.`)}
    ${Object.keys(stats).length ? `<div class="dashboard-stats">
      ${has('view_lost_reports') || has('view_found_items') ? stat('file', 'claim', 'Active reports',
    (stats.lostCount || 0) + (stats.foundCount || 0),
    `${has('view_lost_reports') ? `${stats.lostCount || 0} lost` : ''}${has('view_lost_reports') && has('view_found_items') ? ' · ' : ''}${has('view_found_items') ? `${stats.foundCount || 0} recovered` : ''}`) : ''}
      ${has('view_claims') ? stat('clipboard', 'found', 'Pending claims', stats.pendingClaimCount || 0, 'Awaiting ownership review') : ''}
      ${has('view_found_items') ? stat('check', 'found', 'Items in staff custody', stats.storedCount || 0, 'Awaiting return to their owners') : ''}
      ${has('view_found_items') ? stat('check', 'claim', 'Returned items', stats.returnedCount || 0, 'Received by owners') : ''}
    </div>` : ''}
    <div class="dashboard-grid"><section class="card dashboard-panel">
      <div class="dashboard-panel-head"><h3>Recent activity</h3>${has('view_records') ? link('staff-records', 'View records', 'link-sm') : ''}</div>
      <div class="dashboard-activity">${activity.length ? activity.map((entry) => `<div class="dashboard-activity-row">
        <span class="dashboard-activity-icon ${entry.type}">${icon(entry.type === 'claim' ? 'clipboard' : entry.type === 'found' ? 'check' : 'alert', 15)}</span>
        <div><strong>${h(entry.label)}</strong><span>${h(entry.name)}</span></div><time>${date(entry.date)}</time></div>`).join('') : '<p class="empty">No staff activity yet.</p>'}</div>
    </section><aside class="dashboard-side"><section class="card dashboard-panel"><div class="dashboard-panel-head"><h3>Quick actions</h3></div>
      <div class="quick-actions">${has('view_lost_reports') ? `<a class="quick" href="/?page=staff-lost-reports">${icon('file', 16)}${has('review_lost_report') ? 'Review' : 'View'} lost reports</a>` : ''}
        ${has('view_found_items') ? `<a class="quick" href="/?page=staff-found-items">${icon('check', 16)}View recovered items</a>
        <a class="quick" href="/?page=staff-stored-items">${icon('clipboard', 16)}View items in staff custody</a>
        <a class="quick" href="/?page=staff-returned-items">${icon('check', 16)}View returned items</a>` : ''}
        ${has('view_claims') ? `<a class="quick" href="/?page=staff-claims">${icon('clipboard', 16)}Review ownership claims</a>` : ''}
        ${has('view_records') ? `<a class="quick" href="/?page=staff-records">${icon('file', 16)}View records</a>` : ''}
        <a class="quick" href="/?page=notifications">${icon('bell', 16)}View notifications</a></div>
    </section></aside></div></main>`;
}

async function staffRecords() {
  const params = new URLSearchParams(location.search);
  const filters = new URLSearchParams();
  ['query', 'item_type', 'status', 'record_type', 'date_from', 'date_to'].forEach((key) => {
    if (params.get(key)) filters.set(key, params.get(key));
  });
  const { items, claims } = await request(`/staff/records?${filters}`);
  const selected = (key, value) => params.get(key) === value ? 'selected' : '';
  const statusOptions = ['lost', 'found', 'stored', 'claimed', 'returned', 'cancelled', 'resolved', 'pending', 'approved', 'rejected'];
  const summaryRows = (records) => records.length ? `<div class="table-wrap"><table class="staff-summary-table"><thead><tr>
    <th>ID</th><th>Item</th><th>Status</th><th>Date</th></tr></thead><tbody>${records.map((record) => `<tr>
    <td data-label="ID">${h(record.id)}</td><td data-label="Item">${h(record.item_name)}</td>
    <td data-label="Status">${badge(record.status)}</td><td data-label="Date">${date(record.created_at)}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="empty">No records found.</p>';
  return `<main class="container staff-workspace"><header class="page-header browse-header"><div><h1>View Records</h1><p>${items.length + claims.length} records found</p></div>
    ${staffPageLink('view_staff_dashboard', 'staff-dashboard', 'Staff dashboard')}</header>
    <form method="get" class="browse-filter-form"><input type="hidden" name="page" value="staff-records">
      <div class="card browse-toolbar"><label class="browse-search" for="records-search">${icon('search', 17)}<input id="records-search" name="query" value="${h(params.get('query') || '')}" placeholder="Search by item or record ID..."></label>
        <select class="select" name="item_type" aria-label="Filter by item type"><option value="">All Types</option><option value="lost" ${selected('item_type', 'lost')}>Lost</option><option value="found" ${selected('item_type', 'found')}>Recovered</option></select>
        <select class="select" name="status" aria-label="Filter by status"><option value="">All Statuses</option>${statusOptions.map((value) => `<option value="${value}" ${selected('status', value)}>${value === 'returned' ? 'Returned to owner' : itemStatusLabel(value)}</option>`).join('')}</select>
        <button class="button button-primary browse-search-submit" type="submit">Search</button></div>
      <nav class="browse-tabs" aria-label="Filter records by type">
        ${['all', 'items', 'claims'].map((value) => `<button class="browse-tab ${!params.get('record_type') && value === 'all' || params.get('record_type') === value ? 'active' : ''}" type="submit" name="record_type" value="${value}">${value === 'all' ? 'All Records' : value === 'items' ? 'Item Reports' : 'Claims'}</button>`).join('')}
      </nav><details class="browse-more-filters"><summary>More filters</summary><div class="browse-more-grid">
        <div class="field"><label for="date_from">From date</label><input class="input" id="date_from" name="date_from" type="date" value="${h(params.get('date_from') || '')}"></div>
        <div class="field"><label for="date_to">To date</label><input class="input" id="date_to" name="date_to" type="date" value="${h(params.get('date_to') || '')}"></div>
        <div class="browse-more-actions"><button class="button button-primary" type="submit">Apply filters</button><a class="button button-secondary" href="/?page=staff-records">Clear filters</a></div>
      </div></details>
    </form>
    ${params.get('record_type') !== 'claims' ? `<section class="card staff-record-list"><div class="staff-list-heading"><h2>Item and report summaries</h2><span>${items.length} records</span></div>${summaryRows(items)}</section>` : ''}
    ${params.get('record_type') !== 'items' ? `<section class="card staff-record-list staff-claims-list"><div class="staff-list-heading"><h2>Claim summaries</h2><span>${claims.length} claims</span></div>${summaryRows(claims)}</section>` : ''}
    </main>`;
}

async function staffItems(type) {
  const { items } = await request(`/staff/items?type=${type}`);
  const labels = { lost: 'Lost Item Reports', found: 'Recovered Item Reports', stored: 'Items in Staff Custody' };
  const descriptions = { lost: 'Review lost item reports and their private identifying information.', found: 'Review recovered-item reports and match them with items handed in to staff.', stored: 'Track recovered items currently held by staff.' };
  return `<main class="container staff-workspace">${pageHeader(labels[type], descriptions[type], staffPageLink('view_staff_dashboard', 'staff-dashboard', 'Staff dashboard'))}
    <section class="card staff-record-list">${reportRows(items, true)}</section></main>`;
}

async function staffReturnedItems() {
  const { items } = await request('/staff/returned-items');
  return `<main class="container staff-workspace">${pageHeader('Returned Items', 'Items in staff custody that have been returned to their verified owners.', staffPageLink('view_staff_dashboard', 'staff-dashboard', 'Staff dashboard'))}
    <section class="card staff-record-list">${reportRows(items, true)}</section></main>`;
}

async function staffItemPage(id) {
  const { item } = await request(`/staff/items/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const canUpdate = item.item_type === 'found'
    && hasPermission('update_item_status')
    && ['found', 'stored'].includes(item.status);
  const imageUrl = item.image_path ? `${API}/staff/items/${encodeURIComponent(item.id)}/image` : '';
  const reportType = item.item_type === 'found' ? 'recovered item' : 'lost item';
  const formatLongDate = (value) => {
    if (!value) return 'Not available';
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return Number.isNaN(parsedDate.getTime())
      ? 'Not available'
      : parsedDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  };
  const statusOptions = [['found', 'Awaiting handoff'], ['stored', 'In staff custody']];
  return `<main class="container staff-workspace staff-review-page"><header class="page-header"><div><h1>Review ${reportType}</h1>
      <p>Compare the submitted information with the report${item.item_type === 'found' ? ' and physical item' : ''}.</p></div>
      ${staffPageLink('view_records', 'staff-records', 'Back to records')}</header>
    <section class="card staff-review-card" data-edit-session="staff_item" data-edit-session-id="${h(item.id)}"><div class="staff-review-heading"><div><span class="type-banner ${h(item.item_type)}">${reportType} report</span><h2>${h(item.item_name)}</h2></div>
      ${badge(item.status, itemStatusLabel(item.status, item.item_type))}</div>
      ${imageUrl ? `<figure class="staff-review-media"><img class="staff-review-image" alt="${h(item.item_name)}" src="${h(imageUrl)}"><figcaption>Photo provided with the report</figcaption></figure>` : ''}
      <dl class="staff-item-facts">
        <div><dt>Category</dt><dd>${h(item.category)}</dd></div>
        <div><dt>Location</dt><dd>${h(item.location)}</dd></div>
        <div><dt>Date</dt><dd>${formatLongDate(item.date_lost)}</dd></div>
        <div><dt>Reported by</dt><dd>${h(item.reported_by || 'Unknown')}</dd></div>
        <div><dt>Reporter email</dt><dd>${h(item.reporter_email || 'Not provided')}</dd></div>
        <div><dt>Report ID</dt><dd>${h(item.id)}</dd></div>
      </dl>
      <div class="staff-review-notes">
        <section><h3>Description</h3><p>${h(item.description)}</p></section>
        <section><h3>Private identifying details</h3><p>${h(item.identifying_details)}</p></section>
      </div>
      ${canUpdate ? `<section class="staff-status-editor"><div class="staff-status-copy"><h3>Update item status</h3>
        <p>Select a new status, then press Save status to apply it. Recovered items must be in staff custody before users can submit claims.</p></div>
        <form class="staff-status-form" data-form="staff-status" data-id="${h(item.id)}">
          ${selectField('New status', 'status', statusOptions, item.status, true)}
          <button class="button button-primary" type="submit">Save status</button>
        </form></section>` : ''}
      ${item.item_type === 'found' && ['found', 'stored'].includes(item.status)
        && hasPermission('verify_found_item')
        ? `<section class="staff-verification">
            ${item.physical_verification_status === 'verified'
              ? `<p>This report was marked physically verified on ${formatLongDate(item.physical_verified_at)}.</p><span class="staff-verification-complete">${icon('check', 15)} Verification complete</span>`
              : `<p>Confirm that the physical item has been handed in to staff before marking it verified.</p>${formAction('verify-item', item.id, 'Mark physically verified', 'primary')}`}
          </section>`
        : ''}</section></main>`;
}

async function staffClaims() {
  const { claims } = await request('/staff/claims');
  return `<main class="container staff-workspace">${pageHeader('Ownership Claims', 'Review claimants’ identifying details before deciding who owns a recovered item.', staffPageLink('view_staff_dashboard', 'staff-dashboard', 'Staff dashboard'))}
    <section class="card staff-record-list staff-claims-list"><div class="staff-list-heading"><h2>Submitted claims</h2><span>${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}</span></div>${claimRows(claims)}</section></main>`;
}

function claimRows(claims) {
  if (!claims.length) return `<div class="staff-claims-empty"><span class="staff-empty-icon">${icon('clipboard', 22)}</span><h3>No claims yet</h3><p>Ownership claims will appear here when someone requests a recovered item.</p></div>`;
  return claims.map((claim) => `<article class="staff-claim-row" id="claim-${h(claim.id)}"><span class="staff-claim-icon">${icon('clipboard', 19)}</span>
    <div class="staff-record-info"><h2>${h(claim.item_name || claim.item?.item_name)}</h2><p class="staff-claimant">Claimant <strong>${h(claim.claimant?.full_name || 'Account unavailable')}</strong></p>
    <p class="staff-claim-date">Submitted ${date(claim.created_at)}</p></div>
    <div class="staff-claim-actions">${badge(claim.status)}<a class="button button-outline" href="/?page=staff-claim&amp;id=${encodeURIComponent(claim.id)}">${claim.status === 'pending' ? 'Verify ownership' : 'View decision'}</a></div></article>`).join('');
}

async function staffClaimPage(id) {
  const { claim, pickupDefaults = {} } = await request(`/staff/claims/${encodeURIComponent(id)}`);
  const claimant = claim.claimant;
  const item = claim.item || {};
  const pickupTimeZone = pickupDefaults.time_zone || claim.pickup_time_zone || 'Asia/Manila';
  const earliestPickupDate = localDateInTimeZone(pickupTimeZone);
  return `<main class="container staff-workspace"><header class="page-header"><div><h1>Verify Item Ownership</h1>
    <p>Compare the claimant’s information with the private details on the item report.</p></div>${buttonLink('staff-claims', 'Back to claims', 'button-secondary')}</header>
    <section class="card staff-review-card" data-edit-session="staff_claim" data-edit-session-id="${h(claim.id)}"><div class="staff-review-heading"><div><span class="type-banner found">Recovered item claim</span><h2>${h(claim.item_name)}</h2></div>${badge(claim.status)}</div>
      <div class="staff-claim-comparison"><section class="staff-private-details"><h3>Claimant account information</h3>
        ${claimant ? `<dl class="staff-item-facts"><div><dt>Name</dt><dd>${h(claimant.full_name)}</dd></div><div><dt>Email</dt><dd>${h(claimant.email)}</dd></div>
          <div><dt>Student ID</dt><dd>${h(claimant.student_id || 'Not provided')}</dd></div><div><dt>Phone</dt><dd>${h(claimant.phone || 'Not provided')}</dd></div></dl>` : '<p>The claimant account is unavailable.</p>'}
        <h3>Claimant’s ownership details</h3><p>${h(claim.claim_details)}</p></section>
        <section class="staff-private-details"><h3>Item report information</h3><dl class="staff-item-facts">
          <div><dt>Category</dt><dd>${h(item.category)}</dd></div><div><dt>Location</dt><dd>${h(item.location)}</dd></div>
          <div><dt>Date</dt><dd>${date(item.date_lost)}</dd></div><div><dt>Reported by</dt><dd>${h(item.reported_by || 'Unknown')}</dd></div></dl>
          ${item.image_path ? `<img class="staff-review-image" src="${h(API)}/staff/items/${encodeURIComponent(item.id)}/image" alt="${h(claim.item_name)} image">` : ''}
          <h3>Private identifying details from report</h3><p>${h(item.identifying_details)}</p></section></div>
      ${claim.status === 'pending' && (hasPermission('approve_claim')
        || hasPermission('reject_claim')) ? `<div class="staff-verification"><p>Compare the claimant’s statements with the private report details and the physical item before deciding.</p>
        ${hasPermission('approve_claim') && hasPermission('schedule_pickup')
          ? `<form class="form-grid pickup-schedule-form" data-form="approve-claim" data-id="${h(claim.id)}">
              <h3>Schedule an item pickup (optional)</h3><div class="form-row">
                <div class="field"><label for="pickup-date">Pickup date</label><input class="input" id="pickup-date" type="date" name="pickup_date" min="${earliestPickupDate}" required></div>
                <div class="field"><label for="pickup-time">Pickup time</label><input class="input" id="pickup-time" type="time" name="pickup_time" required></div></div>
              <div class="field"><label for="pickup-location">Pickup location</label><input class="input" id="pickup-location" name="pickup_location" maxlength="256" value="${h(pickupDefaults.office_location || '')}"></div>
              <p class="muted">Pickup hours: ${h(pickupDefaults.pickup_open_time || '08:00')}–${h(pickupDefaults.pickup_close_time || '17:00')} (${h(pickupDefaults.time_zone || 'Asia/Manila')}), ${h(pickupDefaults.pickup_days || 'Monday, Tuesday, Wednesday, Thursday, Friday, Saturday')}.</p>
              <button class="button button-primary" type="submit">Approve and schedule pickup</button>
            </form>
            <div class="pickup-schedule-alternatives"><p class="muted">Or decide without scheduling:</p><div class="staff-decision-actions">
              ${formAction('review-claim', claim.id, 'Approve without pickup time', 'outline', { decision: 'approved' })}
              ${hasPermission('reject_claim') ? formAction('review-claim', claim.id, 'Reject claim', 'danger', { decision: 'rejected' }) : ''}
            </div></div>`
          : `<div class="staff-decision-actions">
              ${hasPermission('approve_claim') ? formAction('review-claim', claim.id, 'Approve ownership', 'primary', { decision: 'approved' }) : ''}
              ${hasPermission('reject_claim') ? formAction('review-claim', claim.id, 'Reject claim', 'danger', { decision: 'rejected' }) : ''}
            </div>`}</div>`
        : claim.status === 'approved' && item.status === 'claimed' && hasPermission('mark_item_returned')
          ? `<div class="staff-verification"><p>Confirm that the verified owner has received the item before recording its return.</p>${formAction('mark-returned', claim.id, 'Mark item as returned', 'primary')}</div>` : ''}
      ${claim.pickup_at && (claim.status === 'approved' || claim.calendar_sync_status === 'failed') ? `<section class="staff-verification pickup-status">
        <h3>Pickup appointment</h3><p>${h(formatPickup(claim.pickup_at, claim.pickup_time_zone))} · ${h(claim.pickup_location)}</p>
        ${claim.calendar_sync_status === 'failed' ? `<p class="claim-outcome">Calendar not synced</p>${hasPermission('schedule_pickup') ? formAction('retry-calendar-sync', claim.id, 'Retry sync', 'outline') : ''}` : ''}
        ${hasPermission('schedule_pickup') && item.status === 'claimed' && !item.deleted_at ? `<form class="form-grid pickup-schedule-form" data-form="reschedule-pickup" data-id="${h(claim.id)}">
          <h3>Reschedule pickup</h3><div class="form-row">
            <div class="field"><label for="reschedule-pickup-date">Pickup date</label><input class="input" id="reschedule-pickup-date" type="date" name="pickup_date" min="${earliestPickupDate}" required value="${h(localPickupDate(claim))}"></div>
            <div class="field"><label for="reschedule-pickup-time">Pickup time</label><input class="input" id="reschedule-pickup-time" type="time" name="pickup_time" required value="${h(localPickupTime(claim))}"></div></div>
          <div class="field"><label for="reschedule-pickup-location">Pickup location</label><input class="input" id="reschedule-pickup-location" name="pickup_location" maxlength="256" required value="${h(claim.pickup_location)}"></div>
          <button class="button button-outline" type="submit">Save new pickup time</button></form>` : ''}
      </section>` : ''}
    </section></main>`;
}

function formatPickup(value, timeZone = 'Asia/Manila') {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

function localPickupFields(claim) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: claim.pickup_time_zone || 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(claim.pickup_at)).filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, value]));
  return parts;
}

function localPickupDate(claim) {
  const parts = localPickupFields(claim);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localPickupTime(claim) {
  const parts = localPickupFields(claim);
  return `${parts.hour}:${parts.minute}`;
}

function localDateInTimeZone(timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function staffPageLink(permission, page, label) {
  return hasPermission(permission)
    ? buttonLink(page, label, 'button-secondary') : '';
}

export { staffDashboard, staffRecords, staffItems, staffReturnedItems, staffItemPage, staffClaims, staffClaimPage };
