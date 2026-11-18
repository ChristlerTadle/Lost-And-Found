const { randomUUID } = require('node:crypto');

const ACTIONS = new Set([
  'user.create', 'user.update', 'user.disable', 'staff_permissions.update', 'role_permissions.update',
  'account_permissions.update', 'account_permissions.reset', 'account.role_change',
  'item.update', 'item.remove', 'report.generate', 'claim.approve',
  'claim.reject', 'ownership.verify', 'item.status_update', 'item.mark_returned',
  'auth.login', 'auth.login_failed', 'access.denied',
  'integration.enable', 'integration.disable', 'integration.update',
  'integration.unlock', 'integration.unlock_failed', 'integration.unlock_locked',
  'integration.code_sent', 'integration.code_failed', 'integration.restore_default',
  'integration.set_default', 'integration.failure',
  'calendar.event_create', 'calendar.event_update', 'calendar.event_delete', 'calendar.sync_failed',
  'admin.mfa_enroll_start', 'admin.mfa_enrolled', 'admin.mfa_verify_success',
  'admin.mfa_verify_failed', 'admin.mfa_locked', 'admin.mfa_recovery_used',
  'admin.mfa_recovery_regenerated', 'admin.mfa_reset',
]);

function createAuditLogService(database, client) {
  const collection = database.collection('audit_log');
  let transactionSupport;

  async function supportsTransactions() {
    if (transactionSupport !== undefined) return transactionSupport;
    const hello = await database.admin().command({ hello: 1 });
    transactionSupport = Boolean(hello.setName || hello.msg === 'isdbgrid');
    return transactionSupport;
  }

  async function logAction(event, session = undefined) {
    if (!ACTIONS.has(event.action)) throw new Error('Unsupported audit action.');
    const result = event.result || 'success';
    if (!['success', 'denied', 'failed', 'attempted'].includes(result)) {
      throw new Error('Unsupported audit result.');
    }
    const entry = {
      _id: randomUUID(),
      actor_id: event.actor_id ? String(event.actor_id) : null,
      actor_role: ['admin', 'staff'].includes(event.actor_role) ? event.actor_role : null,
      action: event.action,
      target_type: event.target_type || null,
      target_id: event.target_id === undefined || event.target_id === null ? null : String(event.target_id),
      old_value: event.old_value ?? null,
      new_value: event.new_value ?? null,
      result,
      ip_address: event.ip_address || null,
      created_at: new Date(),
    };
    await collection.insertOne(entry, session ? { session } : undefined);
    return entry;
  }

  async function runAction(event, action) {
    const events = Array.isArray(event) ? event : [event];
    if (await supportsTransactions()) {
      const session = client.startSession();
      try {
        let value;
        await session.withTransaction(async () => {
          value = await action(session);
          for (const entry of events) {
            await logAction({ ...resolveEvent(entry, value), result: 'success' }, session);
          }
        });
        return value;
      } finally {
        await session.endSession();
      }
    }

    const pendingEntries = [];
    for (const entry of events) {
      pendingEntries.push(await logAction({ ...resolveEvent(entry, undefined, true), result: 'attempted' }));
    }
    let value;
    try {
      value = await action(undefined);
    } catch (error) {
      try {
        await Promise.all(pendingEntries.map((entry) => collection.updateOne(
          { _id: entry._id, result: 'attempted' },
          { $set: { result: 'failed' } },
        )));
      } catch (auditError) {
        console.error('Unable to finalize failed audit action:', auditError);
      }
      throw error;
    }
    for (let index = 0; index < events.length; index += 1) {
      if (typeof events[index].target_id === 'function') {
        pendingEntries[index].target_id = events[index].target_id(value) || null;
      }
    }
    try {
      await Promise.all(pendingEntries.map((entry) => collection.updateOne(
        { _id: entry._id, result: 'attempted' },
        { $set: { result: 'success', target_id: entry.target_id } },
      )));
    } catch (error) {
      console.error('Unable to finalize successful audit action:', error);
    }
    return value;
  }

  async function findRecords(filters = {}) {
    const filter = {};
    const dateFrom = validDate(filters.date_from);
    const dateTo = validDate(filters.date_to);
    if (dateFrom || dateTo) {
      filter.created_at = {};
      if (dateFrom) filter.created_at.$gte = dateFrom;
      if (dateTo) {
        dateTo.setUTCHours(23, 59, 59, 999);
        filter.created_at.$lte = dateTo;
      }
    }
    if (typeof filters.actor_id === 'string' && filters.actor_id.trim()) {
      filter.actor_id = filters.actor_id.trim().slice(0, 100);
    }
    if (['admin', 'staff'].includes(filters.actor_role)) filter.actor_role = filters.actor_role;
    if (ACTIONS.has(filters.action)) filter.action = filters.action;
    if (['user', 'staff', 'item', 'claim', 'report', 'integration'].includes(filters.target_type)) {
      filter.target_type = filters.target_type;
    }
    if (filters.result === 'failed') {
      filter.$or = [
        { result: 'failed' },
        { action: { $in: ['integration.unlock_failed', 'integration.code_failed'] } },
      ];
    } else if (filters.result === 'denied') {
      filter.$or = [
        { result: 'denied' },
        { action: 'integration.unlock_locked' },
      ];
    } else if (['success', 'attempted'].includes(filters.result)) {
      filter.result = filters.result;
      if (filters.result === 'success') {
        filter.$and = [{
          action: {
            $nin: ['integration.unlock_failed', 'integration.code_failed', 'integration.unlock_locked'],
          },
        }];
      }
    }
    const page = Math.max(1, Math.min(1_000_000, parsePositiveInteger(filters.page, 1)));
    const pageSize = 25;
    const [total, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection.find(filter, {
        projection: { actor_id: 1, actor_role: 1, action: 1, target_type: 1, target_id: 1,
          old_value: 1, new_value: 1, result: 1, ip_address: 1, created_at: 1 },
      }).sort({ created_at: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    ]);
    return {
      records: documents.map(({ _id, ...record }) => ({ id: String(_id), ...record })),
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    };
  }

  return { logAction, runAction, findRecords };
}

function resolveEvent(event, value, pending = false) {
  const resolved = { ...event };
  for (const key of ['target_id', 'old_value', 'new_value']) {
    if (typeof resolved[key] === 'function') {
      resolved[key] = pending && key === 'target_id' ? null : resolved[key](value);
    }
  }
  return resolved;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return value > today ? null : parsed;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requestAuditContext(req, action, fields = {}) {
  return {
    actor_id: req.user?.id || null,
    actor_role: req.user?.role_name || null,
    action,
    ip_address: req.ip || null,
    ...fields,
  };
}

module.exports = { createAuditLogService, requestAuditContext };
