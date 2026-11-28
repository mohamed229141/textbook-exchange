// SERVICE 1 - Identity & Access (owner: Student A)
// Business capability: who the users are and what they may do.
// Business rules:
//  - unique e-mail, optional university e-mail domain allow-list
//  - password policy (8-72 chars, at least one letter and one digit), scrypt hashing
//  - account lockout: 5 failed logins -> locked 15 minutes
//  - suspended accounts cannot log in; existing tokens stop working at once
//  - logout / password change invalidate all tokens (tokenVersion)
//  - an admin cannot suspend or demote themself; the last admin cannot be demoted
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../../config');
const { tables } = require('../../store');
const jwt = require('../../lib/jwt');
const { getJwtSecret } = require('../../lib/secrets');
const { AppError, errors, v } = require('../../lib/http');
const { audit } = require('../../lib/logger');
const events = require('../../lib/events');

const scrypt = promisify(crypto.scrypt);
const ROLES = ['student', 'admin'];
const STATUSES = ['active', 'suspended'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}

async function passwordMatches(password, user) {
  const { hash } = await hashPassword(password, user.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkPassword(password, label = 'Password') {
  const clean = v.text(password, label, { min: 8, max: 72 });
  if (!/[A-Za-z]/.test(clean) || !/\d/.test(clean)) {
    throw errors.validation(`${label} must contain at least one letter and one digit.`);
  }
  return password; // hash the exact value the user typed
}

function checkEmail(email) {
  const clean = v.text(email, 'Email', { min: 5, max: 120, pattern: EMAIL_RE, patternMessage: 'Email is not valid.' }).toLowerCase();
  if (config.allowedEmailDomains.length) {
    const domain = clean.split('@')[1];
    if (!config.allowedEmailDomains.includes(domain)) {
      throw errors.validation(`Use your university e-mail (${config.allowedEmailDomains.join(', ')}).`);
    }
  }
  return clean;
}

// What the API shows about a user (never the hash, salt or counters)
function publicUser(u) {
  return {
    id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: u.status,
    phone: u.phone, faculty: u.faculty, strikes: u.strikes || 0, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt
  };
}

async function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion }, await getJwtSecret(), config.tokenTtlSeconds);
}

async function findByEmail(email) {
  const found = await tables.users.queryBy('email', email);
  return found[0];
}

async function register(body, { role = 'student' } = {}) {
  v.onlyKeys(body, ['email', 'password', 'displayName', 'phone', 'faculty']);
  const email = checkEmail(body.email);
  const password = checkPassword(body.password);
  const displayName = v.text(body.displayName, 'Display name', { min: 2, max: 50 });
  const phone = v.text(body.phone, 'Phone', { required: false, min: 7, max: 20, pattern: /^\+?[0-9 ()-]+$/ });
  const faculty = v.text(body.faculty, 'Faculty', { required: false, min: 2, max: 60 });

  if (await findByEmail(email)) throw errors.conflict('EMAIL_TAKEN', 'An account with this e-mail already exists.');

  const { salt, hash } = await hashPassword(password);
  const now = new Date().toISOString();
  const user = await tables.users.create({
    id: `usr_${crypto.randomUUID().replace(/-/g, '')}`,
    email, displayName, phone, faculty,
    role, // never taken from the request body
    status: 'active',
    passwordHash: hash, passwordSalt: salt,
    tokenVersion: 1, failedLogins: 0, lockedUntil: null,
    createdAt: now, lastLoginAt: now
  });
  await audit('USER_REGISTERED', { userId: user.id, role });
  return { user: publicUser(user), token: await issueToken(user) };
}

