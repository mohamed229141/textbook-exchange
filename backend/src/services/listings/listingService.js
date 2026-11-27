// SERVICE 2 - Listings (owner: Student B)
// Business capability: the catalogue of used textbooks for sale.
// Business rules:
//  - course code format (e.g. CS101, MATH201A), condition scale, price 1..5000 EGP
//  - a seller may have at most 15 active (Available/Reserved) listings
//  - no duplicate active listing of the same ISBN by the same seller
//  - ISBN check digit + verification against Google Books (external API)
//  - a listing expires at the end of the semester it was posted in; it can be
//    renewed once for the following semester
//  - status workflow: Available -> Reserved -> Sold, Reserved -> Available,
//    Available -> Sold. Sold / Removed are final. Only Available listings can be edited.
//  - only the seller may edit / change status / delete; admins may remove any listing (moderation)
//  - a listing with 3 open reports is UnderReview (Moderation service): hidden, frozen for the seller
//  - price guide: min / average / max sold price per course (calculation)
const crypto = require('crypto');
const config = require('../../config');
const { tables } = require('../../store');
const { AppError, errors, v } = require('../../lib/http');
const { audit } = require('../../lib/logger');
const { currentSemester } = require('./semesterService');
const events = require('../../lib/events');
const googleBooks = require('./googleBooks');
const photos = require('./photoStore');

const CONDITIONS = ['New', 'Like New', 'Good', 'Fair', 'Poor'];
const STATUSES = ['Available', 'Reserved', 'Sold', 'Expired', 'UnderReview', 'Removed'];
const HIDDEN = ['Removed', 'UnderReview']; // only the seller and admins can open these
const ACTIVE = ['Available', 'Reserved'];
const OWNER_TRANSITIONS = {
  Available: ['Reserved', 'Sold'],
  Reserved: ['Available', 'Sold']
};
const EDITABLE = ['courseCode', 'title', 'author', 'isbn', 'edition', 'condition', 'price', 'description'];

function normalizeCourseCode(raw) {
  const code = v.text(raw, 'Course code', { max: 12 }).toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{2,4}\d{3,4}[A-Z]?$/.test(code)) {
    throw errors.validation('Course code must look like CS101 or MATH201 (2-4 letters, 3-4 digits).');
  }
  return code;
}

// Expiry is also applied when reading, so an expired listing is never shown
// as Available even before the scheduled job has run.
function effective(listing, now = new Date()) {
  if (listing && listing.status === 'Available' && new Date(listing.expiresAt) < now) {
    return { ...listing, status: 'Expired' };
  }
  return listing;
}

function canSeePrivate(listing, viewer) {
  return viewer && (viewer.id === listing.sellerId || viewer.role === 'admin');
}

function toPublic(listing, viewer) {
  const l = effective(listing);
  const out = {
    id: l.id, sellerId: l.sellerId, sellerName: l.sellerName,
    courseCode: l.courseCode, title: l.title, author: l.author, isbn: l.isbn || null,
    isbnVerified: Boolean(l.isbnVerified), coverUrl: l.coverUrl || null, edition: l.edition || null,
    condition: l.condition, price: l.price, description: l.description || '',
    status: l.status, semester: l.semester, expiresAt: l.expiresAt, renewals: l.renewals || 0,
    hasPhoto: Boolean(l.photoKey), createdAt: l.createdAt, updatedAt: l.updatedAt
  };
  if (l.status === 'Sold') out.soldAt = l.soldAt;
  if (canSeePrivate(l, viewer)) {
    out.reservedFor = l.reservedFor || null;
    out.reservedUntil = l.reservedUntil || null;
    out.soldPrice = l.soldPrice;
    if (l.status === 'Removed') out.removedReason = l.removedReason;
    if (l.status === 'UnderReview') out.reviewNote = 'Hidden while a moderator reviews reports about this listing.';
  }
  return out;
}

async function loadOr404(id) {
  const listing = await tables.listings.get(v.id(id, 'listing id'));
  if (!listing) throw errors.notFound('Listing');
  return listing;
}

