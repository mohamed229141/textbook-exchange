// Requests & Notifications routes (Student C)
//   POST  /api/requests                     logged in  send a purchase request (201)
//   GET   /api/requests?box=&status=        logged in  incoming (as seller) / outgoing (as buyer) / all (admin)
//   GET   /api/requests/:id                 buyer, seller or admin
//   PATCH /api/requests/:id/status          Accepted/Declined/Completed (seller), Cancelled (buyer)
//   GET   /api/notifications                logged in  my notifications (?unread=true)
//   PATCH /api/notifications/:id/read       owner      mark one as read
//   POST  /api/notifications/read-all       logged in  mark all as read
const express = require('express');
const requests = require('./requestService');
const { requireAuth } = require('../../middleware/auth');
const { ah, requireJson } = require('../../lib/http');
const { rateLimit } = require('../../lib/rateLimit');

const router = express.Router();
const createLimiter = rateLimit({ name: 'request-create', max: 20 });

router.post('/requests', requireAuth, createLimiter, ah(async (req, res) => {
  requireJson(req);
  const request = await requests.createRequest(req.user, req.body);
  res.status(201).location(`/api/requests/${request.id}`).json(request);
}));

router.get('/requests', requireAuth, ah(async (req, res) => {
  res.json(await requests.listRequests(req.user, req.query));
}));

router.get('/requests/:id', requireAuth, ah(async (req, res) => {
  res.json(await requests.getRequest(req.user, req.params.id));
}));

router.patch('/requests/:id/status', requireAuth, ah(async (req, res) => {
  requireJson(req);
  const body = req.body && Object.keys(req.body).length ? req.body : { status: req.query.status };
  res.json(await requests.changeStatus(req.user, req.params.id, body));
}));

router.get('/notifications', requireAuth, ah(async (req, res) => {
  res.json(await requests.listNotifications(req.user, req.query));
}));

router.patch('/notifications/:id/read', requireAuth, ah(async (req, res) => {
  res.json(await requests.markRead(req.user, req.params.id));
}));

router.post('/notifications/read-all', requireAuth, ah(async (req, res) => {
  res.json(await requests.markAllRead(req.user));
}));

module.exports = router;
