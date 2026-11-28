// Fixed-window rate limiter per client IP (in memory, per process / per Lambda instance).
// Limitation (documented in the report): counts are not shared between instances.
const { AppError } = require('./http');
const { audit } = require('./logger');

function rateLimit({ name, max, windowMs = 60_000 }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) hits.clear(); // memory guard
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)));
      if (entry.count === max + 1) audit('RATE_LIMITED', { limiter: name, ip: key, path: req.path }, { security: true });
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.'));
    }
    next();
  };
}

module.exports = { rateLimit };