async function loadOwned(user, id) {
  const listing = await loadOr404(id);
  if (listing.sellerId !== user.id) {
    await audit('OWNERSHIP_VIOLATION', { userId: user.id, listingId: listing.id, sellerId: listing.sellerId }, { security: true });
    throw errors.forbidden('Only the seller can change this listing.');
  }
  return listing;
}

async function validateFields(body) {
  v.onlyKeys(body, EDITABLE);
  const fields = {
    courseCode: normalizeCourseCode(body.courseCode),
    title: v.text(body.title, 'Title', { min: 2, max: 150 }),
    author: v.text(body.author, 'Author', { min: 2, max: 120 }),
    edition: v.text(body.edition, 'Edition', { required: false, max: 30 }) || null,
    condition: v.oneOf(body.condition, 'Condition', CONDITIONS),
    price: v.number(body.price, 'Price', { min: 1, max: config.maxPrice }),
    description: v.text(body.description, 'Description', { required: false, max: 1000 }) || '',
    isbn: null, isbnVerified: false, coverUrl: null
  };
  if (body.isbn !== undefined && body.isbn !== null && body.isbn !== '') {
    fields.isbn = googleBooks.normalizeIsbn(String(body.isbn));
    if (!fields.isbn) throw errors.validation('ISBN is not valid (check digit failed).');
    try {
      const book = await googleBooks.lookupIsbn(fields.isbn);
      fields.isbnVerified = true;
      fields.coverUrl = book.coverUrl;
    } catch (err) {
      if (err.status !== 404 && err.status !== 503) throw err;
      // not found / service down: listing is still allowed, but not marked verified
    }
  }
  return fields;
}

