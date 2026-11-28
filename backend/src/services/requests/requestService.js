// SERVICE 3 - Purchase Requests & Notifications (owner: Student C)
// Business capability: a buyer asks for a book, the seller decides, the deal completes.
// Business rules:
//  - a buyer cannot request their own listing; the listing must be Available (not expired)
//  - one open (Pending/Accepted) request per buyer per listing
//  - a buyer may have at most 5 Pending requests at a time
//  - an offer must be between 50% and 100% of the asking price
//  - status workflow:
//        Pending  -> Accepted (seller)  -> Completed (seller)
//        Pending  -> Declined (seller)
//        Pending / Accepted -> Cancelled (buyer)
//        Accepted -> Expired (reservation not completed within 72 hours: job)
//  - accepting reserves the listing for 72 hours (calls the Listings service) and
//    automatically declines every other Pending request for the same listing
//  - completing marks the listing Sold at the agreed price (calls the Listings service)
//  - contact details (e-mail / phone) are only shown to both sides after acceptance
//  - every step notifies the other party (DynamoDB + SNS + SQS)
const crypto = require('crypto');
const config = require('../../config');
const { tables } = require('../../store');
const { AppError, errors, v } = require('../../lib/http');
const { audit } = require('../../lib/logger');
const events = require('../../lib/events');
const listings = require('../listings/listingService');
const identity = require('../identity/identityService');
const { notify } = require('./notifier');

const STATUSES = ['Pending', 'Accepted', 'Declined', 'Cancelled', 'Completed', 'Expired'];
const OPEN = ['Pending', 'Accepted'];

function participant(request, user) {
  if (user.role === 'admin') return 'admin';
  if (request.buyerId === user.id) return 'buyer';
  if (request.sellerId === user.id) return 'seller';
  return null;
}

async function toView(request, user) {
  const out = {
    id: request.id, listingId: request.listingId, listingTitle: request.listingTitle,
    courseCode: request.courseCode, askingPrice: request.askingPrice, offerPrice: request.offerPrice,
    message: request.message, status: request.status,
    buyerId: request.buyerId, buyerName: request.buyerName,
    sellerId: request.sellerId, sellerName: request.sellerName,
    reservedUntil: request.reservedUntil || null,
    history: request.history, createdAt: request.createdAt, updatedAt: request.updatedAt,
    myRole: participant(request, user)
  };
  // Privacy rule: contact details only after the seller accepted
  if (['Accepted', 'Completed'].includes(request.status)) {
    out.contact = {
      buyer: await identity.getContact(request.buyerId),
      seller: await identity.getContact(request.sellerId)
    };
  }
  return out;
}

async function loadVisible(user, id) {
  const request = await tables.requests.get(v.id(id, 'request id'));
  if (!request) throw errors.notFound('Request');
  if (!participant(request, user)) {
    await audit('OWNERSHIP_VIOLATION', { userId: user.id, requestId: request.id }, { security: true });
    throw errors.forbidden('This request belongs to other users.');
  }
  return request;
}

function step(request, status, by, note) {
  return [...(request.history || []), { status, by, at: new Date().toISOString(), ...(note ? { note } : {}) }];
}

async function save(request, changes, by, note) {
  return tables.requests.update({
    ...request, ...changes,
    history: step(request, changes.status, by, note),
    updatedAt: new Date().toISOString()
  }, request.version);
}

async function createRequest(user, body) {
  v.onlyKeys(body, ['listingId', 'offerPrice', 'message']);
  const listingId = v.id(body.listingId, 'listingId');
  const message = v.text(body.message, 'Message', { required: false, max: 500 }) || '';

  const listing = await listings.getForRequest(listingId);
  if (!listing || listing.status === 'Removed') throw errors.notFound('Listing');
  if (listing.sellerId === user.id) {
    await audit('SELF_REQUEST_BLOCKED', { userId: user.id, listingId }, { security: true });
    throw errors.forbidden('You cannot request your own listing.');
  }
  if (listing.status !== 'Available') {
    throw errors.conflict('LISTING_NOT_AVAILABLE', `This book is ${listing.status}.`);
  }
  const minOffer = Math.ceil(listing.price * config.minOfferRatio);
  const offerPrice = body.offerPrice === undefined || body.offerPrice === null || body.offerPrice === ''
    ? listing.price
    : v.number(body.offerPrice, 'Offer price', { min: 1, max: listing.price });
  if (offerPrice < minOffer) {
    throw errors.validation(`Offer must be between ${minOffer} and ${listing.price} EGP (at least 50% of the asking price).`);
  }

  const mine = await tables.requests.queryBy('buyerId', user.id);
  if (mine.some((r) => r.listingId === listingId && OPEN.includes(r.status))) {
    throw errors.conflict('DUPLICATE_REQUEST', 'You already have an open request for this book.');
  }
  const pending = mine.filter((r) => r.status === 'Pending').length;
  if (pending >= config.maxPendingRequestsPerBuyer) {
    throw errors.conflict('REQUEST_LIMIT_REACHED', `You can have at most ${config.maxPendingRequestsPerBuyer} pending requests. Cancel one first.`);
  }

  const now = new Date().toISOString();
  const request = await tables.requests.create({
    id: `req_${crypto.randomUUID().replace(/-/g, '')}`,
    listingId, listingTitle: listing.title, courseCode: listing.courseCode, askingPrice: listing.price,
    sellerId: listing.sellerId, sellerName: listing.sellerName,
    buyerId: user.id, buyerName: user.displayName,
    offerPrice, message, status: 'Pending',
    history: [{ status: 'Pending', by: user.id, at: now }],
    createdAt: now, updatedAt: now
  });
  await notify(listing.sellerId, 'REQUEST_CREATED',
    `${user.displayName} wants "${listing.title}" for ${offerPrice} EGP.`, { requestId: request.id, listingId });
  await audit('REQUEST_CREATED', { userId: user.id, requestId: request.id, listingId });
  return toView(request, user);
}

async function listRequests(user, query) {
  const box = v.oneOf(query.box, 'box', ['incoming', 'outgoing', 'all'], { required: false }) || 'outgoing';
  const status = v.oneOf(query.status, 'status', STATUSES, { required: false });
  let items;
  if (box === 'all') {
    if (user.role !== 'admin') throw errors.forbidden('Only admins can see all requests.');
    items = await tables.requests.scan();
  } else {
    items = await tables.requests.queryBy(box === 'incoming' ? 'sellerId' : 'buyerId', user.id);
  }
  items = items.filter((r) => !status || r.status === status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return Promise.all(items.map((r) => toView(r, user)));
}

async function getRequest(user, id) {
  return toView(await loadVisible(user, id), user);
}

async function declineOthers(listingId, keepId, reason, by) {
  const others = await tables.requests.queryBy('listingId', listingId);
  for (const r of others.filter((x) => x.id !== keepId && x.status === 'Pending')) {
    try {
      await save(r, { status: 'Declined' }, by, reason);
      await notify(r.buyerId, 'REQUEST_DECLINED', `Your request for "${r.listingTitle}" was declined: ${reason}.`,
        { requestId: r.id, listingId });
    } catch { /* changed meanwhile */ }
  }
}

async function changeStatus(user, id, body) {
  v.onlyKeys(body, ['status', 'note']);
  const to = v.oneOf(body.status, 'status', ['Accepted', 'Declined', 'Cancelled', 'Completed']);
  const note = v.text(body.note, 'Note', { required: false, max: 200 });
  const request = await loadVisible(user, id);
  const role = participant(request, user);

  const rules = {
    Accepted: { who: 'seller', from: ['Pending'] },
    Declined: { who: 'seller', from: ['Pending'] },
    Cancelled: { who: 'buyer', from: ['Pending', 'Accepted'] },
    Completed: { who: 'seller', from: ['Accepted'] }
  }[to];
  if (role !== rules.who) {
    await audit('ROLE_DENIED', { userId: user.id, requestId: request.id, wanted: to }, { security: true });
    throw errors.forbidden(`Only the ${rules.who} can set a request to ${to}.`);
  }
  if (!rules.from.includes(request.status)) {
    throw errors.conflict('INVALID_TRANSITION', `A ${request.status} request cannot become ${to}.`);
  }

  let saved;
  if (to === 'Accepted') {
    const listing = await listings.reserveForBuyer(request.listingId, request.buyerId); // 409 if no longer Available
    saved = await save(request, { status: 'Accepted', reservedUntil: listing.reservedUntil }, user.id, note);
    await declineOthers(request.listingId, request.id, 'the seller accepted another buyer', user.id);
    await notify(request.buyerId, 'REQUEST_ACCEPTED',
      `${request.sellerName} accepted your request for "${request.listingTitle}". It is reserved for you for ${config.reservationHours} hours.`,
      { requestId: request.id, listingId: request.listingId });
  } else if (to === 'Declined') {
    saved = await save(request, { status: 'Declined' }, user.id, note);
    await notify(request.buyerId, 'REQUEST_DECLINED', `Your request for "${request.listingTitle}" was declined.`,
      { requestId: request.id, listingId: request.listingId });
  } else if (to === 'Cancelled') {
    if (request.status === 'Accepted') await listings.releaseReservation(request.listingId, request.buyerId);
    saved = await save(request, { status: 'Cancelled' }, user.id, note);
    await notify(request.sellerId, 'REQUEST_CANCELLED', `${request.buyerName} cancelled the request for "${request.listingTitle}".`,
      { requestId: request.id, listingId: request.listingId });
  } else if (to === 'Completed') {
    await listings.markSold(request.listingId, request.buyerId, request.offerPrice);
    saved = await save(request, { status: 'Completed', completedAt: new Date().toISOString() }, user.id, note);
    await notify(request.buyerId, 'REQUEST_COMPLETED', `Purchase of "${request.listingTitle}" completed. Enjoy your book!`,
      { requestId: request.id, listingId: request.listingId });
  }
  await audit('REQUEST_STATUS_CHANGED', { userId: user.id, requestId: request.id, from: request.status, to });
  return toView(saved, user);
}

// ---- notifications ------------------------------------------------------------

async function listNotifications(user, query) {
  const unreadOnly = query.unread === 'true';
  const items = (await tables.notifications.queryBy('userId', user.id))
    .filter((n) => !unreadOnly || !n.read)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);
  return { unread: items.filter((n) => !n.read).length, items };
}

async function markRead(user, id) {
  const n = await tables.notifications.get(v.id(id, 'notification id'));
  if (!n) throw errors.notFound('Notification');
  if (n.userId !== user.id) {
    await audit('OWNERSHIP_VIOLATION', { userId: user.id, notificationId: n.id }, { security: true });
    throw errors.forbidden('This notification belongs to another user.');
  }
  if (n.read) return n;
  return tables.notifications.update({ ...n, read: true, readAt: new Date().toISOString() }, n.version);
}

async function markAllRead(user) {
  const items = (await tables.notifications.queryBy('userId', user.id)).filter((n) => !n.read);
  for (const n of items) await tables.notifications.update({ ...n, read: true, readAt: new Date().toISOString() }, n.version).catch(() => {});
  return { updated: items.length };
}

// ---- jobs + stats -------------------------------------------------------------

