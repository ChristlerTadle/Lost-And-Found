const { timingSafeEqual } = require('node:crypto');

function requireCsrf(frontendOrigin) {
  return (req, _res, next) => {
    const token = req.get('x-csrf-token');
    const expected = req.session?.csrfToken;
    const tokenBuffer = typeof token === 'string' ? Buffer.from(token) : Buffer.alloc(0);
    const expectedBuffer = typeof expected === 'string' ? Buffer.from(expected) : Buffer.alloc(0);
    if (req.get('origin') !== frontendOrigin
      || typeof token !== 'string'
      || typeof expected !== 'string'
      || tokenBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(tokenBuffer, expectedBuffer)) {
      const error = new Error('The request could not be verified. Reload the page and try again.');
      error.status = 403;
      return next(error);
    }
    return next();
  };
}

module.exports = { requireCsrf };
