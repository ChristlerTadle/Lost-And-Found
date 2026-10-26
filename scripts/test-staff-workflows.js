const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const pages = require('../src/routes/pages');

async function testRoleNavigation() {
  const layout = path.resolve(__dirname, '..', 'views', 'layouts', 'app.ejs');
  const nav = [
    { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'home' },
    { key: 'staff-dashboard', label: 'Staff Dashboard', href: '/staff-dashboard', icon: 'home' },
    { key: 'staff-records', label: 'View Records', href: '/staff-records', icon: 'file' },
    { key: 'staff-lost-reports', label: 'Lost Item Reports', href: '/staff-lost-reports', icon: 'file' },
    { key: 'staff-found-items', label: 'Found Items', href: '/staff-found-items', icon: 'check' },
    { key: 'staff-stored-items', label: 'Stored Items', href: '/staff-stored-items', icon: 'clipboard' },
    { key: 'staff-returned-items', label: 'Returned Items', href: '/staff-returned-items', icon: 'check' },
    { key: 'staff-claims', label: 'Ownership Claims', href: '/staff-claims', icon: 'clipboard' },
    { key: 'notifications', label: 'Notifications', href: '/notifications', icon: 'bell' },
    { key: 'profile', label: 'Profile', href: '/profile', icon: 'user' },
  ];
  const render = (role) => ejs.renderFile(layout, {
    title: 'Role Navigation Check',
    assetVersion: 'test',
    icon: () => '',
    nav,
    user: { role_name: role, full_name: 'Test User' },
    roleLabel: () => role,
    unreadNotifications: 0,
    active: '',
    body: '',
  });
  const userHtml = await render('user');
  const staffHtml = await render('staff');
  assert.equal(userHtml.includes('Staff Dashboard'), false);
  assert.equal(userHtml.includes('Lost Item Reports'), false);
  assert.equal(userHtml.includes('Found Items'), false);
  assert.equal(userHtml.includes('Ownership Claims'), false);
  assert.equal(staffHtml.includes('Staff Dashboard'), true);
  assert.equal(staffHtml.includes('View Records'), true);
  assert.equal(staffHtml.includes('Lost Item Reports'), true);
  assert.equal(staffHtml.includes('Found Items'), true);
  assert.equal(staffHtml.includes('Stored Items'), true);
  assert.equal(staffHtml.includes('Returned Items'), true);
  assert.equal(staffHtml.includes('Ownership Claims'), true);
}

async function testVerificationButtonState() {
  const template = path.resolve(__dirname, '..', 'views', 'staff-item.ejs');
  const render = (status) => ejs.renderFile(template, {
    item: {
      id: 'found-1',
      item_type: 'found',
      status: 'found',
      item_name: 'Test item',
      physical_verification_status: status,
      category: 'Other',
      location: 'Library',
      date_lost: '2026-10-14',
      reported_by: 'Reporter',
      reporter_email: 'reporter@example.test',
      description: 'Test description',
      identifying_details: 'Private details',
    },
    message: null,
    formatDate: (value) => value,
    icon: () => '',
  });
  const pendingHtml = await render('pending');
  const verifiedHtml = await render('verified');
  assert.equal(pendingHtml.includes('Mark physically verified'), true);
  assert.equal(pendingHtml.includes('name="action" value="verify_found_item"'), true);
  assert.equal(pendingHtml.includes('name="action" value="update_item_status"'), true);
  assert.equal(pendingHtml.includes('name="status"'), true);
  assert.equal(verifiedHtml.includes('Mark physically verified'), false);
  assert.equal(verifiedHtml.includes('Confirm verification'), false);
  assert.equal(verifiedHtml.includes('Verification complete'), true);
}

