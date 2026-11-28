// Shared HTTP helpers: one error type, one error format, input validators.
// Every error the API returns looks like: { "error": { "code", "message", "details"? } }

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

const errors = {
  validation: (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Login required.') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'You are not allowed to do this.') => new AppError(403, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (code, message) => new AppError(409, code, message)
};

// Wrap async route handlers so rejected promises reach the error handler
// (Express 5 does this itself; the wrapper keeps Express 4 compatibility too).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireJson(req) {
  if (!req.is('application/json')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
}

// ---- validators: each returns the cleaned value or throws a 400 -------------

function text(value, label, { min = 1, max = 200, required = true, pattern, patternMessage } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw errors.validation(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw errors.validation(`${label} must be text.`);
  const clean = value.trim();
  if (clean.length < min || clean.length > max) {
    throw errors.validation(`${label} must contain between ${min} and ${max} characters.`);
  }
  // Reject control characters (log injection, odd payloads)
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(clean)) {
    throw errors.validation(`${label} contains invalid characters.`);
  }
  if (pattern && !pattern.test(clean)) {
    throw errors.validation(patternMessage || `${label} has an invalid format.`);
  }
  return clean;
}

function number(value, label, { min, max, required = true, decimals = 2 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw errors.validation(`${label} is required.`);
    return undefined;
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw errors.validation(`${label} must be a number.`);
  if (min !== undefined && n < min) throw errors.validation(`${label} must be at least ${min}.`);
  if (max !== undefined && n > max) throw errors.validation(`${label} must be at most ${max}.`);
  const factor = 10 ** decimals;
  if (Math.abs(Math.round(n * factor) - n * factor) > 1e-6) {
    throw errors.validation(`${label} may have at most ${decimals} decimal places.`);
  }
  return Math.round(n * factor) / factor;
}

function oneOf(value, label, allowed, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw errors.validation(`${label} is required.`);
    return undefined;
  }
  if (!allowed.includes(value)) {
    throw errors.validation(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

// Only allow the listed keys in a body: blocks mass assignment (e.g. "role": "admin")
function onlyKeys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw errors.validation('Request body must be a JSON object.');
  }
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw errors.validation(`Unknown field(s): ${extra.join(', ')}.`, { allowed });
  }
  return body;
}

function id(value, label = 'id') {
  return text(value, label, {
    min: 6, max: 64, pattern: /^[A-Za-z0-9_-]+$/, patternMessage: `${label} is not a valid id.`
  });
}

module.exports = { AppError, errors, ah, requireJson, v: { text, number, oneOf, onlyKeys, id } };