// Accepted requests whose 72-hour reservation ran out: expire them, free the book
async function expireReservations(now = new Date()) {
  const accepted = (await tables.requests.scan()).filter((r) => r.status === 'Accepted'
    && r.reservedUntil && new Date(r.reservedUntil) < now);
  for (const r of accepted) {
    try {
      await listings.releaseReservation(r.listingId, r.buyerId);
      await save(r, { status: 'Expired' }, 'system', 'reservation time ran out');
      const msg = `The reservation of "${r.listingTitle}" expired after ${config.reservationHours} hours.`;
      await notify(r.buyerId, 'RESERVATION_EXPIRED', msg, { requestId: r.id, listingId: r.listingId });
      await notify(r.sellerId, 'RESERVATION_EXPIRED', `${msg} The book is Available again.`, { requestId: r.id, listingId: r.listingId });
    } catch { /* changed meanwhile */ }
  }
  return accepted.length;
}

async function stats() {
  const all = await tables.requests.scan();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  all.forEach((r) => { byStatus[r.status] += 1; });
  const decided = byStatus.Accepted + byStatus.Completed + byStatus.Declined + byStatus.Expired;
  return {
    total: all.length, byStatus,
    acceptanceRate: decided ? Math.round(((byStatus.Accepted + byStatus.Completed + byStatus.Expired) / decided) * 100) : null
  };
}

// ---- reactions to events from the other services ------------------------------

async function closeOpenRequests(listingId, reason, by) {
  const related = await tables.requests.queryBy('listingId', listingId);
  for (const r of related.filter((x) => OPEN.includes(x.status))) {
    try {
      await save(r, { status: r.status === 'Pending' ? 'Declined' : 'Cancelled' }, by, reason);
      await notify(r.buyerId, 'REQUEST_CLOSED', `Your request for "${r.listingTitle}" was closed: ${reason}.`,
        { requestId: r.id, listingId });
    } catch { /* changed meanwhile */ }
  }
}

// Seller changed the listing status by hand
events.on('listing.statusChanged', async ({ listing, to, actorId }) => {
  const related = await tables.requests.queryBy('listingId', listing.id);
  if (to === 'Sold') {
    const accepted = related.find((r) => r.status === 'Accepted');
    if (accepted) {
      await save(accepted, { status: 'Completed', completedAt: new Date().toISOString() }, actorId, 'seller marked the book as sold');
      await notify(accepted.buyerId, 'REQUEST_COMPLETED', `"${accepted.listingTitle}" was marked as sold to you.`, { requestId: accepted.id, listingId: listing.id });
    }
    await declineOthers(listing.id, accepted && accepted.id, 'the book was sold', actorId);
  } else if (to === 'Available') {
    await closeOpenRequests(listing.id, 'the seller released the reservation', actorId);
  }
});

events.on('listing.removed', async ({ listing, byAdmin, reason }) => {
  await closeOpenRequests(listing.id, byAdmin ? 'the listing was removed by a moderator' : 'the seller deleted the listing', 'system');
  if (byAdmin) {
    await notify(listing.sellerId, 'LISTING_REMOVED', `Your listing "${listing.title}" was removed: ${reason}.`, { listingId: listing.id });
  }
});

events.on('listing.expired', async ({ listing }) => {
  await closeOpenRequests(listing.id, 'the listing expired at the end of the semester', 'system');
  await notify(listing.sellerId, 'LISTING_EXPIRED', `Your listing "${listing.title}" expired. You can renew it once.`, { listingId: listing.id });
});

// Identity -> Requests: a suspended user's pending purchase requests are cancelled
events.on('user.suspended', async ({ userId }) => {
  const mine = await tables.requests.queryBy('buyerId', userId);
  for (const r of mine.filter((x) => OPEN.includes(x.status))) {
    if (r.status === 'Accepted') await listings.releaseReservation(r.listingId, r.buyerId);
    await save(r, { status: 'Cancelled' }, 'system', 'buyer account suspended').catch(() => {});
    await notify(r.sellerId, 'REQUEST_CANCELLED', `A request for "${r.listingTitle}" was cancelled (account suspended).`, { requestId: r.id, listingId: r.listingId });
  }
});

module.exports = {
  createRequest, listRequests, getRequest, changeStatus,
  listNotifications, markRead, markAllRead, expireReservations, stats, AppError
};