async function testReturnButtonState() {
  const template = path.resolve(__dirname, '..', 'views', 'staff-claim.ejs');
  const render = (itemStatus, highlightTarget = '') => ejs.renderFile(template, {
    claim: {
      id: 'claim-1',
      status: 'approved',
      item_name: 'Test item',
      item: {
        status: itemStatus,
        category: 'Other',
        location: 'Library',
        date_lost: '2026-10-14',
        reported_by: 'Reporter',
        identifying_details: 'Private details',
      },
      claimant: {
        full_name: 'Claimant',
        email: 'claimant@example.test',
        department: 'Engineering',
        employee_id: 'EMP-1',
      },
      claim_details: 'My initials are inside.',
    },
    message: null,
    highlightTarget,
    formatDate: (value) => value,
    icon: () => '',
  });
  const awaitingReturnHtml = await render('claimed');
  const returnedHtml = await render('returned');
  assert.equal(awaitingReturnHtml.includes('id="claim-claim-1"'), true);
  assert.equal(awaitingReturnHtml.includes('Mark item as returned'), true);
  assert.equal(awaitingReturnHtml.includes('Department'), false);
  assert.equal(awaitingReturnHtml.includes('Employee ID'), false);
  const highlightedHtml = await render('claimed', 'claim-claim-1');
  assert.equal(
    highlightedHtml.includes('class="card staff-review-card notification-highlight" id="claim-claim-1"'),
    true,
  );
  assert.equal(returnedHtml.includes('Mark item as returned'), false);
  assert.equal(returnedHtml.includes('marked as returned'), true);
}

async function testStaffDashboardTools() {
  const template = path.resolve(__dirname, '..', 'views', 'staff-dashboard.ejs');
  const html = await ejs.renderFile(template, {
    user: { full_name: 'Staff Member' },
    lostCount: 2,
    foundCount: 2,
    pendingClaimCount: 0,
    pendingVerificationCount: 0,
    storedCount: 2,
    returnedCount: 0,
    unreadNotifications: 3,
    activity: [{ type: 'claim', label: 'Claim submitted', name: 'Test wallet', date: '2026-10-22T10:00:00.000Z' }],
    formatDate: (value) => value,
    icon: () => '',
  });
  assert.equal((html.match(/class="quick" href=/g) || []).length, 6);
  assert.equal(html.includes('Recent activity'), true);
  assert.equal(html.includes('Quick actions'), true);
  assert.equal(html.includes('Test wallet'), true);
  assert.equal(html.includes('href="/index.php?page=notifications"'), true);
  assert.equal(html.includes('href="/index.php?page=staff-returned-items"'), true);
  assert.equal(html.includes('class="notification-count">3</span>'), true);
}

async function testReturnedItemsTemplate() {
  const template = path.resolve(__dirname, '..', 'views', 'staff-returned-items.ejs');
  const html = await ejs.renderFile(template, {
    items: [{
      id: 'returned-1',
      item_name: 'Blue wallet',
      category: 'Accessories',
      location: 'Library',
      claimant: { full_name: 'Verified Owner', email: 'owner@example.test' },
      reported_by: 'Reporter',
      returned_at: '2026-10-22T10:00:00.000Z',
      updated_at: '2026-10-22T10:00:00.000Z',
      claimed_claim_id: 'claim-1',
    }],
    filters: { query: '', category: '', date_from: '', date_to: '' },
    categories: ['Accessories'],
    formatDate: (value) => value,
    icon: () => '',
  });
  assert.equal(html.includes('Returned to owner'), true);
  assert.equal(html.includes('All Categories'), true);
  assert.equal(html.includes('All Returned'), true);
  assert.equal(html.includes('Search items, claimant, or location...'), true);
  assert.equal(html.includes('More filters'), true);
  assert.equal(html.includes('Verified Owner'), true);
  assert.equal(html.includes('href="/index.php?page=staff-item&amp;id=returned-1"'), true);
  assert.equal(html.includes('href="/index.php?page=staff-claim&amp;id=claim-1"'), true);
}

async function testStaffRecordsTemplate() {
  const template = path.resolve(__dirname, '..', 'views', 'staff-records.ejs');
  const html = await ejs.renderFile(template, {
    items: [{
      id: 'item-1',
      item_name: 'Blue wallet',
      item_type: 'found',
      category: 'Accessories',
      location: 'Library',
      reported_by: 'Reporter',
      created_at: '2026-10-22',
      status: 'stored',
    }],
    claims: [{
      id: 'claim-1',
      item_name: 'Blue wallet',
      status: 'pending',
      created_at: '2026-10-22',
      claimant: { full_name: 'Owner' },
    }],
    filters: {
      query: 'wallet',
      record_type: 'all',
      item_type: 'found',
      status: 'stored',
      category: 'Accessories',
      date_from: '',
      date_to: '',
    },
    categories: ['Accessories'],
    formatDate: (value) => value,
    icon: () => '',
  });
  assert.equal(html.includes('Search items, reports, claimants...'), true);
  assert.equal(html.includes('All Categories'), true);
  assert.equal(html.includes('Returned to owner'), true);
  assert.equal(html.includes('More filters'), true);
  assert.equal(html.includes('Ownership claim records'), true);
}

async function testClaimantPickupInstruction() {
  const template = path.resolve(__dirname, '..', 'views', 'claims.ejs');
  const html = await ejs.renderFile(template, {
    claims: [{
      id: 'claim-1',
      item_name: 'Blue wallet',
      category: 'Accessories',
      location: 'Library',
      claim_details: 'My initials are inside.',
      status: 'approved',
      item_status: 'claimed',
    }],
    error: null,
  });
  assert.equal(html.includes('Your claim was approved.'), true);
  assert.equal(html.includes('Please collect your item from Lost and Found staff.'), true);
  assert.equal(html.includes('Staff will mark it as returned after you receive it.'), true);
  assert.equal(html.includes('id="claim-claim-1"'), true);
}

async function testDuplicateItemNamesHaveUniqueNotificationTargets() {
  const template = path.resolve(__dirname, '..', 'views', 'claims.ejs');
  const html = await ejs.renderFile(template, {
    claims: [
      { id: 'claim-1', item_name: 'Department shirt', category: 'Clothing', location: 'Library', claim_details: 'First claim', status: 'approved', item_status: 'claimed' },
      { id: 'claim-2', item_name: 'Department shirt', category: 'Clothing', location: 'Library', claim_details: 'Second claim', status: 'rejected', item_status: 'stored' },
    ],
    highlightTarget: 'claim-claim-2',
    error: null,
  });
  assert.equal(html.includes('id="claim-claim-1"'), true);
  assert.equal(html.includes('id="claim-claim-2"'), true);
  assert.equal((html.match(/notification-highlight/g) || []).length, 1);
  assert.equal(html.includes('class="report notification-highlight" id="claim-claim-2"'), true);
}

async function testNotificationTargetHighlightStyle() {
  const stylesheet = await require('node:fs/promises').readFile(
    path.resolve(__dirname, '..', 'assets', 'app.css'),
    'utf8',
  );
  assert.equal(stylesheet.includes('.report:target, .staff-claim-row:target, .staff-review-card:target'), true);
  assert.equal(stylesheet.includes('notification-target-glow 3s ease-out'), true);
  assert.equal(stylesheet.includes('background-color: #f2fff6;'), true);
  assert.equal(stylesheet.includes('background-color: transparent;'), true);
  assert.equal(stylesheet.includes('.report:target, .report.notification-highlight {'), true);
  assert.equal(stylesheet.includes('border-radius: 8px;'), true);
  assert.equal(stylesheet.includes('@media (prefers-reduced-motion: reduce)'), true);
  assert.equal(stylesheet.includes('box-shadow: 0 0 0 3px #1a5c2e55'), false);
  assert.equal(stylesheet.includes('box-shadow: 0 0 0 3px #1a5c2e44'), false);
}

