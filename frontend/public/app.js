import * as shared from './js/shared.js';
import { homePage, loginPage, authForm } from './js/pages/public.js';
import { dashboardPage, browsePage, itemPage, reportPage, reportsPage, editReportPage, claimPage, claimsPage, profilePage, notificationsPage } from './js/pages/user.js';
import { staffDashboard, staffRecords, staffItems, staffReturnedItems, staffItemPage, staffClaims, staffClaimPage } from './js/pages/staff.js';
import { adminDashboard, adminUsers, adminAddUser, adminEditUser, adminRolePermissions, adminItems, adminEditItem, adminClaims, adminInventory, adminSettings, adminSystemRecords } from './js/pages/admin.js';
import { adminMfaVerifyPage, adminSecurityPage } from './js/pages/admin-mfa.js';

const { app, sessionInfo, h, date, param, link, buttonLink, badge, field, selectField, optionsFrom, request, icon, roleLabel, hasPermission, shell, pageHeader, alert, empty, reportRows, table, statCards, formAction, setSessionInfo } = shared;
let pendingIntegrationCard = null;
let pendingIntegrationRestore = null;
let integrationCodeResendTimer;

async function render() {
  app.innerHTML = '<main class="loading" aria-live="polite">Loading…</main>';
  try {
    setSessionInfo(await request('/auth/me'));
    const roleHome = sessionInfo.user?.role_name === 'admin' ? 'admin-dashboard'
      : sessionInfo.user?.role_name === 'staff' ? staffHomePage() : 'dashboard';
    const page = param('page') || (sessionInfo.user ? roleHome : 'home');
    const content = await renderPage(page);
    app.innerHTML = shell(content, page);
    bindForms();
    await mountRecaptchaWidgets();
    const target = param('highlight');
    if (target) {
      const element = document.getElementById(target);
      if (element) {
        element.classList.add('notification-highlight');
        requestAnimationFrame(() => element.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      }
    }
  } catch (error) {
    const page = param('page') || 'home';
    app.innerHTML = shell(`<main class="container">${alert(error.message, true)}<a class="button button-primary" href="/">Reload</a></main>`, page);
    bindForms();
  }
}

async function renderPage(page) {
  const user = sessionInfo.user;
  const privatePages = new Set([
    'dashboard', 'report', 'report-found', 'reports', 'edit-report', 'claims', 'claim', 'profile',
    'notifications', 'staff-dashboard', 'staff-records', 'staff-lost-reports', 'staff-found-items',
    'staff-stored-items', 'staff-returned-items', 'staff-item', 'staff-claims', 'staff-claim',
    'admin-dashboard', 'admin-users', 'admin-add-user', 'admin-edit-user', 'admin-role-permissions', 'admin-items',
    'admin-edit-item', 'admin-claims', 'admin-inventory', 'admin-settings', 'admin-system-records',
    'admin-security',
  ]);
  if (sessionInfo.pendingAdminMfa) return adminMfaVerifyPage();
  if (sessionInfo.adminMfaReauthRequired) return loginPage('Administrator MFA is now required. Sign in again to verify your account.');
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
  };
  const requiredPermission = pagePermissions[page];
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
    case 'admin-add-user': return adminAddUser();
    case 'admin-edit-user': return adminEditUser(param('id'));
    case 'admin-role-permissions': return adminRolePermissions();
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
  app.querySelectorAll('form[data-form]').forEach((form) => form.addEventListener('submit', onFormSubmit));
  app.querySelectorAll('form[data-action]').forEach((form) => form.addEventListener('submit', onActionForm));
  app.querySelectorAll('[data-action="logout"]').forEach((button) => button.addEventListener('click', logout));
  app.querySelectorAll('[data-action="read-all"]').forEach((button) => button.addEventListener('click', readAll));
  app.querySelectorAll('[data-action="google-signin"]').forEach((link) => link.addEventListener('click', startGoogleSignIn));
  app.querySelectorAll('[data-action="integration-toggle"]').forEach((button) => button.addEventListener('click', toggleIntegration));
  app.querySelectorAll('[data-action="save-integration"]').forEach((button) => button.addEventListener('click', saveIntegrationSettings));
  app.querySelectorAll('[data-action="cancel-integration"]').forEach((button) => button.addEventListener('click', cancelIntegrationChanges));
  app.querySelectorAll('[data-action="set-integration-default"]').forEach((button) => button.addEventListener('click', setIntegrationDefault));
  app.querySelectorAll('[data-action="restore-integration-default"]').forEach((button) => button.addEventListener('click', restoreIntegrationDefault));
  app.querySelectorAll('[data-action="integration-test"]').forEach((button) => button.addEventListener('click', testIntegrationConnection));
  app.querySelectorAll('[data-action="smtp-test"]').forEach((button) => button.addEventListener('click', testSmtpConnection));
  app.querySelectorAll('[data-action="calendar-test"]').forEach((button) => button.addEventListener('click', testCalendarConnection));
  app.querySelectorAll('[data-action="admin-mfa-test"]').forEach((button) => button.addEventListener('click', testAdminMfa));
  app.querySelectorAll('[data-action="admin-mfa-enrollment-start"]').forEach((button) => button.addEventListener('click', startAdminMfaEnrollment));
  app.querySelectorAll('[data-action="resend-integration-code"]').forEach((button) => button.addEventListener('click', resendIntegrationCode));
  app.querySelectorAll('[data-action="cancel-integration-code"]').forEach((button) => button.addEventListener('click', cancelIntegrationCode));
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
  const menuButton = app.querySelector('#menu-btn');
  const sidebar = app.querySelector('#sidebar');
  const overlay = app.querySelector('#overlay');
  const closeMenu = () => {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('show');
    menuButton?.setAttribute('aria-expanded', 'false');
  };
  menuButton?.addEventListener('click', () => {
    sidebar?.classList.add('open');
    overlay?.classList.add('show');
    menuButton.setAttribute('aria-expanded', 'true');
  });
  overlay?.addEventListener('click', closeMenu);
}

