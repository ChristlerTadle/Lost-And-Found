const API = window.API_BASE;
const app = document.querySelector('#app');
const sessionInfo = { user: null, rolePermissions: [], categories: [], locations: [], unreadNotifications: 0, csrfToken: '', googleAuth: { active: false }, recaptcha: { active: false }, pendingAdminMfa: false, adminMfaSetupRequired: false, adminMfaReauthRequired: false };
const rateLimitTimers = new WeakMap();
let lastInteraction = null;
let lastFieldError = null;
let lastDisplayedMessage = null;
let memoryFlash = null;
let messageSequence = 0;

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
const otherLocationValue = '__other_location__';
const locationOptions = (value = '', placeholder = 'Choose location', includeOther = false) => {
  const locations = [...sessionInfo.locations];
  if (value && !locations.includes(value)) locations.push(value);
  if (value === 'Other') {
    return [
      ['', placeholder],
      ...locations.map((location) => [location, location === 'Other' ? 'Other (saved location)' : location]),
      ...(includeOther ? [[otherLocationValue, 'Other']] : []),
    ];
  }
  return [
    ['', placeholder],
    ...locations.map((location) => [location, location]),
    ...(includeOther ? [[otherLocationValue, 'Other']] : []),
  ];
};
const otherLocationField = () => `<div class="field" data-other-location-field hidden>
  <label for="location_other">Specify location</label>
  <input class="input" id="location_other" name="location_other" type="text" maxlength="120" autocomplete="off" placeholder="Enter the campus location">
</div>`;

function currentInteraction() {
  return lastInteraction?.isConnected ? lastInteraction : null;
}

function currentDialog() {
  return [...document.querySelectorAll('dialog[open]')].pop() || null;
}

function isAuthRequest(path) {
  return [
    '/auth/login',
    '/auth/register',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/mfa/verify',
    '/admin/mfa/enrollment/start',
    '/admin/mfa/enrollment/confirm',
    '/admin/mfa/recovery/regenerate',
  ].includes(path);
}

function isAuthenticatedPage() {
  const page = param('page');
  if (['login', 'forgot-password', 'reset-password', 'home', 'items', 'item'].includes(page)) {
    return false;
  }
  return Boolean(sessionInfo.user) || [
    'dashboard', 'report', 'report-found', 'reports', 'edit-report', 'claims', 'claim', 'profile',
    'notifications', 'staff-dashboard', 'staff-records', 'staff-lost-reports', 'staff-found-items',
    'staff-stored-items', 'staff-returned-items', 'staff-item', 'staff-claims', 'staff-claim',
    'admin-dashboard', 'admin-users', 'admin-edit-user', 'admin-items', 'admin-edit-item',
    'admin-claims', 'admin-inventory', 'admin-settings', 'admin-system-records', 'admin-security',
  ].includes(page);
}

function retryDelay(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : 60;
}

function fieldErrorsFrom(data) {
  const result = {};
  const fieldErrors = data?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === 'object' && !Array.isArray(fieldErrors)) {
    for (const [name, message] of Object.entries(fieldErrors)) {
      if (typeof message === 'string') result[name] = message;
      else if (message && typeof message === 'object' && !Array.isArray(message)) {
        for (const [field, fieldMessage] of Object.entries(message)) {
          if (typeof fieldMessage === 'string') result[field] = fieldMessage;
        }
      }
    }
  }
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  for (const entry of errors) {
    if (typeof entry?.field === 'string' && typeof entry?.message === 'string') {
      result[entry.field] = entry.message;
    }
  }
  if (typeof data?.error?.field === 'string' && typeof data.error.message === 'string') {
    result[data.error.field] = data.error.message;
  }
  return result;
}

function safeServerMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return 'Something went wrong. Please try again.';
  const message = value.trim();
  if (/\b(?:stack trace|at\s+[\w.$]+\s*\(|\w+Error:|upstream|provider (?:response|error)|invalid_grant|invalid_client|ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(message)
    || /(?:googleapis\.com|accounts\.google|<\/?[a-z][^>]*>)/i.test(message)) {
    return 'Something went wrong. Please try again.';
  }
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\b\d{6,}\b/g, '[redacted]');
}