async function testNotificationLinks() {
  const template = path.resolve(__dirname, '..', 'views', 'notifications.ejs');
  const html = await ejs.renderFile(template, {
    notifications: [
      {
        id: 'legacy-1',
        type: 'status',
        title: 'Item status updated',
        message: 'The status of "Blue wallet" was updated to stored.',
        href: '/index.php?page=reports',
        created_at: '2026-10-22',
        read_at: null,
      },
      {
        id: 'current-1',
        type: 'claim',
        title: 'Claim approved',
        message: 'Your claim for "Blue wallet" was approved.',
        href: '/index.php?page=claims&highlight=claim-claim-1',
        created_at: '2026-10-22',
        read_at: null,
      },
    ],
    unreadNotifications: 2,
    icon: () => '',
    formatDate: (value) => value,
  });
  assert.equal(html.includes('href="/index.php?page=reports"'), true);
  assert.equal(html.includes('href="/index.php?page=claims&amp;highlight=claim-claim-1"'), true);
}

async function testStudentDashboardStoredSummary() {
  const template = path.resolve(__dirname, '..', 'views', 'dashboard.ejs');
  const html = await ejs.renderFile(template, {
    user: { full_name: 'Student' },
    lostCount: 1,
    foundCount: 2,
    storedCount: 1,
    pendingClaims: 0,
    claims: [],
    activity: [],
    icon: () => '',
    formatDate: (value) => value,
  });
  assert.equal(html.includes('Stored items'), true);
  assert.equal(html.includes('Currently in staff custody'), true);
  assert.equal(html.includes('status_tab=stored'), true);
}

async function testReturnedToOwnerLabels() {
  const reportsTemplate = path.resolve(__dirname, '..', 'views', 'reports.ejs');
  const reportsHtml = await ejs.renderFile(reportsTemplate, {
    items: [{
      id: 'returned-1',
      item_name: 'Blue wallet',
      item_type: 'found',
      status: 'returned',
      category: 'Accessories',
      location: 'Library',
      date_lost: '2026-10-20',
      physical_verification_status: 'verified',
    }],
    message: null,
    foundReportSubmitted: false,
    error: null,
  });
  assert.equal(reportsHtml.includes('Returned to owner'), true);
  assert.equal(reportsHtml.includes('id="item-returned-1"'), true);
  const foundReportSuccessHtml = await ejs.renderFile(reportsTemplate, {
    items: [],
    message: null,
    foundReportSubmitted: true,
    error: null,
  });
  assert.equal(foundReportSuccessHtml.includes('Next step: Bring the item to Lost and Found staff'), true);
  assert.equal(foundReportSuccessHtml.includes('record it as stored'), true);

  const staffItemTemplate = path.resolve(__dirname, '..', 'views', 'staff-item.ejs');
  const returnedItemHtml = await ejs.renderFile(staffItemTemplate, {
    item: {
      id: 'returned-1',
      item_type: 'found',
      item_name: 'Blue wallet',
      status: 'returned',
      category: 'Accessories',
      location: 'Library',
      date_lost: '2026-10-20',
      reported_by: 'Reporter',
      reporter_email: 'reporter@example.test',
      description: 'Blue leather wallet.',
      identifying_details: 'Initials inside.',
    },
    message: null,
    formatDate: (value) => value,
    icon: () => '',
  });
  assert.equal(returnedItemHtml.includes('Returned to owner'), true);
}