async function login(body, ip) {
  const email = v.text(body && body.email, 'Email', { max: 120 }).toLowerCase();
  const password = v.text(body && body.password, 'Password', { max: 72 });
  const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'E-mail or password is incorrect.');

  const user = await findByEmail(email);
  if (!user) {
    await hashPassword(password); // same work as a real check: no timing hint that the e-mail is unknown
    await audit('LOGIN_FAILED', { reason: 'unknown_email', ip }, { security: true });
    throw invalid;
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    await audit('LOGIN_BLOCKED_LOCKED', { userId: user.id, ip }, { security: true });
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed logins. Try again after ${new Date(user.lockedUntil).toLocaleTimeString('en-GB')}.`);
  }
  if (!(await passwordMatches(password, user))) {
    const failedLogins = (user.failedLogins || 0) + 1;
    const locked = failedLogins >= config.maxFailedLogins;
    await tables.users.update({
      ...user,
      failedLogins: locked ? 0 : failedLogins,
      lockedUntil: locked ? new Date(Date.now() + config.lockMinutes * 60_000).toISOString() : null
    }, user.version).catch(() => {});
    await audit(locked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', { userId: user.id, failedLogins, ip }, { security: true });
    throw invalid;
  }
  if (user.status !== 'active') {
    await audit('LOGIN_BLOCKED_SUSPENDED', { userId: user.id, ip }, { security: true });
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended. Contact the administrator.');
  }
  const saved = await tables.users.update({
    ...user, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date().toISOString()
  }, user.version);
  await audit('LOGIN_SUCCESS', { userId: user.id, ip });
  return { user: publicUser(saved), token: await issueToken(saved) };
}

async function logout(userId) {
  const user = await tables.users.get(userId);
  await tables.users.update({ ...user, tokenVersion: user.tokenVersion + 1 }, user.version);
  await audit('LOGOUT', { userId });
}

async function getMe(userId) {
  const user = await tables.users.get(userId);
  if (!user) throw errors.notFound('User');
  return publicUser(user);
}

async function updateMe(userId, body) {
  v.onlyKeys(body, ['displayName', 'phone', 'faculty']);
  const user = await tables.users.get(userId);
  const changes = {};
  if (body.displayName !== undefined) changes.displayName = v.text(body.displayName, 'Display name', { min: 2, max: 50 });
  if (body.phone !== undefined) changes.phone = v.text(body.phone, 'Phone', { required: false, min: 7, max: 20, pattern: /^\+?[0-9 ()-]+$/ }) || null;
  if (body.faculty !== undefined) changes.faculty = v.text(body.faculty, 'Faculty', { required: false, min: 2, max: 60 }) || null;
  if (!Object.keys(changes).length) throw errors.validation('Nothing to update.');
  const saved = await tables.users.update({ ...user, ...changes }, user.version);
  return publicUser(saved);
}

async function changePassword(userId, body) {
  v.onlyKeys(body, ['currentPassword', 'newPassword']);
  const current = v.text(body.currentPassword, 'Current password', { max: 72 });
  const next = checkPassword(body.newPassword, 'New password');
  const user = await tables.users.get(userId);
  if (!(await passwordMatches(current, user))) {
    await audit('PASSWORD_CHANGE_FAILED', { userId }, { security: true });
    // 400 (not 401): the session itself is valid, only the typed password is wrong
    throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
  }
  if (current === next) throw errors.validation('New password must be different.');
  const { salt, hash } = await hashPassword(next);
  const saved = await tables.users.update({
    ...user, passwordHash: hash, passwordSalt: salt, tokenVersion: user.tokenVersion + 1
  }, user.version);
  await audit('PASSWORD_CHANGED', { userId });
  return { token: await issueToken(saved) }; // all other sessions are logged out
}

// Used by the Requests service: contact details are only shared after a request is accepted
async function getContact(userId) {
  const user = await tables.users.get(userId);
  return user ? { displayName: user.displayName, email: user.email, phone: user.phone || null } : null;
}

// ---- admin functions --------------------------------------------------------

async function listUsers(query) {
  const role = v.oneOf(query.role, 'role', ROLES, { required: false });
  const status = v.oneOf(query.status, 'status', STATUSES, { required: false });
  const users = await tables.users.scan();
  return users
    .filter((u) => (!role || u.role === role) && (!status || u.status === status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(publicUser);
}

async function setStatus(admin, targetId, body) {
  v.onlyKeys(body, ['status', 'reason']);
  const status = v.oneOf(body.status, 'status', STATUSES);
  const reason = v.text(body.reason, 'Reason', { required: false, max: 200 });
  if (targetId === admin.id) throw errors.conflict('CANNOT_CHANGE_SELF', 'You cannot change your own account status.');
  const user = await tables.users.get(targetId);
  if (!user) throw errors.notFound('User');
  if (user.status === status) return publicUser(user);
  const saved = await tables.users.update({
    ...user, status,
    tokenVersion: user.tokenVersion + 1 // suspended user is logged out everywhere
  }, user.version);
  await audit('USER_STATUS_CHANGED', { adminId: admin.id, userId: targetId, status, reason });
  if (status === 'suspended') await events.emit('user.suspended', { userId: targetId, adminId: admin.id });
  return publicUser(saved);
}

// Used by the Moderation service: an upheld report gives the seller a strike;
// at 3 strikes the account is suspended automatically (same effect as an admin suspension).
async function addStrike(userId, { maxStrikes = 3, reason = 'repeated upheld reports' } = {}) {
  const user = await tables.users.get(userId);
  if (!user) return null;
  const strikes = (user.strikes || 0) + 1;
  const suspend = strikes >= maxStrikes && user.status === 'active' && user.role !== 'admin';
  await tables.users.update({
    ...user, strikes,
    ...(suspend ? { status: 'suspended', tokenVersion: user.tokenVersion + 1 } : {})
  }, user.version);
  await audit(suspend ? 'USER_AUTO_SUSPENDED' : 'USER_STRIKE_ADDED', { userId, strikes, reason }, { security: suspend });
  if (suspend) await events.emit('user.suspended', { userId, adminId: 'system' });
  return { strikes, suspended: suspend };
}

async function setRole(admin, targetId, body) {
  v.onlyKeys(body, ['role']);
  const role = v.oneOf(body.role, 'role', ROLES);
  if (targetId === admin.id) throw errors.conflict('CANNOT_CHANGE_SELF', 'You cannot change your own role.');
  const user = await tables.users.get(targetId);
  if (!user) throw errors.notFound('User');
  if (user.role === 'admin' && role !== 'admin') {
    const admins = (await tables.users.scan()).filter((u) => u.role === 'admin' && u.status === 'active');
    if (admins.length <= 1) throw errors.conflict('LAST_ADMIN', 'The last admin cannot be demoted.');
  }
  const saved = await tables.users.update({ ...user, role, tokenVersion: user.tokenVersion + 1 }, user.version);
  await audit('USER_ROLE_CHANGED', { adminId: admin.id, userId: targetId, from: user.role, to: role });
  return publicUser(saved);
}

module.exports = {
  register, login, logout, getMe, updateMe, changePassword, getContact,
  listUsers, setStatus, setRole, addStrike, hashPassword, publicUser, findByEmail
};
