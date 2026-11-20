import * as shared from './js/shared.js';
import { homePage, loginPage, authForm } from './js/pages/public.js';
import { dashboardPage, browsePage, itemPage, reportPage, reportsPage, editReportPage, claimPage, claimsPage, profilePage, notificationsPage } from './js/pages/user.js';
import { staffDashboard, staffRecords, staffItems, staffReturnedItems, staffItemPage, staffClaims, staffClaimPage } from './js/pages/staff.js';
import { adminDashboard, adminUsers, adminEditUser, adminItems, adminEditItem, adminClaims, adminInventory, adminSettings, adminSystemRecords } from './js/pages/admin.js';
import { adminMfaVerifyPage, adminSecurityPage } from './js/pages/admin-mfa.js';

const { app, sessionInfo, h, date, param, link, buttonLink, badge, field, selectField, optionsFrom, otherLocationValue, request, icon, roleLabel, hasPermission, shell, pageHeader, alert, empty, reportRows, table, statCards, formAction, showFormError, showFormSuccess, showPendingFlash, isRateLimited, setSessionInfo } = shared;
let pendingIntegrationCard = null;
let pendingIntegrationRestore = null;
let integrationCodeResendTimer;
let pendingAdminRoleChange = null;
let roleChangeCodeResendTimer;
const recaptchaChallengeCancels = new WeakMap();
let pendingGoogleSavePopup = null;
let mobileMenuPreviousOverflow = '';

function mobileMenuElements() {
  return {
    button: app.querySelector('#menu-btn'),
    overlay: app.querySelector('#overlay'),
    sidebar: app.querySelector('#sidebar'),
  };
}

function setMobileMenuClosedState(sidebar) {
  if (!sidebar) return;
  const mobile = window.matchMedia('(max-width: 1023px)').matches;
  sidebar.classList.remove('open');
  sidebar.inert = mobile;
  if (mobile) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');
}

function closeMobileMenu(restoreFocus = true) {
  const { button, overlay, sidebar } = mobileMenuElements();
  const wasOpen = sidebar?.classList.contains('open');
  setMobileMenuClosedState(sidebar);
  overlay?.classList.remove('show');
  button?.setAttribute('aria-expanded', 'false');
  button?.setAttribute('aria-label', 'Open menu');
  if (wasOpen) document.body.style.overflow = mobileMenuPreviousOverflow;
  if (wasOpen && restoreFocus) button?.focus({ preventScroll: true });
}

function openMobileMenu() {
  const { button, overlay, sidebar } = mobileMenuElements();
  if (!button || !sidebar) return;
  mobileMenuPreviousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  sidebar.inert = false;
  sidebar.removeAttribute('aria-hidden');
  sidebar.classList.add('open');
  overlay?.classList.add('show');
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-label', 'Close menu');
  sidebar.querySelector('a[href], button:not([disabled])')?.focus({ preventScroll: true });
}

function drawerFocusableElements(sidebar) {
  return [...sidebar.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert], [hidden]'));
}

document.addEventListener('keydown', (event) => {
  const { sidebar } = mobileMenuElements();
  if (!sidebar?.classList.contains('open')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMobileMenu();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = drawerFocusableElements(sidebar);
  if (!focusable.length) {
    event.preventDefault();
    sidebar.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});

document.addEventListener('click', (event) => {
  const { sidebar } = mobileMenuElements();
  if (sidebar?.classList.contains('open')
    && event.target instanceof Element
    && sidebar.contains(event.target)
    && event.target.closest('a[href]')) {
    closeMobileMenu();
  }
});

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)
    || !target.matches('input, select, textarea, [contenteditable="true"]')) return;
  scrollFocusedFieldAboveActionBar(target);
});

window.visualViewport?.addEventListener('resize', () => {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) scrollFocusedFieldAboveActionBar(focused);
});

window.addEventListener('resize', () => {
  const { sidebar } = mobileMenuElements();
  if (!sidebar) return;
  if (!window.matchMedia('(max-width: 1023px)').matches && sidebar.classList.contains('open')) {
    closeMobileMenu(false);
  } else if (!sidebar.classList.contains('open')) {
    setMobileMenuClosedState(sidebar);
  }
});

function scrollFocusedFieldAboveActionBar(target) {
  const bar = document.querySelector('.sticky-action-bar');
  if (!bar?.getClientRects().length || !target.getClientRects().length) return;
  const rect = target.getBoundingClientRect();
  const viewportBottom = window.visualViewport
    ? Math.min(window.innerHeight, window.visualViewport.offsetTop + window.visualViewport.height)
    : window.innerHeight;
  const barTop = Math.min(bar.getBoundingClientRect().top, viewportBottom);
  const topbarBottom = document.querySelector('.app-topbar')?.getBoundingClientRect().bottom || 0;
  if (rect.bottom <= barTop - 8 && rect.top >= topbarBottom) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
}

window.addEventListener('message', (event) => {
  const pending = pendingGoogleSavePopup;
  if (!pending || event.origin !== window.location.origin || event.source !== pending.popup
    || event.data?.type !== 'google-integration-verification') return;
  const statuses = ['success', 'access_denied', 'redirect_mismatch', 'expired', 'failed'];
  if (statuses.includes(event.data.status)) pending.finish(event.data.status);
});

document.addEventListener('shared-rate-limit-ended', (event) => {
  const form = event.detail?.closest?.('form[data-form="integration-settings"]');
  if (form) updateIntegrationSaveState(form);
});