async function run() {
  await testRoleNavigation();
  await testVerificationButtonState();
  await testReturnButtonState();
  await testStaffDashboardTools();
  await testReturnedItemsTemplate();
  await testStaffRecordsTemplate();
  await testClaimantPickupInstruction();
  await testDuplicateItemNamesHaveUniqueNotificationTargets();
  await testNotificationTargetHighlightStyle();
  await testNotificationLinks();
  await testStudentDashboardStoredSummary();
  await testReturnedToOwnerLabels();
  const calls = [];
  let staffRecordsFilters = null;
  const staff = { id: 'staff-1', role_name: 'staff', full_name: 'Staff Member' };
  const legacyStaffNotification = {
    id: 'legacy-claim',
    type: 'claim',
    title: 'Ownership claim needs review',
    message: 'A new ownership claim was submitted for "Department shirt".',
    href: '/index.php?page=staff-claims',
    created_at: '2026-10-23T17:00:00.000Z',
    read_at: null,
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const role = req.headers['x-test-role'];
    req.session = { user: role === 'user'
      ? { id: 'user-1', role_name: 'user', full_name: 'Student' }
      : role === 'admin'
        ? { id: 'admin-1', role_name: 'admin', full_name: 'Admin' }
        : staff };
    res.render = (view, data) => res.status(res.statusCode).json({ view, data });
    res.sendFile = (filename) => res.status(200).json({ filename });
    next();
  });
  app.locals.services = {
    notifications: {
      findForUser: async () => [legacyStaffNotification],
    },
    auth: {
      requireRole(user, roles) {
        if (!roles.includes(user.role_name)) {
          const error = new Error('You do not have permission to perform this action.');
          error.status = 403;
          throw error;
        }
      },
    },
    items: {
      findStaffItems: async (type) => [{ id: `${type}-1`, item_type: type, physical_verification_status: 'pending' }],
      search: async (filters) => {
        const foundItems = [
          { id: 'stored-1', item_type: 'found', status: 'stored' },
          { id: 'found-1', item_type: 'found', status: 'found' },
          { id: 'lost-1', item_type: 'lost', status: 'lost' },
        ];
        return filters.status === 'stored'
          ? foundItems.filter((item) => item.status === 'stored')
          : foundItems;
      },
      findStaffRecords: async (filters) => {
        staffRecordsFilters = filters;
        return {
        items: [
          { id: 'lost-1', item_type: 'lost', item_name: 'Lost bag', status: 'lost', created_at: '2026-10-20', updated_at: '2026-10-20' },
          { id: 'found-1', item_type: 'found', item_name: 'Found wallet', status: 'found', physical_verification_status: 'pending', created_at: '2026-10-21', updated_at: '2026-10-21' },
          { id: 'stored-1', item_type: 'found', item_name: 'Stored keys', status: 'stored', physical_verification_status: 'verified', created_at: '2026-10-22', updated_at: '2026-10-22' },
          { id: 'returned-1', item_type: 'found', item_name: 'Returned book', status: 'returned', created_at: '2026-10-22', updated_at: '2026-10-22' },
        ],
        claims: [{ id: 'claim-1', item_name: 'Stored keys', status: 'pending', created_at: '2026-10-22', updated_at: '2026-10-22' }],
        };
      },
      findStaffReturnedItems: async (filters) => [{
        id: 'returned-1',
        item_type: 'found',
        item_name: 'Returned wallet',
        status: 'returned',
        returned_at: '2026-10-22T10:00:00.000Z',
        claimed_claim_id: 'claim-1',
        claimant: { full_name: 'Owner', email: 'owner@example.test' },
        reported_by: 'Reporter',
        category: 'Accessories',
        location: 'Library',
        query: filters.query,
        category_filter: filters.category,
      }],
      findStaffClaims: async () => [
        { id: 'older-shirt-claim', item_name: 'Department shirt', status: 'pending', created_at: '2026-10-23T16:30:00.000Z' },
        { id: 'latest-shirt-claim', item_name: 'Department shirt', status: 'approved', created_at: '2026-10-23T16:59:00.000Z' },
      ],
      findStaffItem: async (id) => ({ id, item_type: 'found', image_path: 'a1b2c3d4-e5f6-4789-a123-456789abcdef.png' }),
      findStaffClaim: async (id) => ({ id, status: 'pending' }),
      findPublic: async (id) => ({
        id,
        item_type: 'found',
        status: id === 'claimed-1' ? 'claimed' : id === 'stored-1' ? 'stored' : 'found',
        user_id: 'owner-1',
        user_claim_id: null,
      }),
      verifyFoundItem: async (id, staffId) => calls.push({ action: 'verify', id, staffId }),
      updateItemStatus: async (id, staffId, status) => calls.push({ action: 'status', id, staffId, status }),
      markItemReturned: async (id, staffId) => calls.push({ action: 'return', id, staffId }),
      reviewClaim: async (id, staffId, decision) => calls.push({ action: 'review', id, staffId, decision }),
    },
  };
  app.use(pages);

  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/index.php`;
    const dashboardResponse = await fetch(`${baseUrl}?page=staff-dashboard`);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboardResponse.status, 200);
    assert.equal(dashboard.view, 'staff-dashboard');
    assert.equal(dashboard.data.pendingVerificationCount, 1);
    assert.equal(dashboard.data.pendingClaimCount, 1);
    assert.equal(dashboard.data.storedCount, 1);
    assert.equal(dashboard.data.returnedCount, 1);
    assert.equal(dashboard.data.activity.length, 5);
    assert.equal(dashboard.data.activity[0].date, '2026-10-22');
    assert.equal(dashboard.data.activity.some((entry) => entry.label === 'Found item stored'), true);
    assert.equal(dashboard.data.activity.some((entry) => entry.label === 'Claim submitted'), true);

    const notificationsResponse = await fetch(`${baseUrl}?page=notifications`);
    const notificationsPage = await notificationsResponse.json();
    assert.equal(notificationsResponse.status, 200);
    assert.equal(
      notificationsPage.data.notifications[0].href,
      '/index.php?page=staff-claim&id=latest-shirt-claim&highlight=claim-latest-shirt-claim',
    );

    for (const [page, expectedView] of [
      ['staff-records', 'staff-records'],
      ['staff-lost-reports', 'staff-items'],
      ['staff-found-items', 'staff-items'],
      ['staff-stored-items', 'staff-items'],
      ['staff-returned-items', 'staff-returned-items'],
      ['staff-item&id=found-1', 'staff-item'],
      ['staff-claims', 'staff-claims'],
      ['staff-claim&id=claim-1&highlight=claim-claim-1', 'staff-claim'],
    ]) {
      const response = await fetch(`${baseUrl}?page=${page}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).view, expectedView);
    }
    const highlightedStaffClaimResponse = await fetch(
      `${baseUrl}?page=staff-claim&id=claim-1&highlight=claim-claim-1`,
    );
    const highlightedStaffClaimPage = await highlightedStaffClaimResponse.json();
    assert.equal(highlightedStaffClaimPage.data.highlightTarget, 'claim-claim-1');
    const filteredRecordsResponse = await fetch(
      `${baseUrl}?page=staff-records&query=wallet&record_type=claims&item_type=found&status=pending&category=Other&date_from=2026-10-01&date_to=2026-10-31`,
    );
    const filteredRecordsPage = await filteredRecordsResponse.json();
    assert.equal(filteredRecordsResponse.status, 200);
    assert.equal(filteredRecordsPage.view, 'staff-records');
    assert.deepEqual(staffRecordsFilters, {
      query: 'wallet',
      record_type: 'claims',
      item_type: 'found',
      status: 'pending',
      category: 'Other',
      date_from: '2026-10-01',
      date_to: '2026-10-31',
    });
    const storedFilterResponse = await fetch(`${baseUrl}?page=items&status_tab=stored`);
    const storedFilterPage = await storedFilterResponse.json();
    assert.equal(storedFilterResponse.status, 200);
    assert.equal(storedFilterPage.view, 'items');
    assert.equal(storedFilterPage.data.storedOnly, true);
    assert.equal(storedFilterPage.data.items.length, 1);
    assert.equal(storedFilterPage.data.items[0].status, 'stored');

    const denied = await fetch(`${baseUrl}?page=staff-claims`, { headers: { 'x-test-role': 'user' } });
    assert.equal(denied.status, 403);
    const deniedRecords = await fetch(`${baseUrl}?page=staff-records`, { headers: { 'x-test-role': 'user' } });
    assert.equal(deniedRecords.status, 403);
    const deniedReturnedItems = await fetch(`${baseUrl}?page=staff-returned-items`, { headers: { 'x-test-role': 'user' } });
    assert.equal(deniedReturnedItems.status, 403);
    const returnedItemsResponse = await fetch(`${baseUrl}?page=staff-returned-items&query=wallet&category=Other&date_from=2026-10-01`);
    const returnedItemsPage = await returnedItemsResponse.json();
    assert.equal(returnedItemsResponse.status, 200);
    assert.equal(returnedItemsPage.view, 'staff-returned-items');
    assert.equal(returnedItemsPage.data.filters.query, 'wallet');
    assert.equal(returnedItemsPage.data.filters.category, 'Other');
    assert.equal(returnedItemsPage.data.items[0].category_filter, 'Other');
    assert.equal(returnedItemsPage.data.items[0].item_name, 'Returned wallet');
    const deniedFoundImage = await fetch(`${baseUrl}?page=staff-found-image&id=found-1`, { headers: { 'x-test-role': 'user' } });
    assert.equal(deniedFoundImage.status, 403);
    const staffFoundImage = await fetch(`${baseUrl}?page=staff-found-image&id=found-1`);
    const staffFoundImageResult = await staffFoundImage.json();
    assert.equal(staffFoundImage.status, 200);
    assert.equal(staffFoundImageResult.filename.endsWith('private_uploads\\found\\a1b2c3d4-e5f6-4789-a123-456789abcdef.png'), true);
    const adminFoundImage = await fetch(`${baseUrl}?page=staff-found-image&id=found-1`, { headers: { 'x-test-role': 'admin' } });
    assert.equal(adminFoundImage.status, 200);

    const claimedItemResponse = await fetch(`${baseUrl}?page=item&id=claimed-1`);
    const claimedItemPage = await claimedItemResponse.json();
    assert.equal(claimedItemPage.data.item.status, 'claimed');
    assert.equal(claimedItemPage.data.canClaim, false);

    const foundItemResponse = await fetch(`${baseUrl}?page=item&id=found-1`);
    const foundItemPage = await foundItemResponse.json();
    assert.equal(foundItemPage.data.item.status, 'found');
    assert.equal(foundItemPage.data.canClaim, false);

    const storedItemResponse = await fetch(`${baseUrl}?page=item&id=stored-1`);
    const storedItemPage = await storedItemResponse.json();
    assert.equal(storedItemPage.data.item.status, 'stored');
    assert.equal(storedItemPage.data.canClaim, true);

    const verifyResponse = await fetch(`${baseUrl}?page=staff-item`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'verify_found_item', item_id: 'found-1' }),
      redirect: 'manual',
    });
    assert.equal(verifyResponse.status, 302);
    assert.deepEqual(calls[0], { action: 'verify', id: 'found-1', staffId: staff.id });

    const statusResponse = await fetch(`${baseUrl}?page=staff-item`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'update_item_status', item_id: 'found-1', status: 'stored' }),
      redirect: 'manual',
    });
    assert.equal(statusResponse.status, 302);
    assert.deepEqual(calls[1], { action: 'status', id: 'found-1', staffId: staff.id, status: 'stored' });

    const reviewResponse = await fetch(`${baseUrl}?page=staff-claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'review_claim', claim_id: 'claim-1', decision: 'approved' }),
      redirect: 'manual',
    });
    assert.equal(reviewResponse.status, 302);
    assert.deepEqual(calls[2], { action: 'review', id: 'claim-1', staffId: staff.id, decision: 'approved' });

    const returnResponse = await fetch(`${baseUrl}?page=staff-claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'mark_item_returned', claim_id: 'claim-1' }),
      redirect: 'manual',
    });
    assert.equal(returnResponse.status, 302);
    assert.deepEqual(calls[3], { action: 'return', id: 'claim-1', staffId: staff.id });
    console.log('Staff Lost and Found workflow route checks passed.');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
