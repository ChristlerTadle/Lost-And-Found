const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { generate, generateSecret, generateURI, verify } = require('otplib');
const QRCode = require('qrcode');

const TOTP_SETTINGS = { algorithm: 'sha1', digits: 6, period: 30 };
const PENDING_TTL_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function createAdminMfa(database, integrationSettings, {
  disabled = false,
  rateLimitDisabled = false,
  now = Date.now,
  callIntegration,
} = {}) {
  if (typeof callIntegration !== 'function') {
    throw new Error('callIntegration is required for Admin MFA verification.');
  }
  const users = database.collection('users');
  const attempts = database.collection('admin_mfa_attempts');

  async function getPolicy() {
    const integration = await integrationSettings.getIntegration('admin_mfa');
    return {
      active: !disabled && integration.active,
      enabled: integration.enabled,
      requireForAllAdmins: Boolean(integration.settings.require_for_all_admins),
      issuer: integration.settings.issuer || 'Lost and Found System',
      window: Number(integration.settings.window ?? 1),
    };
  }

  async function getLoginAction(user, ipAddress) {
    if (user.role_name !== 'admin') return { action: 'complete' };
    const policy = await getPolicy();
    if (!policy.active) return { action: 'complete' };
    const account = await findAdmin(user.id);
    const enrolled = isEnrolled(account);
    if (enrolled) {
      const retryAfterSeconds = await getLockRemainingSeconds(user.id, ipAddress);
      if (retryAfterSeconds) return { action: 'locked', retryAfterSeconds };
    }
    if (enrolled) return { action: 'verify' };
    return { action: policy.requireForAllAdmins ? 'enroll' : 'complete' };
  }

  async function getAdminRouteAccess(user, session, ipAddress) {
    if (user.role_name !== 'admin') return { allowed: true };
    const action = await getLoginAction(user, ipAddress);
    if (action.action === 'complete') return { allowed: true };
    if (action.action === 'locked') {
      return {
        allowed: false,
        reason: 'locked',
        retryAfterSeconds: action.retryAfterSeconds,
      };
    }
    if (action.action === 'enroll') {
      return { allowed: false, reason: 'setup_required' };
    }
    return session.adminMfaVerified === String(user.id)
      ? { allowed: true }
      : { allowed: false, reason: 'verification_required' };
  }

  async function canAccessAdminRoutes(user, session, ipAddress) {
    return (await getAdminRouteAccess(user, session, ipAddress)).allowed;
  }

  async function getAdminSummary() {
    const policy = await getPolicy();
    const [total, enrolled] = await Promise.all([
      users.countDocuments({ role_name: 'admin', status: 'active' }),
      users.countDocuments({ role_name: 'admin', status: 'active', 'admin_mfa.enabled': true }),
    ]);
    return {
      enabled: policy.enabled,
      active: policy.active,
      enrolledAdmins: enrolled,
      totalAdmins: total,
    };
  }

  async function getStatus(adminId) {
    const [account, policy] = await Promise.all([findAdmin(adminId), getPolicy()]);
    return {
      enabled: policy.active,
      requireForAllAdmins: policy.requireForAllAdmins,
      enrolled: isEnrolled(account),
      pending: Boolean(account?.admin_mfa?.pending_id
        && account.admin_mfa.pending_expires_at > now()),
      issuer: policy.issuer,
      recoveryCodesRemaining: account?.admin_mfa?.recovery_hashes?.length || 0,
    };
  }

  async function selfTest() {
    if (!integrationSettings.selfTestEncryption()) throw new Error('Encryption self-test failed.');
    const secret = generateSecret();
    const epoch = Math.floor(now() / 1000);
    const token = await generate({ secret, epoch, ...TOTP_SETTINGS });
    const result = await verify({
      secret, token, epoch, epochTolerance: 0, ...TOTP_SETTINGS,
    });
    if (!result.valid) throw new Error('Authenticator self-test failed.');
    return true;
  }

  async function verifyCandidate({ adminId, proof }) {
    const account = await findAdmin(adminId);
    if (!isEnrolled(account)) throw genericError();

    await selfTest();
    const result = await verifyToken(
      integrationSettings.decryptSecret(account.admin_mfa.secret),
      proof?.code,
      (await getPolicy()).window,
    );
    if (!result.valid || !(await claimTimeStep(adminId, result.timeStep))) {
      throw genericError();
    }

    return { verified: true, proofType: 'authenticator_code_accepted' };
  }

  async function startEnrollment({ adminId, ipAddress, code, audit }) {
    const account = await findAdmin(adminId);
    if (!account) throw genericError();
    await assertNotLocked(adminId, ipAddress);
    await recordEnrollmentStart(adminId, ipAddress, audit);

    const recoveryUsed = isEnrolled(account)
      ? await verifyAccountCode(account, code, ipAddress)
      : false;
    if (isEnrolled(account) && recoveryUsed === null) {
      await recordFailure(adminId, ipAddress, audit);
      throw genericError();
    }
    if (recoveryUsed) await logMfa(audit, 'admin.mfa_recovery_used', adminId, ipAddress);

    const policy = await getPolicy();
    const secret = generateSecret();
    const pendingId = randomUUID();
    const uri = generateURI({
      issuer: policy.issuer,
      label: account.email,
      secret,
      ...TOTP_SETTINGS,
    });
    const qrCode = await QRCode.toDataURL(uri);
    await users.updateOne(
      { _id: String(adminId), role_name: 'admin', status: 'active' },
      { $set: {
        'admin_mfa.pending_secret': integrationSettings.encryptSecret(secret),
        'admin_mfa.pending_id': pendingId,
        'admin_mfa.pending_expires_at': now() + PENDING_TTL_MS,
      } },
    );
    await logMfa(audit, 'admin.mfa_enroll_start', adminId, ipAddress);
    return { secret, qrCode };
  }

  async function confirmEnrollment({ adminId, ipAddress, code, audit }) {
    const account = await findAdmin(adminId);
    const pending = account?.admin_mfa;
    if (!pending?.pending_secret || !pending.pending_id || pending.pending_expires_at <= now()) {
      throw genericError();
    }
    await assertNotLocked(adminId, ipAddress);
    const secret = integrationSettings.decryptSecret(pending.pending_secret);
    const result = await verifyToken(secret, code, (await getPolicy()).window);
    if (!result.valid) {
      await recordFailure(adminId, ipAddress, audit);
      throw genericError();
    }

    const recoveryCodes = generateRecoveryCodes();
    const wasEnrolled = isEnrolled(account);
    const updated = await users.updateOne(
      {
        _id: String(adminId),
        role_name: 'admin',
        status: 'active',
        'admin_mfa.pending_id': pending.pending_id,
        'admin_mfa.pending_expires_at': { $gt: now() },
      },
      {
        $set: {
          'admin_mfa.enabled': true,
          'admin_mfa.secret': integrationSettings.encryptSecret(secret),
          'admin_mfa.last_time_step': result.timeStep,
          'admin_mfa.recovery_hashes': recoveryCodes.map(hashRecoveryCode),
        },
        $unset: {
          'admin_mfa.pending_secret': '',
          'admin_mfa.pending_id': '',
          'admin_mfa.pending_expires_at': '',
        },
      },
    );
    if (updated.modifiedCount !== 1) throw genericError();
    await clearAttempts(adminId, ipAddress);
    if (wasEnrolled) await logMfa(audit, 'admin.mfa_reset', adminId, ipAddress);
    await logMfa(audit, 'admin.mfa_enrolled', adminId, ipAddress);
    return { recoveryCodes };
  }

  async function verifyLogin(params) {
    const bucketKey = integrationSettings.hashForRateLimit(`admin-mfa:${params.adminId}`);
    return callIntegration(
      'admin_mfa',
      () => verifyLoginCode(params),
      {},
      { purpose: 'admin_mfa', bucketKey, skipHealth: true },
    );
  }

  async function verifyLoginCode({ adminId, ipAddress, code, audit }) {
    await assertNotLocked(adminId, ipAddress);
    const account = await findAdmin(adminId);
    if (!isEnrolled(account)) throw genericError();
    const recoveryUsed = await verifyAccountCode(account, code, ipAddress);
    if (recoveryUsed === null) {
      await recordFailure(adminId, ipAddress, audit);
      throw genericError();
    }
    await clearAttempts(adminId, ipAddress);
    if (recoveryUsed) await logMfa(audit, 'admin.mfa_recovery_used', adminId, ipAddress);
    await logMfa(audit, 'admin.mfa_verify_success', adminId, ipAddress);
    return true;
  }

  async function regenerateRecoveryCodes({ adminId, ipAddress, code, audit }) {
    await assertNotLocked(adminId, ipAddress);
    const account = await findAdmin(adminId);
    if (!isEnrolled(account)) throw genericError();
    const policy = await getPolicy();
    const result = await verifyToken(
      integrationSettings.decryptSecret(account.admin_mfa.secret),
      code,
      policy.window,
    );
    if (!result.valid || !(await claimTimeStep(adminId, result.timeStep))) {
      await recordFailure(adminId, ipAddress, audit);
      throw genericError();
    }
    const recoveryCodes = generateRecoveryCodes();
    const updated = await users.updateOne(
      {
        _id: String(adminId),
        'admin_mfa.enabled': true,
        'admin_mfa.last_time_step': result.timeStep,
      },
      { $set: { 'admin_mfa.recovery_hashes': recoveryCodes.map(hashRecoveryCode) } },
    );
    if (updated.modifiedCount !== 1) throw genericError();
    await clearAttempts(adminId, ipAddress);
    await logMfa(audit, 'admin.mfa_recovery_regenerated', adminId, ipAddress);
    return { recoveryCodes };
  }

  async function verifyAccountCode(account, code, ipAddress) {
    const policy = await getPolicy();
    const mfa = account.admin_mfa;
    if (!isEnrolled(account)) return null;
    const result = await verifyToken(
      integrationSettings.decryptSecret(mfa.secret),
      code,
      policy.window,
    );
    if (result.valid) return await claimTimeStep(account._id, result.timeStep) ? false : null;
    return consumeRecoveryCode(account._id, mfa.recovery_hashes || [], code, ipAddress);
  }

  async function claimTimeStep(adminId, timeStep) {
    const result = await users.updateOne(
      {
        _id: String(adminId),
        'admin_mfa.enabled': true,
        $or: [
          { 'admin_mfa.last_time_step': { $exists: false } },
          { 'admin_mfa.last_time_step': { $lt: timeStep } },
        ],
      },
      { $set: { 'admin_mfa.last_time_step': timeStep } },
    );
    return result.modifiedCount === 1;
  }

  async function consumeRecoveryCode(adminId, recoveryHashes, code, ipAddress) {
    const candidate = hashRecoveryCode(code);
    let matchingHash = null;
    const candidateBytes = Buffer.from(candidate, 'hex');
    for (const hash of recoveryHashes) {
      const savedBytes = Buffer.from(hash, 'hex');
      const matches = savedBytes.length === candidateBytes.length
        && timingSafeEqual(savedBytes, candidateBytes);
      if (matches) matchingHash = hash;
    }
    if (!matchingHash) return null;
    const result = await users.updateOne(
      { _id: String(adminId), 'admin_mfa.recovery_hashes': matchingHash },
      { $pull: { 'admin_mfa.recovery_hashes': matchingHash } },
    );
    return result.modifiedCount === 1 ? true : null;
  }

  async function recordFailure(adminId, ipAddress, audit) {
    if (rateLimitDisabled) {
      await logMfa(audit, 'admin.mfa_verify_failed', adminId, ipAddress, 'failed');
      return false;
    }
    const key = attemptKey(adminId, ipAddress);
    const timestamp = now();
    const existing = await attempts.findOne({ _id: key });
    if (existing?.window_started_at && existing.window_started_at <= timestamp - ATTEMPT_WINDOW_MS) {
      await attempts.updateOne(
        { _id: key, window_started_at: existing.window_started_at },
        { $set: { window_started_at: timestamp, failures: 0, starts: 0 }, $unset: { locked_until: '' } },
      );
    }
    await attempts.updateOne(
      { _id: key },
      { $setOnInsert: { window_started_at: timestamp }, $inc: { failures: 1 } },
      { upsert: true },
    );
    const updated = await attempts.findOne({ _id: key });
    await logMfa(audit, 'admin.mfa_verify_failed', adminId, ipAddress, 'failed');
    if (updated.failures >= MAX_ATTEMPTS && !(updated.locked_until > timestamp)) {
      await attempts.updateOne(
        { _id: key },
        { $set: { locked_until: timestamp + LOCK_TTL_MS } },
      );
      await logMfa(audit, 'admin.mfa_locked', adminId, ipAddress, 'denied');
      return true;
    }
    return false;
  }

  async function recordEnrollmentStart(adminId, ipAddress, audit) {
    if (rateLimitDisabled) return;
    const key = attemptKey(adminId, ipAddress);
    const timestamp = now();
    const existing = await attempts.findOne({ _id: key });
    if (existing?.window_started_at && existing.window_started_at <= timestamp - ATTEMPT_WINDOW_MS) {
      await attempts.updateOne(
        { _id: key, window_started_at: existing.window_started_at },
        { $set: { window_started_at: timestamp, failures: 0, starts: 0 }, $unset: { locked_until: '' } },
      );
    }
    await attempts.updateOne(
      { _id: key },
      { $setOnInsert: { window_started_at: timestamp }, $inc: { starts: 1 } },
      { upsert: true },
    );
    const updated = await attempts.findOne({ _id: key });
    if (updated.starts >= MAX_ATTEMPTS) {
      await attempts.updateOne({ _id: key }, { $set: { locked_until: timestamp + LOCK_TTL_MS } });
      await logMfa(audit, 'admin.mfa_locked', adminId, ipAddress, 'denied');
      throw lockError();
    }
  }

  async function assertNotLocked(adminId, ipAddress) {
    if (await isLocked(adminId, ipAddress)) throw lockError();
  }

  async function isLocked(adminId, ipAddress) {
    return (await getLockRemainingSeconds(adminId, ipAddress)) > 0;
  }

  async function getLockRemainingSeconds(adminId, ipAddress) {
    if (rateLimitDisabled) return 0;
    const entry = await attempts.findOne({ _id: attemptKey(adminId, ipAddress) });
    return entry?.locked_until > now()
      ? Math.ceil((entry.locked_until - now()) / 1000)
      : 0;
  }

  async function clearAttempts(adminId, ipAddress) {
    await attempts.deleteOne({ _id: attemptKey(adminId, ipAddress) });
  }

  async function findAdmin(adminId) {
    return users.findOne({ _id: String(adminId), role_name: 'admin', status: 'active' });
  }

  function isEnrolled(account) {
    return Boolean(account?.admin_mfa?.enabled && account.admin_mfa.secret);
  }

  function attemptKey(adminId, ipAddress) {
    return integrationSettings.hashForRateLimit(`${adminId}\u0000${ipAddress || 'unknown'}`);
  }

  async function verifyToken(secret, token, window) {
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return { valid: false };
    return verify({
      secret,
      token,
      epoch: Math.floor(now() / 1000),
      epochTolerance: window * TOTP_SETTINGS.period,
      ...TOTP_SETTINGS,
    });
  }

  function generateRecoveryCodes() {
    return Array.from({ length: 8 }, () => {
      const value = randomBytes(16).toString('hex').toUpperCase();
      return `${value.slice(0, 8)}-${value.slice(8, 16)}-${value.slice(16, 24)}-${value.slice(24)}`;
    });
  }

  function hashRecoveryCode(code) {
    return createHash('sha256')
      .update(String(code || '').replace(/-/g, '').toUpperCase())
      .digest('hex');
  }

  async function logMfa(audit, action, adminId, ipAddress, result = 'success') {
    await audit.logAction({
      actor_id: String(adminId),
      actor_role: 'admin',
      action,
      target_type: 'user',
      target_id: String(adminId),
      result,
      ip_address: ipAddress || null,
    });
  }

  return {
    getPolicy,
    getLoginAction,
    getAdminRouteAccess,
    canAccessAdminRoutes,
    getAdminSummary,
    getStatus,
    selfTest,
    verifyCandidate,
    startEnrollment,
    confirmEnrollment,
    verifyLogin,
    regenerateRecoveryCodes,
  };
}

function genericError() {
  const error = new Error('The authentication code could not be verified. Try again later.');
  error.status = 400;
  return error;
}

function lockError() {
  const error = new Error('The authentication code could not be verified. Try again later.');
  error.status = 429;
  return error;
}

module.exports = { createAdminMfa };
