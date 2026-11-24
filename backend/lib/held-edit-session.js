const { LockConflictError } = require('../../src/services/locks');

function heldEditTokens(req, requests, requiredKeys, allowedAdditionalKeys = []) {
  const raw = req.get?.('X-Lock-Token') || req.headers?.['x-lock-token'];
  if (raw === undefined) return undefined;
  try {
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Invalid lock token.');
    const tokens = JSON.parse(raw);
    if (!tokens || Array.isArray(tokens) || typeof tokens !== 'object') throw new Error('Invalid lock token.');
    const allowed = new Set([...requests.map(({ key }) => key), ...allowedAdditionalKeys]);
    const keys = Object.keys(tokens);
    if (keys.some((key) => !allowed.has(key) || typeof tokens[key] !== 'string' || !tokens[key])
      || requiredKeys.some((key) => !keys.includes(key))) {
      throw new Error('Invalid lock token.');
    }
    return tokens;
  } catch {
    throw new LockConflictError(
      0,
      'This edit lock was lost or expired. Keep your changes and try again.',
      'lock_lost',
    );
  }
}

module.exports = { heldEditTokens };