async function render() {
  pendingIntegrationCard = null;
  pendingIntegrationRestore = null;
  clearInterval(integrationCodeResendTimer);
  app.innerHTML = '<main class="loading" aria-live="polite">Loading…</main>';
  try {
    setSessionInfo(await request('/auth/me'));
    const roleHome = sessionInfo.user?.role_name === 'admin' ? 'admin-dashboard'
      : sessionInfo.user?.role_name === 'staff' ? staffHomePage() : 'dashboard';
    const page = param('page') || (sessionInfo.user ? roleHome : 'home');
    const content = await renderPage(page);
    app.innerHTML = shell(content, page);
    bindForms();
    restorePendingIntegrationCodeDialog();
    await mountRecaptchaWidgets();
    showPendingFlash();
    showGoogleOAuthVerificationResult(page);
    const target = param('highlight');
    if (target) {
      const element = document.getElementById(target);
      if (element) {
        element.classList.add('notification-highlight');
        requestAnimationFrame(() => element.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      }
      if (page === 'admin-users' && param('tab') !== 'role-defaults'
        && !sessionInfo.rolePermissions.includes('view_users')) {
        return `<main class="container">${alert('You do not have permission to view user accounts.', true)}</main>`;
      }
      if (page === 'admin-edit-user' && !sessionInfo.rolePermissions.includes('edit_user')
        && !sessionInfo.rolePermissions.includes('manage_permissions')) {
        return `<main class="container">${alert('You do not have permission to edit this account.', true)}</main>`;
      }
      if (page === 'admin-users' && param('tab') === 'role-defaults'
        && !sessionInfo.rolePermissions.includes('manage_permissions')) {
        location.replace('/?page=admin-users');
        return `<main class="container">${alert('You do not have permission to manage role defaults.', true)}</main>`;
      }
    }
  } catch (error) {
    const page = param('page') || 'home';
    app.innerHTML = shell(`<main class="container page-load-error" data-page-error>
      <h1>Unable to load this page</h1><div data-message-area></div>
      <button class="button button-primary" type="button" data-action="retry-page-load">Try again</button>
    </main>`, page);
    window.scrollTo({ top: 0, behavior: 'auto' });
    bindForms();
    showFormError(error, { anchor: app.querySelector('[data-page-error]') });
  }
}

async function renderPage(page) {
  const user = sessionInfo.user;
  const privatePages = new Set([
    'dashboard', 'report', 'report-found', 'reports', 'edit-report', 'claims', 'claim', 'profile',
    'notifications', 'staff-dashboard', 'staff-records', 'staff-lost-reports', 'staff-found-items',
    'staff-stored-items', 'staff-returned-items', 'staff-item', 'staff-claims', 'staff-claim',
    'admin-dashboard', 'admin-users', 'admin-edit-user', 'admin-role-permissions', 'admin-items',
    'admin-edit-item', 'admin-claims', 'admin-inventory', 'admin-settings', 'admin-system-records',
    'admin-security',
  ]);
  if (sessionInfo.pendingAdminMfa) return adminMfaVerifyPage();
  if (sessionInfo.adminMfaReauthRequired) return loginPage('Administrator MFA is now required. Sign in again to verify your account.');
  if (page === 'admin-role-permissions') {
    location.replace('/?page=admin-users&tab=role-defaults');
    return '<main class="loading" aria-live="polite">Redirecting to User Management…</main>';
  }
  if (page === 'admin-add-user') {
    location.replace('/?page=admin-users&create=1');
    return '<main class="loading" aria-live="polite">Redirecting to User Management…</main>';
  }
  if (user?.role_name === 'admin' && sessionInfo.adminMfaSetupRequired && page !== 'admin-security') {
    return adminSecurityPage();
  }
  if (privatePages.has(page) && !user) return loginPage('Sign in to continue.');
  if (page.startsWith('admin-') && user?.role_name !== 'admin') {
    location.replace(user ? '/?page=dashboard' : '/?page=login');
    return `<main class="container">${alert('Administrator access is required.', true)}</main>`;
  }
  const pagePermissions = {
    report: 'report_lost_item',
    'report-found': 'report_found_item',
    items: 'view_items',
    item: 'view_items',
    reports: 'view_my_reports',
    'edit-report': 'edit_my_report',
    claims: 'view_claim_status',
    claim: 'submit_claim',
    profile: 'view_profile',
    notifications: 'receive_notifications',
    'staff-dashboard': 'view_staff_dashboard',
    'staff-records': 'view_records',
    'staff-lost-reports': 'view_lost_reports',
    'staff-found-items': 'view_found_items',
    'staff-stored-items': 'view_found_items',
    'staff-returned-items': 'view_found_items',
    'staff-claims': 'view_claims',
    'staff-claim': 'view_claims',
    'admin-dashboard': 'view_admin_dashboard',
    'admin-items': 'view_all_items',
    'admin-claims': 'view_all_claims',
    'admin-inventory': 'generate_inventory_report',
    'admin-settings': 'manage_integrations',
    'admin-system-records': 'view_system_records',
    'admin-security': 'view_admin_dashboard',
  };
  const requiredPermission = pagePermissions[page];
  const canAccessAdminEdit = page === 'admin-edit-user'
    && (hasPermission('edit_user') || hasPermission('manage_permissions'))
    && hasPermission('view_users');
  const canAccessAdminUsers = page === 'admin-users'
    && (param('tab') === 'role-defaults'
      ? hasPermission('manage_permissions')
      : hasPermission('view_users'));
  const canAccessAdminItemEdit = page === 'admin-edit-item'
    && hasPermission('view_all_items') && hasPermission('edit_item_records');
  if (user && page === 'dashboard' && user.role_name === 'admin' && !hasPermission('view_admin_dashboard')) {
    return `<main class="container">${alert('This feature is currently disabled by the administrator.', true)}</main>`;
  }
  if ((user && page === 'admin-users' && !canAccessAdminUsers)
    || (user && page === 'admin-edit-user' && !canAccessAdminEdit)
    || (user && page === 'admin-edit-item' && !canAccessAdminItemEdit)) {
    return `<main class="container">${alert('This feature is currently disabled by the administrator.', true)}</main>`;
  }
  if (user && requiredPermission && !hasPermission(requiredPermission)) {
    return `<main class="container">${alert('This feature is currently disabled by the administrator.', true)}</main>`;
  }
  if (!user && ['items', 'item'].includes(page)) {
    return `<main class="container">${pageHeader('Sign in to view items', 'Log in to browse item reports and view item details.')}
      ${buttonLink('login', 'Log in', 'button-primary')}</main>`;
  }
  if (page === 'login') return loginPage();
  if (page === 'forgot-password') return authForm('forgot');
  if (page === 'reset-password') return authForm('reset');
  if (page === 'home') return homePage();
  switch (page) {
    case 'dashboard': return user.role_name === 'admin' ? adminDashboard()
      : user.role_name === 'staff' ? hasPermission('view_staff_dashboard')
        ? staffDashboard() : staffPermissionHome() : dashboardPage(user);
    case 'items': return browsePage();
    case 'item': return itemPage(param('id'));
    case 'report': return reportPage('lost');
    case 'report-found': return reportPage('found');
    case 'reports': return reportsPage();
    case 'edit-report': return editReportPage(param('id'));
    case 'claim': return claimPage(param('id'));
    case 'claims': return claimsPage();
    case 'profile': return profilePage();
    case 'notifications': return notificationsPage();
    case 'staff-dashboard': return staffDashboard();
    case 'staff-records': return staffRecords();
    case 'staff-lost-reports': return staffItems('lost');
    case 'staff-found-items': return staffItems('found');
    case 'staff-stored-items': return staffItems('stored');
    case 'staff-returned-items': return staffReturnedItems();
    case 'staff-item': return staffItemPage(param('id'));
    case 'staff-claims': return staffClaims();
    case 'staff-claim': return staffClaimPage(param('id'));
    case 'staff-no-access': return staffPermissionHome();
    case 'admin-dashboard': return adminDashboard();
    case 'admin-users': return adminUsers();
    case 'admin-edit-user': return adminEditUser(param('id'));
    case 'admin-items': return adminItems();
    case 'admin-edit-item': return adminEditItem(param('id'));
    case 'admin-claims': return adminClaims();
    case 'admin-inventory': return adminInventory();
    case 'admin-settings': return adminSettings();
    case 'admin-system-records': return adminSystemRecords();
    case 'admin-security': return adminSecurityPage();
    default: return `<main class="page">${pageHeader('Page not found')}<a class="button" href="/">Go home</a></main>`;
  }
}

function bindForms() {
  app.querySelector('[data-action="retry-page-load"]')?.addEventListener('click', () => { void render(); });
  app.querySelectorAll('input[name="phone"]').forEach((input) => {
    const keepDigitsOnly = () => {
      const cursor = input.selectionStart;
      const value = input.value;
      const digits = value.replace(/\D/g, '');
      if (digits === value) return;
      input.value = digits;
      if (cursor !== null) {
        const digitCursor = value.slice(0, cursor).replace(/\D/g, '').length;
        input.setSelectionRange(digitCursor, digitCursor);
      }
    };
    keepDigitsOnly();
    input.addEventListener('input', keepDigitsOnly);
  });
  app.querySelectorAll('form[data-form]').forEach((form) => form.addEventListener('submit', onFormSubmit));
  app.querySelectorAll('form[data-form="report"], form[data-form="edit-report"], form[data-form="admin-edit-item"]')
    .forEach(bindOtherLocation);
  app.querySelectorAll('form[data-action]').forEach((form) => form.addEventListener('submit', onActionForm));
  app.querySelectorAll('[data-action="logout"]').forEach((button) => button.addEventListener('click', logout));
  app.querySelectorAll('[data-action="read-all"]').forEach((button) => button.addEventListener('click', readAll));
  app.querySelectorAll('[data-action="google-signin"]').forEach((link) => link.addEventListener('click', startGoogleSignIn));
  app.querySelectorAll('[data-action="integration-toggle"]').forEach((button) => button.addEventListener('click', toggleIntegration));
  app.querySelectorAll('[data-action="save-integration"]').forEach((button) => button.addEventListener('click', saveIntegrationSettings));
  app.querySelectorAll('[data-action="integration-verify"], [data-action="smtp-test"], [data-action="calendar-test"]').forEach((button) => button.addEventListener('click', verifyIntegrationCard));
  app.querySelectorAll('[data-action="cancel-integration"]').forEach((button) => button.addEventListener('click', cancelIntegrationChanges));
  app.querySelectorAll('[data-action="set-integration-default"]').forEach((button) => button.addEventListener('click', setIntegrationDefault));
  app.querySelectorAll('[data-action="restore-integration-default"]').forEach((button) => button.addEventListener('click', restoreIntegrationDefault));
  app.querySelectorAll('[data-action="admin-mfa-enrollment-start"]').forEach((button) => button.addEventListener('click', startAdminMfaEnrollment));
  app.querySelectorAll('[data-action="resend-integration-code"]').forEach((button) => button.addEventListener('click', resendIntegrationCode));
  app.querySelectorAll('[data-action="cancel-integration-code"]').forEach((button) => button.addEventListener('click', cancelIntegrationCode));
  app.querySelector('[data-action="send-verification-test-email"]')?.addEventListener('click', sendVerificationTestEmail);
  app.querySelector('[data-action="resend-role-change-code"]')?.addEventListener('click', resendAdminRoleChangeCode);
  app.querySelector('[data-action="close-role-change-code"]')?.addEventListener('click', closeAdminRoleChangeCodeDialog);
  app.querySelector('[data-role-change-code-dialog]')?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeAdminRoleChangeCodeDialog();
  });
  app.querySelectorAll('[data-integration-code-dialog]').forEach((dialog) => {
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      void cancelIntegrationCode({ currentTarget: dialog });
    });
  });
  const integrationForm = app.querySelector('form[data-form="integration-settings"]');
  if (integrationForm) bindIntegrationSettings(integrationForm);
  app.querySelectorAll('form[data-form="integration-pin"]').forEach(bindIntegrationPinForm);
  app.querySelectorAll('[data-action="print-inventory"]').forEach((button) => button.addEventListener('click', () => window.print()));
  app.querySelectorAll('form[data-form="admin-role-permissions"]').forEach(bindRolePermissionCheckboxes);
  app.querySelector('[data-action="cancel-role-permissions"]')?.addEventListener('click', cancelRolePermissionChanges);
  app.querySelector('[data-action="role-permission-role"]')?.addEventListener('change', changeRolePermissionRole);
  const accountEditForm = app.querySelector('form[data-form="admin-edit-user"]');
  if (accountEditForm) bindAccountPermissionForm(accountEditForm);
  const accountCreateForm = app.querySelector('form[data-form="admin-add-user"]');
  if (accountCreateForm) bindAccountPermissionForm(accountCreateForm);
  app.querySelector('[data-action="account-role"]')?.addEventListener('change', changeAccountRole);
  app.querySelector('[data-action="reset-account-permissions"]')?.addEventListener('click', resetAccountPermissions);
  const profileForm = app.querySelector('#profile-form');
  const profileEdit = app.querySelector('[data-action="edit-profile"]');
  const profileCancel = app.querySelector('[data-action="cancel-profile"]');
  const profileActions = profileForm?.querySelector('.form-actions');
  profileEdit?.addEventListener('click', () => {
    profileForm?.querySelectorAll('[data-editable]').forEach((input) => { input.disabled = false; });
    if (profileActions) profileActions.hidden = false;
    profileEdit.hidden = true;
  });
  profileCancel?.addEventListener('click', () => {
    profileForm?.reset();
    profileForm?.querySelectorAll('[data-editable]').forEach((input) => { input.disabled = true; });
    if (profileActions) profileActions.hidden = true;
    if (profileEdit) profileEdit.hidden = false;
  });
  const { button: menuButton, overlay, sidebar } = mobileMenuElements();
  setMobileMenuClosedState(sidebar);
  menuButton?.addEventListener('click', () => {
    if (sidebar?.classList.contains('open')) closeMobileMenu();
    else openMobileMenu();
  });
  overlay?.addEventListener('click', () => closeMobileMenu());
  bindDiscardNavigation();
}

function bindOtherLocation(form) {
  const select = form.elements.namedItem('location');
  const field = form.querySelector('[data-other-location-field]');
  const input = field?.querySelector('[name="location_other"]');
  if (!select || !field || !input) return;
  const update = () => {
    const isOther = select.value === otherLocationValue;
    field.hidden = !isOther;
    input.required = isOther;
    if (!isOther) input.value = '';
  };
  select.addEventListener('change', update);
  update();
}

