// SERVICE - Moderation & Reports (owner: Tarek Waleed)
// Business capability: keep fake, wrong and abusive listings off the platform.
// Workflow:   student reports a listing  ->  3 different reporters  ->  listing hidden (UnderReview)
//             -> admin reviews the CASE (all open reports of that listing at once)
//                 dismiss: reports Dismissed, listing restored as it was
//                 uphold : reports Upheld, listing Removed, seller gets a strike
//             -> 3 strikes: seller suspended automatically (listings removed, requests cancelled)
// Business rules:
//  - you cannot report your own listing; the listing must exist and be visible
//  - one open report per reporter per listing (409); max 10 reports per reporter per 24 h (429)
//  - reason from a fixed list; "other" needs details
//  - only admins see the queue and decide; reporters see only their own reports and the outcome
// Talks to: Book Listing (hide / restore / remove), shared login (strikes, suspension),
//           Purchase Request notifications (tell reporters, seller and admins).
const crypto = require('crypto');
const { tables } = require('../../store');
const { AppError, errors, v } = require('../../lib/http');
const { audit } = require('../../lib/logger');
const listings = require('../listings/listingService');
const identity = require('../identity/identityService');
const { notify } = require('../requests/notifier');

const REASONS = ['fake_listing', 'wrong_details', 'scam', 'inappropriate', 'other'];
const REASON_TEXT = {
  fake_listing: 'fake listing', wrong_details: 'wrong book details', scam: 'scam attempt',
  inappropriate: 'inappropriate content', other: 'other'
};
const AUTO_HIDE_THRESHOLD = 3;
const DAILY_LIMIT = 10;

function toView(r, viewer) {
  const out = {
    id: r.id, listingId: r.listingId, listingTitle: r.listingTitle, courseCode: r.courseCode,
    reason: r.reason, details: r.details, status: r.status,
    decisionNote: r.decisionNote || null, createdAt: r.createdAt, decidedAt: r.decidedAt || null
  };
  if (viewer.role === 'admin') Object.assign(out, { reporterId: r.reporterId, reporterName: r.reporterName, sellerId: r.sellerId, sellerName: r.sellerName });
  return out;
}

async function openReportsFor(listingId) {
  return (await tables.reports.queryBy('listingId', listingId)).filter((r) => r.status === 'Open');
}

async function createReport(user, body) {
  v.onlyKeys(body, ['listingId', 'reason', 'details']);
  const listingId = v.id(body.listingId, 'listingId');
  const reason = v.oneOf(body.reason, 'Reason', REASONS);
  const details = v.text(body.details, 'Details', { required: reason === 'other', min: 5, max: 500 }) || '';

  const listing = await listings.getForRequest(listingId);
  if (!listing || listing.status === 'Removed') throw errors.notFound('Listing');
  if (listing.sellerId === user.id) throw errors.forbidden('You cannot report your own listing.');

  const mine = await tables.reports.queryBy('reporterId', user.id);
  if (mine.some((r) => r.listingId === listingId && r.status === 'Open')) {
    throw errors.conflict('DUPLICATE_REPORT', 'You already reported this listing. A moderator will review it.');
  }
  const since = Date.now() - 24 * 3600_000;
  if (mine.filter((r) => new Date(r.createdAt).getTime() > since).length >= DAILY_LIMIT) {
    await audit('REPORT_LIMIT_HIT', { userId: user.id }, { security: true });
    throw new AppError(429, 'REPORT_LIMIT_REACHED', `You can send at most ${DAILY_LIMIT} reports per day.`);
  }

  const report = await tables.reports.create({
    id: `rpt_${crypto.randomUUID().replace(/-/g, '')}`,
    listingId, listingTitle: listing.title, courseCode: listing.courseCode,
    sellerId: listing.sellerId, sellerName: listing.sellerName,
    reporterId: user.id, reporterName: user.displayName,
    reason, details, status: 'Open', createdAt: new Date().toISOString()
  });
  await audit('LISTING_REPORTED', { userId: user.id, listingId, reason });

  // Business rule: enough DIFFERENT reporters -> hide the listing until an admin decides
  const open = await openReportsFor(listingId);
  const reporters = new Set(open.map((r) => r.reporterId));
  let hidden = false;
  if (reporters.size >= AUTO_HIDE_THRESHOLD) {
    const saved = await listings.hideForReview(listingId).catch(() => null);
    if (saved) {
      hidden = true;
      await audit('LISTING_AUTO_HIDDEN', { listingId, reports: open.length }, { security: true });
      await notify(listing.sellerId, 'LISTING_UNDER_REVIEW',
        `Your listing "${listing.title}" was reported by ${reporters.size} students and is hidden until a moderator reviews it.`, { listingId });
      const admins = (await tables.users.scan()).filter((u) => u.role === 'admin' && u.status === 'active');
      for (const a of admins) {
        await notify(a.id, 'MODERATION_NEEDED', `"${listing.title}" has ${open.length} open reports and was hidden automatically.`, { listingId });
      }
    }
  }
  return { ...toView(report, user), listingHidden: hidden };
}