function normalizeRequestError(response, data, path, authenticated) {
  const errorBody = data && typeof data === 'object' ? data : {};
  const retryAfter = response.status === 429 || response.status === 503
    ? retryDelay(response.headers.get('Retry-After') || errorBody.retryAfter)
    : 0;
  let message;
  let showSignIn = false;
  if (response.status === 429) {
    message = errorBody.error === 'Please try again shortly'
      ? errorBody.error
      : `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfter / 60))} minute${Math.ceil(retryAfter / 60) === 1 ? '' : 's'}.`;
  } else if (response.status === 503 && errorBody.error === 'Please try again shortly') {
    message = errorBody.error;
  } else if (response.status === 401 && authenticated && !isAuthRequest(path) && isAuthenticatedPage()) {
    message = 'Your access changed. Please sign in again.';
    showSignIn = true;
  } else if (response.status >= 500) {
    message = 'Something went wrong. Please try again.';
  } else if (response.status >= 400) {
    const serverMessage = typeof errorBody.error === 'string' ? errorBody.error
      : typeof errorBody.message === 'string' ? errorBody.message
        : typeof errorBody.error?.message === 'string' ? errorBody.error.message : '';
    message = safeServerMessage(serverMessage);
  } else {
    message = 'Something went wrong. Please try again.';
  }
  const error = new Error(message);
  error.status = response.status;
  error.retryAfter = retryAfter;
  error.fieldErrors = fieldErrorsFrom(errorBody);
  error.showSignIn = showSignIn;
  return error;
}

function normalizeNetworkError() {
  const error = new Error('Could not reach the server. Check your connection and try again.');
  error.networkError = true;
  return error;
}

async function request(path, options = {}) {
  const headers = { ...options.headers };
  const anchor = options.anchor || currentInteraction();
  const method = String(options.method || 'GET').toUpperCase();
  const authenticated = Boolean(sessionInfo.user);
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)
    && sessionInfo.csrfToken && !headers['X-CSRF-Token']) {
    headers['X-CSRF-Token'] = sessionInfo.csrfToken;
  }
  let response;
  try {
    const fetchOptions = { ...options };
    delete fetchOptions.anchor;
    response = await fetch(`${API}${path}`, {
      credentials: 'include',
      ...fetchOptions,
      headers,
    });
  } catch {
    const error = normalizeNetworkError();
    showFormError(error, { anchor });
    throw error;
  }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      sessionInfo.user = null;
      sessionInfo.pendingAdminMfa = false;
      sessionInfo.adminMfaSetupRequired = false;
      sessionInfo.adminMfaReauthRequired = false;
    }
    const error = normalizeRequestError(response, data, path, authenticated);
    showFormError(error, { anchor });
    throw error;
  }
  const flash = successMessageForRequest(path, method, options.body, data);
  if (flash && !data?.verificationRequired) storeFlash(flash);
  return data;
}

