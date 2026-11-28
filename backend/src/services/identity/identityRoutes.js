// Identity & Access routes (Student A)
//   POST  /api/auth/register         public      create a student account (201)
//   POST  /api/auth/login            public      get a token (200)
//   POST  /api/auth/logout           logged in   invalidate all tokens (204)
//   GET   /api/users/me              logged in   my profile
//   PATCH /api/users/me              logged in   update my profile
//   PUT   /api/users/me/password     logged in   change password (new token)
//   GET   /api/admin/users           admin       list / filter users
//   PATCH /api/admin/users/:id/status admin      suspend / reactivate
//   PATCH /api/admin/users/:id/role   admin      change role
//   GET   /api/admin/stats           admin       platform statistics + monitoring counters
//   POST  /api/admin/jobs/run        admin       run expiry jobs now
const express = require('express');
const config = require('../../config');
const identity = require('./identityService');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { ah, requireJson, v } = require('../../lib/http');
const { rateLimit } = require('../../lib/rateLimit');
const { metrics } = require('../../lib/logger');

const router = express.Router();
const authLimiter = rateLimit({ name: 'auth', max: config.rateLimitAuth });

router.post('/auth/register', authLimiter, ah(async (req, res) => {
  requireJson(req);
  res.status(201).json(await identity.register(req.body));
}));

router.post('/auth/login', authLimiter, ah(async (req, res) => {
  requireJson(req);
  res.status(200).json(await identity.login(req.body, req.ip));
}));

router.post('/auth/logout', requireAuth, ah(async (req, res) => {
  await identity.logout(req.user.id);
  res.status(204).end();
}));

router.get('/users/me', requireAuth, ah(async (req, res) => {
  res.json(await identity.getMe(req.user.id));
}));

router.patch('/users/me', requireAuth, ah(async (req, res) => {
  requireJson(req);
  res.json(await identity.updateMe(req.user.id, req.body));
}));

router.put('/users/me/password', requireAuth, authLimiter, ah(async (req, res) => {
  requireJson(req);
  res.json(await identity.changePassword(req.user.id, req.body));
}));

// ---- admin ------------------------------------------------------------------
const admin = express.Router();
admin.use(requireAuth, requireRole('admin'));

admin.get('/users', ah(async (req, res) => {
  res.json(await identity.listUsers(req.query));
}));

admin.patch('/users/:id/status', ah(async (req, res) => {
  requireJson(req);
  res.json(await identity.setStatus(req.user, v.id(req.params.id), req.body));
}));

admin.patch('/users/:id/role', ah(async (req, res) => {
  requireJson(req);
  res.json(await identity.setRole(req.user, v.id(req.params.id), req.body));
}));

// Stats combine data from all four services (cross-service read)
admin.get('/stats', ah(async (req, res) => {
  const users = await identity.listUsers({});
  const listingStats = await require('../listings/listingService').stats();
  const requestStats = await require('../requests/requestService').stats();
  const reportStats = await require('../moderation/moderationService').stats();
  const alertStats = await require('../alerts/alertService').stats();
  const semester = await require('../listings/semesterService').currentSemester();
  res.json({
    users: {
      total: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      suspended: users.filter((u) => u.status === 'suspended').length
    },
    listings: listingStats,
    requests: requestStats,
    reports: reportStats,
    alerts: alertStats,
    semester: { name: semester.name, endsAt: semester.endsAt.toISOString(), source: semester.source },
    monitoring: { runtime: config.runtime, ...metrics }
  });
}));

admin.post('/jobs/run', ah(async (req, res) => {
  const { runAllJobs } = require('../../jobsRunner');
  res.json(await runAllJobs({ trigger: `admin:${req.user.id}` }));
}));

router.use('/admin', admin);

module.exports = router;
