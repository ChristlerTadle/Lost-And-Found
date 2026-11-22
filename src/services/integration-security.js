const { createHmac, randomInt, timingSafeEqual } = require('node:crypto');
const nodemailer = require('nodemailer');

const ACCESS_WINDOW_MS = 10 * 60 * 1000;
const PIN_LOCK_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CODE_RESEND_MS = 60 * 1000;
const DEFAULT_CODE_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_CODE_REQUEST_LIMIT = 5;
const CODE_SEND_FAILURE_LIMIT = 10;
const TEST_EMAIL_REQUEST_LIMIT = 3;
const EMAIL_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function createIntegrationSecurity(database, {
  pin,
  email,
  emailError = '',
  smtp,
  smtpErrors = [],
  hashKey,
  mailer = nodemailer,
  now = () => Date.now(),
  delay = sleep,
  codeRequestLimit = DEFAULT_CODE_REQUEST_LIMIT,
  codeRequestWindowMs = DEFAULT_CODE_REQUEST_WINDOW_MS,
  codeResendMs = DEFAULT_CODE_RESEND_MS,
  accessWindowMs = ACCESS_WINDOW_MS,
  pinAttemptLimit = 5,
  pinLockMs = PIN_LOCK_MS,
  codeTtlMs = CODE_TTL_MS,
  codeAttemptLimit = MAX_CODE_ATTEMPTS,
  codeSendFailureLimit = CODE_SEND_FAILURE_LIMIT,
  testEmailRequestLimit = TEST_EMAIL_REQUEST_LIMIT,
  emailRequestWindowMs = EMAIL_REQUEST_WINDOW_MS,
} = {}) {
  const attempts = createLimitedCollection(database, 'integration_settings_pin_attempts');
  const codes = createLimitedCollection(database, 'integration_settings_pending_codes');
  const requests = createLimitedCollection(database, 'integration_settings_code_requests');
  const failedCodeSends = createLimitedCollection(database, 'integration_settings_code_send_failures');
  const testEmailRequests = createLimitedCollection(database, 'integration_settings_test_email_requests');
  const codeSendsInProgress = new Set();

  function configuration() {
    const missingAccess = [];
    if (!pin) missingAccess.push('SU_PIN is missing');
    const configuredEmailError = emailError || (!email
      ? 'SU_EMAIL is missing'
      : isValidEmailAddress(email) ? '' : 'SU_EMAIL is invalid');
    if (configuredEmailError) missingAccess.push(configuredEmailError);
    const missingSmtp = smtpErrors.length ? [...smtpErrors] : validateSmtp(smtp);
    return {
      accessReady: missingAccess.length === 0,
      accessError: missingAccess.length
        ? `Integration Settings are locked. ${missingAccess.join('; ')}.`
        : '',
      verificationEmailConfigured: missingSmtp.length === 0,
      verificationEmailError: missingSmtp.length
        ? `${missingSmtp.join('; ')}.`
        : '',
      missingSmtp,
      maskedRecipient: configuredEmailError ? '' : maskEmail(email),
    };
  }

  async function unlock({ adminId, ipAddress, candidate, session, auditContext, audit }) {
    const state = configuration();
    if (!state.accessReady) {
      const error = new Error(state.accessError);
      error.status = 503;
      throw error;
    }

    const accessId = keyedHash(`${adminId}\u0000${ipAddress || ''}`);
    const record = await attempts.findOne({ _id: accessId });
    const timestamp = now();
    if (record?.lockedUntil > timestamp) {
      await auditEvent(audit, auditContext, 'integration.unlock_locked');
      throw pinError();
    }
    let count = Number(record?.count || 0);
    if (record?.lockedUntil && record.lockedUntil <= timestamp) {
      await attempts.updateOne(
        { _id: accessId, lockedUntil: record.lockedUntil },
        { $set: { count: 0, lockedUntil: 0 } },
      );
      count = 0;
    }
    if (count) await delay(Math.min(4000, 250 * (2 ** Math.min(count - 1, 4))));
    const supplied = typeof candidate === 'string' && candidate.length <= 256 ? candidate : '';
    const matches = constantTimeMatch(supplied, pin);
    if (matches) {
      await attempts.deleteOne({ _id: accessId });
      await auditEvent(audit, auditContext, 'integration.unlock');
      session.integrationSettingsAccess = { adminId: String(adminId), lastActivityAt: timestamp };
      return true;
    }

    await attempts.updateOne(
      { _id: accessId },
      { $inc: { count: 1 } },
      { upsert: true },
    );
    const updatedAttempt = await attempts.findOne({ _id: accessId });
    const locked = Number(updatedAttempt?.count || 0) >= pinAttemptLimit;
    if (locked) {
      await attempts.updateOne(
        { _id: accessId },
        { $set: { lockedUntil: timestamp + pinLockMs } },
      );
    }
    await auditEvent(audit, auditContext, locked ? 'integration.unlock_locked' : 'integration.unlock_failed');
    throw pinError();
  }

  function touchSession(session, adminId) {
    const state = session.integrationSettingsAccess;
    const timestamp = now();
    if (!state || state.adminId !== String(adminId) || timestamp - state.lastActivityAt >= accessWindowMs) {
      delete session.integrationSettingsAccess;
      return false;
    }
    state.lastActivityAt = timestamp;
    return true;
  }

  async function sendCode(parameters) {
    const adminKey = String(parameters.adminId);
    if (codeSendsInProgress.has(adminKey)) {
      return failCodeSend(
        'A verification email is already being sent. Try again shortly.',
        'rate_limited',
        429,
        { auditContext: parameters.auditContext, audit: parameters.audit, retryAfter: 1 },
      );
    }
    codeSendsInProgress.add(adminKey);
    try {
      return await sendCodeInternal(parameters);
    } finally {
      codeSendsInProgress.delete(adminKey);
    }
  }

  async function sendCodeInternal({
    adminId, sessionId, payloadHash, changes, requester, ipAddress, auditContext, audit, restoreDefault,
  }) {
    const state = configuration();
    if (!state.accessReady) {
      return failCodeSend(state.accessError, 'not_configured', 503, {
        auditContext, audit,
      });
    }
    if (!state.verificationEmailConfigured) {
      return failCodeSend(state.verificationEmailError, 'not_configured', 503, {
        auditContext, audit,
      });
    }

    const timestamp = now();
    const adminKey = String(adminId);
    const pending = await codes.findOne({ _id: String(sessionId) });
    if (pending?.status === 'sent' && timestamp - pending.sentAt < codeResendMs) {
      const retryAfter = Math.max(1, Math.ceil((codeResendMs - (timestamp - pending.sentAt)) / 1000));
      return failCodeSend(
        `Please wait ${retryAfter} seconds before requesting another verification code.`,
        'rate_limited', 429, { auditContext, audit, retryAfter },
      );
    }
    const recent = (await requests.findOne({ _id: adminKey }))?.timestamps || [];
    if (recent.length && timestamp - recent[recent.length - 1] < codeResendMs) {
      const retryAfter = Math.max(1, Math.ceil((codeResendMs - (timestamp - recent[recent.length - 1])) / 1000));
      return failCodeSend(
        `Please wait ${retryAfter} seconds before requesting another verification code.`,
        'rate_limited', 429, { auditContext, audit, retryAfter },
      );
    }
    const recentRequests = recent.filter((entry) => timestamp - entry < codeRequestWindowMs);
    if (recentRequests.length >= codeRequestLimit) {
      const retryAfter = Math.max(1, Math.ceil(
        (recentRequests[0] + codeRequestWindowMs - timestamp) / 1000,
      ));
      return failCodeSend(
        `The verification code request limit has been reached. Try again in ${retryAfter} seconds.`,
        'rate_limited', 429, { auditContext, audit, retryAfter },
      );
    }
    const failed = (await failedCodeSends.findOne({ _id: adminKey }))?.timestamps || [];
    const recentFailures = failed.filter((entry) => timestamp - entry < emailRequestWindowMs);
    if (recentFailures.length >= codeSendFailureLimit) {
      const retryAfter = Math.max(1, Math.ceil(
        (recentFailures[0] + emailRequestWindowMs - timestamp) / 1000,
      ));
      return failCodeSend(
        `Too many failed verification email sends. Try again in ${retryAfter} seconds.`,
        'rate_limited', 429, { auditContext, audit, retryAfter },
      );
    }

    const code = String(randomInt(100000, 1000000));
    const entry = {
      _id: String(sessionId),
      adminId: adminKey,
      codeHash: keyedHash(`code\u0000${code}`),
      payloadHash,
      status: 'sending',
      integrationIds: [...new Set((changes || []).map(({ integration }) => integration).filter(Boolean))],
      restoreDefault: null,
      expiresAt: timestamp + codeTtlMs,
      sentAt: timestamp,
      attempts: 0,
    };
    entry.restoreDefault = restoreDefault || null;
    await codes.updateOne(
      { _id: entry._id },
      { $set: entry, $unset: { usedAt: '' } },
      { upsert: true },
    );
    try {
      await sendBootstrapEmail({
        to: email,
        subject: 'Integration settings verification code',
        text: formatCodeMessage({ code, changes, requester, ipAddress, timestamp }),
      });
    } catch (error) {
      await codes.deleteOne({ _id: entry._id });
      const category = mailFailureCategory(error);
      const failedAt = now();
      await failedCodeSends.findOneAndUpdate(
        { _id: adminKey },
        { $push: { timestamps: { $each: [failedAt], $slice: -codeSendFailureLimit } } },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false },
      );
      await logCodeSendFailure(audit, auditContext, category);
      throw codeSendError(category, state.maskedRecipient);
    }
    const sentAt = now();
    const expiresAt = sentAt + codeTtlMs;
    await codes.updateOne(
      { _id: entry._id, adminId: adminKey },
      { $set: { status: 'sent', sentAt, expiresAt } },
    );
    await requests.findOneAndUpdate(
      { _id: adminKey },
      { $push: { timestamps: { $each: [sentAt], $slice: -codeRequestLimit } } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    await auditEvent(audit, auditContext, 'integration.code_sent', changes);
    return {
      expiresInSeconds: codeTtlMs / 1000,
      resendInSeconds: codeResendMs / 1000,
      maskedRecipient: state.maskedRecipient,
      expiresAt: new Date(expiresAt).toISOString(),
      resendAvailableAt: new Date(sentAt + codeResendMs).toISOString(),
    };
  }

  async function getPendingCodeStatus({ adminId, sessionId }) {
    const entry = await codes.findOne({ _id: String(sessionId) });
    if (!entry || entry.adminId !== String(adminId) || entry.status !== 'sent'
      || entry.usedAt || entry.expiresAt <= now()) {
      if (entry?.adminId === String(adminId) && entry.expiresAt <= now()) {
        await codes.deleteOne({ _id: String(sessionId), adminId: String(adminId) });
      }
      return null;
    }
    return {
      integrationIds: entry.integrationIds || [],
      restoreDefault: entry.restoreDefault || null,
      maskedRecipient: maskEmail(email),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      resendAvailableAt: new Date(entry.sentAt + codeResendMs).toISOString(),
    };
  }

  async function verifyCode({ adminId, sessionId, candidate, payloadHash, auditContext, audit, changes }) {
    const id = String(sessionId);
    const entry = await codes.findOne({ _id: id });
    if (!entry || entry.adminId !== String(adminId) || entry.status !== 'sent' || entry.usedAt
      || entry.expiresAt <= now()) {
      if (entry && entry.adminId === String(adminId)) await codes.deleteOne({ _id: id });
      await auditEvent(audit, auditContext, 'integration.code_failed', changes);
      throw codeError();
    }
    if (!constantTimeMatch(entry.payloadHash, payloadHash)) {
      await codes.deleteOne({ _id: id });
      await auditEvent(audit, auditContext, 'integration.code_failed', changes);
      const error = new Error('The pending settings changed. Save again to request a new code.');
      error.status = 400;
      throw error;
    }

    const candidateCode = typeof candidate === 'string' && /^\d{6}$/.test(candidate) ? candidate : '';
    if (!constantTimeMatch(keyedHash(`code\u0000${candidateCode}`), entry.codeHash)) {
      await codes.updateOne(
        { _id: id, adminId: String(adminId), usedAt: { $exists: false }, attempts: { $lt: codeAttemptLimit } },
        { $inc: { attempts: 1 } },
      );
      const current = await codes.findOne({ _id: id });
      if (current && current.attempts >= codeAttemptLimit) {
        await codes.deleteOne({ _id: id });
      }
      await auditEvent(audit, auditContext, 'integration.code_failed', changes);
      throw codeError();
    }

    const claimed = await codes.updateOne(
      {
        _id: id,
        adminId: String(adminId),
        codeHash: entry.codeHash,
        attempts: entry.attempts,
        usedAt: { $exists: false },
      },
      { $set: { usedAt: now() } },
    );
    if (claimed.modifiedCount !== 1) {
      await auditEvent(audit, auditContext, 'integration.code_failed', changes);
      throw codeError();
    }
    return true;
  }

  async function cancelCode({ adminId, sessionId }) {
    await codes.deleteOne({ _id: String(sessionId), adminId: String(adminId) });
  }

  async function sendTestEmail({ adminId, auditContext }) {
    const state = configuration();
    if (!state.accessReady) throw configurationError(state.accessError);
    if (!state.verificationEmailConfigured) throw configurationError(state.verificationEmailError);
    const id = String(adminId);
    const timestamp = now();
    const recent = (await testEmailRequests.findOne({ _id: id }))?.timestamps || [];
    const recentAttempts = recent.filter((entry) => timestamp - entry < emailRequestWindowMs);
    if (recentAttempts.length >= testEmailRequestLimit) {
      const retryAfter = Math.max(1, Math.ceil(
        (recentAttempts[0] + emailRequestWindowMs - timestamp) / 1000,
      ));
      const error = new Error(`Test email limit reached. Try again in ${retryAfter} seconds.`);
      error.status = 429;
      error.retryAfter = retryAfter;
      error.reason = 'rate_limited';
      error.maskedRecipient = state.maskedRecipient;
      throw error;
    }
    await testEmailRequests.findOneAndUpdate(
      { _id: id },
      { $push: { timestamps: { $each: [timestamp], $slice: -testEmailRequestLimit } } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    try {
      await sendBootstrapEmail({
        subject: 'Verification email test',
        text: 'This is a test message confirming the verification email service is working.',
      });
    } catch (error) {
      const category = mailFailureCategory(error);
      const safeError = new Error(`Test email could not be sent: ${categoryMessage(category)}.`);
      safeError.status = 503;
      safeError.reason = category;
      safeError.maskedRecipient = state.maskedRecipient;
      throw safeError;
    }
    return { maskedRecipient: state.maskedRecipient };
  }

  async function sendBootstrapEmail({ to = email, subject, text }) {
    const state = configuration();
    if (!state.verificationEmailConfigured) {
      const error = new Error(state.verificationEmailError);
      error.status = 503;
      throw error;
    }
    try {
      const transporter = mailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port),
        secure: String(smtp.secure).toLowerCase() === 'true',
        requireTLS: String(smtp.secure).toLowerCase() !== 'true',
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
        auth: { user: smtp.user, pass: smtp.password },
      });
      const result = await transporter.sendMail({ from: smtp.from, to, subject, text });
      if (result && ((Array.isArray(result.accepted) && !result.accepted.length)
        || (Array.isArray(result.rejected) && result.rejected.length && !result.accepted?.length))) {
        const error = new Error('Bootstrap email recipient was rejected.');
        error.code = 'EENVELOPE';
        throw error;
      }
      return result;
    } catch (error) {
      const code = safeMailErrorCode(error?.code);
      const command = safeMailCommand(error?.command);
      const responseCode = Number.isInteger(error?.responseCode) ? error.responseCode : null;
      console.error('Bootstrap email delivery failed.', JSON.stringify({ code, command, responseCode }));
      throw error;
    }
  }

  function safeMailErrorCode(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null;
  }

  function safeMailCommand(value) {
    return typeof value === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(value) ? value : null;
  }

  function keyedHash(value) {
    return createHmac('sha256', hashKey).update(String(value)).digest('hex');
  }

  async function failCodeSend(message, category, status, { auditContext, audit, retryAfter } = {}) {
    await logCodeSendFailure(audit, auditContext, category);
    const error = new Error(message);
    error.status = status;
    error.reason = category;
    if (retryAfter) error.retryAfter = retryAfter;
    error.maskedRecipient = configuration().maskedRecipient;
    throw error;
  }

  return {
    configuration,
    unlock,
    touchSession,
    sendCode,
    getPendingCodeStatus,
    verifyCode,
    cancelCode,
    sendBootstrapEmail,
    sendTestEmail,
    keyedHash,
  };
}