function actionPayload(body) {
  if (typeof body !== 'string') return body && typeof body === 'object' ? body : {};
  try {
    const payload = JSON.parse(body);
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function successMessageForRequest(path, method, body, data) {
  const pathname = new URL(path, location.origin).pathname;
  const payload = actionPayload(body);
  if (method === 'POST' && pathname === '/auth/reset-password') return 'Password reset. Sign in with your new password.';
  if (method === 'POST' && pathname === '/items') return 'Report submitted.';
  if (method === 'PUT' && /^\/items\/[^/]+$/.test(pathname)) return 'Report updated.';
  if (method === 'DELETE' && /^\/items\/[^/]+$/.test(pathname)) return 'Report cancelled.';
  if (method === 'POST' && pathname === '/claims') return 'Claim submitted.';
  if (method === 'PATCH' && pathname === '/profile') return 'Profile updated.';
  if (method === 'PATCH' && /^\/notifications\/[^/]+\/read$/.test(pathname)) return 'Notification marked as read.';
  if (method === 'PATCH' && pathname === '/notifications/read-all') return 'Notifications marked as read.';
  if (method === 'POST' && /^\/staff\/items\/[^/]+\/verify$/.test(pathname)) return 'Item verification saved.';
  if (method === 'PATCH' && /^\/staff\/items\/[^/]+\/status$/.test(pathname)) return 'Item status updated.';
  if (method === 'PATCH' && /^\/staff\/claims\/[^/]+$/.test(pathname)) {
    if (payload.action === 'returned') return 'Item marked as returned.';
    if (payload.action === 'review') return `Claim ${payload.decision || 'review'} saved.`;
  }
  if (method === 'PATCH' && /^\/staff\/claims\/[^/]+\/pickup$/.test(pathname)) return 'Pickup appointment updated.';
  if (method === 'POST' && /^\/staff\/claims\/[^/]+\/calendar-sync$/.test(pathname)) return 'Calendar sync retried.';
  if (method === 'POST' && pathname === '/admin/users') return 'Account created.';
  if (method === 'PATCH' && /^\/admin\/users\/[^/]+$/.test(pathname)) {
    if (payload.action === 'disable') return 'Account disabled.';
    if (payload.action === 'enable') return 'Account enabled.';
    if (payload.role_change_code) return 'Account role updated.';
    if (payload.role_change && !data?.verificationRequired) return 'Account role updated.';
    return 'Account updated.';
  }
  if (method === 'PUT' && /^\/admin\/users\/[^/]+\/permissions$/.test(pathname)) return 'Account permissions updated.';
  if (method === 'DELETE' && /^\/admin\/users\/[^/]+\/permissions$/.test(pathname)) return 'Account permissions reset.';
  if (method === 'PUT' && /^\/admin\/role-permissions\/[^/]+$/.test(pathname)) return 'Role defaults saved.';
  if (method === 'PATCH' && /^\/admin\/items\/[^/]+$/.test(pathname)) return 'Item record updated.';
  if (method === 'DELETE' && /^\/admin\/items\/[^/]+$/.test(pathname)) return 'Item record removed.';
  return '';
}

function storeFlash(message) {
  try {
    sessionStorage.setItem('app-flash-message', message);
  } catch {
    memoryFlash = message;
  }
}

function takeFlash() {
  let message = memoryFlash;
  memoryFlash = null;
  try {
    message = sessionStorage.getItem('app-flash-message') || message;
    sessionStorage.removeItem('app-flash-message');
  } catch {
    return message;
  }
  return message;
}

function clearFlash() {
  memoryFlash = null;
  try {
    sessionStorage.removeItem('app-flash-message');
  } catch {
    return;
  }
}

function showPendingFlash() {
  const message = takeFlash();
  if (message) showFormSuccess(message, { fixed: true, autoDismiss: true });
}

function messageContext(anchor) {
  const dialog = currentDialog();
  if (dialog) return dialog;
  if (!(anchor instanceof Element) || !anchor.isConnected) return null;
  if (anchor.matches('[data-page-error]')) return anchor;
  const row = anchor.closest('tr, .report, .notification, .staff-claim-row, .admin-item-row, .admin-claim-record');
  if (row) return row;
  return anchor.closest('[data-integration], form, .card, section');
}

function messageText(error) {
  if (typeof error === 'string') return safeServerMessage(error);
  if (error?.userMessage) return safeServerMessage(error.userMessage);
  if (error?.networkError) return 'Could not reach the server. Check your connection and try again.';
  if (error?.status === 429 || (error?.status === 503 && error?.retryAfter > 0)) return error.message;
  if (error?.status >= 500) return 'Something went wrong. Please try again.';
  if (error?.showSignIn) return 'Your access changed. Please sign in again.';
  return safeServerMessage(error?.message);
}

function findFieldErrorTarget(context, name) {
  if (!context || !name) return null;
  const fields = context.querySelectorAll('[name]');
  return [...fields].find((fieldElement) => fieldElement.name === name) || null;
}

function showFieldErrors(error, context) {
  const entries = Object.entries(error.fieldErrors || {});
  let firstField = null;
  let shown = 0;
  for (const [name, message] of entries) {
    const input = findFieldErrorTarget(context, name);
    if (!input || typeof message !== 'string') continue;
    const wrapper = input.closest('.field, .form-field') || input.parentElement;
    if (!wrapper) continue;
    input.setAttribute('aria-invalid', 'true');
    input.classList.add('input-invalid');
    wrapper.classList.add('field-invalid');
    let fieldMessage = [...wrapper.querySelectorAll('[data-shared-field-error], [data-field-error]')]
      .find((element) => element.dataset.fieldError === name || element.hasAttribute('data-shared-field-error'));
    if (!fieldMessage) {
      fieldMessage = document.createElement('small');
      fieldMessage.dataset.sharedFieldError = '';
      wrapper.append(fieldMessage);
    }
    fieldMessage.dataset.fieldError = name;
    fieldMessage.className = 'shared-field-error';
    fieldMessage.setAttribute('role', 'alert');
    fieldMessage.textContent = safeServerMessage(message);
    if (!firstField) firstField = input;
    shown += 1;
  }
  if (shown) {
    lastFieldError = { message: error.message, context, until: Date.now() + 1500 };
    if (!isInViewport(firstField)) scrollIntoView(firstField);
  }
  return shown > 0;
}

function isInViewport(element) {
  if (!element?.getClientRects().length) return false;
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

function scrollIntoView(element) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({
    block: 'nearest',
    behavior: reducedMotion ? 'auto' : 'smooth',
  });
}

function createMessageArea(context, anchor) {
  const prior = context.querySelector('[data-shared-message], [data-message-area], [data-role-change-code-error], [data-integration-code-error], [data-integration-pin-error]');
  if (prior) {
    prior.dataset.sharedMessage = '';
    prior.classList.add('shared-message-area');
    return prior;
  }
  if (context.matches('tr')) {
    const row = document.createElement('tr');
    row.dataset.sharedMessageRow = '';
    const cell = document.createElement('td');
    cell.colSpan = Math.max(1, context.children.length);
    const area = document.createElement('div');
    area.dataset.sharedMessage = '';
    area.className = 'shared-message-area';
    cell.append(area);
    row.append(cell);
    context.parentElement?.insertBefore(row, context.nextElementSibling);
    return area;
  }
  const area = document.createElement('div');
  area.dataset.sharedMessage = '';
  area.className = 'shared-message-area';
  if (context.matches('.report, .notification, .staff-claim-row, .admin-item-row, .admin-claim-record')) {
    context.append(area);
    return area;
  }
  const placement = context.matches('form')
    ? context.querySelector('.form-actions, .integration-card-actions, .integration-pin-actions, button[type="submit"]')
    : context.querySelector('.form-actions, .integration-card-actions, .integration-pin-actions, .admin-item-actions, .staff-decision-actions, button[type="submit"]');
  if (placement?.parentElement) placement.parentElement.insertBefore(area, placement);
  else if (context.matches('form')) context.append(area);
  else if (anchor?.parentElement) anchor.parentElement.insertBefore(area, anchor);
  else context.append(area);
  return area;
}

function showBanner(message, isError, error, autoDismiss) {
  let banner = document.querySelector('[data-shared-error-banner]');
  if (!banner) {
    banner = document.createElement('div');
    banner.dataset.sharedErrorBanner = '';
    banner.className = 'shared-error-banner';
    document.body.append(banner);
  }
  banner.replaceChildren();
  banner.setAttribute('role', isError ? 'alert' : 'status');
  banner.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  const text = document.createElement('span');
  text.textContent = message;
  banner.append(text);
  if (error?.showSignIn) {
    const signIn = document.createElement('a');
    signIn.href = '/?page=login';
    signIn.textContent = 'Sign in';
    banner.append(document.createTextNode(' '), signIn);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'shared-message-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss message');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => banner.remove());
  banner.append(dismiss);
  const displayId = String(++messageSequence);
  banner.dataset.displayId = displayId;
  banner.classList.toggle('alert-error', isError);
  banner.classList.toggle('alert-success', !isError);
  if (autoDismiss && !isError) {
    window.setTimeout(() => {
      if (banner.isConnected && banner.dataset.displayId === displayId) banner.remove();
    }, 6000);
  }
  return banner;
}

function setMessage(area, message, isError, error) {
  area.replaceChildren();
  area.setAttribute('role', isError ? 'alert' : 'status');
  area.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  area.dataset.messageText = message;
  area.classList.toggle('alert-error', isError);
  area.classList.toggle('alert-success', !isError);
  const text = document.createElement('span');
  text.textContent = message;
  area.append(text);
  if (error?.showSignIn) {
    const signIn = document.createElement('a');
    signIn.href = '/?page=login';
    signIn.textContent = 'Sign in';
    area.append(document.createTextNode(' '), signIn);
  }
}

function sameMessageVisible(context, message) {
  const nodes = context?.querySelectorAll('[data-message-text], [data-shared-field-error], [data-field-error], [data-role-change-code-error], [data-integration-code-error], [data-integration-pin-error]') || [];
  const rowMessage = context?.matches('tr') ? context.nextElementSibling?.querySelector('[data-message-text]') : null;
  const localNodes = rowMessage ? [...nodes, rowMessage] : nodes;
  const localMatch = [...localNodes].some((node) => {
    if (!isInViewport(node) && !node.closest('dialog[open]')) return false;
    return node.dataset.messageText === message || node.textContent.trim() === message;
  });
  if (localMatch) return true;
  return lastDisplayedMessage?.message === message
  && lastDisplayedMessage.context === context
  && lastDisplayedMessage.element?.isConnected;
}

function showFormError(error, options = {}) {
  const message = messageText(error);
  const anchor = options.anchor || currentInteraction();
  const context = messageContext(anchor);
  if (error?.status === 429 || (error?.status === 503 && error.retryAfter > 0)) {
    startRateLimit(anchor, error.retryAfter);
  }
  if (context && error?.showSignIn) {
    const area = createMessageArea(context, anchor);
    if (isInViewport(area) || context.matches('dialog[open]') || context.matches('[data-page-error]')) {
      setMessage(area, message, true, error);
      lastDisplayedMessage = { message, context, element: area };
      return area;
    }
  }
  if (context && !error?.showSignIn && error?.status !== 429 && error?.status < 500
    && error?.fieldErrors && showFieldErrors(error, context)) return null;
  if (lastFieldError?.message === message && lastFieldError.context === context
    && lastFieldError.until > Date.now()) return null;
  if (sameMessageVisible(context, message)) return null;
  if (context) {
    const area = createMessageArea(context, anchor);
    if (isInViewport(area) || context.matches('dialog[open]') || context.matches('[data-page-error]')) {
      setMessage(area, message, true, error);
      lastDisplayedMessage = { message, context, element: area };
      return area;
    }
  }
  const banner = showBanner(message, true, error, false);
  lastDisplayedMessage = { message, context, element: banner };
  return banner;
}

function showFormSuccess(message, options = {}) {
  clearFlash();
  const anchor = options.anchor || currentInteraction();
  const context = options.fixed ? null : messageContext(anchor);
  if (sameMessageVisible(context, message)) return null;
  if (context) {
    const area = createMessageArea(context, anchor);
    if (isInViewport(area) || context.matches('dialog[open]')) {
      setMessage(area, safeServerMessage(message), false, null);
      lastDisplayedMessage = { message, context, element: area };
      return area;
    }
  }
  const banner = showBanner(safeServerMessage(message), false, null, options.autoDismiss !== false);
  lastDisplayedMessage = { message, context, element: banner };
  return banner;
}

function startRateLimit(anchor, retryAfter) {
  const control = anchor instanceof Element ? anchor : null;
  const action = control?.matches('button, a') ? control
    : control?.closest('button, a') || control?.querySelector('button[type="submit"]')
      || control?.closest('form')?.querySelector('button[type="submit"]');
  if (!action) return;
  const until = Date.now() + Math.max(1, Number(retryAfter) || 60) * 1000;
  const previous = rateLimitTimers.get(action);
  if (previous) clearInterval(previous);
  action.dataset.rateLimitUntil = String(until);
  action.dataset.rateLimitOriginal = action.dataset.rateLimitOriginal || action.innerHTML;
  if (action.matches('button')) action.disabled = true;
  if (action.matches('a')) {
    action.setAttribute('aria-disabled', 'true');
    action.classList.add('disabled');
  }
  const update = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (remaining) {
      action.textContent = `Retry in ${remaining}s`;
      return;
    }
    clearInterval(rateLimitTimers.get(action));
    rateLimitTimers.delete(action);
    delete action.dataset.rateLimitUntil;
    action.innerHTML = action.dataset.rateLimitOriginal;
    delete action.dataset.rateLimitOriginal;
    if (action.matches('button')) action.disabled = false;
    if (action.matches('a')) {
      action.removeAttribute('aria-disabled');
      action.classList.remove('disabled');
    }
    action.dispatchEvent(new CustomEvent('shared-rate-limit-ended', { bubbles: true, detail: action }));
  };
  update();
  rateLimitTimers.set(action, window.setInterval(update, 1000));
}

