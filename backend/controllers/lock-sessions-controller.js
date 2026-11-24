const { LockConflictError, LockServiceUnavailableError } = require('../../src/services/locks');
const { stateConflict } = require('../../src/services/state-conflict');

const EDIT_SESSION_LEASE_MS = 60 * 1000;
const EDIT_FORM_TYPES = new Set(['admin_item', 'admin_user', 'staff_item', 'staff_claim']);

function createLockSessionsController({
  locks,
  auth,
  items,
  audit,
  leaseMs = EDIT_SESSION_LEASE_MS,
}) {
  async function acquire(req, res) {
    const form = validateForm(req.body);
    const before = await deriveRequests(form, { auth, items });
    const ordered = locks.sortLockRequests(before.requests);
    const tokens = {};
    try {
      for (const request of ordered) {
        tokens[request.key] = await locks.acquire(
          request.key,
          request.mode,
          String(req.user.id),
          { leaseMs },
        );
      }
      const after = await deriveRequests(form, { auth, items });
      if (!sameLockKeys(ordered, after.requests) || !sameDerivedState(before.signature, after.signature)) {
        throw stateConflict('This record changed while the edit lock was being opened. Reload and try again.');
      }
      await auditLocks(audit, req, ordered, 'lock.acquire');
      const expiresAt = await earliestExpiry(locks, tokens);
      const since = await earliestAcquiredAt(locks, tokens);
      return res.json({
        locked: true,
        token: JSON.stringify(tokens),
        expiresAt,
        holder: {
          name: req.user.full_name,
          since,
        },
      });
    } catch (error) {
      await releaseAll(locks, tokens, String(req.user.id));
      if (error instanceof LockConflictError && error.key) {
        error.lockHolder = await safeHolder(locks, auth, error.key);
      }
      throw error;
    }
  }

  async function renew(req, res) {
    const form = validateForm(req.body);
    const requests = locks.sortLockRequests((await deriveRequests(form, { auth, items })).requests);
    const tokens = parseTokens(req);
    assertTokenKeys(tokens, requests, form);
    const tokenRequests = locks.sortLockRequests(Object.keys(tokens).map((key) => ({ key, mode: 'X' })));
    for (const { key } of tokenRequests) {
      if (!await locks.renew(key, tokens[key], 'X', String(req.user.id))) {
        throw lockLost();
      }
    }
    return res.json({
      renewed: true,
      token: JSON.stringify(tokens),
      expiresAt: await earliestExpiry(locks, tokens),
      holder: {
        name: req.user.full_name,
        since: await earliestAcquiredAt(locks, tokens),
      },
    });
  }

  async function release(req, res) {
    const form = validateForm(req.body);
    const requests = locks.sortLockRequests((await deriveRequests(form, { auth, items })).requests);
    const tokens = parseTokens(req);
    assertTokenKeys(tokens, requests, form);
    const tokenRequests = locks.sortLockRequests(Object.keys(tokens).map((key) => ({ key, mode: 'X' })));
    const results = await Promise.all(tokenRequests.map(({ key }) => (
      locks.release(key, tokens[key], String(req.user.id))
    )));
    if (results.some((released) => !released)) throw lockLost();
    await auditLocks(audit, req, tokenRequests, 'lock.release');
    return res.json({ released: true });
  }

  return { acquire, renew, release };
}

