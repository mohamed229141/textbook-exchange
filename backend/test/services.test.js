// Tests for Moderation & Reports (Tarek), Course Alerts (Mohamed) and the admin-set semester end.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, client, newUser, newAdmin, book, PASSWORD } = require('../test-support/helpers');

let server;
let api;
test.before(async () => { server = await startApi(); api = client(server.base); });
test.after(async () => server.close());

const notes = async (u) => (await api.get('/api/notifications', { token: u.token })).body.items;

// ---------------- Moderation & Reports ----------------
test('moderation: report rules - own listing 403, reason "other" needs details, duplicate 409', async () => {
  const seller = await newUser(api, 'Seller');
  const r1 = await newUser(api, 'Rep');
  const l = (await api.post('/api/listings', book(), { token: seller.token })).body;
  assert.equal((await api.post('/api/reports', { listingId: l.id, reason: 'fake_listing' }, { token: seller.token })).status, 403);
  assert.equal((await api.post('/api/reports', { listingId: l.id, reason: 'other' }, { token: r1.token })).status, 400);
  assert.equal((await api.post('/api/reports', { listingId: l.id, reason: 'nonsense' }, { token: r1.token })).status, 400);
  const ok = await api.post('/api/reports', { listingId: l.id, reason: 'wrong_details', details: 'Wrong edition' }, { token: r1.token });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.listingHidden, false);
  const dup = await api.post('/api/reports', { listingId: l.id, reason: 'scam' }, { token: r1.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_REPORT');
  const mine = await api.get('/api/reports/mine', { token: r1.token });
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].reporterId, undefined, 'reporters do not see admin-only fields');
});

test('moderation: 3 reporters hide the listing; admin dismisses -> listing back, reporters told', async () => {
  const admin = await newAdmin(api);
  const seller = await newUser(api, 'Seller');
  const l = (await api.post('/api/listings', book({ courseCode: 'MOD101' }), { token: seller.token })).body;
  const reporters = [await newUser(api, 'R'), await newUser(api, 'R'), await newUser(api, 'R')];
  let last;
  for (const r of reporters) last = await api.post('/api/reports', { listingId: l.id, reason: 'fake_listing' }, { token: r.token });
  assert.equal(last.body.listingHidden, true);
  assert.equal((await api.get(`/api/listings/${l.id}`)).status, 404, 'hidden from the public');
  assert.equal((await api.get('/api/listings?courseCode=MOD101')).body.total, 0);
  const own = await api.get(`/api/listings/${l.id}`, { token: seller.token });
  assert.equal(own.body.status, 'UnderReview');
  assert.ok((await notes(seller)).some((n) => n.type === 'LISTING_UNDER_REVIEW'));
  assert.equal((await api.put(`/api/listings/${l.id}`, book({ courseCode: 'MOD101' }), { token: seller.token })).status, 409, 'frozen during review');
  assert.equal((await api.del(`/api/listings/${l.id}`, { token: seller.token })).status, 409, 'cannot delete to escape review');

  assert.equal((await api.get('/api/admin/reports', { token: seller.token })).status, 403);
  const queue = await api.get('/api/admin/reports', { token: admin.token });
  const theCase = queue.body.find((c) => c.listingId === l.id);
  assert.equal(theCase.reportCount, 3);
  assert.equal(theCase.listingStatus, 'UnderReview');

  const d = await api.patch(`/api/admin/reports/${l.id}/decision`, { decision: 'dismiss' }, { token: admin.token });
  assert.equal(d.status, 200);
  assert.equal(d.body.reportsClosed, 3);
  assert.equal((await api.get(`/api/listings/${l.id}`)).body.status, 'Available');
  assert.ok((await notes(reporters[0])).some((n) => n.type === 'REPORT_DECIDED'));
  const again = await api.patch(`/api/admin/reports/${l.id}/decision`, { decision: 'dismiss' }, { token: admin.token });
  assert.equal(again.status, 409, 'nothing left to decide');
});

