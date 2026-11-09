const FAILURE_CODES = new Set([
  'invalid_credentials',
  'network',
  'timeout',
  'provider_error',
  'calendar_not_shared',
]);

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
  constructor(integrationId, code) {
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

function createIntegrationCaller({ integrationSettings, audit, timeoutMs = PROVIDER_TIMEOUT_MS }) {
  return async function callIntegration(integrationId, operation, auditContext = {}) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      const operationPromise = Promise.resolve().then(() => operation({ signal: controller.signal }));
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(providerFailure('timeout'));
        }, timeoutMs);
      });
      const result = await Promise.race([operationPromise, timeoutPromise]);
      await integrationSettings.recordIntegrationSuccess(integrationId);
      return result;
    } catch (error) {
      if (error?.integrationFailure === false) throw error;

      const code = timedOut ? 'timeout' : classifyProviderError(error, integrationId);
      if (!code) throw error;

      await recordFailure(integrationId, code, auditContext);
      throw new IntegrationError(integrationId, code);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

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
        integrationId, new Date(Date.now() - FAILURE_AUDIT_WINDOW_MS),
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
