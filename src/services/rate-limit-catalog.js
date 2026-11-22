const KEY_TYPE_LABELS = {
  account: 'per account',
  'account+ip': 'per account and IP',
  'account+item': 'per account and item',
  'account+resource': 'per account and integration',
  email: 'per email',
  ip: 'per IP',
  'ip+email': 'per IP and email',
  resource: 'per integration',
  session: 'per settings session',
};

function toRow(configGroup, definition, metadata, kind, controlId) {
  if (!metadata?.label || !metadata.module || !metadata.action) {
    throw new Error(`Missing rate-limit catalog metadata for ${configGroup}.`);
  }
  const keyType = definition.keyType;
  if (!KEY_TYPE_LABELS[keyType]) {
    throw new Error(`Unsupported rate-limit key type in ${configGroup}.`);
  }
  return {
    kind,
    configGroup,
    controlId,
    label: metadata.label,
    module: metadata.module,
    action: metadata.action,
    max: definition.max,
    windowSeconds: Math.ceil(definition.windowMs / 1000),
    keyType: KEY_TYPE_LABELS[keyType],
    store: definition.store,
    failureMode: definition.store === 'mongo' && definition.sensitive ? 'Fail closed' : 'Fail open',
    source: definition.source || metadata.source || 'default',
  };
}

function buildRateLimitRows(config) {
  const { rateLimits, rateLimitMetadata, rateLimitControlRows = [] } = config || {};
  if (!rateLimits || !rateLimitMetadata) {
    throw new TypeError('Rate-limit configuration and catalog metadata are required.');
  }

  const routeRows = Object.entries(rateLimits).flatMap(([configGroup, definition]) => {
    if (!rateLimitMetadata[configGroup]) {
      throw new Error(`Missing rate-limit catalog metadata for ${configGroup}.`);
    }
    const rules = definition.rules || [definition];
    return rules.map((rule) => {
      const ruleGroup = rule.group || configGroup;
      return toRow(
        configGroup,
        rule,
        rateLimitMetadata[ruleGroup] || rateLimitMetadata[configGroup],
        'route',
      );
    });
  });
  const controlRows = rateLimitControlRows.map((row) => (
    toRow(row.id, row, row, 'control', row.id)
  ));
  return [...routeRows, ...controlRows];
}

module.exports = { buildRateLimitRows };