async function onFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = normalizedFormValues(form);
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    switch (form.dataset.form) {
      case 'integration-settings': return;
      case 'integration-pin': await unlockIntegrationSettings(form); return;
      case 'integration-code': await verifyIntegrationCode(form); return;
      case 'admin-role-change-code': {
        if (!pendingAdminRoleChange?.form?.isConnected) throw new Error('The pending role change is no longer available.');
        const roleChange = adminEditUserRequest(pendingAdminRoleChange.form);
        const code = String(values.code || '').trim();
        await request(`/admin/users/${encodeURIComponent(pendingAdminRoleChange.targetId)}`, jsonPatch({
          ...roleChange.body,
          role_change_code: code,
        }));
        pendingAdminRoleChange = null;
        closeAdminRoleChangeCodeDialog();
        navigate('admin-users');
        return;
      }
      case 'admin-mfa-verify': {
        const result = await request('/auth/mfa/verify', jsonPost(values));
        sessionInfo.pendingAdminMfa = false;
        sessionInfo.user = result.user;
        navigate('admin-dashboard');
        return;
      }
      case 'admin-mfa-enrollment-confirm': {
        const result = await request('/admin/mfa/enrollment/confirm', jsonPost(values));
        sessionInfo.adminMfaSetupRequired = false;
        form.reset();
        showAdminMfaRecoveryCodes(result.recoveryCodes);
        showNotice('Authenticator set up. Save your recovery codes now.');
        return;
      }
      case 'admin-mfa-recovery': {
        const result = await request('/admin/mfa/recovery/regenerate', jsonPost(values));
        form.reset();
        showAdminMfaRecoveryCodes(result.recoveryCodes);
        showNotice('New recovery codes generated. Previous codes no longer work.');
        return;
      }
      case 'login':
      case 'register': {
        if (sessionInfo.recaptcha?.active) {
          const token = getRecaptchaResponse(form.querySelector('.g-recaptcha'));
          if (!token) throw new Error('Complete the reCAPTCHA challenge.');
          values['g-recaptcha-response'] = token;
        }
        const path = form.dataset.form === 'register' ? '/auth/register' : '/auth/login';
        const result = await request(path, jsonPost(values));
        if (result.mfaRequired) {
          sessionInfo.pendingAdminMfa = true;
          sessionInfo.user = null;
          navigate('admin-mfa-verify');
          return;
        }
        sessionInfo.user = result.user;
        sessionInfo.adminMfaSetupRequired = Boolean(result.adminMfaSetupRequired);
        if (result.adminMfaSetupRequired) {
          navigate('admin-security');
          return;
        }
        const destination = result.user.role_name === 'admin' ? 'admin-dashboard'
          : result.user.role_name === 'staff' ? 'staff-dashboard' : 'dashboard';
        navigate(destination);
        return;
      }
      case 'forgot': await request('/auth/forgot-password', jsonPost(values)); showNotice('If an active account uses that email, reset instructions have been sent.'); return;
      case 'reset':
        values.token = param('token');
        await request('/auth/reset-password', jsonPost(values));
        navigate('login');
        return;
      case 'report': {
        const data = normalizedFormData(form);
        data.set('item_type', form.dataset.type);
        await request('/items', { method: 'POST', body: data });
        navigate('reports');
        return;
      }
      case 'edit-report': {
        const data = normalizedFormData(form);
        await request(`/items/${encodeURIComponent(form.dataset.id)}`, { method: 'PUT', body: data });
        navigate('reports');
        return;
      }
      case 'claim': await request('/claims', jsonPost(values)); navigate('claims'); return;
      case 'approve-claim':
        await request(`/staff/claims/${encodeURIComponent(form.dataset.id)}`, jsonPatch({
          action: 'review',
          decision: 'approved',
          ...values,
        }));
        break;
      case 'reschedule-pickup':
        await request(`/staff/claims/${encodeURIComponent(form.dataset.id)}/pickup`, jsonPatch(values));
        break;
      case 'profile': await request('/profile', jsonPatch(values)); break;
      case 'staff-status': await request(`/staff/items/${encodeURIComponent(form.dataset.id)}/status`, jsonPatch(values)); break;
      case 'admin-add-user': {
        const formData = new FormData(form);
        const permissions = formData.getAll('permissions');
        const valuesToSave = Object.fromEntries([...formData.entries()].filter(([key]) => key !== 'permissions'));
        if (form.dataset.managePermissions === 'true') valuesToSave.permissions = permissions;
        await request('/admin/users', jsonPost(valuesToSave));
        navigate('admin-users');
        return;
      }
      case 'admin-edit-user': {
        const roleChange = adminEditUserRequest(form);
        const { role, changedRole, adminRoleChange, permissions } = roleChange;
        if (!changedRole && sessionInfo.rolePermissions.includes('manage_permissions')) {
          const currentPanel = form.querySelector(`[data-role-panel="${role}"]`);
          const saved = new Set(JSON.parse(currentPanel?.querySelector('[data-saved-permissions]')?.dataset.savedPermissions || '[]'));
          const removed = [...saved].filter((permission) => !permissions.includes(permission));
          if (removed.length) {
            const labels = removed.map((permission) => [...currentPanel.querySelectorAll('input[name="permissions"]')]
              .find((input) => input.value === permission)
              ?.closest('label')?.querySelector('strong')?.textContent || permission);
            if (!confirm(`Remove ${labels.join(', ')} from ${form.dataset.fullName}?`)) {
              if (submit && !isRateLimited(submit)) submit.disabled = false;
              return;
            }
          }
        }
        const confirmation = role === 'admin' && form.dataset.currentRole !== 'admin'
          ? `Make ${form.dataset.fullName} an Admin? Admins can manage users, permissions, items, and system settings. Their individual permission changes for the old role will be reset.`
          : `Change ${form.dataset.fullName} from ${accountRoleName(form.dataset.currentRole)} to ${accountRoleName(role)}? Their individual permission changes for the old role will be reset, and the ${accountRoleName(role)} role's settings apply.`;
        if (changedRole && !confirm(confirmation)) {
          if (submit) submit.disabled = false;
          return;
        }
        if (pendingAdminRoleChange?.targetId === form.dataset.id && !adminRoleChange) {
          pendingAdminRoleChange = null;
          closeAdminRoleChangeCodeDialog();
        }
        if (pendingAdminRoleChange?.targetId === form.dataset.id && adminRoleChange) {
          pendingAdminRoleChange.form = form;
          if (submit) submit.disabled = false;
          openAdminRoleChangeCodeDialog();
          return;
        }
        if (changedRole || sessionInfo.rolePermissions.includes('edit_user')) {
          const result = await request(`/admin/users/${encodeURIComponent(form.dataset.id)}`, jsonPatch(roleChange.body));
          if (result.verificationRequired) {
            pendingAdminRoleChange = {
              targetId: form.dataset.id,
              form,
              resendAt: Date.now() + (Number(result.resendInSeconds) || 60) * 1000,
            };
            if (submit) submit.disabled = false;
            openAdminRoleChangeCodeDialog();
            return;
          }
        } else {
          await request(`/admin/users/${encodeURIComponent(form.dataset.id)}/permissions`, {
            method: 'PUT',
            body: JSON.stringify({ permissions }),
          });
        }
        form.dataset.savedAccountForm = accountFormSnapshot(form);
        navigate('admin-users');
        return;
      }
      case 'admin-role-permissions': {
        const formData = new FormData(form);
        const permissions = formData.getAll('permissions');
        const saved = new Set(JSON.parse(form.dataset.savedPermissions || '[]'));
        const disabled = [...saved].filter((permission) => !permissions.includes(permission));
        if (disabled.length) {
          const labels = [...form.querySelectorAll('input[name="permissions"]')]
            .filter((input) => disabled.includes(input.value))
            .map((input) => input.closest('label').querySelector('strong').textContent);
          const roleName = accountRoleName(form.dataset.role);
          const affected = Number(form.dataset.activeAccounts || 0);
          if (!confirm(`This will disable ${labels.join(', ')} for all ${affected} active ${roleName} accounts. Continue?`)) {
            if (submit) submit.disabled = false;
            return;
          }
        }
        await request(`/admin/role-permissions/${encodeURIComponent(form.dataset.role)}`, {
          method: 'PUT',
          body: JSON.stringify({ permissions }),
        });
        await render();
        showNotice('Role permissions saved.');
        return;
      }
      case 'admin-edit-item': await request(`/admin/items/${encodeURIComponent(form.dataset.id)}`, jsonPatch(values)); navigate('admin-items'); return;
      default: throw new Error('Unknown form action.');
    }
    await render();
  } catch (error) {
    if (form.dataset.form === 'admin-mfa-verify' && error.status === 401
      && /this sign-in attempt (?:expired|is no longer valid)/i.test(error.message)) {
      navigate('login');
      return;
    }
    if (form.dataset.form === 'admin-role-change-code') {
      const errorElement = form.querySelector('[data-role-change-code-error]');
      if (errorElement) errorElement.textContent = error.message;
      form.querySelector('[name="code"]').value = '';
      if (error.message.includes('pending settings changed')) {
        pendingAdminRoleChange = null;
        closeAdminRoleChangeCodeDialog();
        showNotice(error.message, true);
      }
      if (submit && !isRateLimited(submit)) submit.disabled = false;
      return;
    }
    showNotice(error.message, true);
    if (sessionInfo.recaptcha?.active && ['login', 'register'].includes(form.dataset.form)) {
      const widget = form.querySelector('.g-recaptcha');
      if (widget) {
        window.grecaptcha.reset(Number(widget.dataset.widgetId));
        delete widget.dataset.responseToken;
      }
    }
    if (submit && !isRateLimited(submit)) submit.disabled = false;
  }
}

async function mountRecaptchaWidgets() {
  const widgets = app.querySelectorAll('.g-recaptcha');
  if (!widgets.length) return;
  await loadRecaptchaApi();
  widgets.forEach((widget) => {
    const widgetId = window.grecaptcha.render(widget, {
      sitekey: widget.dataset.sitekey,
      size: window.matchMedia('(max-width: 640px)').matches ? 'compact' : 'normal',
      callback: (token) => { widget.dataset.responseToken = token; },
      'expired-callback': () => { delete widget.dataset.responseToken; },
      'error-callback': () => { delete widget.dataset.responseToken; },
    });
    widget.dataset.widgetId = String(widgetId);
  });
  app.querySelectorAll('form[data-form="login"] button[type="submit"], form[data-form="register"] button[type="submit"]')
    .forEach((button) => { button.disabled = false; });
}

function normalizedFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  if (values.location === otherLocationValue) {
    values.location = String(values.location_other || '').trim();
  }
  delete values.location_other;
  return values;
}

function normalizedFormData(form) {
  const data = new FormData(form);
  const values = normalizedFormValues(form);
  if (data.has('location')) data.set('location', values.location);
  data.delete('location_other');
  return data;
}

