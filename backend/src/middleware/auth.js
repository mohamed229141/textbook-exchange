// Authentication + role checks, enforced in the BACKEND on every protected route.
//   requireAuth        -> 401 if no/invalid/expired token, 403 if the account is suspended
//   requireRole('admin') -> 403 if the logged-in user does not have the role
// The user is re-loaded from the database on every request, so a suspension,
// role change or logout (tokenVersion++) takes effect immediately.
const jwt = require('../lib/jwt');
const { getJwtSecret } = require('../lib/secrets');
const { tables } = require('../store');
const { AppError, errors } = require('../lib/http');
const { audit } = require('../lib/logger');

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

async function requireAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) throw errors.unauthorized();
    const payload = jwt.verify(token, await getJwtSecret());
    if (!payload) {
      audit('INVALID_TOKEN', { ip: req.ip, path: req.path }, { security: true });
      throw errors.unauthorized('Your session is invalid or has expired. Please log in again.');
    }
    const user = await tables.users.get(payload.sub);
    if (!user || user.tokenVersion !== payload.tv) {
      throw errors.unauthorized('Your session has ended. Please log in again.');
    }
    if (user.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended.');
    }
    req.user = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

// Public routes that show more to the owner/admin (e.g. GET /api/listings/:id):
// use the user if a valid token is sent, otherwise continue as a guest.
async function optionalAuth(req, res, next) {
  if (!bearer(req)) return next();
  requireAuth(req, res, (err) => {
    if (err) req.user = undefined;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(errors.unauthorized());
    if (!roles.includes(req.user.role)) {
      audit('ROLE_DENIED', { userId: req.user.id, role: req.user.role, needed: roles, path: req.originalUrl }, { security: true });
      return next(errors.forbidden(`This action needs the ${roles.join(' or ')} role.`));
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole };
