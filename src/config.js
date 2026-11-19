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

const bootstrapMail = normalizeBootstrapMail(process.env);

// Integration settings route limits are process-local and reset with the API.
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
  integrationCodeRequestLimit: positiveIntegerEnv('SU_CODE_REQUEST_LIMIT', 5, 100),
  integrationCodeRequestWindowMs: positiveIntegerEnv('SU_CODE_REQUEST_WINDOW_SECONDS', 3600, 86400) * 1000,
  integrationCodeResendMs: positiveIntegerEnv('SU_CODE_RESEND_SECONDS', 60, 3600) * 1000,
  recaptchaAllowTestKeys: process.env.RECAPTCHA_ALLOW_TEST_KEYS === 'true'
    && process.env.NODE_ENV !== 'production',
  adminMfaDisabled: process.env.ADMIN_MFA_DISABLED === 'true',
  adminMfaRateLimitDisabled: process.env.ADMIN_MFA_RATE_LIMIT_DISABLED === 'true'
    && process.env.NODE_ENV !== 'production',
  adminMfaRateLimitBypassRequested: process.env.ADMIN_MFA_RATE_LIMIT_DISABLED === 'true',
  integrationBootstrapSmtp: bootstrapMail.smtp,
};
