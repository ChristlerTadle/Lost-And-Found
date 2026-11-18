const { createHmac, randomInt, timingSafeEqual } = require('node:crypto');
const nodemailer = require('nodemailer');

const ACCESS_WINDOW_MS = 10 * 60 * 1000;
const PIN_LOCK_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CODE_RESEND_MS = 60 * 1000;
const DEFAULT_CODE_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_CODE_REQUEST_LIMIT = 5;
const MAX_CODE_ATTEMPTS = 5;

function createIntegrationSecurity(database, {
  pin,
  email,
  smtp,
  hashKey,
  mailer = nodemailer,
  now = () => Date.now(),
  delay = sleep,
  codeRequestLimit = DEFAULT_CODE_REQUEST_LIMIT,
  codeRequestWindowMs = DEFAULT_CODE_REQUEST_WINDOW_MS,
  codeResendMs = DEFAULT_CODE_RESEND_MS,
} = {}) {
  const attempts = database.collection('integration_settings_pin_attempts');
  const codes = database.collection('integration_settings_pending_codes');
  const requests = database.collection('integration_settings_code_requests');

  function configuration() {
    const missingAccess = [];
    if (!pin) missingAccess.push('SU_PIN');
    if (!email) missingAccess.push('SU_EMAIL');
    const missingSmtp = [];
    for (const name of ['host', 'port', 'secure', 'user', 'password', 'from']) {
      if (smtp?.[name] === undefined || smtp[name] === null || smtp[name] === '') {
        missingSmtp.push(`SU_SMTP_${name.toUpperCase()}`);
      }
    }
    if (smtp?.secure && !['true', 'false'].includes(String(smtp.secure).toLowerCase())) {
      missingSmtp.push('SU_SMTP_SECURE');
    }
    if (smtp?.port && (!/^\d{1,5}$/.test(String(smtp.port))
      || Number(smtp.port) < 1 || Number(smtp.port) > 65535)) {
      missingSmtp.push('SU_SMTP_PORT');
    }
    return {
      accessReady: missingAccess.length === 0,
      accessError: missingAccess.length
        ? `Integration Settings are locked. Configure ${missingAccess.join(' and ')} in the server environment.`
        : '',
      verificationEmailConfigured: missingSmtp.length === 0,
      verificationEmailError: missingSmtp.length
        ? 'Verification email is not configured. Configure all SU_SMTP_* environment variables.'
        : '',
      missingSmtp,
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
    const locked = Number(updatedAttempt?.count || 0) >= 5;
    if (locked) {
      await attempts.updateOne(
        { _id: accessId },
        { $set: { lockedUntil: timestamp + PIN_LOCK_MS } },
      );
    }
    await auditEvent(audit, auditContext, locked ? 'integration.unlock_locked' : 'integration.unlock_failed');
    throw pinError();
  }

  function touchSession(session, adminId) {
    const state = session.integrationSettingsAccess;
    const timestamp = now();
    if (!state || state.adminId !== String(adminId) || timestamp - state.lastActivityAt >= ACCESS_WINDOW_MS) {
      delete session.integrationSettingsAccess;
      return false;
    }
    state.lastActivityAt = timestamp;
    return true;
  }

  async function sendCode({ adminId, sessionId, payloadHash, changes, requester, ipAddress, auditContext, audit }) {
    const state = configuration();
    if (!state.accessReady) {
      const error = new Error(state.accessError);
      error.status = 503;
      throw error;
    }
    if (!state.verificationEmailConfigured) {
      const error = new Error(state.verificationEmailError);
      error.status = 503;
      throw error;
    }

    const timestamp = now();
    const pending = await codes.findOne({ _id: String(sessionId) });
    if (pending && timestamp - pending.sentAt < codeResendMs) {
      const error = new Error('Please wait before requesting another verification code.');
      error.status = 429;
      throw error;
    }
    const recent = (await requests.findOne({ _id: String(adminId) }))?.timestamps || [];
    if (recent.length && timestamp - recent[recent.length - 1] < codeResendMs) {
      const error = new Error('Please wait before requesting another verification code.');
      error.status = 429;
      throw error;
    }
    const recentRequests = recent.filter((entry) => timestamp - entry < codeRequestWindowMs);
    if (recentRequests.length >= codeRequestLimit) {
      const error = new Error('The verification code request limit has been reached. Try again later.');
      error.status = 429;
      throw error;
    }
    await requests.findOneAndUpdate(
      { _id: String(adminId) },
      { $push: { timestamps: { $each: [timestamp], $slice: -codeRequestLimit } } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );

    const code = String(randomInt(100000, 1000000));
    const entry = {
      _id: String(sessionId),
      adminId: String(adminId),
      codeHash: keyedHash(`code\u0000${code}`),
      payloadHash,
      expiresAt: timestamp + CODE_TTL_MS,
      sentAt: timestamp,
      attempts: 0,
    };
    await codes.updateOne({ _id: entry._id }, { $set: entry }, { upsert: true });
    try {
      await sendBootstrapEmail({
        to: email,
        subject: 'Integration settings verification code',
        text: formatCodeMessage({ code, changes, requester, ipAddress, timestamp }),
      });
    } catch {
      await codes.deleteOne({ _id: entry._id });
      const error = new Error('The verification email could not be sent. Check the SU_SMTP_* configuration.');
      error.status = 503;
      throw error;
    }
    await auditEvent(audit, auditContext, 'integration.code_sent', changes);
    return {
      expiresInSeconds: CODE_TTL_MS / 1000,
      resendInSeconds: codeResendMs / 1000,
    };
  }

  async function verifyCode({ adminId, sessionId, candidate, payloadHash, auditContext, audit, changes }) {
    const id = String(sessionId);
    const entry = await codes.findOne({ _id: id });
    if (!entry || entry.adminId !== String(adminId) || entry.usedAt
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
        { _id: id, adminId: String(adminId), usedAt: { $exists: false }, attempts: { $lt: MAX_CODE_ATTEMPTS } },
        { $inc: { attempts: 1 } },
      );
      const current = await codes.findOne({ _id: id });
      if (current && current.attempts >= MAX_CODE_ATTEMPTS) {
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
      await transporter.sendMail({ from: smtp.from, to, subject, text });
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

  return {
    configuration,
    unlock,
    touchSession,
    sendCode,
    verifyCode,
    cancelCode,
    sendBootstrapEmail,
    keyedHash,
  };
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

module.exports = {
  createIntegrationSecurity,
  ACCESS_WINDOW_MS,
  PIN_LOCK_MS,
  CODE_TTL_MS,
  DEFAULT_CODE_RESEND_MS,
  DEFAULT_CODE_REQUEST_WINDOW_MS,
  DEFAULT_CODE_REQUEST_LIMIT,
};