function validateSmtp(smtp) {
  const errors = [];
  if (!smtp?.host) errors.push('SU_SMTP_HOST is missing');
  if (smtp?.port === undefined || smtp?.port === null || smtp.port === '') {
    errors.push('SU_SMTP_PORT is missing');
  } else if (!/^\d+$/.test(String(smtp.port)) || Number(smtp.port) < 1 || Number(smtp.port) > 65535) {
    errors.push('SU_SMTP_PORT is invalid');
  }
  if (smtp?.secure !== true && smtp?.secure !== false
    && !['true', 'false'].includes(String(smtp?.secure).toLowerCase())) {
    errors.push(smtp?.secure === undefined || smtp?.secure === null || smtp?.secure === ''
      ? 'SU_SMTP_SECURE is missing' : 'SU_SMTP_SECURE is invalid');
  }
  if (!smtp?.user) errors.push('SU_SMTP_USER is missing');
  if (!smtp?.password) errors.push('SU_SMTP_PASSWORD is missing');
  if (!smtp?.from) errors.push('SU_SMTP_FROM is missing');
  return errors;
}

function isValidEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at > 64 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && domain.includes('.') && domain.split('.').every((label) => (
      label.length > 0 && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
}

function maskEmail(value) {
  if (typeof value !== 'string') return '***';
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (at < 1 || local.length <= 1 || !domain) return '***';
  return `${local[0]}***@${domain}`;
}

function mailFailureCategory(error) {
  if (error?.code === 'EAUTH' || error?.responseCode === 535
    || error?.code === 'invalid_credentials') return 'login_rejected';
  return 'unreachable';
}

function categoryMessage(category) {
  return {
    not_configured: 'verification email is not configured',
    login_rejected: 'mail server login was rejected',
    unreachable: 'mail server is unreachable',
    rate_limited: 'too many attempts',
  }[category] || 'mail server is unreachable';
}

function codeSendError(category, maskedRecipient) {
  const error = new Error(`Verification email could not be sent: ${categoryMessage(category)}.`);
  error.status = 503;
  error.reason = category;
  error.maskedRecipient = maskedRecipient;
  return error;
}

function configurationError(message) {
  const error = new Error(message);
  error.status = 503;
  error.reason = 'not_configured';
  return error;
}

async function logCodeSendFailure(audit, auditContext, reason) {
  await audit.logAction({
    ...auditContext,
    action: 'integration.code_send_failed',
    target_type: null,
    target_id: null,
    new_value: { reason },
    result: 'failed',
  });
}

function constantTimeMatch(value, expected) {
  const key = Buffer.alloc(32, 0x5a);
  const left = createHmac('sha256', key).update(String(value)).digest();
  const right = createHmac('sha256', key).update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

function formatCodeMessage({ code, changes, requester, ipAddress, timestamp }) {
  const lines = [
    `Your integration settings verification code is: ${code}`,
    '',
    'Requested changes:',
    ...changes.map(({ integration, label, fields }) => `- ${label || integration}: ${fields.join(', ')}`),
    '',
    `Requested by: ${requester || 'Administrator'}`,
    `Time: ${new Date(timestamp).toISOString()}`,
    `IP: ${ipAddress || 'Unavailable'}`,
    'This code expires in 10 minutes and can be used once.',
  ];
  return lines.join('\n');
}

async function auditEvent(audit, context, action, changes = []) {
  const targets = changes.length ? changes : [{ integration: null, fields: [] }];
  for (const change of targets) {
    await audit.logAction({
      ...context,
      action,
      target_type: change.integration ? 'integration' : null,
      target_id: change.integration,
      new_value: { changed_fields: change.fields },
      result: action === 'integration.unlock_locked' ? 'denied'
        : ['integration.unlock_failed', 'integration.code_failed'].includes(action) ? 'failed'
          : 'success',
    });
  }
}

function pinError() {
  const error = new Error('PIN could not be verified. Try again later.');
  error.status = 403;
  return error;
}

function codeError() {
  const error = new Error('The verification code is invalid or expired.');
  error.status = 400;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createLimitedCollection(database, name) {
  const collection = database.collection(name);
  return new Proxy(collection, {
    get(target, property) {
      const method = target[property];
      if (typeof method !== 'function') return method;
      return (...args) => {
        let timer;
        const operation = Promise.resolve().then(() => method.apply(target, args));
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(storeUnavailableError()), 200);
        });
        return Promise.race([operation, timeout])
          .catch((error) => {
            if (error?.status === 503 && error?.code === 'rate_limit_store_unavailable') throw error;
            throw storeUnavailableError();
          })
          .finally(() => clearTimeout(timer));
      };
    },
  });
}

function storeUnavailableError() {
  const error = new Error('Please try again shortly');
  error.status = 503;
  error.retryAfter = 1;
  error.code = 'rate_limit_store_unavailable';
  return error;
}

module.exports = {
  createIntegrationSecurity,
  ACCESS_WINDOW_MS,
  PIN_LOCK_MS,
  CODE_TTL_MS,
  DEFAULT_CODE_RESEND_MS,
  DEFAULT_CODE_REQUEST_WINDOW_MS,
  DEFAULT_CODE_REQUEST_LIMIT,
};