async function deriveRequests(form, { auth, items }) {
  const { formType, id } = form;
  if (formType === 'admin_item' || formType === 'staff_item') {
    const item = await items.findItemLockState(id);
    if (item.deleted) throw stateConflict('This item was removed. Reload the record.');
    return {
      requests: [{ key: `item:${item.id}`, mode: 'X' }],
      signature: { id: item.id, itemType: item.itemType, status: item.status, deleted: item.deleted },
    };
  }
  if (formType === 'admin_user') {
    const account = await auth.findAccountLockTarget(id);
    const requests = [{ key: `account:${account.id}`, mode: 'X' }];
    if (account.role_name === 'admin') requests.push({ key: 'roster', mode: 'X' });
    return {
      requests,
      signature: { id: account.id, role: account.role_name, status: account.status },
    };
  }
  const state = await items.findClaimLockState(id);
  if (!state.item || state.item.deleted) {
    throw stateConflict('The item was removed and this claim can no longer be reviewed.');
  }
  return {
    requests: [
      { key: `item:${state.claim.itemId}`, mode: 'X' },
      { key: `claim:${state.claim.id}`, mode: 'X' },
    ],
    signature: {
      claimId: state.claim.id,
      itemId: state.claim.itemId,
      claimantId: state.claim.claimantId,
      claimStatus: state.claim.status,
      itemStatus: state.item.status,
      itemDeleted: state.item.deleted,
    },
  };
}

function validateForm(body) {
  const formType = body?.formType;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!EDIT_FORM_TYPES.has(formType) || !id || id.length > 128) {
    const error = new Error('Choose a valid edit form and record.');
    error.status = 400;
    throw error;
  }
  return { formType, id };
}

function parseTokens(req) {
  const raw = req.get?.('X-Lock-Token') || req.headers?.['x-lock-token'];
  if (typeof raw !== 'string' || raw.length > 4096) throw lockLost();
  try {
    const tokens = JSON.parse(raw);
    if (!tokens || Array.isArray(tokens) || typeof tokens !== 'object') throw lockLost();
    return tokens;
  } catch {
    throw lockLost();
  }
}

function assertTokenKeys(tokens, requests, form) {
  const required = requests.map(({ key }) => key).sort();
  const actual = Object.keys(tokens).sort();
  const allowed = new Set(required);
  if (form.formType === 'admin_user') allowed.add('roster');
  if (required.some((key) => !actual.includes(key))
    || actual.some((key) => !allowed.has(key))
    || actual.some((key) => typeof tokens[key] !== 'string' || !tokens[key])) {
    throw lockLost();
  }
}

function lockLost() {
  const error = new Error('This edit lock was lost or expired. Keep your changes and try again.');
  error.status = 409;
  error.code = 'lock_lost';
  return error;
}

function sameLockKeys(left, right) {
  const a = left.map(({ key }) => key).sort();
  const b = right.map(({ key }) => key).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function sameDerivedState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function releaseAll(locks, tokens, owner) {
  const released = await Promise.all(Object.entries(tokens).map(async ([key, token]) => (
    locks.release(key, token, owner)
  )));
  if (released.some((value) => !value)) throw new LockServiceUnavailableError();
}

async function earliestExpiry(locks, tokens) {
  const entries = await Promise.all(Object.entries(tokens).map(async ([key, token]) => {
    const holder = (await locks.inspect(key)).find((candidate) => candidate.token === token);
    return holder?.expiresAt;
  }));
  return entries.filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
}

async function earliestAcquiredAt(locks, tokens) {
  const entries = await Promise.all(Object.entries(tokens).map(async ([key, token]) => {
    const holder = (await locks.inspect(key)).find((candidate) => candidate.token === token);
    return holder?.acquiredAt;
  }));
  return entries.filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
}

async function safeHolder(locks, auth, key) {
  const holders = await locks.inspect(key);
  const holder = holders[0];
  if (!holder) return null;
  const account = await auth.findLockHolder(holder.owner);
  return {
    name: ['admin', 'staff'].includes(account?.role_name) ? account.full_name : null,
    since: holder.acquiredAt,
    expiresAt: holder.expiresAt,
  };
}

async function auditLocks(audit, req, requests, action) {
  const events = requests.map(({ key }) => {
    const separator = key.indexOf(':');
    const type = separator === -1 ? 'role' : key.slice(0, separator);
    const id = separator === -1 ? 'roster' : key.slice(separator + 1);
    return audit.logAction({
      actor_id: String(req.user.id),
      actor_role: req.user.role_name,
      action,
      target_type: type,
      target_id: id,
      result: 'success',
    });
  });
  await Promise.all(events);
}

module.exports = { createLockSessionsController };