async function onFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    switch (form.dataset.form) {
      case 'integration-settings': return;
      case 'integration-pin': await unlockIntegrationSettings(form); return;
      case 'integration-code': await verifyIntegrationCode(form); return;
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
        const data = new FormData(form);
        data.set('item_type', form.dataset.type);
        await request('/items', { method: 'POST', body: data });
        navigate('reports');
        return;
      }
      case 'edit-report': {
        const data = new FormData(form);
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
      case 'admin-add-user': await request('/admin/users', jsonPost(values)); navigate('admin-users'); return;
      case 'admin-edit-user': await request(`/admin/users/${encodeURIComponent(form.dataset.id)}`, jsonPatch({ ...values, action: 'edit' })); navigate('admin-users'); return;
      case 'admin-role-permissions': {
        const formData = new FormData(form);
        const permissions = formData.getAll('permissions');
        const saved = new Set(JSON.parse(form.dataset.savedPermissions || '[]'));
        const disabled = [...saved].filter((permission) => !permissions.includes(permission));
        if (disabled.length) {
          const labels = [...form.querySelectorAll('input[name="permissions"]')]
            .filter((input) => disabled.includes(input.value))
            .map((input) => input.closest('label').querySelector('strong').textContent);
          if (!confirm(`This will disable ${labels.join(', ')} for ALL ${form.dataset.role} accounts. Continue?`)) {
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
    if (form.dataset.form === 'admin-mfa-verify' && error.status === 401) {
      navigate('login');
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
    if (submit) submit.disabled = false;
  }
}

async function mountRecaptchaWidgets() {
  const widgets = app.querySelectorAll('.g-recaptcha');
  if (!widgets.length) return;
  await loadRecaptchaApi();
  widgets.forEach((widget) => {
    const widgetId = window.grecaptcha.render(widget, {
      sitekey: widget.dataset.sitekey,
      callback: (token) => { widget.dataset.responseToken = token; },
      'expired-callback': () => { delete widget.dataset.responseToken; },
      'error-callback': () => { delete widget.dataset.responseToken; },
    });
    widget.dataset.widgetId = String(widgetId);
  });
  app.querySelectorAll('form[data-form="login"] button[type="submit"], form[data-form="register"] button[type="submit"]')
    .forEach((button) => { button.disabled = false; });
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
  const token = getRecaptchaResponse(widget);
  if (!token) {
    showNotice('Complete the reCAPTCHA challenge before continuing with Google.', true);
    link.removeAttribute('aria-disabled');
    link.classList.remove('disabled');
    return;
  }
  try {
    const result = await request('/auth/google', jsonPost({ 'g-recaptcha-response': token }));
    window.location.assign(result.url);
  } catch (error) {
    showNotice(error.message, true);
    if (widget) {
      window.grecaptcha.reset(Number(widget.dataset.widgetId));
      delete widget.dataset.responseToken;
    }
    link.removeAttribute('aria-disabled');
    link.classList.remove('disabled');
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
async function logout() {
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
    const changed = JSON.stringify(integrationCardPayload(card)) !== card.dataset.savedState;
    card.querySelector('.integration-card-actions').hidden = !changed;
    card.querySelector('[data-action="set-integration-default"]').disabled = changed;
    card.querySelector('[data-action="integration-test"]')?.toggleAttribute('disabled', changed);
    card.querySelector('[data-action="smtp-test"]')?.toggleAttribute('disabled', changed);
    card.querySelector('[data-action="calendar-test"]')?.toggleAttribute('disabled', changed);
    card.querySelector('[data-action="admin-mfa-test"]')?.toggleAttribute('disabled', changed);
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
    pin.focus();
  } finally {
    submit.disabled = false;
  }
}

function openIntegrationCodeDialog(form, resendInSeconds) {
  const dialog = form.closest('.admin-settings').querySelector('[data-integration-code-dialog]');
  const codeForm = dialog.querySelector('form');
  codeForm.reset();
  codeForm.querySelector('[data-integration-code-error]').textContent = '';
  if (!dialog.open) dialog.showModal();
  startIntegrationCodeResendTimer(dialog, resendInSeconds);
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
    if (requestError.message.includes('pending settings changed')) {
      pendingIntegrationCard = null;
      pendingIntegrationRestore = null;
      closeIntegrationCodeDialog();
    }
  } finally {
    submit.disabled = false;
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
      startIntegrationCodeResendTimer(dialog, result.resendInSeconds);
      showNotice('A new verification code was sent.');
      return;
    }
    const result = await request('/admin/settings/code/resend', {
      method: 'POST',
      headers: { 'X-CSRF-Token': settingsCsrf(card.closest('form')) },
      body: JSON.stringify({ integrations: { [card.dataset.integration]: integrationCardPayload(card) } }),
    });
    startIntegrationCodeResendTimer(dialog, result.resendInSeconds);
    showNotice('A new verification code was sent.');
  } catch (error) {
    showNotice(error.message, true);
    button.disabled = false;
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
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
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
      openIntegrationCodeDialog(form, result.resendInSeconds);
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
    button.disabled = false;
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
  updateIntegrationSaveState(button.closest('form'));
}

async function saveIntegrationSettings(event) {
  const button = event.currentTarget;
  const card = button.closest('[data-integration]');
  const form = button.closest('form');
  const payload = { [card.dataset.integration]: integrationCardPayload(card) };
  clearIntegrationErrors(card);
  button.disabled = true;
  try {
    const result = await request('/admin/settings', {
      method: 'PUT',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({ integrations: payload }),
    });
    if (result.verificationRequired) {
      pendingIntegrationCard = card;
      openIntegrationCodeDialog(form, result.resendInSeconds);
      showNotice('A verification code was sent to the configured administrator email.');
      return;
    }
    applySavedIntegration(card, result.integrations[card.dataset.integration]);
    if (card.dataset.integration === 'admin_mfa') await refreshAdminMfaGate();
    showNotice(`${result.integrations[card.dataset.integration].label} settings saved.`);
  } catch (error) {
    if (error.fieldErrors) showIntegrationErrors(form, error.fieldErrors);
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
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
  card.dataset.usingDefault = String(integration.usingDefault);
  card.dataset.hasDefault = String(integration.hasDefault);
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

async function testSmtpConnection(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  const card = button.closest('[data-integration]');
  button.disabled = true;
  try {
    const result = await request('/admin/settings/smtp/test', {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({}),
    });
    applySavedIntegration(card, result.integrations.smtp);
    showNotice('Saved SMTP connection verified and set as the default.');
  } catch (error) {
    if (error.fieldErrors) showIntegrationErrors(form, error.fieldErrors);
    try {
      const current = await request('/admin/settings');
      if (current.integrations?.smtp) applySavedIntegration(card, current.integrations.smtp);
    } catch {
      console.warn('Integration health could not be refreshed after the SMTP test.');
    }
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function testIntegrationConnection(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  const card = button.closest('[data-integration]');
  const integrationId = card.dataset.integration;
  const connectionTests = {
    google_auth: {
      path: '/admin/settings/google-auth/test',
      label: 'Google sign-in',
    },
    recaptcha: {
      path: '/admin/settings/recaptcha/test',
      label: 'reCAPTCHA',
    },
  };
  const connectionTest = connectionTests[integrationId];
  if (!connectionTest) return;

  button.disabled = true;
  try {
    const result = await request(connectionTest.path, {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({}),
    });
    applySavedIntegration(card, result.integrations[integrationId]);
    showNotice(`${connectionTest.label} connection verified and saved settings are now the default.`);
  } catch (error) {
    try {
      const current = await request('/admin/settings');
      if (current.integrations?.[integrationId]) applySavedIntegration(card, current.integrations[integrationId]);
    } catch {
      console.warn(`${connectionTest.label} health could not be refreshed after the connection test.`);
    }
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function testCalendarConnection(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  const card = button.closest('[data-integration]');
  button.disabled = true;
  try {
    const result = await request('/admin/settings/google-calendar/test', {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.closest('.admin-settings').dataset.csrfToken },
      body: JSON.stringify({}),
    });
    applySavedIntegration(card, result.integrations.google_calendar);
    showNotice('Google Calendar is reachable and the saved settings are now the default.');
  } catch (error) {
    try {
      const current = await request('/admin/settings');
      if (current.integrations?.google_calendar) applySavedIntegration(card, current.integrations.google_calendar);
    } catch {
      console.warn('Google Calendar health could not be refreshed after the connection test.');
    }
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function testAdminMfa(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request('/admin/settings/admin-mfa/test', jsonPost({}));
    showNotice('Admin MFA encryption and authenticator self-test passed.');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
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
    button.disabled = false;
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
  const previous = app.querySelector('.alert');
  if (previous) previous.remove();
  const notice = document.createElement('div');
  notice.className = `alert ${isError ? 'alert-error' : 'alert-success'}`;
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  const authBox = app.querySelector('.auth-box');
  const subtitle = authBox?.querySelector('.sub');
  if (subtitle) subtitle.insertAdjacentElement('afterend', notice);
  else app.querySelector('main')?.prepend(notice);
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
  location.href = `/?page=admin-role-permissions&role=${encodeURIComponent(selector.value)}`;
}

render();
