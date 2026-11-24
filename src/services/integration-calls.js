const config = require('../config');

const FAILURE_CODES = new Set([
  'invalid_credentials',
  'network',
  'timeout',
  'provider_error',
  'calendar_not_shared',
]);
const RATE_LIMIT_AUDIT_WINDOW_MS = 10 * 60 * 1000;

const SAFE_REASONS = {
  invalid_credentials: 'Credentials rejected by provider',
  network: 'Provider could not be reached',
  timeout: 'Connection timed out',
  provider_error: 'Provider is temporarily unavailable',
  calendar_not_shared: 'Calendar not shared with the service account',
};

const SAFE_MESSAGES = {
  google_auth: 'Google sign-in is temporarily unavailable. Please use email and password.',
  recaptcha: 'Verification is temporarily unavailable. Please try again later.',
  smtp: 'Email could not be sent. Please try again later.',
  google_calendar: 'Google Calendar is temporarily unavailable. Please try again later.',
};

const PROVIDER_TIMEOUT_MS = 10_000;
const FAILURE_AUDIT_WINDOW_MS = 10 * 60 * 1000;

class IntegrationError extends Error {
  constructor(integrationId, code, { retryAfter } = {}) {
    if (code === 'rate_limited') {
      super('Please try again shortly');
      this.name = 'IntegrationError';
      this.status = 429;
      this.integrationId = integrationId;
      this.code = code;
      this.retryAfter = retryAfter;
      return;
    }
    const safeCode = FAILURE_CODES.has(code) ? code : 'provider_error';
    const message = integrationId === 'google_calendar' && safeCode === 'calendar_not_shared'
      ? 'Calendar not shared with the service account.'
      : SAFE_MESSAGES[integrationId] || 'This feature is temporarily unavailable. Please try again later.';
    super(message);
    this.name = 'IntegrationError';
    this.status = 503;
    this.integrationId = integrationId;
    this.code = safeCode;
  }
}

class UserProviderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserProviderError';
    this.status = status;
    this.integrationFailure = false;
  }
}

function providerFailure(code) {
  const error = new Error('Integration provider request failed.');
  error.integrationFailureCode = FAILURE_CODES.has(code) ? code : 'provider_error';
  return error;
}

function createIntegrationCaller({
  integrationSettings,
  audit,
  rateLimits,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  const rateLimitAuditWindows = new Map();
  const validationFailures = new Map();
  const validationCooldowns = new Map();
  const { integrationRouteLimits, integrationRateLimits } = config;

  async function consumeIntegrationBucket(integrationId, options = {}) {
    if (!integrationSettings.getIntegration) return;
    const integration = await integrationSettings.getIntegration(integrationId);
    const limit = Math.max(
      integrationRateLimits.minimum,
      Math.min(integrationRateLimits.maximum, Number(
        integration.settings?.rate_limit_per_minute
        || integrationRateLimits.defaultPerMinute[integrationId]
        || integrationRateLimits.maximum,
      )),
    );
    const timestamp = now();
    const windowMs = integrationRateLimits.bucketWindowMs;
    const bucketId = options.bucketKey
      ? `${integrationId}:${options.bucketKey}`
      : integrationId;
    let bucket = buckets.get(bucketId);
    if (!bucket) {
      bucket = { tokens: limit, updatedAt: timestamp, limit };
      buckets.set(bucketId, bucket);
    } else {
      const elapsed = timestamp - bucket.updatedAt;
      bucket.tokens = Math.min(bucket.limit, bucket.tokens + (elapsed / windowMs) * bucket.limit);
      if (limit > bucket.limit) {
        bucket.tokens = Math.min(limit, bucket.tokens + (limit - bucket.limit));
      } else {
        bucket.tokens = Math.min(bucket.tokens, limit);
      }
      bucket.updatedAt = timestamp;
      bucket.limit = limit;
    }
    if (bucket.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil(
        ((1 - bucket.tokens) / limit) * windowMs / 1000,
      ));
      throw new IntegrationError(integrationId, 'rate_limited', { retryAfter });
    }
    bucket.tokens -= 1;
  }

  async function recordValidationFailure(integrationId) {
    if (rateLimits) return rateLimits.recordValidationFailure(integrationId);
    const timestamp = now();
    let failures = (validationFailures.get(integrationId) || []).filter(
      (at) => timestamp - at < integrationRouteLimits.validationFailureWindowMs,
    );
    failures.push(timestamp);
    validationFailures.set(integrationId, failures);
    if (failures.length >= integrationRouteLimits.validationFailureCount) {
    validationCooldowns.set(integrationId, timestamp + integrationRouteLimits.validationCooldownMs);
    }
  }

  async function checkValidationCooldown(integrationId) {
    if (rateLimits) return rateLimits.checkValidationCooldown(integrationId);
    const until = validationCooldowns.get(integrationId);
    if (until && now() < until) {
      const error = new Error('Could not verify, try again');
      error.status = 429;
      error.code = 'validation_cooldown';
      throw error;
    }
  }

  async function clearValidationFailures(integrationId) {
    if (rateLimits) return rateLimits.clearValidationFailures(integrationId);
    validationFailures.delete(integrationId);
    validationCooldowns.delete(integrationId);
  }

  async function recordRateLimitAudit(integrationId, bucketKey) {
    if (rateLimits?.recordIntegrationRateLimitAudit) {
      await rateLimits.recordIntegrationRateLimitAudit(integrationId, bucketKey);
      return;
    }
    const timestamp = now();
    const previous = rateLimitAuditWindows.get(integrationId);
    if (previous && timestamp - previous.loggedAt < RATE_LIMIT_AUDIT_WINDOW_MS) {
      previous.suppressedCount += 1;
      return;
    }
    const suppressedCount = previous?.suppressedCount || 0;
    rateLimitAuditWindows.set(integrationId, { loggedAt: timestamp, suppressedCount: 0 });
    try {
      await audit.logAction({
        action: 'integration.rate_limited',
        target_type: 'integration',
        target_id: integrationId,
        new_value: { suppressed_count: suppressedCount },
        result: 'failed',
      });
    } catch {
      console.error(`Integration ${integrationId} rate-limit audit failed.`);
    }
  }

  async function callIntegration(integrationId, operation, auditContext = {}, options = {}) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      if (options.purpose !== 'admin_check') {
        await consumeIntegrationBucket(integrationId, options);
      }
      if (options.candidateValidation) await checkValidationCooldown(integrationId);
      const operationPromise = Promise.resolve().then(() => operation({ signal: controller.signal }));
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(providerFailure('timeout'));
        }, Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
          ? Math.min(options.timeoutMs, timeoutMs)
          : timeoutMs);
      });
      const result = await Promise.race([operationPromise, timeoutPromise]);
      if (!options.candidateValidation && !options.skipHealth) {
        await integrationSettings.recordIntegrationSuccess(integrationId);
      }
      return result;
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'rate_limited') {
        await recordRateLimitAudit(integrationId, options.bucketKey);
        throw error;
      }
      if (error?.integrationFailure === false) throw error;

      const code = timedOut ? 'timeout' : classifyProviderError(error, integrationId);
      if (!code) throw error;

      if (!options.candidateValidation && !options.skipHealth) {
        await recordFailure(integrationId, code, auditContext);
      }
      throw new IntegrationError(integrationId, code);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  callIntegration.checkValidationCooldown = checkValidationCooldown;
  callIntegration.recordValidationFailure = recordValidationFailure;
  callIntegration.clearValidationFailures = clearValidationFailures;
  return callIntegration;

  async function recordFailure(integrationId, code, auditContext) {
    const health = {
      code,
      message: SAFE_REASONS[code],
      at: new Date(),
    };
    try {
      await integrationSettings.recordIntegrationFailure(integrationId, health);
    } catch {
      console.error(`Integration ${integrationId} health update failed (${code}).`);
    }
    console.error(`Integration ${integrationId} failed (${code}).`);

    try {
      if (await integrationSettings.claimIntegrationFailureAudit(
        integrationId, new Date(now() - FAILURE_AUDIT_WINDOW_MS),
      )) {
        await audit.logAction({
          ...auditContext,
          action: 'integration.failure',
          target_type: 'integration',
          target_id: integrationId,
          new_value: { code },
          result: 'failed',
        });
      }
    } catch {
      console.error(`Integration ${integrationId} audit update failed (${code}).`);
    }
  }
}

