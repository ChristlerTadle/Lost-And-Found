const path = require('node:path');
const { isIP } = require('node:net');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function normalizeBootstrapValue(value) {
  if (typeof value !== 'string') return '';
  let normalized = value.trim();
  if (normalized.length >= 2
    && ['"', "'"].includes(normalized[0])
    && normalized.at(-1) === normalized[0]) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function isValidEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at > 64 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return domain.length <= 253 && domain.includes('.') && domain.split('.').every((label) => (
    label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function isValidSmtpHost(value) {
  if (!value || value.length > 253 || /\s/.test(value)) return false;
  if (isIP(value)) return true;
  return value.split('.').every((label) => (
    label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function normalizeBootstrapMail(env) {
  const email = normalizeBootstrapValue(env.SU_EMAIL);
  const emailError = !email ? 'SU_EMAIL is missing'
    : isValidEmailAddress(email) ? '' : 'SU_EMAIL is invalid';
  const host = normalizeBootstrapValue(env.SU_SMTP_HOST);
  const portValue = normalizeBootstrapValue(env.SU_SMTP_PORT);
  const secureValue = normalizeBootstrapValue(env.SU_SMTP_SECURE).toLowerCase();
  const user = normalizeBootstrapValue(env.SU_SMTP_USER);
  const password = normalizeBootstrapValue(env.SU_SMTP_PASSWORD);
  const from = normalizeBootstrapValue(env.SU_SMTP_FROM);
  const fromAddress = /<([^<>]+)>$/.exec(from)?.[1]?.trim() || from;
  const smtpErrors = [];
  if (!host) smtpErrors.push('SU_SMTP_HOST is missing');
  else if (!isValidSmtpHost(host)) smtpErrors.push('SU_SMTP_HOST is invalid');
  const port = portValue ? Number(portValue) : null;
  if (!portValue) smtpErrors.push('SU_SMTP_PORT is missing');
  else if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    smtpErrors.push('SU_SMTP_PORT is invalid');
  }
  if (!secureValue) smtpErrors.push('SU_SMTP_SECURE is missing');
  else if (!['true', 'false'].includes(secureValue)) smtpErrors.push('SU_SMTP_SECURE is invalid');
  if (!user) smtpErrors.push('SU_SMTP_USER is missing');
  if (!password) smtpErrors.push('SU_SMTP_PASSWORD is missing');
  if (!from) smtpErrors.push('SU_SMTP_FROM is missing');
  else if (!isValidEmailAddress(fromAddress)) smtpErrors.push('SU_SMTP_FROM is invalid');
  return {
    email,
    emailError,
    smtp: {
      host,
      port: smtpErrors.includes('SU_SMTP_PORT is invalid') || !portValue ? null : port,
      secure: ['true', 'false'].includes(secureValue) ? secureValue === 'true' : null,
      user,
      password,
      from,
    },
    smtpErrors,
  };
}

function positiveIntegerEnv(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum) {
    throw new Error(`${name} must be a whole number between 1 and ${maximum}.`);
  }
  return Number(raw);
}

function hasEnvironmentOverride(name) {
  return process.env[name] !== undefined && process.env[name] !== '';
}

function parseTrustProxy(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (Number.isSafeInteger(hops) && hops <= 100) return hops;
    throw new Error('TRUST_PROXY must be false, a hop count from 0 to 100, or a comma-separated CIDR list.');
  }
  const addresses = raw.split(',').map((entry) => entry.trim());
  const valid = addresses.every((entry) => {
    const [address, prefix, ...extra] = entry.split('/');
    const version = isIP(address);
    if (!version || extra.length) return false;
    if (prefix === undefined) return true;
    const bits = Number(prefix);
    return /^\d+$/.test(prefix) && Number.isInteger(bits)
      && bits >= 0 && bits <= (version === 4 ? 32 : 128);
  });
  if (!valid) {
    throw new Error('TRUST_PROXY must be false, a hop count from 0 to 100, or a comma-separated CIDR list.');
  }
  return addresses;
}

const bootstrapMail = normalizeBootstrapMail(process.env);

// Shared by integration settings throttles and their route limiter groups.
const integrationRouteLimits = {
  saveValidationWindowMs: 10 * 60 * 1000,
  saveValidationLimit: 10,
  testWindowMs: 10 * 60 * 1000,
  testLimit: 10,
  restoreWindowMs: 10 * 60 * 1000,
  restoreLimit: 5,
  adminSettingsWindowMs: 10 * 60 * 1000,
  adminSettingsLimit: 100,
  validationFailureWindowMs: 10 * 60 * 1000,
  validationFailureCount: 5,
  validationCooldownMs: 5 * 60 * 1000,
};

const integrationCodeRequestLimit = positiveIntegerEnv('SU_CODE_REQUEST_LIMIT', 5, 100);
const integrationCodeRequestWindowMs = positiveIntegerEnv('SU_CODE_REQUEST_WINDOW_SECONDS', 3600, 86400) * 1000;
const integrationCodeResendMs = positiveIntegerEnv('SU_CODE_RESEND_SECONDS', 60, 3600) * 1000;

const integrationRateLimits = {
  bucketWindowMs: 60 * 1000,
  minimum: 1,
  maximum: 600,
  defaultPerMinute: {
    google_auth: 20,
    recaptcha: 60,
    smtp: 10,
    google_calendar: 30,
    admin_mfa: 30,
  },
};

const rateLimits = {
  global_api: {
    windowMs: 15 * 60 * 1000,
    max: 1500,
    keyType: 'ip',
    store: 'memory',
    sensitive: false,
  },
  register: {
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyType: 'ip',
    store: 'mongo',
    sensitive: false,
  },
  login: {
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyType: 'ip+email',
    store: 'mongo',
    sensitive: true,
    failedStatus: 401,
  },
  forgot: {
    rateLimitedMessage: 'If an active account uses that email, reset instructions have been sent.',
    rules: [
      {
        group: 'forgot_ip',
        windowMs: 60 * 60 * 1000,
        max: 10,
        keyType: 'ip',
        store: 'mongo',
        sensitive: true,
      },
      {
        group: 'forgot_email',
        windowMs: 60 * 60 * 1000,
        max: 5,
        keyType: 'email',
        store: 'mongo',
        sensitive: true,
      },
    ],
  },
  reset: {
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyType: 'ip',
    store: 'mongo',
    sensitive: true,
  },
  google_signin: {
    windowMs: 60 * 1000,
    max: 20,
    keyType: 'ip',
    store: 'mongo',
    sensitive: false,
  },
  mfa_login: {
    windowMs: 60 * 1000,
    max: 20,
    keyType: 'ip',
    store: 'mongo',
    sensitive: true,
  },
  settings_overall: {
    windowMs: integrationRouteLimits.adminSettingsWindowMs,
    max: integrationRouteLimits.adminSettingsLimit,
    keyType: 'account',
    store: 'mongo',
    sensitive: false,
    rateLimitedMessage: true,
  },
  settings_save: {
    windowMs: integrationRouteLimits.saveValidationWindowMs,
    max: integrationRouteLimits.saveValidationLimit,
    keyType: 'account+ip',
    store: 'mongo',
    sensitive: true,
    rateLimitedMessage: true,
  },
  settings_tests: {
    windowMs: integrationRouteLimits.testWindowMs,
    max: integrationRouteLimits.testLimit,
    keyType: 'account+ip',
    store: 'mongo',
    sensitive: true,
    rateLimitedMessage: true,
  },
  settings_verify: {
    windowMs: integrationRouteLimits.testWindowMs,
    max: integrationRouteLimits.testLimit,
    keyType: 'account+resource',
    store: 'mongo',
    sensitive: true,
    rateLimitedMessage: true,
  },
  settings_default: {
    windowMs: integrationRouteLimits.restoreWindowMs,
    max: integrationRouteLimits.restoreLimit,
    keyType: 'account+ip',
    store: 'mongo',
    sensitive: true,
    rateLimitedMessage: true,
  },
  settings_read: {
    windowMs: 60 * 1000,
    max: 60,
    keyType: 'account',
    store: 'memory',
    sensitive: false,
  },
  mfa_enrollment: {
    windowMs: 10 * 60 * 1000,
    max: 10,
    keyType: 'account+ip',
    store: 'mongo',
    sensitive: true,
    rateLimitedMessage: true,
  },
  user_reads: { windowMs: 60 * 1000, max: 120, keyType: 'account', store: 'memory', sensitive: false },
  item_images: { windowMs: 60 * 1000, max: 600, keyType: 'account', store: 'memory', sensitive: false },
  report_create: { windowMs: 60 * 60 * 1000, max: 20, keyType: 'account+ip', store: 'mongo', sensitive: false },
  report_edit: { windowMs: 60 * 60 * 1000, max: 30, keyType: 'account+ip', store: 'mongo', sensitive: false },
  report_cancel: { windowMs: 60 * 60 * 1000, max: 30, keyType: 'account+ip', store: 'mongo', sensitive: false },
  image_upload: { windowMs: 60 * 60 * 1000, max: 20, keyType: 'account+ip', store: 'mongo', sensitive: false },
  claim_submit: { windowMs: 60 * 60 * 1000, max: 10, keyType: 'account+ip', store: 'mongo', sensitive: false },
  claim_item: { windowMs: 24 * 60 * 60 * 1000, max: 3, keyType: 'account+item', store: 'mongo', sensitive: false },
  profile_edit: { windowMs: 60 * 60 * 1000, max: 10, keyType: 'account+ip', store: 'mongo', sensitive: false },
  notification_read: { windowMs: 60 * 1000, max: 120, keyType: 'account', store: 'memory', sensitive: false },
  notification_write: { windowMs: 60 * 1000, max: 60, keyType: 'account+ip', store: 'mongo', sensitive: false },
  staff_reads: { windowMs: 60 * 1000, max: 240, keyType: 'account', store: 'memory', sensitive: false },
  staff_item_images: { windowMs: 60 * 1000, max: 600, keyType: 'account', store: 'memory', sensitive: false },
  staff_writes: { windowMs: 60 * 1000, max: 60, keyType: 'account+ip', store: 'mongo', sensitive: false },
  staff_calendar_retry: { windowMs: 10 * 60 * 1000, max: 10, keyType: 'account+ip', store: 'mongo', sensitive: false },
  admin_reads: { windowMs: 60 * 1000, max: 240, keyType: 'account', store: 'memory', sensitive: false },
  admin_item_images: { windowMs: 60 * 1000, max: 600, keyType: 'account', store: 'memory', sensitive: false },
  admin_user_write: { windowMs: 10 * 60 * 1000, max: 30, keyType: 'account+ip', store: 'mongo', sensitive: false },
  role_permission_write: { windowMs: 10 * 60 * 1000, max: 20, keyType: 'account+ip', store: 'mongo', sensitive: false },
  admin_item_write: { windowMs: 10 * 60 * 1000, max: 30, keyType: 'account+ip', store: 'mongo', sensitive: false },
  admin_inventory: { windowMs: 60 * 1000, max: 10, keyType: 'account', store: 'memory', sensitive: false },
  admin_system_records: { windowMs: 60 * 1000, max: 60, keyType: 'account', store: 'memory', sensitive: false },
};

const rateLimitControls = {
  integrationSettings: {
    accessWindowMs: 10 * 60 * 1000,
    pinAttemptLimit: 5,
    pinLockMs: 15 * 60 * 1000,
    codeTtlMs: 10 * 60 * 1000,
    codeAttemptLimit: 5,
    codeRequestLimit: integrationCodeRequestLimit,
    codeRequestWindowMs: integrationCodeRequestWindowMs,
    codeResendMs: integrationCodeResendMs,
    codeSendFailureLimit: 10,
    testEmailRequestLimit: 3,
    emailRequestWindowMs: 60 * 60 * 1000,
  },
  adminMfa: {
    attemptWindowMs: 15 * 60 * 1000,
    maxAttempts: 5,
    lockMs: 15 * 60 * 1000,
  },
  validationCooldown: {
    windowMs: integrationRouteLimits.validationFailureWindowMs,
    max: integrationRouteLimits.validationFailureCount,
    cooldownMs: integrationRouteLimits.validationCooldownMs,
    keyType: 'resource',
    store: 'mongo',
    sensitive: true,
  },
};

const rateLimitMetadata = {
  global_api: { label: 'API flood guard', module: 'Public and auth', action: 'API requests' },
  register: { label: 'Account registration', module: 'Public and auth', action: 'Register' },
  login: { label: 'Login failures', module: 'Public and auth', action: 'Sign in' },
  forgot: { label: 'Forgot password', module: 'Public and auth', action: 'Request a reset' },
  forgot_ip: { label: 'Forgot-password IP cap', module: 'Public and auth', action: 'Request a reset' },
  forgot_email: { label: 'Forgot-password email cap', module: 'Public and auth', action: 'Request a reset' },
  reset: { label: 'Password reset', module: 'Public and auth', action: 'Reset password' },
  google_signin: { label: 'Google sign-in', module: 'Public and auth', action: 'Start or complete Google sign-in' },
  mfa_login: { label: 'MFA login verification', module: 'Public and auth', action: 'Verify sign-in code' },
  user_reads: { label: 'User reads', module: 'User', action: 'Read items, claims, and profile' },
  item_images: { label: 'Item images', module: 'User', action: 'Load item images' },
  report_create: { label: 'Create report', module: 'User', action: 'Submit a report' },
  report_edit: { label: 'Edit report', module: 'User', action: 'Edit a report' },
  report_cancel: { label: 'Cancel or resolve report', module: 'User', action: 'Cancel or resolve a report' },
  image_upload: { label: 'Image uploads', module: 'User', action: 'Upload a report image' },
  claim_submit: { label: 'Claim submissions', module: 'User', action: 'Submit a claim' },
  claim_item: { label: 'Claims per item', module: 'User', action: 'Claim the same item' },
  profile_edit: { label: 'Profile edits', module: 'User', action: 'Save profile changes' },
  notification_read: { label: 'Notification reads', module: 'User', action: 'Load notifications' },
  notification_write: { label: 'Notification updates', module: 'User', action: 'Mark notifications read' },
  staff_reads: { label: 'Staff reads', module: 'Staff', action: 'Read staff pages and records' },
  staff_item_images: { label: 'Staff item images', module: 'Staff', action: 'Load staff item images' },
  staff_writes: { label: 'Staff updates', module: 'Staff', action: 'Update item or claim status' },
  staff_calendar_retry: { label: 'Calendar sync retries', module: 'Staff', action: 'Retry claim calendar sync' },
  admin_reads: { label: 'Admin reads', module: 'Admin', action: 'Read admin pages and records' },
  admin_item_images: { label: 'Admin item images', module: 'Admin', action: 'Load admin item images' },
  admin_user_write: { label: 'User management', module: 'Admin', action: 'Create or edit an account' },
  role_permission_write: { label: 'Role and permission changes', module: 'Admin', action: 'Save role or account permissions' },
  admin_item_write: { label: 'Admin item updates', module: 'Admin', action: 'Edit or remove an item' },
  admin_inventory: { label: 'Inventory report', module: 'Admin', action: 'Generate inventory' },
  admin_system_records: { label: 'System records', module: 'Admin', action: 'Read the audit log' },
  settings_overall: { label: 'Settings overall', module: 'Settings and security', action: 'Use Integration Settings' },
  settings_save: { label: 'Settings saves and code actions', module: 'Settings and security', action: 'Save settings or manage verification code' },
  settings_tests: { label: 'Settings connection tests', module: 'Settings and security', action: 'Test integrations' },
  settings_verify: { label: 'Settings verification', module: 'Settings and security', action: 'Verify an integration' },
  settings_default: { label: 'Settings defaults', module: 'Settings and security', action: 'Set or restore an integration default' },
  settings_read: { label: 'Settings reads', module: 'Settings and security', action: 'Read Integration Settings' },
  mfa_enrollment: { label: 'MFA enrollment actions', module: 'Settings and security', action: 'Enroll or regenerate recovery codes' },
  validation_cooldown: { label: 'Integration validation cooldown', module: 'Integrations', action: 'Validate integration credentials' },
};

const rateLimitControlRows = [
  {
    id: 'pin_lockout', label: 'Settings PIN lockout', module: 'Settings and security',
    action: 'Five failed PIN attempts trigger a 15-minute lockout',
    max: rateLimitControls.integrationSettings.pinAttemptLimit,
    windowMs: rateLimitControls.integrationSettings.pinLockMs,
    keyType: 'account+ip', store: 'mongo', sensitive: true, source: 'default',
  },
  {
    id: 'email_code_requests', label: 'Verification-code requests', module: 'Settings and security',
    action: 'Request a verification email',
    max: rateLimitControls.integrationSettings.codeRequestLimit,
    windowMs: rateLimitControls.integrationSettings.codeRequestWindowMs,
    keyType: 'account', store: 'mongo', sensitive: true,
    source: hasEnvironmentOverride('SU_CODE_REQUEST_LIMIT')
      || hasEnvironmentOverride('SU_CODE_REQUEST_WINDOW_SECONDS') ? 'env' : 'default',
  },
  {
    id: 'email_code_resend', label: 'Verification-code resend cooldown', module: 'Settings and security',
    action: 'Wait between verification-code emails',
    max: 1, windowMs: rateLimitControls.integrationSettings.codeResendMs,
    keyType: 'account', store: 'mongo', sensitive: true,
    source: hasEnvironmentOverride('SU_CODE_RESEND_SECONDS') ? 'env' : 'default',
  },
  {
    id: 'email_code_attempts', label: 'Verification-code attempts', module: 'Settings and security',
    action: 'Verify the emailed code before it expires',
    max: rateLimitControls.integrationSettings.codeAttemptLimit,
    windowMs: rateLimitControls.integrationSettings.codeTtlMs,
    keyType: 'session', store: 'mongo', sensitive: true, source: 'default',
  },
  {
    id: 'failed_email_sends', label: 'Failed verification-email sends', module: 'Settings and security',
    action: 'Failed code-delivery attempts',
    max: rateLimitControls.integrationSettings.codeSendFailureLimit,
    windowMs: rateLimitControls.integrationSettings.emailRequestWindowMs,
    keyType: 'account', store: 'mongo', sensitive: true, source: 'default',
  },
  {
    id: 'test_email', label: 'Test-email requests', module: 'Settings and security',
    action: 'Send a verification test email',
    max: rateLimitControls.integrationSettings.testEmailRequestLimit,
    windowMs: rateLimitControls.integrationSettings.emailRequestWindowMs,
    keyType: 'account', store: 'mongo', sensitive: true, source: 'default',
  },
  {
    id: 'mfa_lockout', label: 'Admin MFA lockout', module: 'Settings and security',
    action: 'Five failed verification attempts trigger a 15-minute lockout',
    max: rateLimitControls.adminMfa.maxAttempts,
    windowMs: rateLimitControls.adminMfa.attemptWindowMs,
    keyType: 'account+ip', store: 'mongo', sensitive: true, source: 'default',
  },
  {
    id: 'validation_cooldown', label: 'Integration validation cooldown', module: 'Integrations',
    action: 'Five failed validations in the window trigger a 5-minute per-integration block',
    max: rateLimitControls.validationCooldown.max,
    windowMs: rateLimitControls.validationCooldown.windowMs,
    keyType: 'resource', store: 'mongo', sensitive: true, source: 'default',
  },
];

const rateLimitRouteExemptions = [
  // The public health check must remain available while the API flood guard is active.
  { method: 'GET', path: '/health' },
  // Session discovery is intentionally exempt from the per-route auth limiter.
  { method: 'GET', path: '/auth/me' },
  // Signing out must remain possible while auth limits are active.
  { method: 'POST', path: '/auth/logout' },
];

module.exports = {
  sessionSecret: process.env.SESSION_SECRET || 'replace-this-session-secret-before-deployment',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongodbDatabase: process.env.MONGODB_DATABASE || 'lost_and_found',
  integrationEncryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || '',
  integrationSettingsPin: process.env.SU_PIN || '',
  integrationSettingsEmail: bootstrapMail.email,
  integrationSettingsEmailError: bootstrapMail.emailError,
  integrationBootstrapSmtpErrors: bootstrapMail.smtpErrors,
  integrationRouteLimits,
  integrationRateLimits,
  rateLimits,
  rateLimitControls,
  rateLimitMetadata,
  rateLimitControlRows,
  rateLimitRouteExemptions,
  integrationCodeRequestLimit,
  integrationCodeRequestWindowMs,
  integrationCodeResendMs,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  parseTrustProxy,
  recaptchaAllowTestKeys: process.env.RECAPTCHA_ALLOW_TEST_KEYS === 'true'
    && process.env.NODE_ENV !== 'production',
  adminMfaDisabled: process.env.ADMIN_MFA_DISABLED === 'true',
  adminMfaRateLimitDisabled: process.env.ADMIN_MFA_RATE_LIMIT_DISABLED === 'true'
    && process.env.NODE_ENV !== 'production',
  adminMfaRateLimitBypassRequested: process.env.ADMIN_MFA_RATE_LIMIT_DISABLED === 'true',
  integrationBootstrapSmtp: bootstrapMail.smtp,
};
