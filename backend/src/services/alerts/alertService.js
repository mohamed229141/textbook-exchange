// SERVICE - Course Alerts (owner: Mohamed Al Ghazaly)
// Business capability: buyers do not have to keep searching - they follow a course and
// are told as soon as a matching book is listed.
// Business rules:
//  - an alert = course code + optional max price + optional minimum condition
//  - max 10 active alerts per student; no two active alerts with the same criteria (409)
//  - an alert expires at the end of the current semester (set by the admin / calendar)
//  - matching runs automatically when a listing becomes Available: new listing, edit
//    (e.g. a price drop), renewal, reservation released, or restored after moderation
//  - never alert a student about their own listing; each listing notifies an alert only once
//  - only the owner can see, change or delete an alert (403 otherwise)
// Talks to: Book Listing (event listing.available, search for current matches, semester end),
//           Purchase Request notifications (in-app + SNS + SQS).
const crypto = require('crypto');
const config = require('../../config');
const { tables } = require('../../store');
const { errors, v } = require('../../lib/http');
const { audit, log } = require('../../lib/logger');
const events = require('../../lib/events');
const listings = require('../listings/listingService');
const { currentSemester } = require('../listings/semesterService');
const { notify } = require('../requests/notifier');

const MAX_ACTIVE = 10;
const MAX_MATCH_HISTORY = 200;

const isActive = (a, now = new Date()) => a.active && new Date(a.expiresAt) > now;

function matches(alert, listing) {
  return alert.courseCode === listing.courseCode
    && alert.userId !== listing.sellerId
    && (alert.maxPrice === null || alert.maxPrice === undefined || listing.price <= alert.maxPrice)
    && (!alert.minCondition || listings.conditionRank(listing.condition) >= listings.conditionRank(alert.minCondition));
}

function toView(a) {
  return {
    id: a.id, courseCode: a.courseCode, maxPrice: a.maxPrice ?? null, minCondition: a.minCondition || null,
    active: isActive(a), paused: !a.active, expiresAt: a.expiresAt, semester: a.semester,
    matchCount: a.matchCount || 0, lastMatchedAt: a.lastMatchedAt || null, createdAt: a.createdAt
  };
}

async function loadOwned(user, id) {
  const alert = await tables.alerts.get(v.id(id, 'alert id'));
  if (!alert) throw errors.notFound('Alert');
  if (alert.userId !== user.id) {
    await audit('OWNERSHIP_VIOLATION', { userId: user.id, alertId: alert.id }, { security: true });
    throw errors.forbidden('This alert belongs to another student.');
  }
  return alert;
}

function readCriteria(body, partial = false) {
  const out = {};
  if (!partial || body.maxPrice !== undefined) {
    out.maxPrice = v.number(body.maxPrice, 'Max price', { required: false, min: 1, max: config.maxPrice }) ?? null;
  }
  if (!partial || body.minCondition !== undefined) {
    out.minCondition = v.oneOf(body.minCondition, 'Minimum condition', listings.CONDITIONS, { required: false }) || null;
  }
  return out;
}

async function createAlert(user, body) {
  v.onlyKeys(body, ['courseCode', 'maxPrice', 'minCondition']);
  const courseCode = listings.normalizeCourseCode(body.courseCode);
  const criteria = readCriteria(body);

  const mine = (await tables.alerts.queryBy('userId', user.id)).filter((a) => isActive(a));
  if (mine.length >= MAX_ACTIVE) {
    throw errors.conflict('ALERT_LIMIT_REACHED', `You can have at most ${MAX_ACTIVE} active alerts. Delete one first.`);
  }
  if (mine.some((a) => a.courseCode === courseCode && (a.maxPrice ?? null) === criteria.maxPrice && (a.minCondition || null) === criteria.minCondition)) {
    throw errors.conflict('DUPLICATE_ALERT', 'You already have the same alert.');
  }
  const semester = await currentSemester();
  const alert = await tables.alerts.create({
    id: `alr_${crypto.randomUUID().replace(/-/g, '')}`,
    userId: user.id, courseCode, ...criteria, active: true,
    semester: semester.name, expiresAt: semester.endsAt.toISOString(),
    matchedListingIds: [], matchCount: 0, createdAt: new Date().toISOString()
  });
  await audit('ALERT_CREATED', { userId: user.id, alertId: alert.id, courseCode });
  // Books already on sale that match right now (so the student sees results at once)
  const current = await currentMatches(user, alert);
  return { ...toView(alert), currentMatches: current.length };
}

