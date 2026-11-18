const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function positiveIntegerEnv(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum) {
    throw new Error(`${name} must be a whole number between 1 and ${maximum}.`);
  }
  return Number(raw);
}

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
  maximum: 300,
  defaultPerMinute: {
    google_auth: 20,
    recaptcha: 20,
    smtp: 60,
    google_calendar: 60,
    admin_mfa: 10,
  },
};

module.exports = {
  sessionSecret: process.env.SESSION_SECRET || 'replace-this-session-secret-before-deployment',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongodbDatabase: process.env.MONGODB_DATABASE || 'lost_and_found',
  integrationEncryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || '',
  integrationSettingsPin: process.env.SU_PIN || '',
  integrationSettingsEmail: process.env.SU_EMAIL || '',
  integrationRouteLimits,
  integrationRateLimits,
  integrationCodeRequestLimit: positiveIntegerEnv('SU_CODE_REQUEST_LIMIT', 5, 100),
  integrationCodeRequestWindowMs: positiveIntegerEnv('SU_CODE_REQUEST_WINDOW_SECONDS', 3600, 86400) * 1000,
  integrationCodeResendMs: positiveIntegerEnv('SU_CODE_RESEND_SECONDS', 60, 3600) * 1000,
  adminMfaDisabled: process.env.ADMIN_MFA_DISABLED === 'true',
  adminMfaRateLimitDisabled: process.env.ADMIN_MFA_RATE_LIMIT_DISABLED === 'true'
    && process.env.NODE_ENV !== 'production',
  adminMfaRateLimitBypassRequested: process.env.ADMIN_MFA_RATE_LIMIT_DISABLED === 'true',
  integrationBootstrapSmtp: {
    host: process.env.SU_SMTP_HOST || '',
    port: process.env.SU_SMTP_PORT || '',
    secure: process.env.SU_SMTP_SECURE || '',
    user: process.env.SU_SMTP_USER || '',
    password: process.env.SU_SMTP_PASSWORD || '',
    from: process.env.SU_SMTP_FROM || '',
  },
};