async function createListing(user, body) {
  const fields = await validateFields(body);
  const mine = (await tables.listings.queryBy('sellerId', user.id)).map((l) => effective(l));
  const active = mine.filter((l) => ACTIVE.includes(l.status));
  if (active.length >= config.maxActiveListingsPerSeller) {
    throw errors.conflict('LISTING_LIMIT_REACHED', `You can have at most ${config.maxActiveListingsPerSeller} active listings.`);
  }
  if (fields.isbn && active.some((l) => l.isbn === fields.isbn)) {
    throw errors.conflict('DUPLICATE_LISTING', 'You already have an active listing for this ISBN.');
  }
  const now = new Date();
  const semester = await currentSemester(now);
  const listing = await tables.listings.create({
    id: `lst_${crypto.randomUUID().replace(/-/g, '')}`,
    sellerId: user.id, sellerName: user.displayName,
    ...fields,
    status: 'Available',
    semester: semester.name, expiresAt: semester.endsAt.toISOString(), renewals: 0,
    reservedFor: null, reservedUntil: null, photoKey: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  await audit('LISTING_CREATED', { userId: user.id, listingId: listing.id, courseCode: listing.courseCode });
  await events.emit('listing.available', { listing }); // Course Alerts service matches it
  return toPublic(listing, user);
}

async function search(query, viewer) {
  const filters = {
    courseCode: query.courseCode ? normalizeCourseCode(query.courseCode) : undefined,
    condition: v.oneOf(query.condition, 'condition', CONDITIONS, { required: false }),
    status: v.oneOf(query.status, 'status', ['Available', 'Reserved', 'Sold'], { required: false }) || 'Available',
    minPrice: v.number(query.minPrice, 'minPrice', { required: false, min: 0, max: config.maxPrice }),
    maxPrice: v.number(query.maxPrice, 'maxPrice', { required: false, min: 0, max: config.maxPrice }),
    q: v.text(query.q, 'Search text', { required: false, max: 60 }),
    sort: v.oneOf(query.sort, 'sort', ['newest', 'price_asc', 'price_desc'], { required: false }) || 'newest',
    limit: v.number(query.limit, 'limit', { required: false, min: 1, max: 50, decimals: 0 }) || 20,
    offset: v.number(query.offset, 'offset', { required: false, min: 0, max: 10000, decimals: 0 }) || 0
  };
  const source = filters.courseCode
    ? await tables.listings.queryBy('courseCode', filters.courseCode) // DynamoDB Query on course-index
    : await tables.listings.scan();
  const q = filters.q && filters.q.toLowerCase();
  const matches = source.map((l) => effective(l)).filter((l) => l.status === filters.status
    && (!filters.condition || l.condition === filters.condition)
    && (filters.minPrice === undefined || l.price >= filters.minPrice)
    && (filters.maxPrice === undefined || l.price <= filters.maxPrice)
    && (!q || `${l.title} ${l.author} ${l.courseCode} ${l.isbn || ''}`.toLowerCase().includes(q)));
  const sorters = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price
  };
  matches.sort(sorters[filters.sort]);
  return {
    total: matches.length,
    limit: filters.limit, offset: filters.offset,
    items: matches.slice(filters.offset, filters.offset + filters.limit).map((l) => toPublic(l, viewer))
  };
}

async function getListing(id, viewer) {
  const listing = await loadOr404(id);
  if (HIDDEN.includes(listing.status) && !canSeePrivate(listing, viewer)) throw errors.notFound('Listing');
  return toPublic(listing, viewer);
}

async function myListings(user) {
  const mine = await tables.listings.queryBy('sellerId', user.id);
  return mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((l) => toPublic(l, user));
}

async function updateListing(user, id, body) {
  const listing = await loadOwned(user, id);
  if (effective(listing).status !== 'Available') {
    throw errors.conflict('LISTING_NOT_EDITABLE', `Only Available listings can be edited (this one is ${effective(listing).status}).`);
  }
  const fields = await validateFields(body);
  const saved = await tables.listings.update({ ...listing, ...fields, updatedAt: new Date().toISOString() }, listing.version);
  await audit('LISTING_UPDATED', { userId: user.id, listingId: listing.id, oldPrice: listing.price, newPrice: saved.price });
  await events.emit('listing.available', { listing: saved }); // e.g. a price drop can match an alert
  return toPublic(saved, user);
}

async function changeStatus(user, id, body) {
  v.onlyKeys(body, ['status']);
  const to = v.oneOf(body.status, 'status', ['Available', 'Reserved', 'Sold']);
  const listing = await loadOwned(user, id);
  const from = effective(listing).status;
  if (!(OWNER_TRANSITIONS[from] || []).includes(to)) {
    throw errors.conflict('INVALID_TRANSITION', `A listing cannot go from ${from} to ${to}.`);
  }
  const now = new Date().toISOString();
  const changes = { status: to, updatedAt: now };
  if (to === 'Available') Object.assign(changes, { reservedFor: null, reservedUntil: null });
  if (to === 'Reserved') Object.assign(changes, { reservedFor: null, reservedUntil: null }); // reserved by the seller (outside the app)
  if (to === 'Sold') Object.assign(changes, { soldAt: now, soldPrice: listing.price });
  const saved = await tables.listings.update({ ...listing, ...changes }, listing.version);
  await audit('LISTING_STATUS_CHANGED', { userId: user.id, listingId: listing.id, from, to });
  // Requests service reacts: decline / complete / cancel the related requests
  await events.emit('listing.statusChanged', { listing: saved, from, to, actorId: user.id });
  if (to === 'Available') await events.emit('listing.available', { listing: saved });
  return toPublic(saved, user);
}

async function renewListing(user, id) {
  const listing = await loadOwned(user, id);
  if (effective(listing).status !== 'Expired') {
    throw errors.conflict('NOT_EXPIRED', 'Only expired listings can be renewed.');
  }
  if ((listing.renewals || 0) >= config.maxRenewals) {
    throw errors.conflict('RENEWAL_LIMIT', `A listing can be renewed only ${config.maxRenewals} time(s). Create a new listing instead.`);
  }
  const semester = await currentSemester(new Date());
  const saved = await tables.listings.update({
    ...listing, status: 'Available', semester: semester.name, expiresAt: semester.endsAt.toISOString(),
    renewals: (listing.renewals || 0) + 1, updatedAt: new Date().toISOString()
  }, listing.version);
  await audit('LISTING_RENEWED', { userId: user.id, listingId: listing.id, semester: semester.name });
  await events.emit('listing.available', { listing: saved });
  return toPublic(saved, user);
}

async function deleteListing(user, id, reasonRaw) {
  const listing = await loadOr404(id);
  const isOwner = listing.sellerId === user.id;
  if (!isOwner && user.role !== 'admin') {
    await audit('OWNERSHIP_VIOLATION', { userId: user.id, listingId: listing.id, action: 'delete' }, { security: true });
    throw errors.forbidden('Only the seller or an admin can delete this listing.');
  }
  if (isOwner) {
    const status = effective(listing).status;
    if (!['Available', 'Expired'].includes(status)) {
      throw errors.conflict('LISTING_IN_USE', `A ${status} listing cannot be deleted (it is part of a transaction).`);
    }
    await tables.listings.remove(listing.id);
    await photos.deletePhoto(listing.photoKey);
    await audit('LISTING_DELETED', { userId: user.id, listingId: listing.id });
    await events.emit('listing.removed', { listing, byAdmin: false });
    return { deleted: true };
  }
  // Admin moderation: keep the record for the audit trail, hide it from everyone else
  const reason = v.text(reasonRaw, 'Reason', { required: false, max: 200 }) || 'Removed by moderator';
  if (listing.status === 'Removed') return { deleted: true };
  const saved = await tables.listings.update({
    ...listing, status: 'Removed', removedReason: reason, removedBy: user.id, updatedAt: new Date().toISOString()
  }, listing.version);
  await audit('LISTING_REMOVED_BY_ADMIN', { adminId: user.id, listingId: listing.id, reason });
  await events.emit('listing.removed', { listing: saved, byAdmin: true, reason });
  return { deleted: true, softDeleted: true };
}

async function uploadPhoto(user, id, body) {
  v.onlyKeys(body, ['data']);
  const listing = await loadOwned(user, id);
  if (['Sold', 'Removed'].includes(listing.status)) throw errors.conflict('LISTING_CLOSED', 'This listing is closed.');
  const data = v.text(body.data, 'Photo data', { max: Math.ceil(config.photoMaxBytes * 1.4) });
  if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw errors.validation('Photo must be base64 encoded.');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > config.photoMaxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Photo must be at most 1 MB.');
  const type = photos.sniffImageType(buffer);
  if (!type) throw errors.validation('Photo must be a JPEG, PNG or WebP image.');
  const key = `listings/${listing.id}/${crypto.randomUUID()}.${type.split('/')[1]}`;
  await photos.putPhoto(key, buffer, type);
  const saved = await tables.listings.update({ ...listing, photoKey: key, photoType: type, updatedAt: new Date().toISOString() }, listing.version);
  await photos.deletePhoto(listing.photoKey);
  return toPublic(saved, user);
}

async function getPhoto(id, viewer) {
  const listing = await loadOr404(id);
  if (HIDDEN.includes(listing.status) && !canSeePrivate(listing, viewer)) throw errors.notFound('Listing');
  if (!listing.photoKey) throw errors.notFound('Photo');
  const photo = await photos.getPhoto(listing.photoKey);
  if (!photo) throw errors.notFound('Photo');
  return { contentType: photo.contentType, data: photo.buffer.toString('base64') };
}

async function priceGuide(courseCodeRaw) {
  const courseCode = normalizeCourseCode(courseCodeRaw);
  const all = (await tables.listings.queryBy('courseCode', courseCode)).map((l) => effective(l));
  const summary = (prices) => (prices.length ? {
    count: prices.length,
    min: Math.min(...prices),
    max: Math.max(...prices),
    average: Math.round((prices.reduce((s, p) => s + p, 0) / prices.length) * 100) / 100
  } : { count: 0 });
  return {
    courseCode,
    sold: summary(all.filter((l) => l.status === 'Sold').map((l) => l.soldPrice || l.price)),
    available: summary(all.filter((l) => l.status === 'Available').map((l) => l.price))
  };
}

// ---- used by the Requests service (service-to-service calls) ----------------

async function getForRequest(listingId) {
  const listing = await tables.listings.get(listingId);
  return listing ? effective(listing) : null;
}

async function reserveForBuyer(listingId, buyerId) {
  const listing = await tables.listings.get(listingId);
  if (!listing) throw errors.notFound('Listing');
  if (effective(listing).status !== 'Available') {
    throw errors.conflict('LISTING_NOT_AVAILABLE', `The listing is ${effective(listing).status}, not Available.`);
  }
  const until = new Date(Date.now() + config.reservationHours * 3600_000).toISOString();
  // version check: if two accepts race, only one wins (the other gets 409)
  return tables.listings.update({
    ...listing, status: 'Reserved', reservedFor: buyerId, reservedUntil: until, updatedAt: new Date().toISOString()
  }, listing.version);
}

async function releaseReservation(listingId, buyerId) {
  const listing = await tables.listings.get(listingId);
  if (!listing || listing.status !== 'Reserved' || listing.reservedFor !== buyerId) return null;
  return tables.listings.update({
    ...listing, status: 'Available', reservedFor: null, reservedUntil: null, updatedAt: new Date().toISOString()
  }, listing.version);
}

async function markSold(listingId, buyerId, price) {
  const listing = await tables.listings.get(listingId);
  if (!listing || listing.status !== 'Reserved' || listing.reservedFor !== buyerId) {
    throw errors.conflict('LISTING_NOT_RESERVED', 'The listing is no longer reserved for this buyer.');
  }
  const now = new Date().toISOString();
  return tables.listings.update({
    ...listing, status: 'Sold', soldAt: now, soldPrice: price, soldTo: buyerId, updatedAt: now
  }, listing.version);
}

// ---- used by the Moderation service ------------------------------------------

// 3 reports: hide the listing while an admin reviews it (only Available / Reserved listings)
async function hideForReview(listingId) {
  const listing = await tables.listings.get(listingId);
  if (!listing || !ACTIVE.includes(effective(listing).status)) return null;
  return tables.listings.update({
    ...listing, status: 'UnderReview', statusBeforeReview: listing.status, updatedAt: new Date().toISOString()
  }, listing.version);
}

// Reports dismissed: the listing comes back as it was (unless it expired meanwhile)
async function restoreAfterReview(listingId) {
  const listing = await tables.listings.get(listingId);
  if (!listing || listing.status !== 'UnderReview') return null;
  const saved = await tables.listings.update({
    ...listing, status: listing.statusBeforeReview || 'Available', statusBeforeReview: null, updatedAt: new Date().toISOString()
  }, listing.version);
  if (effective(saved).status === 'Available') await events.emit('listing.available', { listing: saved });
  return saved;
}

// ---- jobs and statistics ----------------------------------------------------

async function expireListings(now = new Date()) {
  const all = await tables.listings.scan();
  let expired = 0;
  for (const listing of all) {
    if (listing.status === 'Available' && new Date(listing.expiresAt) < now) {
      try {
        const saved = await tables.listings.update({ ...listing, status: 'Expired', updatedAt: now.toISOString() }, listing.version);
        expired += 1;
        await events.emit('listing.expired', { listing: saved });
      } catch { /* changed meanwhile: next run */ }
    }
  }
  return expired;
}

async function stats() {
  const all = (await tables.listings.scan()).map((l) => effective(l));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  all.forEach((l) => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
  const sold = all.filter((l) => l.status === 'Sold');
  return {
    total: all.length,
    byStatus,
    soldValue: Math.round(sold.reduce((s, l) => s + (l.soldPrice || l.price), 0) * 100) / 100,
    courses: new Set(all.map((l) => l.courseCode)).size
  };
}

// Identity service -> Listings: hide a suspended seller's active listings
events.on('user.suspended', async ({ userId, adminId }) => {
  const mine = await tables.listings.queryBy('sellerId', userId);
  for (const listing of mine.filter((l) => [...ACTIVE, 'UnderReview'].includes(l.status))) {
    const saved = await tables.listings.update({
      ...listing, status: 'Removed', removedReason: 'Seller account suspended', removedBy: adminId,
      updatedAt: new Date().toISOString()
    }, listing.version);
    await events.emit('listing.removed', { listing: saved, byAdmin: true, reason: 'Seller account suspended' });
  }
});

module.exports = {
  CONDITIONS, createListing, search, getListing, myListings, updateListing, changeStatus,
  renewListing, deleteListing, uploadPhoto, getPhoto, priceGuide,
  getForRequest, reserveForBuyer, releaseReservation, markSold, expireListings, stats,
  hideForReview, restoreAfterReview, normalizeCourseCode, conditionRank: (c) => CONDITIONS.length - CONDITIONS.indexOf(c),
  lookupIsbn: googleBooks.lookupIsbn, effective
};
