const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { integrations } = require('../config/integrations');

const MASK = '••••••••';

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

  async function getAdminIntegrations() {
    const result = {};
    for (const [id, definition] of Object.entries(integrations)) {
      const integration = await getIntegration(id);
      result[id] = {
        id,
        label: definition.label,
        enabled: integration.enabled,
        configured: integration.configured,
        active: integration.active,
        status: integration.status,
        missingFields: integration.missingFields,
        fields: definition.fields.map((field) => {
          const value = integration.settings[field.name];
          return {
            name: field.name,
            label: field.label,
            type: field.type,
            secret: field.secret,
            required: field.required,
            value: field.secret && value ? `${MASK}${value.slice(-4)}` : value,
            hasValue: Boolean(value),
          };
        }),
      };
    }
    return result;
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
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw validationError('Submit valid integration settings.');
    }
    const ids = Object.keys(input);
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
      if (Object.keys(fieldErrors).length) errors[id] = fieldErrors;

      const enabledChanged = submitted.enabled !== current.enabled;
      if (changedFields.length || enabledChanged) {
        updates.push({ id, enabled: submitted.enabled, persist, changedFields, enabledChanged });
        changed.push(id);
      }
    }

    if (Object.keys(errors).length) {
      const error = validationError('Fix the highlighted integration settings.');
      error.fieldErrors = errors;
      throw error;
    }
    if (!updates.length) return { integrations: await getAdminIntegrations(), changed: [] };

    const operations = updates.map(({ id, enabled, persist }) => {
      const set = { enabled, updated_at: new Date().toISOString() };
      for (const [name, value] of Object.entries(persist)) set[`values.${name}`] = value;
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
    await audit.runAction(events, () => settings.bulkWrite(operations, { ordered: true }));
    return { integrations: await getAdminIntegrations(), changed };
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
      }
    }
  }

  return {
    getIntegration,
    getAdminIntegrations,
    saveIntegrations,
    validateIntegrationFields,
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
  return normalizeFieldValue(field, value);
}

function normalizeFieldValue(field, value) {
  if (field.name === 'secure') return value === true || value === 'true';
  if (field.name === 'port') return value === '' || value === null ? '' : String(value);
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
  const value = raw.trim();
  if (field.secret && isMaskPlaceholder(value)) return { value: '' };
  if (value.length > (field.maxLength || 2048)) return { error: `Use at most ${field.maxLength} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { error: 'Control characters are not allowed.' };
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
  } else if (field.format === 'sender_email'
    && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) {
    return { error: 'Enter a valid sender email address.' };
  } else if (field.format === 'text' && !value) {
    return { error: 'Enter a valid value.' };
  }
  return { value };
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