function isRateLimited(button) {
  return Boolean(button?.dataset.rateLimitUntil && Number(button.dataset.rateLimitUntil) > Date.now());
}

function clearMessages(context = document) {
  const contains = (element) => context === document || context === element || context.contains?.(element);
  if (lastDisplayedMessage && contains(lastDisplayedMessage.element)) lastDisplayedMessage = null;
  if (lastFieldError && contains(lastFieldError.context)) lastFieldError = null;
  context.querySelectorAll('[data-shared-message-row], [data-shared-field-error]').forEach((element) => element.remove());
  context.querySelectorAll('[data-shared-message]').forEach((element) => {
    if (element.matches('[data-message-area], [data-role-change-code-error], [data-integration-code-error], [data-integration-pin-error]')) {
      element.replaceChildren();
      delete element.dataset.sharedMessage;
      delete element.dataset.messageText;
      element.classList.remove('alert-error', 'alert-success');
    } else {
      element.remove();
    }
  });
  if (context.matches?.('tr') && context.nextElementSibling?.matches('[data-shared-message-row]')) {
    context.nextElementSibling.remove();
  }
  context.querySelectorAll('[data-field-error], [data-role-change-code-error], [data-integration-code-error], [data-integration-pin-error]').forEach((element) => {
    element.textContent = '';
  });
  context.querySelectorAll('[aria-invalid="true"]').forEach((element) => {
    element.removeAttribute('aria-invalid');
    element.classList.remove('input-invalid');
    element.closest('.field, .form-field')?.classList.remove('field-invalid');
  });
  document.querySelector('[data-shared-error-banner]')?.remove();
}

