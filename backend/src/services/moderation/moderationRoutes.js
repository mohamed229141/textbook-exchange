// Moderation & Reports routes (Tarek)
//   POST  /api/reports                               logged in  report a listing (201)
//   GET   /api/reports/mine                          logged in  my reports and their outcome
//   GET   /api/admin/reports?status=Open             admin      review queue, one case per listing
//   PATCH /api/admin/reports/{listingId}/decision    admin      dismiss or uphold all open reports of a listing
const express = require('express');
const moderation = require('./moderationService');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { ah, requireJson } = require('../../lib/http');
const { rateLimit } = require('../../lib/rateLimit');
const config = require('../../config');

const router = express.Router();

router.post('/reports', requireAuth, rateLimit({ name: 'report-create', max: config.rateLimitReports }), ah(async (req, res) => {
  requireJson(req);
  res.status(201).json(await moderation.createReport(req.user, req.body));
}));

router.get('/reports/mine', requireAuth, ah(async (req, res) => {
  res.json(await moderation.myReports(req.user));
}));

router.get('/admin/reports', requireAuth, requireRole('admin'), ah(async (req, res) => {
  res.json(await moderation.reviewQueue(req.user, req.query));
}));

router.patch('/admin/reports/:listingId/decision', requireAuth, requireRole('admin'), ah(async (req, res) => {
  requireJson(req);
  res.json(await moderation.decideCase(req.user, req.params.listingId, req.body));
}));

module.exports = router;
