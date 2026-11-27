// Scheduled maintenance, run by:
//   - Amazon EventBridge rule tbx-expiry-schedule (rate 1 hour) -> Lambda tbx-jobs-fn (jobs.handler)
//   - an admin: POST /api/admin/jobs/run
// 1. Listings past the end of their semester -> Expired   (Listings service)
// 2. Accepted requests not completed in 72 hours -> Expired, book Available again (Requests service)
// 3. Course alerts whose semester ended -> switched off (Course Alerts service)
const listings = require('./services/listings/listingService');
const requests = require('./services/requests/requestService');
const alerts = require('./services/alerts/alertService');
const { audit } = require('./lib/logger');

async function runAllJobs({ trigger = 'schedule' } = {}) {
  const started = Date.now();
  const expiredReservations = await requests.expireReservations();
  const expiredListings = await listings.expireListings();
  const expiredAlerts = await alerts.expireAlerts();
  const result = { trigger, expiredListings, expiredReservations, expiredAlerts, durationMs: Date.now() - started, ranAt: new Date().toISOString() };
  await audit('JOBS_RUN', result);
  return result;
}

module.exports = { runAllJobs };