async function myAlerts(user) {
  const mine = await tables.alerts.queryBy('userId', user.id);
  return mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toView);
}

async function updateAlert(user, id, body) {
  v.onlyKeys(body, ['maxPrice', 'minCondition', 'active']);
  const alert = await loadOwned(user, id);
  const changes = readCriteria(body, true);
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw errors.validation('active must be true or false.');
    if (body.active && !alert.active) {
      const active = (await tables.alerts.queryBy('userId', user.id)).filter((a) => isActive(a));
      if (active.length >= MAX_ACTIVE) throw errors.conflict('ALERT_LIMIT_REACHED', `You can have at most ${MAX_ACTIVE} active alerts.`);
    }
    changes.active = body.active;
  }
  if (!Object.keys(changes).length) throw errors.validation('Nothing to update.');
  if (new Date(alert.expiresAt) <= new Date()) throw errors.conflict('ALERT_EXPIRED', 'This alert expired with the semester. Create a new one.');
  const saved = await tables.alerts.update({ ...alert, ...changes, updatedAt: new Date().toISOString() }, alert.version);
  return toView(saved);
}

async function deleteAlert(user, id) {
  const alert = await loadOwned(user, id);
  await tables.alerts.remove(alert.id);
  await audit('ALERT_DELETED', { userId: user.id, alertId: alert.id });
}

// Books on sale now that match the alert (uses the Listings search: Query on course-index)
async function currentMatches(user, alertOrId) {
  const alert = typeof alertOrId === 'string' ? await loadOwned(user, alertOrId) : alertOrId;
  const query = { courseCode: alert.courseCode, sort: 'price_asc', limit: 50 };
  if (alert.maxPrice) query.maxPrice = alert.maxPrice;
  const result = await listings.search(query, user);
  return result.items.filter((l) => matches(alert, l));
}

// Event from the Book Listing service: a listing is (again) Available -> notify matching alerts
async function onListingAvailable({ listing }) {
  if (listings.effective(listing).status !== 'Available') return 0;
  const candidates = await tables.alerts.queryBy('courseCode', listing.courseCode); // Query on course-index
  let sent = 0;
  for (const alert of candidates) {
    if (!isActive(alert) || !matches(alert, listing)) continue;
    if ((alert.matchedListingIds || []).includes(listing.id)) continue; // only once per listing
    try {
      await tables.alerts.update({
        ...alert,
        matchedListingIds: [...(alert.matchedListingIds || []), listing.id].slice(-MAX_MATCH_HISTORY),
        matchCount: (alert.matchCount || 0) + 1,
        lastMatchedAt: new Date().toISOString()
      }, alert.version);
      await notify(alert.userId, 'COURSE_ALERT_MATCH',
        `New ${listing.courseCode} book: "${listing.title}" (${listing.condition}) for ${listing.price} EGP.`,
        { listingId: listing.id });
      sent += 1;
    } catch (err) {
      log('warn', 'alert match skipped', { alertId: alert.id, error: err.message });
    }
  }
  if (sent) await audit('ALERTS_MATCHED', { listingId: listing.id, notified: sent });
  return sent;
}
events.on('listing.available', onListingAvailable);

// Job: switch off alerts whose semester ended
async function expireAlerts(now = new Date()) {
  const all = await tables.alerts.scan();
  let expired = 0;
  for (const a of all.filter((x) => x.active && new Date(x.expiresAt) <= now)) {
    await tables.alerts.update({ ...a, active: false, expiredAt: now.toISOString() }, a.version).catch(() => {});
    expired += 1;
  }
  return expired;
}

async function stats() {
  const all = await tables.alerts.scan();
  return {
    total: all.length,
    active: all.filter((a) => isActive(a)).length,
    notificationsSent: all.reduce((s, a) => s + (a.matchCount || 0), 0),
    courses: new Set(all.map((a) => a.courseCode)).size
  };
}

module.exports = { createAlert, myAlerts, updateAlert, deleteAlert, currentMatches, onListingAvailable, expireAlerts, stats };