function loadRecaptchaApi() {
  if (window.grecaptcha) {
    return new Promise((resolve) => window.grecaptcha.ready(resolve));
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => window.grecaptcha.ready(resolve);
    script.onerror = () => reject(new Error('Unable to load reCAPTCHA. Please reload and try again.'));
    document.head.append(script);
  });
}

async function startGoogleSignIn(event) {
  event.preventDefault();
  const link = event.currentTarget;
  if (link.getAttribute('aria-disabled') === 'true') return;
  link.setAttribute('aria-disabled', 'true');
  link.classList.add('disabled');
  const widget = app.querySelector('.g-recaptcha');
  const token = sessionInfo.recaptcha?.active ? getRecaptchaResponse(widget) : '';
  if (sessionInfo.recaptcha?.active && !token) {
    showNotice('Complete the reCAPTCHA challenge before continuing with Google.', true);
    link.removeAttribute('aria-disabled');
    link.classList.remove('disabled');
    return;
  }
  try {
    const body = token ? { 'g-recaptcha-response': token } : {};
    const result = await request('/auth/google', {
      ...jsonPost(body),
      anchor: link,
    });
    window.location.assign(result.url);
  } catch (error) {
    showNotice(error.message, true);
    if (widget) {
      window.grecaptcha.reset(Number(widget.dataset.widgetId));
      delete widget.dataset.responseToken;
    }
    if (!isRateLimited(link)) {
      link.removeAttribute('aria-disabled');
      link.classList.remove('disabled');
    }
  }
}

function getRecaptchaResponse(widget) {
  if (!widget) return '';
  return widget.dataset.responseToken || window.grecaptcha.getResponse(Number(widget.dataset.widgetId));
}