test('moderation: uphold removes the listing and gives a strike; 3 strikes suspend the seller', async () => {
  const admin = await newAdmin(api);
  const seller = await newUser(api, 'Scammer');
  const reporter = await newUser(api, 'Honest');
  assert.equal((await api.patch('/api/admin/reports/lst_000000/decision', { decision: 'uphold' }, { token: admin.token })).status, 400, 'uphold needs a note');
  let res;
  for (let i = 0; i < 3; i += 1) {
    const l = (await api.post('/api/listings', book(), { token: seller.token })).body;
    await api.post('/api/reports', { listingId: l.id, reason: 'scam', details: 'asks for money first' }, { token: reporter.token });
    res = await api.patch(`/api/admin/reports/${l.id}/decision`, { decision: 'uphold', note: 'Confirmed scam' }, { token: admin.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.sellerStrikes, i + 1);
    assert.equal((await api.get(`/api/listings/${l.id}`)).status, 404);
  }
  assert.equal(res.body.sellerSuspended, true);
  assert.equal((await api.get('/api/users/me', { token: seller.token })).status, 401, 'logged out');
  assert.equal((await api.post('/api/auth/login', { email: seller.email, password: PASSWORD })).status, 403, 'suspended');
});

// ---------------- Course Alerts ----------------
test('alerts: matching listing notifies once; price/condition/own listing filters; price drop matches', async () => {
  const buyer = await newUser(api, 'Buyer');
  const seller = await newUser(api, 'Seller');
  const created = await api.post('/api/alerts', { courseCode: 'alt 201', maxPrice: 300, minCondition: 'Good' }, { token: buyer.token });
  assert.equal(created.status, 201);
  assert.equal(created.body.courseCode, 'ALT201');
  assert.ok(new Date(created.body.expiresAt) > new Date());

  await api.post('/api/listings', book({ courseCode: 'ALT201', price: 500 }), { token: seller.token });          // too expensive
  await api.post('/api/listings', book({ courseCode: 'ALT201', price: 200, condition: 'Poor' }), { token: seller.token }); // condition too low
  await api.post('/api/listings', book({ courseCode: 'ALT201', price: 100 }), { token: buyer.token });           // own listing
  assert.equal((await notes(buyer)).filter((n) => n.type === 'COURSE_ALERT_MATCH').length, 0);

  const match = (await api.post('/api/listings', book({ courseCode: 'ALT201', price: 250, condition: 'Like New' }), { token: seller.token })).body;
  let alertNotes = (await notes(buyer)).filter((n) => n.type === 'COURSE_ALERT_MATCH');
  assert.equal(alertNotes.length, 1);
  assert.equal(alertNotes[0].listingId, match.id);

  await api.put(`/api/listings/${match.id}`, book({ courseCode: 'ALT201', price: 240, condition: 'Like New' }), { token: seller.token });
  alertNotes = (await notes(buyer)).filter((n) => n.type === 'COURSE_ALERT_MATCH');
  assert.equal(alertNotes.length, 1, 'same listing never notifies twice');

  const pricey = (await api.post('/api/listings', book({ courseCode: 'ALT201', price: 450 }), { token: seller.token })).body;
  await api.put(`/api/listings/${pricey.id}`, book({ courseCode: 'ALT201', price: 290 }), { token: seller.token });
  alertNotes = (await notes(buyer)).filter((n) => n.type === 'COURSE_ALERT_MATCH');
  assert.equal(alertNotes.length, 2, 'price drop below max triggers the alert');

  const mine = await api.get('/api/alerts', { token: buyer.token });
  assert.equal(mine.body[0].matchCount, 2);
  const now = await api.get(`/api/alerts/${created.body.id}/matches`, { token: buyer.token });
  assert.deepEqual(now.body.map((l) => l.price), [240, 290]);
});

test('alerts: limits, duplicates, ownership, pause and delete', async () => {
  const u = await newUser(api, 'Alerty');
  const eve = await newUser(api, 'Eve');
  const first = (await api.post('/api/alerts', { courseCode: 'LIM100' }, { token: u.token })).body;
  const dup = await api.post('/api/alerts', { courseCode: 'LIM100' }, { token: u.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_ALERT');
  for (let i = 1; i < 10; i += 1) assert.equal((await api.post('/api/alerts', { courseCode: `LIM10${i}` }, { token: u.token })).status, 201);
  const over = await api.post('/api/alerts', { courseCode: 'LIM200' }, { token: u.token });
  assert.equal(over.body.error.code, 'ALERT_LIMIT_REACHED');

  assert.equal((await api.patch(`/api/alerts/${first.id}`, { maxPrice: 1 }, { token: eve.token })).status, 403);
  assert.equal((await api.del(`/api/alerts/${first.id}`, { token: eve.token })).status, 403);
  assert.equal((await api.get(`/api/alerts/${first.id}/matches`, { token: eve.token })).status, 403);
  assert.equal((await api.patch(`/api/alerts/${first.id}`, { userId: eve.id }, { token: u.token })).status, 400, 'mass assignment');

  const paused = await api.patch(`/api/alerts/${first.id}`, { active: false }, { token: u.token });
  assert.equal(paused.body.paused, true);
  assert.equal((await api.post('/api/alerts', { courseCode: 'LIM200' }, { token: u.token })).status, 201, 'paused alert frees a slot');
  assert.equal((await api.del(`/api/alerts/${first.id}`, { token: u.token })).status, 204);
});

// ---------------- Semester end set by the admin ----------------
test('semester: admin sets the end date; students cannot; listings follow it', async () => {
  const admin = await newAdmin(api);
  const seller = await newUser(api, 'Sem');
  const before = await api.get('/api/settings/semester');
  assert.equal(before.status, 200);
  const l = (await api.post('/api/listings', book({ courseCode: 'SEM101' }), { token: seller.token })).body;

  assert.equal((await api.put('/api/admin/semester', { name: before.body.name, endsAt: '2099-01-01' }, { token: seller.token })).status, 403);
  assert.equal((await api.put('/api/admin/semester', { name: before.body.name, endsAt: '2001-01-01' }, { token: admin.token })).status, 400, 'past date');
  assert.equal((await api.put('/api/admin/semester', { name: 'Winter 26', endsAt: '2027-01-01' }, { token: admin.token })).status, 400, 'bad name');

  const target = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const set = await api.put('/api/admin/semester', { name: before.body.name, endsAt: target }, { token: admin.token });
  assert.equal(set.status, 200);
  assert.ok(set.body.listingsMoved >= 1);
  const after = await api.get('/api/settings/semester');
  assert.equal(after.body.source, 'admin');
  assert.equal(after.body.endsAt.slice(0, 10), target);
  assert.equal((await api.get(`/api/listings/${l.id}`)).body.expiresAt.slice(0, 10), target, 'existing listing moved');
  const fresh = (await api.post('/api/listings', book({ courseCode: 'SEM102' }), { token: seller.token })).body;
  assert.equal(fresh.expiresAt.slice(0, 10), target, 'new listing uses the admin date');
});

test('admin stats include all four services', async () => {
  const admin = await newAdmin(api);
  const s = (await api.get('/api/admin/stats', { token: admin.token })).body;
  for (const k of ['users', 'listings', 'requests', 'reports', 'alerts', 'semester', 'monitoring']) assert.ok(s[k], k);
});
