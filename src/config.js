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
  validation_cooldown: {
    windowMs: integrationRouteLimits.validationFailureWindowMs,
    max: integrationRouteLimits.validationFailureCount,
    cooldownMs: integrationRouteLimits.validationCooldownMs,
    keyType: 'resource',
    store: 'mongo',
    sensitive: true,
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
};

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