async function onActionForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.id;
  const values = JSON.parse(form.dataset.values || '{}');
  try {
    switch (form.dataset.action) {
      case 'cancel-report':
        if (!confirm('Cancel this report?')) return;
        await request(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
        break;
      case 'resolve-report':
        if (!confirm('Mark this lost report as resolved? Do this only after you have recovered the item.')) return;
        await request(`/items/${encodeURIComponent(id)}/resolve`, jsonPost({}));
        break;
      case 'read-notice': await request(`/notifications/${encodeURIComponent(id)}/read`, jsonPatch({})); break;
      case 'verify-item': await request(`/staff/items/${encodeURIComponent(id)}/verify`, { method: 'POST' }); break;
      case 'review-claim': await request(`/staff/claims/${encodeURIComponent(id)}`, jsonPatch({ action: 'review', ...values })); break;
      case 'mark-returned': await request(`/staff/claims/${encodeURIComponent(id)}`, jsonPatch({ action: 'returned' })); break;
      case 'retry-calendar-sync': await request(`/staff/claims/${encodeURIComponent(id)}/calendar-sync`, jsonPost({})); break;
      case 'admin-user': await request(`/admin/users/${encodeURIComponent(id)}`, jsonPatch(values)); break;
      case 'admin-item-remove':
        if (!confirm('Remove this item record? It will be soft-deleted and retained for audit.')) return;
        await request(`/admin/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
        break;
      default: throw new Error('Unknown action.');
    }
    await render();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function jsonPost(body) { return { method: 'POST', body: JSON.stringify(body) }; }
function jsonPatch(body) { return { method: 'PATCH', body: JSON.stringify(body) }; }
function navigate(page) { location.href = `/?page=${encodeURIComponent(page)}`; }

function adminEditUserRequest(form) {
  const formData = new FormData(form);
  const permissions = formData.getAll('permissions');
  const role = String(formData.get('role_name') || form.dataset.currentRole);
  const changedRole = role !== form.dataset.currentRole;
  const adminRoleChange = changedRole
    && (role === 'admin' || form.dataset.currentRole === 'admin');
  const values = Object.fromEntries([...formData.entries()].filter(([key]) => key !== 'permissions'));
  const body = {
    ...values,
    action: 'edit',
    role_change: changedRole,
    admin_role_change: adminRoleChange,
  };
  if (changedRole || sessionInfo.rolePermissions.includes('manage_permissions')) body.permissions = permissions;
  return { body, permissions, role, changedRole, adminRoleChange };
}

function openAdminRoleChangeCodeDialog() {
  const dialog = app.querySelector('[data-role-change-code-dialog]');
  if (!dialog) return;
  const codeForm = dialog.querySelector('form');
  codeForm.reset();
  codeForm.querySelector('[data-role-change-code-error]').textContent = '';
  if (!dialog.open) dialog.showModal();
  startAdminRoleChangeCodeResendTimer();
  codeForm.querySelector('[name="code"]').focus();
}

function closeAdminRoleChangeCodeDialog() {
  clearInterval(roleChangeCodeResendTimer);
  app.querySelector('[data-role-change-code-dialog]')?.close();
}

function startAdminRoleChangeCodeResendTimer() {
  const button = app.querySelector('[data-action="resend-role-change-code"]');
  if (!button || !pendingAdminRoleChange) return;
  clearInterval(roleChangeCodeResendTimer);
  const update = () => {
    const remaining = Math.max(0, Math.ceil((pendingAdminRoleChange.resendAt - Date.now()) / 1000));
    button.disabled = remaining > 0;
    button.textContent = remaining ? `Resend (${remaining}s)` : 'Resend';
    if (!remaining) clearInterval(roleChangeCodeResendTimer);
  };
  update();
  roleChangeCodeResendTimer = setInterval(update, 1000);
}

async function resendAdminRoleChangeCode(event) {
  const button = event.currentTarget;
  const pending = pendingAdminRoleChange;
  if (!pending?.form?.isConnected) return;
  button.disabled = true;
  try {
    const roleChange = adminEditUserRequest(pending.form);
    const result = await request(`/admin/users/${encodeURIComponent(pending.targetId)}`, jsonPatch({
      ...roleChange.body,
      role_change_resend: true,
    }));
    pending.resendAt = Date.now() + (Number(result.resendInSeconds) || 60) * 1000;
    startAdminRoleChangeCodeResendTimer();
    showNotice('A new verification code was sent to SU_EMAIL.');
  } catch (error) {
    if (!isRateLimited(button)) button.disabled = false;
    const errorElement = app.querySelector('[data-role-change-code-error]');
    if (errorElement) errorElement.textContent = error.message;
  }
}

async function logout() {
  if (!confirm('Are you sure you want to sign out?')) return;
  try { await request('/auth/logout', { method: 'POST' }); }
  catch (error) { showNotice(error.message, true); return; }
  location.href = '/';
}
async function readAll() {
  try { await request('/notifications/read-all', jsonPatch({})); await render(); }
  catch (error) { showNotice(error.message, true); }
}
function bindIntegrationSettings(form) {
  for (const card of form.querySelectorAll('[data-integration]')) {
    card.dataset.savedState = JSON.stringify(integrationCardPayload(card));
  }
  form.addEventListener('input', handleIntegrationEdit);
  form.addEventListener('change', handleIntegrationEdit);
  const settingsPage = form.closest('.admin-settings');
  window.addEventListener('pagehide', () => {
    fetch(`${API}/admin/settings/lock`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'X-CSRF-Token': settingsPage.dataset.csrfToken },
    }).catch(() => console.warn('Integration Settings could not be locked during navigation.'));
  }, { once: true });
}

function bindIntegrationPinForm(form) {
  const dialog = form.closest('dialog');
  if (!dialog.open) dialog.showModal();
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  form.addEventListener('input', () => {
    form.querySelector('[data-integration-pin-error]').textContent = '';
  });
}

function handleIntegrationEdit(event) {
  const form = event.currentTarget;
  const card = event.target.closest('[data-integration]');
  if (card && !event.target.matches('[data-verification-code]')) {
    recaptchaChallengeCancels.get(card)?.();
    card.dataset.verifiedPayload = '';
    card.dataset.currentVerification = 'false';
    const message = card.querySelector('[data-integration-validation]');
    if (message) {
      const enabled = card.querySelector('[data-action="integration-toggle"]').dataset.enabled === 'true';
      const saved = JSON.parse(card.dataset.savedState);
      const fieldsChanged = JSON.stringify(integrationCardPayload(card).fields) !== JSON.stringify(saved.fields);
      const needsVerification = enabled || fieldsChanged;
      if (card.dataset.integration === 'recaptcha' && needsVerification) {
        message.textContent = 'Save changes to verify the candidate keys and complete a challenge.';
      } else if (card.dataset.integration === 'google_auth' && needsVerification) {
        message.textContent = 'Save changes to verify by signing in with Google.';
      } else if (card.dataset.integration === 'admin_mfa' && needsVerification) {
        message.textContent = 'Enter your current authenticator code, then click Save Changes to verify.';
      } else if (needsVerification) {
        message.textContent = 'Settings will be verified when saved.';
      } else {
        message.textContent = 'Disabling does not require verification.';
      }
    }
  }
  if (pendingIntegrationCard && card === pendingIntegrationCard) {
    pendingIntegrationCard = null;
    closeIntegrationCodeDialog();
    request('/admin/settings/code/cancel', {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({}),
    }).catch((error) => showNotice(error.message, true));
    showNotice('Settings changed. Save again to request a new verification code.');
  }
  updateIntegrationSaveState(form);
}

function integrationCardPayload(card) {
  const enabled = card.querySelector('[data-action="integration-toggle"]').dataset.enabled === 'true';
  const fields = Object.fromEntries([...card.querySelectorAll('.integration-fields [name]')].map((input) => [
      input.name,
      input.type === 'checkbox' ? input.checked : input.value,
  ]));
  return { enabled, fields };
}

function updateIntegrationSaveState(form) {
  for (const card of form.querySelectorAll('[data-integration]')) {
    const payload = integrationCardPayload(card);
    const payloadText = JSON.stringify(payload);
    const changed = payloadText !== card.dataset.savedState;
    const save = card.querySelector('[data-action="save-integration"]');
    const verify = card.querySelector('[data-action="integration-verify"]');
    if (save) {
      save.disabled = card.dataset.saveInProgress === 'true'
        || isRateLimited(save)
        || isRateLimited(verify);
    }
    card.querySelector('.integration-card-actions').hidden = !changed;
    const setDefault = card.querySelector('[data-action="set-integration-default"]');
    if (setDefault) {
      setDefault.disabled = changed || card.dataset.active !== 'true'
        || card.dataset.usingDefault === 'true'
        || card.dataset.currentVerification !== 'true';
    }
    card.querySelector('[data-action="integration-verify"]')?.removeAttribute('disabled');
    updateIntegrationCardStatus(card);
  }
}

function updateIntegrationCardStatus(card) {
  const status = card.querySelector('[data-integration-status]');
  const missing = [];
  for (const input of card.querySelectorAll('.integration-fields [name]')) {
    if (input.dataset.required === 'true' && !String(input.value).trim() && !input.placeholder) {
      missing.push(input.labels?.[0]?.textContent.trim() || input.name);
    }
  }
  const user = card.querySelector('[name="user"]')?.value || '';
  const password = card.querySelector('[name="password"]');
  if (password && Boolean(user) !== Boolean(password.value || password.placeholder)) {
    missing.push('SMTP username/password pair');
  }
  const enabled = card.querySelector('[data-action="integration-toggle"]').dataset.enabled === 'true';
  const label = card.dataset.failing === 'true'
    ? 'Failing' : missing.length ? 'Not configured' : enabled ? 'Enabled' : 'Disabled';
  status.textContent = label;
  status.className = `badge ${label === 'Failing' ? 'badge-failing'
    : label === 'Enabled' ? 'badge-active' : label === 'Disabled' ? 'badge-cancelled' : 'badge-pending'}`;
  card.querySelector('[data-integration-missing]').textContent = missing.length ? `Missing: ${missing.join(', ')}` : '';
}

function updateIntegrationHealth(card, integration) {
  const health = integration.health || {};
  const failing = integration.status === 'Failing';
  card.dataset.failing = String(failing);
  const status = card.querySelector('[data-integration-status]');
  status.textContent = failing ? 'Failing' : integration.status;
  status.className = `badge ${failing ? 'badge-failing'
    : integration.active ? 'badge-active'
      : integration.configured ? 'badge-cancelled' : 'badge-pending'}`;

  const healthElement = card.querySelector('[data-integration-health]');
  healthElement.hidden = !failing;
  if (failing) {
    const time = health.last_error_at ? new Date(health.last_error_at).toLocaleString() : '';
    const count = health.consecutive_failures ? ` (${health.consecutive_failures} consecutive)` : '';
    healthElement.textContent = `${time ? `Last failure: ${time} · ` : ''}${health.last_error_message || ''}${count}`;
  } else {
    healthElement.textContent = '';
  }
}

function settingsCsrf(form) {
  return form.closest('.admin-settings')?.dataset.csrfToken || form.dataset.csrfToken;
}

async function unlockIntegrationSettings(form) {
  const submit = form.querySelector('[type="submit"]');
  const pin = form.querySelector('[name="pin"]');
  const error = form.querySelector('[data-integration-pin-error]');
  submit.disabled = true;
  error.textContent = '';
  try {
    await request('/admin/settings/unlock', {
      method: 'POST',
      headers: { 'X-CSRF-Token': settingsCsrf(form) },
      body: JSON.stringify({ pin: pin.value }),
    });
    pin.value = '';
    await render();
  } catch (requestError) {
    error.textContent = requestError.message;
    pin.value = '';
  } finally {
    if (!isRateLimited(submit)) submit.disabled = false;
  }
}

function openIntegrationCodeDialog(form, resendInSeconds, status = {}) {
  const dialog = form.closest('.admin-settings').querySelector('[data-integration-code-dialog]');
  const codeForm = dialog.querySelector('form');
  codeForm.reset();
  codeForm.querySelector('[data-integration-code-error]').textContent = '';
  codeForm.querySelector('[data-integration-code-recipient]').textContent = status.maskedRecipient
    ? `Code sent to ${status.maskedRecipient}.`
    : 'Enter the 6-digit verification code.';
  codeForm.querySelector('[data-integration-code-expiry]').textContent = status.expiresAt
    ? `Expires at ${new Date(status.expiresAt).toLocaleTimeString()}.`
    : '';
  if (!dialog.open) dialog.showModal();
  startIntegrationCodeResendTimer(dialog, resendInSeconds);
}

function restorePendingIntegrationCodeDialog() {
  const settings = app.querySelector('.admin-settings[data-pending-code]');
  if (!settings) return;
  const pending = JSON.parse(settings.dataset.pendingCode || 'null');
  if (!pending) return;
  const integrationId = pending.restoreDefault || pending.integrationIds?.[0];
  const card = settings.querySelector(`[data-integration="${CSS.escape(integrationId || '')}"]`);
  const form = settings.querySelector('form[data-form="integration-settings"]');
  if (!card || !form) return;
  pendingIntegrationCard = card;
  pendingIntegrationRestore = pending.restoreDefault || null;
  const resendInSeconds = Math.max(
    0,
    Math.ceil((Date.parse(pending.resendAvailableAt) - Date.now()) / 1000),
  );
  openIntegrationCodeDialog(form, resendInSeconds, pending);
}

function updateIntegrationCodeDialog(dialog, status) {
  const codeForm = dialog.querySelector('form');
  codeForm.querySelector('[name="code"]').value = '';
  if (status.maskedRecipient) {
    codeForm.querySelector('[data-integration-code-recipient]').textContent =
      `Code sent to ${status.maskedRecipient}.`;
  }
  if (status.expiresAt) {
    codeForm.querySelector('[data-integration-code-expiry]').textContent =
      `Expires at ${new Date(status.expiresAt).toLocaleTimeString()}.`;
  }
}

function startIntegrationCodeResendTimer(dialog, seconds) {
  const button = dialog.querySelector('[data-action="resend-integration-code"]');
  clearInterval(integrationCodeResendTimer);
  let remaining = Math.max(0, Number(seconds) || 0);
  const update = () => {
    button.disabled = remaining > 0;
    button.textContent = remaining ? `Resend (${remaining}s)` : 'Resend';
    remaining -= 1;
    if (remaining < 0) clearInterval(integrationCodeResendTimer);
  };
  update();
  integrationCodeResendTimer = setInterval(update, 1000);
}

function closeIntegrationCodeDialog() {
  clearInterval(integrationCodeResendTimer);
  app.querySelector('[data-integration-code-dialog]')?.close();
}

function showIntegrationRateLimit(error, button) {
  if (error.status !== 429) return false;
  if (!isRateLimited(button)) showFormError(error, { anchor: button });
  return true;
}

async function verifyIntegrationCode(form) {
  const card = pendingIntegrationCard;
  const dialog = form.closest('dialog');
  const submit = form.querySelector('[type="submit"]');
  const error = form.querySelector('[data-integration-code-error]');
  if (!card) {
    dialog.close();
    return;
  }
  submit.disabled = true;
  error.textContent = '';
  try {
    if (pendingIntegrationRestore) {
      const integrationId = pendingIntegrationRestore;
      const result = await request('/admin/settings/code/verify', {
        method: 'POST',
        headers: { 'X-CSRF-Token': settingsCsrf(card.closest('form')) },
        body: JSON.stringify({
          code: form.querySelector('[name="code"]').value,
          restoreDefault: integrationId,
        }),
      });
      pendingIntegrationCard = null;
      pendingIntegrationRestore = null;
      closeIntegrationCodeDialog();
      applySavedIntegration(card, result.integrations[integrationId]);
      await refreshAdminMfaGate();
      showNotice(result.warning
        ? `Default restored. ${result.warning}`
        : result.noticeSent
          ? 'Default restored and SU_EMAIL notified.'
          : `${result.integrations[integrationId].label} default settings restored.`);
      return;
    }
    const result = await request('/admin/settings/code/verify', {
      method: 'POST',
      headers: { 'X-CSRF-Token': settingsCsrf(card.closest('form')) },
      body: JSON.stringify({
        code: form.querySelector('[name="code"]').value,
        integrations: { [card.dataset.integration]: integrationCardPayload(card) },
      }),
    });
    pendingIntegrationCard = null;
    closeIntegrationCodeDialog();
    applySavedIntegration(card, result.integrations[card.dataset.integration]);
    if (card.dataset.integration === 'admin_mfa') await refreshAdminMfaGate();
    showNotice(`${result.integrations[card.dataset.integration].label} settings saved.`);
  } catch (requestError) {
    error.textContent = requestError.message;
    form.querySelector('[name="code"]').value = '';
    if (requestError.message.includes('pending settings changed')
      || requestError.message.includes('Verify this integration again')) {
      card.dataset.verifiedPayload = '';
      card.dataset.currentVerification = 'false';
      updateIntegrationSaveState(card.closest('form'));
      pendingIntegrationCard = null;
      pendingIntegrationRestore = null;
      closeIntegrationCodeDialog();
    }
  } finally {
    if (!isRateLimited(submit)) submit.disabled = false;
  }
}

async function resendIntegrationCode(event) {
  const button = event.currentTarget;
  const dialog = button.closest('dialog');
  const card = pendingIntegrationCard;
  if (!card) return;
  button.disabled = true;
  try {
    if (pendingIntegrationRestore) {
      const result = await request('/admin/settings/code/resend', {
        method: 'POST',
        headers: { 'X-CSRF-Token': settingsCsrf(card.closest('form')) },
        body: JSON.stringify({ restoreDefault: pendingIntegrationRestore }),
      });
      updateIntegrationCodeDialog(dialog, result);
      startIntegrationCodeResendTimer(dialog, result.resendInSeconds);
      showNotice('A new verification code was sent.');
      return;
    }
    const result = await request('/admin/settings/code/resend', {
      method: 'POST',
      headers: { 'X-CSRF-Token': settingsCsrf(card.closest('form')) },
      body: JSON.stringify({ integrations: { [card.dataset.integration]: integrationCardPayload(card) } }),
    });
    updateIntegrationCodeDialog(dialog, result);
    startIntegrationCodeResendTimer(dialog, result.resendInSeconds);
    showNotice('A new verification code was sent.');
  } catch (error) {
    if (error.message.includes('Verify this integration again')) {
      card.dataset.verifiedPayload = '';
      card.dataset.currentVerification = 'false';
      pendingIntegrationCard = null;
      pendingIntegrationRestore = null;
      closeIntegrationCodeDialog();
      updateIntegrationSaveState(card.closest('form'));
    }
    showNotice(error.message, true);
    if (!isRateLimited(button)) button.disabled = false;
  }
}

async function sendVerificationTestEmail(event) {
  const button = event.currentTarget;
  const settings = button.closest('.admin-settings');
  const resultElement = settings.querySelector('[data-test-email-result]');
  button.disabled = true;
  resultElement.textContent = '';
  resultElement.classList.remove('alert-error', 'alert-success');
  try {
    const result = await request('/admin/settings/verification-email/test', {
      method: 'POST',
      headers: { 'X-CSRF-Token': settings.dataset.csrfToken },
      body: JSON.stringify({}),
    });
    resultElement.textContent = `Test email sent to ${result.maskedRecipient}.`;
    resultElement.classList.add('alert-success');
  } catch (error) {
    const recipient = settings.dataset.verificationRecipient || 'the verification address';
    resultElement.textContent = `Test email to ${recipient} failed: ${error.message}`;
    resultElement.classList.add('alert-error');
  } finally {
    if (!isRateLimited(button)) button.disabled = false;
  }
}

async function cancelIntegrationCode(event) {
  const dialog = event.currentTarget.closest('dialog');
  const card = pendingIntegrationCard;
  if (card) {
    try {
      await request('/admin/settings/code/cancel', {
        method: 'POST',
        headers: { 'X-CSRF-Token': settingsCsrf(card.closest('form')) },
        body: JSON.stringify({}),
      });
    } catch (error) {
      showNotice(error.message, true);
      return;
    }
  }
  pendingIntegrationCard = null;
  pendingIntegrationRestore = null;
  dialog.close();
  clearInterval(integrationCodeResendTimer);
}

async function setIntegrationDefault(event) {
  const button = event.currentTarget;
  const card = button.closest('[data-integration]');
  const form = card.closest('form');
  const name = card.querySelector('h2').textContent;
  if (!confirm(`Set the current saved ${name} configuration as the default?`)) return;
  button.disabled = true;
  try {
    const result = await request(`/admin/settings/${encodeURIComponent(card.dataset.integration)}/default`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': settingsCsrf(form) },
      body: JSON.stringify({}),
    });
    applySavedIntegration(card, result.integrations[card.dataset.integration]);
    showNotice(`${name} default settings updated.`);
  } catch (error) {
    if (!showIntegrationRateLimit(error, button)) showNotice(error.message, true);
  } finally {
    if (!button.dataset.rateLimitUntil) updateIntegrationSaveState(form);
  }
}

async function restoreIntegrationDefault(event) {
  const button = event.currentTarget;
  const card = button.closest('[data-integration]');
  const form = card.closest('form');
  const name = card.querySelector('h2').textContent;
  const dirty = JSON.stringify(integrationCardPayload(card)) !== card.dataset.savedState;
  const prompt = dirty
    ? `Discard unsaved ${name} edits and restore default settings?`
    : `Restore default settings for ${name}?`;
  if (!confirm(prompt)) return;
  button.disabled = true;
  try {
    const result = await request(`/admin/settings/${encodeURIComponent(card.dataset.integration)}/restore-default`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': settingsCsrf(form) },
      body: JSON.stringify({}),
    });
    if (result.verificationRequired) {
      pendingIntegrationCard = card;
      pendingIntegrationRestore = result.restoreDefault;
      openIntegrationCodeDialog(form, result.resendInSeconds, result);
      showNotice('A verification code was sent to approve the security-settings change.');
      return;
    }
    applySavedIntegration(card, result.integrations[card.dataset.integration]);
    if (card.dataset.integration === 'admin_mfa') await refreshAdminMfaGate();
    if (result.warning) showNotice(`Default restored. ${result.warning}`, true);
    else showNotice(result.noticeSent ? 'Default restored and SU_EMAIL notified.' : 'Default settings are already active.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (!button.dataset.rateLimitUntil) button.disabled = false;
  }
}

function toggleIntegration(event) {
  const button = event.currentTarget;
  const wasEnabled = button.dataset.enabled === 'true';
  const card = button.closest('[data-integration]');
  const integrationId = card.dataset.integration;
  if (wasEnabled && ['google_auth', 'recaptcha'].includes(integrationId)) {
    const name = integrationId === 'google_auth' ? 'Google sign-in' : 'reCAPTCHA';
    const impact = integrationId === 'google_auth'
      ? 'Users will not be able to sign in with Google. Admins can still use email and password.'
      : 'Sign-in and registration will no longer require a reCAPTCHA challenge.';
    if (!confirm(`Disable ${name}? ${impact}`)) return;
  }
  if (wasEnabled && integrationId === 'admin_mfa'
    && !confirm('Disable administrator MFA? This removes the second sign-in step for all administrators.')) return;
  button.dataset.enabled = String(!wasEnabled);
  button.textContent = wasEnabled ? 'Enable' : 'Disable';
  card.dataset.verifiedPayload = '';
  card.dataset.currentVerification = 'false';
  let validationMessage = 'Changed settings need verification before saving.';
  if (wasEnabled) validationMessage = 'Disabling does not require verification.';
  else if (integrationId === 'recaptcha') {
    validationMessage = 'Save changes to verify the candidate keys and complete a challenge.';
  } else if (integrationId === 'google_auth') {
    validationMessage = 'Save changes to verify by signing in with Google.';
  } else if (integrationId === 'admin_mfa') {
    validationMessage = 'Enter your current authenticator code, then click Save Changes to verify.';
  }
  card.querySelector('[data-integration-validation]').textContent = validationMessage;
  updateIntegrationSaveState(button.closest('form'));
}

function waitForGoogleOAuthPopup(popup) {
  let resolveResult;
  let timeoutId;
  let closeCheckId;
  let settled = false;
  const promise = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const waiter = {
    popup,
    finish(status) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(closeCheckId);
      if (pendingGoogleSavePopup === waiter) pendingGoogleSavePopup = null;
      resolveResult(status);
    },
  };
  pendingGoogleSavePopup = waiter;
  timeoutId = setTimeout(() => waiter.finish('expired'), 10 * 60 * 1000);
  closeCheckId = setInterval(() => {
    if (popup.closed) waiter.finish('closed');
  }, 500);
  return {
    promise,
    cancel: () => waiter.finish('cancelled'),
  };
}

async function saveIntegrationSettings(event) {
  const button = event.currentTarget;
  const card = button.closest('[data-integration]');
  const form = button.closest('form');
  const integrationId = card.dataset.integration;
  const candidate = integrationCardPayload(card);
  const payload = { [integrationId]: candidate };
  let googlePopup = null;
  let googlePopupWaiter = null;
  card.dataset.saveInProgress = 'true';
  clearIntegrationErrors(card);
  button.disabled = true;
  card.querySelector('[data-action="cancel-integration"]').disabled = true;
  card.querySelector('[data-integration-validation]').textContent = 'Validating...';
  try {
    if (['google_auth', 'recaptcha', 'admin_mfa'].includes(integrationId)) {
      const savedPayload = JSON.parse(card.dataset.savedState);
      const fieldsChanged = JSON.stringify(candidate.fields) !== JSON.stringify(savedPayload.fields);
      const requiresVerification = (candidate.enabled || fieldsChanged)
        && card.dataset.verifiedPayload !== JSON.stringify(candidate);
      if (requiresVerification) {
        if (integrationId === 'google_auth') {
          if (pendingGoogleSavePopup) {
            throw new Error('Finish the current Google sign-in verification before saving another integration.');
          }
          googlePopup = window.open('about:blank', '_blank', 'popup,width=600,height=720');
          if (!googlePopup) {
            throw new Error('Allow popups for this site to verify Google sign-in settings from Save Changes.');
          }
          googlePopupWaiter = waitForGoogleOAuthPopup(googlePopup);
        }
        const verifyButton = card.querySelector('[data-action="integration-verify"]');
        const verificationResult = await verifyIntegrationCard({
          currentTarget: verifyButton,
          autoSave: true,
          popup: googlePopup,
        });
        if (integrationId === 'google_auth' && verificationResult === 'pending') {
          const status = await googlePopupWaiter.promise;
          if (status !== 'success') {
            const messages = {
              access_denied: 'Google sign-in verification was cancelled.',
              redirect_mismatch: 'The Google callback URL does not match the candidate settings.',
              expired: 'Google sign-in verification expired. Save again to retry.',
              closed: 'The Google sign-in window was closed before verification finished.',
              failed: 'Google sign-in verification failed. Check the candidate settings and try again.',
            };
            showNotice(messages[status] || messages.failed, true);
            return;
          }
          card.dataset.verifiedPayload = JSON.stringify(candidate);
          card.dataset.currentVerification = 'true';
          card.dataset.verificationProof = 'real_sign_in';
          card.dataset.verificationLabel = verificationProofLabel('real_sign_in');
          card.querySelector('[data-integration-validation]').textContent =
            'Google sign-in verified. Continuing to save settings...';
        } else {
          googlePopupWaiter?.cancel();
          if (googlePopup && !googlePopup.closed) googlePopup.close();
          if (!verificationResult) return;
        }
        if (JSON.stringify(integrationCardPayload(card)) !== JSON.stringify(candidate)) {
          card.dataset.verifiedPayload = '';
          card.dataset.currentVerification = 'false';
          card.querySelector('[data-integration-validation]').textContent =
            'Settings changed during verification. Save again to verify the current settings.';
          showNotice('Settings changed during verification. Save again to verify the current settings.', true);
          return;
        }
        button.disabled = true;
        card.querySelector('[data-action="cancel-integration"]').disabled = true;
      }
    }
    const result = await request('/admin/settings', {
      method: 'PUT',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({ integrations: payload }),
    });
    if (result.verificationRequired) {
      pendingIntegrationCard = card;
      openIntegrationCodeDialog(form, result.resendInSeconds, result);
      showNotice('A verification code was sent to the configured administrator email.');
      return;
    }
    applySavedIntegration(card, result.integrations[card.dataset.integration]);
    if (card.dataset.integration === 'admin_mfa') await refreshAdminMfaGate();
    const integrationLabel = result.integrations[card.dataset.integration].label;
    if (Array.isArray(result.changed) && !result.changed.includes(integrationId)) {
      showNotice(`${integrationLabel} already matches the saved settings. No changes were made, so no email code was needed.`);
    } else {
      showNotice(`${integrationLabel} settings saved.`);
    }
  } catch (error) {
    if (showIntegrationRateLimit(error, button)) return;
    if (error.message.includes('Verify this integration again')) {
      card.dataset.verifiedPayload = '';
      card.dataset.currentVerification = 'false';
    }
    if (error.fieldErrors) showIntegrationErrors(form, error.fieldErrors);
    if (error.failures) {
      for (const failure of error.failures) {
        const failedCard = form.querySelector(`[data-integration="${CSS.escape(failure.integration)}"]`);
        if (failedCard) failedCard.querySelector('[data-integration-validation]').textContent = failure.reason;
      }
    }
    showNotice(error.message, true);
  } finally {
    card.dataset.saveInProgress = 'false';
    googlePopupWaiter?.cancel();
    if (googlePopup && !googlePopup.closed) googlePopup.close();
    if (!button.dataset.rateLimitUntil) button.disabled = false;
    card.querySelector('[data-action="cancel-integration"]').disabled = false;
    updateIntegrationSaveState(form);
  }
}

function applySavedIntegration(card, integration) {
  for (const field of integration.fields) {
    const input = card.querySelector(`[name="${CSS.escape(field.name)}"]`);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(field.value);
    else if (field.secret) {
      input.value = '';
      input.placeholder = field.hasValue ? field.value : '';
    } else input.value = field.value ?? '';
  }
  const toggle = card.querySelector('[data-action="integration-toggle"]');
  toggle.dataset.enabled = String(integration.enabled);
  toggle.textContent = integration.enabled ? 'Disable' : 'Enable';
  card.dataset.active = String(integration.active);
  card.dataset.usingDefault = String(integration.usingDefault);
  card.dataset.hasDefault = String(integration.hasDefault);
  card.dataset.currentVerification = String(integration.isCurrentVerification);
  card.dataset.verificationProof = integration.verification?.proofType || '';
  card.dataset.verificationAt = integration.verification?.verifiedAt || '';
  card.dataset.verificationLabel = verificationProofLabel(integration.verification?.proofType);
  card.dataset.verifiedPayload = integration.isCurrentVerification
    ? JSON.stringify(integrationCardPayload(card)) : '';
  card.querySelector('[data-integration-validation]').textContent = integration.verification
    ? `Verified at ${new Date(integration.verification.verifiedAt).toLocaleString()} · ${card.dataset.verificationLabel}`
    : 'Not verified';
  updateIntegrationHealth(card, integration);
  card.querySelector('[data-default-status]').textContent = integration.usingDefault
    ? 'Using default' : integration.hasDefault ? 'Modified' : 'No default saved';
  card.querySelector('[data-action="restore-integration-default"]').disabled =
    !integration.hasDefault || integration.usingDefault;
  card.dataset.savedState = JSON.stringify(integrationCardPayload(card));
  clearIntegrationErrors(card);
  updateIntegrationSaveState(card.closest('form'));
}

async function refreshAdminMfaGate() {
  setSessionInfo(await request('/auth/me'));
  if (sessionInfo.adminMfaSetupRequired) {
    navigate('admin-security');
    return true;
  }
  if (sessionInfo.adminMfaReauthRequired) {
    navigate('login');
    return true;
  }
  return false;
}

function clearIntegrationErrors(card) {
  card.querySelectorAll('[data-field-error]').forEach((element) => { element.textContent = ''; });
  card.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute('aria-invalid'));
  updateIntegrationCardStatus(card);
}

function showIntegrationErrors(form, errors) {
  for (const [integrationId, fields] of Object.entries(errors)) {
    const card = form.querySelector(`[data-integration="${CSS.escape(integrationId)}"]`);
    if (!card) continue;
    if (Object.keys(fields).some((name) => name !== '_form')) {
      card.querySelector('.integration-fields-disclosure').open = true;
    }
    for (const [name, message] of Object.entries(fields)) {
      if (name === '_form') {
        card.querySelector('[data-integration-missing]').textContent = message;
        continue;
      }
      const error = card.querySelector(`[data-field-error="${CSS.escape(name)}"]`);
      const input = card.querySelector(`[name="${CSS.escape(name)}"]`);
      if (error) error.textContent = message;
      input?.setAttribute('aria-invalid', 'true');
    }
    updateIntegrationCardStatus(card);
  }
}

async function cancelIntegrationChanges(event) {
  const card = event.currentTarget.closest('[data-integration]');
  if (JSON.stringify(integrationCardPayload(card)) !== card.dataset.savedState
    && !confirm('Discard changes?')) return;
  const saved = JSON.parse(card.dataset.savedState);
  const toggle = card.querySelector('[data-action="integration-toggle"]');
  toggle.dataset.enabled = String(saved.enabled);
  toggle.textContent = saved.enabled ? 'Disable' : 'Enable';
  for (const input of card.querySelectorAll('.integration-fields [name]')) {
    const value = saved.fields[input.name];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
  card.querySelector('[data-default-status]').textContent = card.dataset.usingDefault === 'true'
    ? 'Using default' : card.dataset.hasDefault === 'true' ? 'Modified' : 'No default saved';
  clearIntegrationErrors(card);
  updateIntegrationSaveState(card.closest('form'));
}

async function verifyIntegrationCard(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  const card = button.closest('[data-integration]');
  const integrationId = card.dataset.integration;
  const payload = integrationCardPayload(card);
  let proof;
  if (integrationId === 'admin_mfa') {
    proof = { code: card.querySelector('[data-verification-code]')?.value || '' };
  } else if (integrationId === 'google_auth' && event.autoSave === true) {
    proof = { popup: true };
  }
  card.dataset.verifiedPayload = '';
  card.dataset.currentVerification = 'false';
  card.querySelector('[data-integration-validation]').textContent = 'Verification in progress...';
  button.disabled = true;
  try {
    if (integrationId === 'recaptcha') {
      proof = { token: await getRecaptchaCandidateToken(card) };
    }
    const result = await request(`/admin/settings/${encodeURIComponent(integrationId)}/verify`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({ ...payload, proof }),
    });
    if (result.verificationPending === true) {
      const authorizationUrl = new URL(result.authorizationUrl);
      if (authorizationUrl.origin !== 'https://accounts.google.com') {
        throw new Error('Google sign-in could not be started. Please try again.');
      }
      if (event.autoSave === true) {
        if (!event.popup || event.popup.closed) {
          throw new Error('The Google sign-in window closed before verification could start.');
        }
        event.popup.location.assign(authorizationUrl.toString());
        return 'pending';
      }
      window.location.assign(authorizationUrl.toString());
      return false;
    }
    if (JSON.stringify(integrationCardPayload(card)) !== JSON.stringify(payload)) {
      card.dataset.verifiedPayload = '';
      card.dataset.currentVerification = 'false';
      card.querySelector('[data-integration-validation]').textContent =
        'Settings changed during verification. Verify the current settings again.';
      showNotice('Settings changed during verification. Verify the current settings again.', true);
      return false;
    }
    card.dataset.verifiedPayload = JSON.stringify(payload);
    card.dataset.currentVerification = 'true';
    card.dataset.verificationProof = result.verification.proofType;
    card.dataset.verificationAt = result.verification.verifiedAt;
    card.dataset.verificationLabel = verificationProofLabel(result.verification.proofType);
    card.querySelector('[data-integration-validation]').textContent =
      `Verified at ${new Date(result.verification.verifiedAt).toLocaleString()} · ${card.dataset.verificationLabel}`;
    showNotice(`Settings verified ${card.dataset.verificationLabel}.`);
    return true;
  } catch (error) {
    card.querySelector('[data-integration-validation]').textContent = 'Verification failed. Verify the current settings before saving.';
    if (showIntegrationRateLimit(error, button)) return;
    showNotice(error.message, true);
    return false;
  } finally {
    const code = card.querySelector('[data-verification-code]');
    if (code) code.value = '';
    if (!button.dataset.rateLimitUntil) button.disabled = false;
    updateIntegrationSaveState(form);
  }
}

function showGoogleOAuthVerificationResult(page) {
  const status = param('googleAuthVerification');
  if (page !== 'admin-settings' || !status) return;
  if (param('googleAuthPopup') === '1' && window.opener) {
    window.opener.postMessage({
      type: 'google-integration-verification',
      status,
    }, window.location.origin);
    window.close();
    return;
  }
  const messages = {
    success: [document.querySelector('[data-integration="google_auth"]')?.dataset.currentVerification === 'true'
      ? 'Google sign-in settings verified with a real sign-in.'
      : 'Google sign-in verification completed. Re-enter the exact candidate settings (including any changed secret), then click Save Changes to continue saving.', false],
    access_denied: ['Google sign-in verification was cancelled.', true],
    redirect_mismatch: ['The Google callback URL does not match the candidate settings.', true],
    expired: ['Google sign-in verification expired. Verify the settings again.', true],
    failed: ['Google sign-in verification failed. Check the candidate settings and try again.', true],
  };
  const [message, isError] = messages[status] || messages.failed;
  showNotice(message, isError);
  const url = new URL(window.location.href);
  url.searchParams.delete('googleAuthVerification');
  url.searchParams.delete('googleAuthPopup');
  window.history.replaceState({}, '', url.toString());
}

async function getRecaptchaCandidateToken(card) {
  const container = card.querySelector('[data-recaptcha-verification]');
  const widget = container?.querySelector('[data-recaptcha-verification-widget]');
  const siteKey = card.querySelector('[name="site_key"]')?.value.trim();
  if (!container || !widget || !siteKey) {
    throw new Error('Enter the candidate reCAPTCHA site key before verifying.');
  }
  try {
    await loadRecaptchaApi();
  } catch {
    throw new Error('Could not load the reCAPTCHA challenge. Check the site key and try again.');
  }

  container.hidden = false;
  widget.replaceChildren();
  const prompt = container.querySelector('[data-recaptcha-verification-prompt]');
  if (prompt) prompt.textContent = 'Complete this challenge to verify the candidate keys.';

  let widgetId;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        recaptchaChallengeCancels.delete(card);
        callback(value);
      };
      recaptchaChallengeCancels.set(card, () => {
        if (widgetId !== undefined) window.grecaptcha.reset(widgetId);
        finish(reject, new Error('Settings changed. Verify the current settings again.'));
      });
      widgetId = window.grecaptcha.render(widget, {
        sitekey: siteKey,
        callback: (token) => finish(resolve, token),
        'error-callback': () => finish(
          reject,
          new Error('Could not load the reCAPTCHA challenge. Check the site key and try again.'),
        ),
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Settings changed. Verify the current settings again.') {
      throw error;
    }
    throw new Error('Could not load the reCAPTCHA challenge. Check the site key and try again.');
  } finally {
    recaptchaChallengeCancels.delete(card);
    if (widgetId !== undefined) window.grecaptcha.reset(widgetId);
    container.hidden = true;
    widget.replaceChildren();
  }
}

function verificationProofLabel(proofType) {
  return {
    real_sign_in: 'with a real sign-in',
    real_challenge: 'with a real challenge',
    test_email_sent: 'test email sent',
    test_event_created_and_removed: 'test event created and removed',
    authenticator_code_accepted: 'authenticator code accepted',
  }[proofType] || 'with verified settings';
}

async function startAdminMfaEnrollment(event) {
  const button = event.currentTarget;
  const card = button.closest('.admin-mfa-card');
  const code = card.querySelector('[name="current_code"]')?.value || '';
  button.disabled = true;
  try {
    const result = await request('/admin/mfa/enrollment/start', jsonPost({ code }));
    const currentCode = card.querySelector('[name="current_code"]');
    if (currentCode) currentCode.value = '';
    card.querySelector('[data-admin-mfa-qr-image]').src = result.qrCode;
    card.querySelector('[data-admin-mfa-secret]').textContent = result.secret;
    card.querySelector('[data-admin-mfa-qr]').hidden = false;
    button.hidden = true;
    showNotice('Scan the QR code, then confirm with the authenticator app.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (!isRateLimited(button)) button.disabled = false;
  }
}

function showAdminMfaRecoveryCodes(codes) {
  const section = app.querySelector('[data-admin-mfa-recovery-codes]');
  const list = section?.querySelector('[data-admin-mfa-recovery-list]');
  if (!section || !list || !Array.isArray(codes)) return;
  list.replaceChildren(...codes.map((code) => {
    const row = document.createElement('li');
    const value = document.createElement('code');
    value.textContent = code;
    row.append(value);
    return row;
  }));
  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showNotice(message, isError = false) {
  if (isError) return showFormError(message);
  return showFormSuccess(message);
}

function staffHomePage() {
  const pages = [
    ['view_staff_dashboard', 'staff-dashboard'],
    ['view_records', 'staff-records'],
    ['view_lost_reports', 'staff-lost-reports'],
    ['view_found_items', 'staff-found-items'],
    ['view_claims', 'staff-claims'],
  ];
  return pages.find(([permission]) => hasPermission(permission))?.[1] || 'staff-no-access';
}

function staffPermissionHome() {
  return `<main class="container">${pageHeader('Staff access not assigned', 'Ask an administrator to grant you the staff permissions needed for this work.')}</main>`;
}

function bindRolePermissionCheckboxes(form) {
  const dependencies = JSON.parse(form.dataset.dependencies || '{}');
  const dependents = Object.entries(dependencies).reduce((map, [child, parents]) => {
    for (const parent of parents) {
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(child);
    }
    return map;
  }, new Map());
  const checkboxes = new Map([...form.querySelectorAll('input[name="permissions"]')]
    .map((checkbox) => [checkbox.value, checkbox]));
  const setParents = (name) => {
    for (const parent of dependencies[name] || []) {
      const checkbox = checkboxes.get(parent);
      if (checkbox) checkbox.checked = true;
      setParents(parent);
    }
  };
  const clearChildren = (name) => {
    for (const child of dependents.get(name) || []) {
      const checkbox = checkboxes.get(child);
      if (checkbox) checkbox.checked = false;
      clearChildren(child);
    }
  };
  checkboxes.forEach((checkbox, name) => checkbox.addEventListener('change', () => {
    if (checkbox.checked) setParents(name);
    else clearChildren(name);
    updateRolePermissionSaveState(form);
  }));
  form.addEventListener('change', () => updateRolePermissionSaveState(form));
  form.addEventListener('input', () => updateRolePermissionSaveState(form));
}

function currentRolePermissionSelection(form) {
  return [...form.querySelectorAll('input[name="permissions"]:checked')].map((input) => input.value).sort();
}

function updateRolePermissionSaveState(form) {
  const saved = JSON.parse(form.dataset.savedPermissions || '[]').sort();
  const current = currentRolePermissionSelection(form);
  form.querySelector('button[type="submit"]').disabled = JSON.stringify(saved) === JSON.stringify(current);
}

function cancelRolePermissionChanges(event) {
  const form = event.currentTarget.closest('form');
  const saved = new Set(JSON.parse(form.dataset.savedPermissions || '[]'));
  const changed = JSON.stringify([...saved].sort()) !== JSON.stringify(currentRolePermissionSelection(form));
  if (changed && !confirm('Discard changes?')) return;
  form.querySelectorAll('input[name="permissions"]').forEach((input) => {
    input.checked = saved.has(input.value);
  });
  updateRolePermissionSaveState(form);
}

function changeRolePermissionRole(event) {
  const selector = event.currentTarget;
  const form = app.querySelector('form[data-form="admin-role-permissions"]');
  const saved = JSON.parse(form?.dataset.savedPermissions || '[]').sort();
  const changed = form && JSON.stringify(saved) !== JSON.stringify(currentRolePermissionSelection(form));
  if (changed && !confirm('Discard changes?')) {
    selector.value = form.dataset.role;
    return;
  }
  if (changed) form.dataset.savedPermissions = JSON.stringify(currentRolePermissionSelection(form));
  location.href = `/?page=admin-users&tab=role-defaults&role=${encodeURIComponent(selector.value)}`;
}

function bindAccountPermissionForm(form) {
  const setActiveRole = (role) => {
    form.querySelectorAll('[data-role-panel]').forEach((panel) => {
      const active = panel.dataset.rolePanel === role;
      panel.hidden = !active;
      panel.querySelectorAll('input[name="permissions"]').forEach((checkbox) => {
        checkbox.disabled = !active || checkbox.dataset.roleEnabled !== 'true';
      });
    });
  };
  const setParents = (checkbox, panel) => {
    const config = JSON.parse(panel.querySelector('[data-dependencies]')?.dataset.dependencies || '{}');
    for (const parent of config[checkbox.value] || []) {
      const parentInput = [...panel.querySelectorAll('input[name="permissions"]')].find((input) => input.value === parent);
      if (parentInput && !parentInput.disabled) parentInput.checked = true;
      if (parentInput) setParents(parentInput, panel);
    }
  };
  const clearChildren = (checkbox, panel) => {
    const config = JSON.parse(panel.querySelector('[data-dependencies]')?.dataset.dependencies || '{}');
    for (const [child, parents] of Object.entries(config)) {
      if (!parents.includes(checkbox.value)) continue;
      const childInput = [...panel.querySelectorAll('input[name="permissions"]')].find((input) => input.value === child);
      if (childInput && !childInput.disabled) childInput.checked = false;
      if (childInput) clearChildren(childInput, panel);
    }
  };
  form.querySelectorAll('[data-role-panel] input[name="permissions"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const panel = checkbox.closest('[data-role-panel]');
      if (checkbox.checked) setParents(checkbox, panel);
      else clearChildren(checkbox, panel);
    });
  });
  form.querySelector('[data-action="account-role"]')?.addEventListener('change', (event) => {
    setActiveRole(event.currentTarget.value);
  });
  setActiveRole(form.querySelector('[data-action="account-role"]')?.value || form.dataset.currentRole);
  form.dataset.savedAccountForm = accountFormSnapshot(form);
}

function changeAccountRole(event) {
  const form = event.currentTarget.form;
  const panel = form?.querySelector(`[data-role-panel="${event.currentTarget.value}"]`);
  const reset = form?.querySelector('[data-action="reset-account-permissions"]');
  if (panel) {
    panel.querySelectorAll('input[name="permissions"]').forEach((input) => {
      input.checked = input.dataset.roleEnabled === 'true';
    });
  }
  if (reset) reset.disabled = event.currentTarget.value !== form.dataset.currentRole;
}

function accountRoleName(role) {
  return ({ user: 'User', staff: 'Staff', admin: 'Admin' })[role] || 'Unknown';
}

function accountFormSnapshot(form) {
  return JSON.stringify([...form.querySelectorAll('input:not([type="hidden"]), select, textarea')].map((input) => ({
    name: input.name,
    value: input.type === 'checkbox' ? input.checked : input.value,
  })));
}

function isFormDirty(form) {
  if (form.dataset.form === 'admin-role-permissions') {
    const saved = JSON.stringify(JSON.parse(form.dataset.savedPermissions || '[]').sort());
    return saved !== JSON.stringify(currentRolePermissionSelection(form));
  }
  if (form.dataset.form === 'admin-edit-user') {
    return form.dataset.savedAccountForm !== accountFormSnapshot(form);
  }
  if (form.dataset.form === 'admin-add-user') {
    return form.dataset.savedAccountForm !== accountFormSnapshot(form);
  }
  return false;
}

function bindDiscardNavigation() {
  if (app.dataset.discardNavigationBound) return;
  app.dataset.discardNavigationBound = 'true';
  app.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href]');
    if (!anchor || anchor.target === '_blank') return;
    const dirty = [...app.querySelectorAll('form[data-form]')].some(isFormDirty);
    if (dirty && !confirm('Discard changes?')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (dirty) {
      [...app.querySelectorAll('form[data-form]')].forEach((form) => {
        if (form.dataset.form === 'admin-role-permissions') {
          form.dataset.savedPermissions = JSON.stringify(currentRolePermissionSelection(form));
        } else if (['admin-edit-user', 'admin-add-user'].includes(form.dataset.form)) {
          form.dataset.savedAccountForm = accountFormSnapshot(form);
        }
      });
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (![...app.querySelectorAll('form[data-form]')].some(isFormDirty)) return;
    event.preventDefault();
    event.returnValue = 'Discard changes?';
  });
}

async function resetAccountPermissions(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  if (form && isFormDirty(form) && !confirm('Discard changes?')) return;
  if (!confirm('Reset this account to its role defaults?')) return;
  try {
    await request(`/admin/users/${encodeURIComponent(button.dataset.id)}/permissions`, { method: 'DELETE' });
    await render();
    showNotice('Account permissions reset to role defaults.');
  } catch (error) {
    showNotice(error.message, true);
  }
}

render();