async function myReports(user) {
  const mine = await tables.reports.queryBy('reporterId', user.id);
  return mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => toView(r, user));
}

// Admin queue: one CASE per listing, most reported first
async function reviewQueue(admin, query) {
  const status = v.oneOf(query.status, 'status', ['Open', 'Dismissed', 'Upheld'], { required: false }) || 'Open';
  const reports = await tables.reports.queryBy('status', status); // DynamoDB Query on status-index
  const cases = new Map();
  for (const r of reports) {
    if (!cases.has(r.listingId)) {
      cases.set(r.listingId, {
        listingId: r.listingId, listingTitle: r.listingTitle, courseCode: r.courseCode,
        sellerId: r.sellerId, sellerName: r.sellerName, reportCount: 0, reasons: {}, reports: []
      });
    }
    const c = cases.get(r.listingId);
    c.reportCount += 1;
    c.reasons[r.reason] = (c.reasons[r.reason] || 0) + 1;
    c.reports.push(toView(r, admin));
  }
  const list = [...cases.values()];
  for (const c of list) {
    const l = await listings.getForRequest(c.listingId);
    c.listingStatus = l ? l.status : 'Deleted';
  }
  return list.sort((a, b) => b.reportCount - a.reportCount);
}

async function decideCase(admin, listingIdRaw, body) {
  v.onlyKeys(body, ['decision', 'note']);
  const listingId = v.id(listingIdRaw, 'listing id');
  const decision = v.oneOf(body.decision, 'decision', ['dismiss', 'uphold']);
  const note = v.text(body.note, 'Note', { required: decision === 'uphold', min: 3, max: 300 }) || '';
  const open = await openReportsFor(listingId);
  if (!open.length) throw errors.conflict('NO_OPEN_REPORTS', 'This listing has no open reports.');
  const listing = await listings.getForRequest(listingId);
  if (listing && listing.sellerId === admin.id) throw errors.forbidden('You cannot decide on reports about your own listing.');

  const now = new Date().toISOString();
  const status = decision === 'uphold' ? 'Upheld' : 'Dismissed';
  for (const r of open) {
    await tables.reports.update({ ...r, status, decidedBy: admin.id, decisionNote: note || null, decidedAt: now }, r.version).catch(() => {});
  }

  let strike = null;
  if (decision === 'dismiss') {
    await listings.restoreAfterReview(listingId);
  } else if (listing) {
    // Listing service removes it (closes its requests, notifies the seller)
    await listings.deleteListing({ id: admin.id, role: 'admin' }, listingId, `Moderation: ${note}`);
    strike = await identity.addStrike(listing.sellerId);
  }
  for (const reporterId of new Set(open.map((r) => r.reporterId))) {
    await notify(reporterId, 'REPORT_DECIDED',
      decision === 'uphold'
        ? `Thanks: the listing "${open[0].listingTitle}" you reported was removed.`
        : `The listing "${open[0].listingTitle}" you reported was checked and kept online.`,
      { listingId });
  }
  await audit('MODERATION_DECISION', { adminId: admin.id, listingId, decision, reports: open.length, strikes: strike && strike.strikes });
  return { listingId, decision, reportsClosed: open.length, sellerStrikes: strike ? strike.strikes : undefined, sellerSuspended: strike ? strike.suspended : false };
}

async function stats() {
  const all = await tables.reports.scan();
  const by = (s) => all.filter((r) => r.status === s).length;
  return {
    total: all.length, open: by('Open'), upheld: by('Upheld'), dismissed: by('Dismissed'),
    openCases: new Set(all.filter((r) => r.status === 'Open').map((r) => r.listingId)).size
  };
}

module.exports = { REASONS, REASON_TEXT, createReport, myReports, reviewQueue, decideCase, stats };
