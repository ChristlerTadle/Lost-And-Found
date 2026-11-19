const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require('node:crypto');
const config = require('../config');
const { integrations } = require('../config/integrations');

const MASK = '••••••••';
const VERIFICATION_TTL_MS = 10 * 60 * 1000;

function parseEncryptionKey(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY is required to start the API.');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

function createIntegrationSettings(database, { encryptionKey, env = process.env } = {}) {
  const key = parseEncryptionKey(encryptionKey);
  const settings = database.collection('integration_settings');
  const verifications = database.collection('integration_verifications');

  function encryptSecret(value) {
    if (typeof value !== 'string' || !value) throw new Error('A non-empty secret is required.');
    return encryptValue(value, key);
  }

  function decryptSecret(value) {
    return decryptValue(value, key);
  }

  function selfTestEncryption() {
    const probe = randomBytes(32).toString('base64url');
    return decryptValue(encryptValue(probe, key), key) === probe;
  }

  function hashForRateLimit(value) {
    return createHmac('sha256', key).update(String(value)).digest('hex');
  }

  async function getIntegration(integrationId) {
    const definition = integrations[integrationId];
    if (!definition) throw new Error('Unknown integration.');

    const document = await settings.findOne({ _id: integrationId });
    const values = {};
    for (const field of definition.fields) {
      const saved = document?.values?.[field.name];
      let value = saved === undefined || saved === null ? '' : saved;
      if (field.secret && value) value = decryptValue(value, key);
      if (value === '') value = getEnvironmentValue(integrationId, field, env);
      values[field.name] = normalizeFieldValue(field, value);
    }

    const missingFields = getMissingFields(integrationId, definition, values);
    const configured = missingFields.length === 0;
    const enabled = typeof document?.enabled === 'boolean'
      ? document.enabled
      : integrationId === 'smtp' && configured;

    return {
      id: integrationId,
      enabled,
      configured,
      active: enabled && configured,
      status: enabled && configured ? 'Enabled' : configured ? 'Disabled' : 'Not configured',
      missingFields,
      settings: values,
    };
  }

  function getIntegrationLabel(integrationId) {
    const definition = integrations[integrationId];
    if (!definition) throw validationError('Unknown integration.');
    return definition.label;
  }

  async function getAdminIntegrations(adminId) {
    const result = {};
    for (const [id, definition] of Object.entries(integrations)) {
      const integration = await getIntegration(id);
      const document = await settings.findOne({ _id: id });
      const verification = adminId
        ? await getCurrentVerification(adminId, id, integration.enabled, integration.settings)
        : null;
      const defaultValues = await decryptSnapshot(id, document?.defaults);
      const hasDefault = Boolean(document?.defaults && typeof document.defaults === 'object');
      const usingDefault = hasDefault
        && JSON.stringify(integration.settings) === JSON.stringify(defaultValues);
      const failing = integration.active && Boolean(document?.last_error_code);
      result[id] = {
        id,
        label: definition.label,
        enabled: integration.enabled,
        configured: integration.configured,
        active: integration.active,
        status: failing ? 'Failing' : integration.status,
        missingFields: integration.missingFields,
        health: {
          last_error_at: document?.last_error_at || null,
          last_error_code: document?.last_error_code || null,
          last_error_message: document?.last_error_message || null,
          consecutive_failures: document?.consecutive_failures || 0,
          last_success_at: document?.last_success_at || null,
        },
        hasDefault,
        usingDefault,
        lastValidatedAt: document?.last_validation?.at || null,
        lastValidationResult: document?.last_validation?.passed
          ? 'Validated'
          : document?.last_validation?.passed === false ? 'Failed' : 'Not validated',
        lastValidationReason: document?.last_validation?.passed === false
          ? String(document.last_validation.result || 'Validation failed')
          : null,
        isCurrentValidation: Boolean(
          document?.last_validation?.passed
          && document.last_validation.hash === configHash(id, integration.settings, key),
        ),
        verification,
        isCurrentVerification: Boolean(verification),
        fields: definition.fields.map((field) => {
          const value = integration.settings[field.name];
          return {
            name: field.name,
            label: field.label,
            type: field.type,
            secret: field.secret,
            credential: Boolean(field.credential),
            required: field.required,
            value: field.secret && value
              ? field.name === 'private_key' ? MASK : `${MASK}${value.slice(-4)}`
              : value,
            hasValue: Boolean(value),
          };
        }),
      };
    }
    return result;
  }

  async function recordIntegrationFailure(integrationId, { code, message, at }) {
    if (!integrations[integrationId]) throw validationError('Unknown integration.');
    await settings.updateOne(
      { _id: integrationId },
      {
        $set: {
          last_error_at: at,
          last_error_code: code,
          last_error_message: message,
        },
        $inc: { consecutive_failures: 1 },
      },
      { upsert: true },
    );
  }

  async function recordIntegrationSuccess(integrationId) {
    if (!integrations[integrationId]) throw validationError('Unknown integration.');
    await settings.updateOne(
      { _id: integrationId },
      {
        $set: {
          last_success_at: new Date(),
          consecutive_failures: 0,
        },
        $unset: {
          last_error_at: '',
          last_error_code: '',
          last_error_message: '',
        },
      },
      { upsert: true },
    );
  }

  async function claimIntegrationFailureAudit(integrationId, cutoff) {
    if (!integrations[integrationId]) throw validationError('Unknown integration.');
    await settings.updateOne(
      { _id: integrationId },
      { $setOnInsert: { _id: integrationId } },
      { upsert: true },
    );
    const result = await settings.updateOne(
      {
        _id: integrationId,
        $or: [
          { last_failure_audit_at: { $exists: false } },
          { last_failure_audit_at: { $lte: cutoff } },
        ],
      },
      { $set: { last_failure_audit_at: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async function claimCalendarSyncFailureAudit(integrationId, cutoff) {
    if (integrationId !== 'google_calendar') throw validationError('Unknown integration.');
    await settings.updateOne(
      { _id: integrationId },
      { $setOnInsert: { _id: integrationId } },
      { upsert: true },
    );
    const result = await settings.updateOne(
      {
        _id: integrationId,
        $or: [
          { last_calendar_sync_failure_audit_at: { $exists: false } },
          { last_calendar_sync_failure_audit_at: { $lte: cutoff } },
        ],
      },
      { $set: { last_calendar_sync_failure_audit_at: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async function validateIntegrationFields(integrationId, submittedFields) {
    const definition = integrations[integrationId];
    if (!definition || !submittedFields || typeof submittedFields !== 'object' || Array.isArray(submittedFields)) {
      throw validationError('Submit valid integration fields.');
    }
    const current = await getIntegration(integrationId);
    const values = { ...current.settings };
    const fieldErrors = {};
    for (const field of definition.fields) {
      if (!Object.hasOwn(submittedFields, field.name)) continue;
      const raw = submittedFields[field.name];
      if (field.secret && (raw === '' || isMaskPlaceholder(raw))) continue;
      const result = validateField(field, raw);
      if (result.error) fieldErrors[field.name] = result.error;
      else values[field.name] = result.value;
    }
    for (const name of getMissingFields(integrationId, definition, values)) {
      fieldErrors[name] = 'This field is required.';
    }
    if (Object.keys(fieldErrors).length) {
      const error = validationError('Fix the highlighted integration settings.');
      error.fieldErrors = { [integrationId]: fieldErrors };
      throw error;
    }
    return values;
  }

  async function saveIntegrations(input, audit, auditContext) {
    const plan = await prepareIntegrationSave(input);
    return applyIntegrationSave(plan, audit, auditContext);
  }

  async function prepareIntegrationSave(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw validationError('Submit valid integration settings.');
    }
    const ids = Object.keys(input);
    if (!ids.length) throw validationError('Submit at least one integration setting.');
    if (ids.some((id) => !integrations[id])) throw validationError('An unknown integration was submitted.');

    const updates = [];
    const changed = [];
    const errors = {};

    for (const id of ids) {
      const definition = integrations[id];
      const submitted = input[id];
      if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)
        || typeof submitted.enabled !== 'boolean'
        || !submitted.fields || typeof submitted.fields !== 'object' || Array.isArray(submitted.fields)) {
        errors[id] = { _form: 'Submit a valid enabled state and field values.' };
        continue;
      }

      const allowedFields = new Set(definition.fields.map(({ name }) => name));
      if (Object.keys(submitted.fields).some((name) => !allowedFields.has(name))) {
        errors[id] = { _form: 'An unknown integration field was submitted.' };
        continue;
      }

      const current = await getIntegration(id);
      const nextValues = { ...current.settings };
      const changedFields = [];
      const credentialFields = [];
      const persist = {};
      const fieldErrors = {};

      for (const field of definition.fields) {
        if (!Object.hasOwn(submitted.fields, field.name)) continue;
        const raw = submitted.fields[field.name];
        if (field.secret && (raw === '' || isMaskPlaceholder(raw))) continue;
        const result = validateField(field, raw);
        if (result.error) {
          fieldErrors[field.name] = result.error;
          continue;
        }
        if (result.value !== current.settings[field.name]) {
          nextValues[field.name] = result.value;
          changedFields.push(field.name);
          if (field.credential) credentialFields.push(field.name);
          persist[field.name] = field.secret ? encryptValue(result.value, key) : result.value;
        }
      }

      const missing = getMissingFields(id, definition, nextValues);
      if (submitted.enabled && missing.length) {
        for (const name of missing) {
          fieldErrors[name] = 'This field is required to enable the integration.';
        }
      }
      if (id === 'smtp' && Boolean(nextValues.user) !== Boolean(nextValues.password)) {
        const message = 'SMTP username and password must either both be set or both be empty.';
        fieldErrors.user = message;
        fieldErrors.password = message;
      }
      if (id === 'google_calendar'
        && nextValues.pickup_open_time >= nextValues.pickup_close_time) {
        fieldErrors.pickup_close_time = 'Pickup closing time must be later than opening time.';
      }
      if (id === 'admin_mfa') {
        if (current.enabled && !submitted.enabled) credentialFields.push('enabled');
        if (current.settings.require_for_all_admins && !nextValues.require_for_all_admins) {
          credentialFields.push('require_for_all_admins');
        }
      }
      if (Object.keys(fieldErrors).length) errors[id] = fieldErrors;

      const enabledChanged = submitted.enabled !== current.enabled;
      if (changedFields.length || enabledChanged) {
        updates.push({
          id,
          enabled: submitted.enabled,
          persist,
          values: nextValues,
          changedFields,
          credentialFields,
          enabledChanged,
        });
        changed.push(id);
      }
    }

    if (Object.keys(errors).length) {
      const error = validationError('Fix the highlighted integration settings.');
      error.fieldErrors = errors;
      throw error;
    }
    const credentialChanges = updates.flatMap(({ id, credentialFields }) => (
      credentialFields.length ? [{ integration: id, fields: credentialFields }] : []
    ));
    const changes = updates.map(({ id, changedFields, credentialFields }) => ({
      integration: id,
      fields: [...changedFields, ...credentialFields.filter((name) => !changedFields.includes(name))],
    }));
    const canonical = updates.map(({ id, enabled, values, changedFields }) => ({
      id,
      enabled,
      changedFields,
      values,
    }));
    const payloadHash = createHmac('sha256', key)
      .update(JSON.stringify(canonical))
      .digest('hex');
    return { updates, changed, credentialChanges, changes, payloadHash };
  }

  async function applyIntegrationSave(plan, audit, auditContext, adminId) {
    const { updates, changed } = plan;
    if (!updates.length) return { integrations: await getAdminIntegrations(adminId), changed: [] };

    const validatedIds = new Set(plan.verifiedIntegrationIds || plan.validatedIntegrationIds || []);
    const defaultSnapshots = new Map();
    for (const { id, values } of updates) {
      if (validatedIds.has(id)) {
        defaultSnapshots.set(id, await encryptSnapshot(id, values));
      }
    }
    const operations = updates.map(({ id, enabled, persist }) => {
      const set = { enabled, updated_at: new Date().toISOString() };
      for (const [name, value] of Object.entries(persist)) set[`values.${name}`] = value;
      if (defaultSnapshots.has(id)) {
        set.defaults = defaultSnapshots.get(id);
        set.defaults_initialized = true;
      }
      return { updateOne: { filter: { _id: id }, update: { $set: set }, upsert: true } };
    });
    const events = updates.flatMap(({ id, changedFields, enabledChanged, enabled }) => {
      const actions = [];
      if (enabledChanged) {
        actions.push({
          ...auditContext,
          action: enabled ? 'integration.enable' : 'integration.disable',
          target_type: 'integration',
          target_id: id,
          new_value: { changed_fields: [] },
        });
      }
      if (changedFields.length) {
        actions.push({
          ...auditContext,
          action: 'integration.update',
          target_type: 'integration',
          target_id: id,
          new_value: { changed_fields: changedFields },
        });
      }
      return actions;
    });
    await audit.runAction(events, async (session) => {
      if (session) {
        await settings.bulkWrite(operations, { ordered: true, session });
        return;
      }

      const previous = await Promise.all(updates.map(({ id }) => settings.findOne({ _id: id })));
      const attempted = [];
      try {
        for (let index = 0; index < operations.length; index += 1) {
          attempted.push(index);
          const { updateOne } = operations[index];
          await settings.updateOne(
            updateOne.filter,
            updateOne.update,
            { upsert: true },
          );
        }
      } catch {
        let rollbackFailed = false;
        for (const index of attempted.reverse()) {
          try {
            const id = updates[index].id;
            if (previous[index]) {
              await settings.replaceOne({ _id: id }, previous[index], { upsert: true });
            } else {
              await settings.deleteOne({ _id: id });
            }
          } catch {
            rollbackFailed = true;
          }
        }
        if (rollbackFailed) console.error('Integration settings rollback failed.');
        const error = new Error('Integration settings could not be saved. No configuration changes were applied.');
        error.status = 503;
        throw error;
      }
    });
    return { integrations: await getAdminIntegrations(adminId), changed };
  }

  async function getDefaultRestorePreview(integrationId) {
    const definition = integrations[integrationId];
    if (!definition) throw validationError('Unknown integration.');
    const document = await settings.findOne({ _id: integrationId });
    if (!document?.defaults || typeof document.defaults !== 'object') {
      const error = new Error('No default settings have been saved for this integration.');
      error.status = 404;
      throw error;
    }
    const current = await getIntegration(integrationId);
    const defaults = await decryptSnapshot(integrationId, document.defaults);
    const changedFields = definition.fields
      .filter(({ name }) => defaults[name] !== current.settings[name])
      .map(({ name }) => name);
    return { id: integrationId, changedFields, values: defaults };
  }

  async function recordCandidateValidation(integrationId, values, passed, result) {
    if (!integrations[integrationId]) throw validationError('Unknown integration.');
    await settings.updateOne(
      { _id: integrationId },
      {
        $set: {
          last_validation: {
            hash: configHash(integrationId, values, key),
            passed: Boolean(passed),
            at: new Date(),
            result: String(result || (passed ? 'Validated' : 'Failed')).slice(0, 160),
          },
        },
      },
      { upsert: true },
    );
  }

  async function recordVerification({
    adminId, integrationId, enabled, values, proofType, result, at = new Date(),
  }) {
    if (!adminId || !integrations[integrationId]) throw validationError('Unknown integration verification.');
    const createdAt = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(createdAt.getTime())) throw validationError('Invalid verification time.');
    const record = {
      _id: `verification-${integrationId}`,
      adminId: String(adminId),
      integrationId,
      hash: verificationHash(integrationId, enabled, values, key),
      proofType: String(proofType || 'pending').slice(0, 64),
      result: Boolean(result),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + VERIFICATION_TTL_MS),
    };
    await verifications.updateOne(
      { _id: record._id },
      { $set: record },
      { upsert: true },
    );
    return verificationSummary(record);
  }

  async function getCurrentVerification(adminId, integrationId, enabled, values, now = new Date()) {
    if (!integrations[integrationId]) throw validationError('Unknown integration.');
    const record = await verifications.findOne({ _id: `verification-${integrationId}` });
    if (!record || record.result !== true
      || (adminId && record.adminId !== String(adminId))
      || record.hash !== verificationHash(integrationId, enabled, values, key)
      || !(new Date(record.expiresAt).getTime() > new Date(now).getTime())) return null;
    return verificationSummary(record);
  }

  async function requireCurrentVerification(adminId, integrationId, enabled, values) {
    const verification = await getCurrentVerification(adminId, integrationId, enabled, values);
    if (!verification) {
      const error = new Error('Verify this integration again before saving these settings.');
      error.status = 400;
      throw error;
    }
    return verification;
  }

  function getVerificationHash(integrationId, enabled, values) {
    return verificationHash(integrationId, enabled, values, key);
  }

  function getConfigHash(integrationId, values) {
    return configHash(integrationId, values, key);
  }

  async function setIntegrationDefault(integrationId, audit, auditContext, adminId) {
    const current = await getIntegration(integrationId);
    if (!current.active) {
      const error = new Error('Enable and configure the active integration before setting it as the default.');
      error.status = 400;
      throw error;
    }
    const verification = await getCurrentVerification(null, integrationId, true, current.settings);
    if (!verification) {
      const error = new Error('The active configuration has no current verification for exactly these settings.');
      error.status = 400;
      throw error;
    }
    const snapshot = await encryptSnapshot(integrationId, current.settings);
    const changedFields = Object.keys(current.settings);
    await audit.runAction({
      ...auditContext,
      action: 'integration.set_default',
      target_type: 'integration',
      target_id: integrationId,
      new_value: { changed_fields: changedFields },
    }, () => settings.updateOne(
      { _id: integrationId },
      { $set: { defaults: snapshot, updated_at: new Date().toISOString() } },
      { upsert: true },
    ));
    return { integrations: await getAdminIntegrations(adminId) };
  }

  async function restoreIntegrationDefault(integrationId, audit, auditContext, adminId) {
    const preview = await getDefaultRestorePreview(integrationId);
    if (!preview.changedFields.length) {
      return { integrations: await getAdminIntegrations(adminId), changed: [], restored: false };
    }
    const persist = await encryptSnapshot(integrationId, preview.values);
    const definition = integrations[integrationId];
    const set = { updated_at: new Date().toISOString() };
    for (const { name } of definition.fields) set[`values.${name}`] = persist[name];
    await audit.runAction({
      ...auditContext,
      action: 'integration.restore_default',
      target_type: 'integration',
      target_id: integrationId,
      new_value: { changed_fields: preview.changedFields },
    }, () => settings.updateOne(
      { _id: integrationId },
      { $set: set },
      { upsert: true },
    ));
    return {
      integrations: await getAdminIntegrations(adminId),
      changed: preview.changedFields,
      restored: true,
    };
  }

  async function encryptSnapshot(integrationId, values) {
    const definition = integrations[integrationId];
    if (!definition) throw validationError('Unknown integration.');
    const snapshot = {};
    for (const field of definition.fields) {
      const value = normalizeFieldValue(field, values[field.name]);
      snapshot[field.name] = field.secret && value ? encryptValue(value, key) : value;
    }
    return snapshot;
  }

  async function decryptSnapshot(integrationId, snapshot) {
    const definition = integrations[integrationId];
    const values = {};
    for (const field of definition.fields) {
      const value = snapshot?.[field.name] ?? '';
      values[field.name] = field.secret && value ? decryptValue(value, key) : normalizeFieldValue(field, value);
    }
    return values;
  }

  async function migrateEnvironmentValues() {
    const results = [];
    for (const [id, definition] of Object.entries(integrations)) {
      const document = await settings.findOne({ _id: id });
      const persisted = {};
      const fieldNames = [];
      for (const field of definition.fields) {
        if (document?.values?.[field.name]) continue;
        const value = normalizeFieldValue(field, getEnvironmentValue(id, field, env));
        if (!value) continue;
        persisted[field.name] = field.secret ? encryptValue(value, key) : value;
        fieldNames.push(field.name);
      }
      const set = {};
      for (const [name, value] of Object.entries(persisted)) set[`values.${name}`] = value;
      const enabledInitialized = id === 'smtp' && typeof document?.enabled !== 'boolean';
      let migratedEnabled;
      if (enabledInitialized) {
        const effective = await getIntegration(id);
        set.enabled = effective.configured;
        migratedEnabled = effective.configured;
      }
      if (fieldNames.length || Object.hasOwn(set, 'enabled')) {
        set.updated_at = new Date().toISOString();
        await settings.updateOne({ _id: id }, { $set: set }, { upsert: true });
      }
      if (!document?.defaults_initialized) {
        const effective = await getIntegration(id);
        const defaultSet = { defaults_initialized: true, updated_at: new Date().toISOString() };
        if ((!document?.defaults || typeof document.defaults !== 'object') && effective.configured) {
          defaultSet.defaults = await encryptSnapshot(id, effective.settings);
        }
        await settings.updateOne({ _id: id }, { $set: defaultSet }, { upsert: true });
      }
      results.push({
        id,
        fieldsMigrated: fieldNames,
        enabledPreserved: !enabledInitialized,
        enabledInitialized,
        enabled: migratedEnabled,
      });
    }
    return results;
  }

  async function validateStoredSecrets() {
    for (const [id, definition] of Object.entries(integrations)) {
      const document = await settings.findOne({ _id: id });
      for (const field of definition.fields) {
        const value = document?.values?.[field.name];
        if (field.secret && value) decryptValue(value, key);
        const defaultValue = document?.defaults?.[field.name];
        if (field.secret && defaultValue) decryptValue(defaultValue, key);
      }
    }
  }

  return {
    getIntegration,
    getIntegrationLabel,
    getAdminIntegrations,
    encryptSecret,
    decryptSecret,
    selfTestEncryption,
    hashForRateLimit,
    recordIntegrationFailure,
    recordIntegrationSuccess,
    claimIntegrationFailureAudit,
    claimCalendarSyncFailureAudit,
    saveIntegrations,
    prepareIntegrationSave,
    applyIntegrationSave,
    getDefaultRestorePreview,
    setIntegrationDefault,
    restoreIntegrationDefault,
    validateIntegrationFields,
    recordCandidateValidation,
    getConfigHash,
    recordVerification,
    getCurrentVerification,
    requireCurrentVerification,
    getVerificationHash,
    migrateEnvironmentValues,
    validateStoredSecrets,
  };
}

function getEnvironmentValue(integrationId, field, env) {
  let value = env[field.env] || (field.fallbackEnv ? env[field.fallbackEnv] : '') || '';
  if (field.name === 'callback_url' && !value) {
    value = `http://localhost:${Number(env.API_PORT || 3001)}/api/auth/google/callback`;
  } else if (field.name === 'port' && !value) {
    value = '587';
  } else if (field.name === 'secure' && !value) {
    value = 'false';
  } else if (field.name === 'sender_email' || field.name === 'sender_name') {
    const sender = parseSender(env.SMTP_FROM || '');
    value = field.name === 'sender_email' ? sender.email : sender.name;
  }
  if (!value && field.defaultValue !== undefined) value = field.defaultValue;
  return normalizeFieldValue(field, value);
}

function normalizeFieldValue(field, value) {
  if (field.type === 'checkbox') return value === true || value === 'true';
  if (field.name === 'port' || field.name === 'rate_limit_per_minute') {
    return value === '' || value === null ? '' : String(value);
  }
  return typeof value === 'string' ? value.trim() : '';
}

function getMissingFields(id, definition, values) {
  const missing = definition.fields
    .filter((field) => field.required && !String(values[field.name] ?? '').trim())
    .map(({ name }) => name);
  if (id === 'smtp' && Boolean(values.user) !== Boolean(values.password)) {
    if (!missing.includes('user')) missing.push('user');
    if (!missing.includes('password')) missing.push('password');
  }
  return missing;
}

function validateField(field, raw) {
  if (field.type === 'checkbox') {
    return typeof raw === 'boolean'
      ? { value: raw }
      : { error: 'Choose a valid value.' };
  }
  if (typeof raw !== 'string') return { error: 'Enter a valid value.' };
  let value = raw.trim();
  if (field.format === 'private_key') {
    value = value.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  if (field.secret && isMaskPlaceholder(value)) return { value: '' };
  if (value.length > (field.maxLength || 2048)) return { error: `Use at most ${field.maxLength} characters.` };
  const controlCharacters = field.format === 'private_key'
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (controlCharacters.test(value)) return { error: 'Control characters are not allowed.' };
  if (field.required && !value) return { error: 'This field is required.' };
  if (!value) return { value };
  if (field.format === 'url') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      return { error: 'Enter a valid HTTP or HTTPS URL.' };
    }
  } else if (field.format === 'hostname'
    && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(value)) {
    return { error: 'Enter a valid SMTP hostname.' };
  } else if (field.format === 'port'
    && (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
    return { error: 'Enter a port between 1 and 65535.' };
  } else if (field.format === 'rate_limit'
    && (!/^\d+$/.test(value)
      || Number(value) < config.integrationRateLimits.minimum
      || Number(value) > config.integrationRateLimits.maximum)) {
    return {
      error: `Enter a call limit between ${config.integrationRateLimits.minimum} and ${config.integrationRateLimits.maximum} per minute.`,
    };
  } else if (field.format === 'mfa_window' && !/^[01]$/.test(value)) {
    return { error: 'Choose a tolerance of 0 or 1 time step.' };
  } else if (field.format === 'sender_email'
    && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) {
    return { error: 'Enter a valid sender email address.' };
  } else if (field.format === 'service_account_email'
    && !/^[^\s@<>]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(value)) {
    return { error: 'Enter a valid Google service account email address.' };
  } else if (field.format === 'calendar_id' && /\s/.test(value)) {
    return { error: 'Calendar ID must not contain spaces.' };
  } else if (field.format === 'iana_timezone' && !isIanaTimeZone(value)) {
    return { error: 'Enter a valid IANA time zone, such as Asia/Manila.' };
  } else if (field.format === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return { error: 'Enter a time in 24-hour HH:MM format.' };
  } else if (field.format === 'private_key'
    && !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (?:RSA )?PRIVATE KEY-----$/.test(value)) {
    return { error: 'Enter a valid PEM private key.' };
  } else if (field.format === 'text' && !value) {
    return { error: 'Enter a valid value.' };
  }
  return { value };
}

function isIanaTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseSender(value) {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].trim() };
  return { name: '', email: value.trim() };
}

function isMaskPlaceholder(value) {
  return typeof value === 'string' && value.startsWith(MASK);
}

function encryptValue(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptValue(value, key) {
  if (!value || typeof value !== 'object' || value.version !== 1) {
    throw new Error('An integration secret is not stored in the supported encrypted format.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Unable to decrypt integration settings. Check INTEGRATION_ENCRYPTION_KEY.');
  }
}

function configHash(integrationId, values, key) {
  const definition = integrations[integrationId];
  if (!definition) return '';
  const canonical = {};
  for (const field of definition.fields) canonical[field.name] = normalizeFieldValue(field, values?.[field.name]);
  return createHmac('sha256', key).update(JSON.stringify({ integrationId, values: canonical })).digest('hex');
}

function verificationHash(integrationId, enabled, values, key) {
  const definition = integrations[integrationId];
  if (!definition) return '';
  const canonical = {};
  for (const field of definition.fields) canonical[field.name] = normalizeFieldValue(field, values?.[field.name]);
  return createHmac('sha256', key)
    .update(JSON.stringify({ integrationId, enabled: Boolean(enabled), values: canonical }))
    .digest('hex');
}

function verificationSummary(record) {
  return {
    verified: record.result === true,
    proofType: record.proofType,
    verifiedAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

module.exports = {
  createIntegrationSettings,
  parseEncryptionKey,
  parseSender,
};