function classifyProviderError(error, integrationId) {
  const providerCode = String(error?.integrationFailureCode || '').toLowerCase();
  if (FAILURE_CODES.has(providerCode)) return providerCode;

  const codes = [
    error?.code,
    error?.cause?.code,
    error?.errno,
    error?.cause?.errno,
    error?.response?.data?.error,
    error?.response?.data?.error_code,
    error?.response?.data?.['error-codes'],
    error?.response?.status,
    error?.status,
    error?.responseCode,
  ].flat().map((value) => String(value || '').toLowerCase());

  if (integrationId === 'google_auth') {
    if (codes.includes('invalid_grant')) return null;
    if (codes.some((value) => ['invalid_client', 'unauthorized_client'].includes(value))) {
      return 'invalid_credentials';
    }
  }
  if (integrationId === 'recaptcha') {
    if (codes.some((value) => ['invalid-input-secret', 'missing-input-secret'].includes(value))) {
      return 'invalid_credentials';
    }
    if (codes.some((value) => ['invalid-input-response', 'timeout-or-duplicate'].includes(value))) {
      return null;
    }
  }
  if (integrationId === 'smtp'
    && (codes.includes('eauth') || codes.includes('535') || codes.includes('534'))) {
    return 'invalid_credentials';
  }
  if (integrationId === 'google_calendar' && codes.some((value) => ['403', '404'].includes(value))) {
    return 'calendar_not_shared';
  }

  if (codes.some((value) => [
    'eai_again', 'enotfound', 'econnreset', 'econnrefused', 'etimedout',
    'esocket', 'econnection', 'epipe', 'econnaborted', 'ehostunreach',
    'enetunreach', 'err_socket_closed',
  ].includes(value)) || error?.name === 'AbortError') {
    return error?.name === 'AbortError' ? 'timeout' : 'network';
  }
  if (codes.includes('und_err_connect_timeout') || codes.includes('und_err_headers_timeout')) return 'timeout';

  const status = Number(error?.response?.status || error?.status);
  if (status >= 500 && status <= 599) return 'provider_error';
  if (status === 401 || status === 403) return 'invalid_credentials';
  if (integrationId === 'smtp' && error?.code === 'EENVELOPE') return null;
  if (error?.isAxiosError || error?.response) return 'provider_error';
  return null;
}

module.exports = {
  createIntegrationCaller,
  IntegrationError,
  UserProviderError,
  providerFailure,
  classifyProviderError,
  PROVIDER_TIMEOUT_MS,
};
