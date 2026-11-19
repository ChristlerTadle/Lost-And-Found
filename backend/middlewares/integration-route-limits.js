function createIntegrationRouteLimit({ limit, windowMs, overall = false, bucketKey = null }) {
  const buckets = new Map();
  return (req, res, next) => {
    const adminId = String(req.user?.id || 'anonymous');
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const scope = overall ? 'overall'
      : typeof bucketKey === 'function' ? bucketKey(req)
        : bucketKey || req.route?.path || req.path;
    const key = `${adminId}|${scope}|${ip}`;
    const now = Date.now();
    const record = buckets.get(key);
    if (!record || now - record.startedAt >= windowMs) {
      buckets.set(key, { count: 1, startedAt: now });
      return next();
    }
    record.count += 1;
    if (record.count <= limit) return next();

    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - record.startedAt)) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${Math.ceil(retryAfter / 60) === 1 ? '' : 's'}.`,
    });
  };
}

module.exports = { createIntegrationRouteLimit };
