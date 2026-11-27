// Semester calendar (Book Listing service, Mohamed).
// Answers the Phase 1 feedback "define who sets the semester end and how expiry runs":
//  - WHO:  an admin sets the current semester name + end date (PUT /api/admin/semester).
//          Until an admin sets one, the default university calendar is used
//          (Fall ends 31 Jan, Spring 30 Jun, Summer 31 Aug - lib/semester.js).
//  - HOW:  every new or renewed listing gets expiresAt = current semester end.
//          Changing the end date also moves every Available listing of that semester.
//          The EventBridge rule runs tbx-jobs-fn every hour; it marks listings past
//          expiresAt as Expired (and search hides them at once, even before the job runs).
const { tables } = require('../../store');
const { errors, v } = require('../../lib/http');
const { audit } = require('../../lib/logger');
const { semesterFor } = require('../../lib/semester');

const SETTING_ID = 'semester';
const MAX_AHEAD_DAYS = 270; // a semester end more than ~9 months away is a typo

async function currentSemester(now = new Date()) {
  const saved = await tables.settings.get(SETTING_ID);
  if (saved && new Date(saved.endsAt) > now) {
    return { name: saved.name, endsAt: new Date(saved.endsAt), source: 'admin', setBy: saved.setBy, updatedAt: saved.updatedAt };
  }
  const calendar = semesterFor(now);
  return { ...calendar, source: 'calendar' };
}

async function setSemester(admin, body) {
  v.onlyKeys(body, ['name', 'endsAt']);
  const name = v.text(body.name, 'Semester name', {
    min: 6, max: 20, pattern: /^(Fall|Spring|Summer) \d{4}$/, patternMessage: 'Semester name must look like "Fall 2026".'
  });
  const endsRaw = v.text(body.endsAt, 'End date', { max: 30, pattern: /^\d{4}-\d{2}-\d{2}/, patternMessage: 'End date must be a date like 2027-01-31.' });
  const endsAt = new Date(endsRaw.length === 10 ? `${endsRaw}T23:59:59Z` : endsRaw);
  if (Number.isNaN(endsAt.getTime())) throw errors.validation('End date is not a valid date.');
  const now = new Date();
  if (endsAt <= now) throw errors.validation('The semester end must be in the future.');
  if (endsAt - now > MAX_AHEAD_DAYS * 86400_000) throw errors.validation(`The semester end must be within ${MAX_AHEAD_DAYS} days.`);

  const existing = await tables.settings.get(SETTING_ID);
  const value = { id: SETTING_ID, name, endsAt: endsAt.toISOString(), setBy: admin.id, updatedAt: now.toISOString() };
  if (existing) await tables.settings.update(value, existing.version);
  else await tables.settings.create(value);

  // Move the expiry of every Available listing of this semester to the new date
  const listings = await tables.listings.scan();
  let moved = 0;
  for (const l of listings.filter((x) => x.semester === name && x.status === 'Available')) {
    try {
      await tables.listings.update({ ...l, expiresAt: value.endsAt, updatedAt: value.updatedAt }, l.version);
      moved += 1;
    } catch { /* changed meanwhile */ }
  }
  await audit('SEMESTER_END_SET', { adminId: admin.id, name, endsAt: value.endsAt, listingsMoved: moved });
  return { name, endsAt: value.endsAt, source: 'admin', listingsMoved: moved };
}

module.exports = { currentSemester, setSemester };
