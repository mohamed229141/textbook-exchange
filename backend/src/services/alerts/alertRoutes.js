// Course Alerts routes (Mohamed)
//   POST   /api/alerts               logged in  follow a course (201)
//   GET    /api/alerts               logged in  my alerts
//   PATCH  /api/alerts/{id}          owner      change max price / condition, pause or resume
//   DELETE /api/alerts/{id}          owner      delete (204)
//   GET    /api/alerts/{id}/matches  owner      books on sale now that match
const express = require('express');
const alerts = require('./alertService');
const { requireAuth } = require('../../middleware/auth');
const { ah, requireJson } = require('../../lib/http');

const router = express.Router();
router.use('/alerts', requireAuth);

router.post('/alerts', ah(async (req, res) => {
  requireJson(req);
  res.status(201).json(await alerts.createAlert(req.user, req.body));
}));

router.get('/alerts', ah(async (req, res) => {
  res.json(await alerts.myAlerts(req.user));
}));

router.patch('/alerts/:id', ah(async (req, res) => {
  requireJson(req);
  res.json(await alerts.updateAlert(req.user, req.params.id, req.body));
}));

router.delete('/alerts/:id', ah(async (req, res) => {
  await alerts.deleteAlert(req.user, req.params.id);
  res.status(204).end();
}));

router.get('/alerts/:id/matches', ah(async (req, res) => {
  res.json(await alerts.currentMatches(req.user, req.params.id));
}));

module.exports = router;