function installMessageListeners() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    lastInteraction = target.closest('button, a, input[type="submit"], [data-action]') || target;
    if (target.closest('button, input[type="submit"], [data-action]')) {
      clearMessages(messageContext(lastInteraction) || document);
    }
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    lastInteraction = event.submitter || form.querySelector('button[type="submit"]') || form;
    clearMessages(messageContext(lastInteraction) || form);
  }, true);
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    clearMessages(target.closest('form, [data-integration], dialog') || target.parentElement || document);
  }, true);
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    clearMessages(target.closest('form, [data-integration], dialog') || target.parentElement || document);
  }, true);
}

installMessageListeners();

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
  return sessionInfo.rolePermissions.includes(permission);
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
    resolved: 'Resolved',
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
        : [
          ...(hasPermission('view_admin_dashboard') ? [['admin-dashboard', 'Dashboard', 'home']] : []),
          ...(hasPermission('view_users') || hasPermission('manage_permissions')
            ? [['admin-users', 'User Management', 'user', hasPermission('view_users')
              ? '/?page=admin-users' : '/?page=admin-users&amp;tab=role-defaults']]
            : []),
          ...(hasPermission('view_system_records') ? [['admin-system-records', 'System Records', 'file']] : []),
          ...(hasPermission('view_all_items') ? [['admin-items', 'All Items', 'file']] : []),
          ...(hasPermission('view_all_claims') ? [['admin-claims', 'All Claims', 'clipboard']] : []),
          ...(hasPermission('generate_inventory_report') ? [['admin-inventory', 'Inventory Report', 'clipboard']] : []),
          ...(hasPermission('manage_integrations') ? [['admin-settings', 'Settings', 'settings']] : []),
          ...(hasPermission('view_admin_dashboard') ? [['admin-security', 'Security', 'shield']] : []),
        ])
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
    const nav = navigation.map(([key, label, iconName, href]) => `<a class="sidebar-link${page === key ? ' active' : ''}" href="${href || `/?page=${key}`}">
      ${icon(iconName)}${h(label)}${key === 'notifications' && sessionInfo.unreadNotifications
        ? `<span class="notification-count">${sessionInfo.unreadNotifications > 99 ? '99+' : sessionInfo.unreadNotifications}</span>` : ''}</a>`).join('');
    const initial = h((user.full_name || '?').charAt(0).toUpperCase());
    const brandHref = user.role_name === 'admin'
      ? hasPermission('view_admin_dashboard') ? '/?page=admin-dashboard'
        : hasPermission('view_users') ? '/?page=admin-users'
          : '/?page=admin-users&amp;tab=role-defaults'
      : '/?page=dashboard';
    return `<div class="app">
      <aside class="sidebar" id="sidebar">
        <a class="sidebar-brand" href="${brandHref}"><span class="brand-mark">${icon('shield', 22)}</span><span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></a>
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
  return message ? `<div class="alert ${error ? 'alert-error' : 'alert-success'}" role="${error ? 'alert' : 'status'}">${h(message)}</div>` : '';
}
function empty(message) { return `<div class="empty">${h(message)}</div>`; }
function reportRows(items, staff = false) {
  if (!items.length) return `<p class="empty">${staff ? 'No item records match these filters.' : 'No reports submitted yet.'}</p>`;
  return `<div class="report-list">${items.map((item) => {
    const editable = !staff && sessionInfo.user?.id === item.user_id && item.status === item.item_type
      && hasPermission('edit_my_report');
    const cancellable = !staff && sessionInfo.user?.id === item.user_id && item.status === item.item_type
      && hasPermission('cancel_my_report');
    const resolvable = cancellable && item.item_type === 'lost';
    const canReviewStaffItem = staff && (item.item_type === 'lost'
      ? hasPermission('review_lost_report')
      : hasPermission('view_found_items'));
    const canCheckMatches = !staff && item.item_type === 'lost' && item.status === 'lost'
      && hasPermission('view_items') && hasPermission('filter_items');
    const matchQuery = new URLSearchParams({ page: 'items', item_type: 'found' });
    if (item.category) matchQuery.set('category', item.category);
    if (item.location) matchQuery.set('location', item.location);
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
          ${canCheckMatches ? `<a class="button button-outline" href="/?${h(matchQuery.toString())}">Check possible matches</a>` : ''}
          ${resolvable ? formAction('resolve-report', item.id, 'Mark as resolved', 'primary') : ''}
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

function stickyActionBar(actions, className = '') {
  return `<div class="sticky-action-bar${className ? ` ${h(className)}` : ''}">
    <div class="sticky-action-bar-message" data-message-area></div>
    <div class="sticky-action-bar-buttons">${actions}</div>
  </div>`;
}

function setSessionInfo(value) {
  Object.assign(sessionInfo, value);
}

export { API, app, sessionInfo, h, date, param, link, buttonLink, badge, field, selectField, optionsFrom, locationOptions, otherLocationValue, otherLocationField, request, icon, roleLabel, hasPermission, itemStatusLabel, itemTypeLabel, frontendHref, shell, pageHeader, alert, empty, reportRows, table, statCards, formAction, showFormError, showFormSuccess, showPendingFlash, isRateLimited, stickyActionBar, setSessionInfo };
