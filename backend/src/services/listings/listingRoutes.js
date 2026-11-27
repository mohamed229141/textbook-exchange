// Listings routes (Student B)
//   GET    /api/listings                  public     search (courseCode, condition, minPrice, maxPrice, q, status, sort, limit, offset)
//   GET    /api/listings/mine             logged in  my listings (all statuses)
//   GET    /api/listings/price-guide      public     min/avg/max price for a course (?courseCode=)
//   GET    /api/listings/:id              public     one listing
//   POST   /api/listings                  logged in  create (201)
//   PUT    /api/listings/:id              seller     replace editable fields
//   PATCH  /api/listings/:id/status       seller     Available / Reserved / Sold workflow
//   POST   /api/listings/:id/renew        seller     renew an expired listing
//   DELETE /api/listings/:id              seller or admin
//   POST   /api/listings/:id/photo        seller     upload photo to S3 (base64 JSON)
//   GET    /api/listings/:id/photo        public     read photo from S3
//   GET    /api/books/isbn/:isbn          logged in  Google Books lookup (external API)
//   GET    /api/settings/semester         public     current semester name + end date (when listings expire)
//   PUT    /api/admin/semester            admin      set the semester end (moves Available listings too)
const express = require('express');
const listings = require('./listingService');
const { requireAuth, optionalAuth, requireRole } = require('../../middleware/auth');
const semesters = require('./semesterService');
const { ah, requireJson, v } = require('../../lib/http');
const { rateLimit } = require('../../lib/rateLimit');

const router = express.Router();
const lookupLimiter = rateLimit({ name: 'isbn-lookup', max: 30 });

router.get('/listings', optionalAuth, ah(async (req, res) => {
  res.json(await listings.search(req.query, req.user));
}));

router.get('/listings/mine', requireAuth, ah(async (req, res) => {
  res.json(await listings.myListings(req.user));
}));

router.get('/listings/price-guide', ah(async (req, res) => {
  res.json(await listings.priceGuide(req.query.courseCode));
}));

router.get('/listings/:id', optionalAuth, ah(async (req, res) => {
  res.json(await listings.getListing(req.params.id, req.user));
}));

router.post('/listings', requireAuth, ah(async (req, res) => {
  requireJson(req);
  const listing = await listings.createListing(req.user, req.body);
  res.status(201).location(`/api/listings/${listing.id}`).json(listing);
}));

router.put('/listings/:id', requireAuth, ah(async (req, res) => {
  requireJson(req);
  res.json(await listings.updateListing(req.user, req.params.id, req.body));
}));

router.patch('/listings/:id/status', requireAuth, ah(async (req, res) => {
  requireJson(req);
  // Fallback to ?status= for API Gateway emulators that drop PATCH bodies (same as Lab 7)
  const body = req.body && Object.keys(req.body).length ? req.body : { status: req.query.status };
  res.json(await listings.changeStatus(req.user, req.params.id, body));
}));

router.post('/listings/:id/renew', requireAuth, ah(async (req, res) => {
  res.json(await listings.renewListing(req.user, req.params.id));
}));

router.delete('/listings/:id', requireAuth, ah(async (req, res) => {
  await listings.deleteListing(req.user, req.params.id, req.query.reason);
  res.status(204).end();
}));

router.post('/listings/:id/photo', requireAuth, ah(async (req, res) => {
  requireJson(req);
  res.json(await listings.uploadPhoto(req.user, req.params.id, req.body));
}));

router.get('/listings/:id/photo', optionalAuth, ah(async (req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  res.json(await listings.getPhoto(req.params.id, req.user));
}));

router.get('/books/isbn/:isbn', requireAuth, lookupLimiter, ah(async (req, res) => {
  v.text(req.params.isbn, 'ISBN', { max: 20 });
  res.json(await listings.lookupIsbn(req.params.isbn));
}));

router.get('/settings/semester', ah(async (req, res) => {
  const s = await semesters.currentSemester();
  res.json({ name: s.name, endsAt: s.endsAt.toISOString(), source: s.source });
}));

router.put('/admin/semester', requireAuth, requireRole('admin'), ah(async (req, res) => {
  requireJson(req);
  res.json(await semesters.setSemester(req.user, req.body));
}));

module.exports = router;
