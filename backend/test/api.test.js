// Functional tests: the business rules of the three services and how they work together.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, client, newUser, newAdmin, book, PASSWORD, FAKE_BOOK_ISBN } = require('../test-support/helpers');

let server;
let api;
test.before(async () => { server = await startApi(); api = client(server.base); });
test.after(async () => server.close());

// ---------------- Service 1: Identity & Access ----------------
test('identity: register, login, profile, logout', async () => {
  const u = await newUser(api, 'Mona');
  assert.equal(u.role, 'student');
  assert.equal(u.passwordHash, undefined, 'hash never returned');

  const login = await api.post('/api/auth/login', { email: u.email, password: PASSWORD });
  assert.equal(login.status, 200);
  const me = await api.get('/api/users/me', { token: login.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, u.email);

  const upd = await api.patch('/api/users/me', { displayName: 'Mona Ali', phone: '+20 100 000 0000' }, { token: login.body.token });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.displayName, 'Mona Ali');

  assert.equal((await api.post('/api/auth/logout', undefined, { token: login.body.token })).status, 204);
  assert.equal((await api.get('/api/users/me', { token: login.body.token })).status, 401, 'token dead after logout');
});

test('identity: duplicate e-mail 409, weak password 400', async () => {
  const u = await newUser(api, 'Dup');
  const again = await api.post('/api/auth/register', { email: u.email, password: PASSWORD, displayName: 'Dup' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'EMAIL_TAKEN');
  const weak = await api.post('/api/auth/register', { email: 'weak@student.edu', password: 'password', displayName: 'Weak' });
  assert.equal(weak.status, 400);
});

test('identity: password change logs out old sessions', async () => {
  const u = await newUser(api, 'Pw');
  const res = await api.put('/api/users/me/password', { currentPassword: PASSWORD, newPassword: 'N3w-Password' }, { token: u.token });
  assert.equal(res.status, 200);
  assert.equal((await api.get('/api/users/me', { token: u.token })).status, 401);
  assert.equal((await api.get('/api/users/me', { token: res.body.token })).status, 200);
});

// ---------------- Service 2: Listings ----------------
test('listings: create with ISBN verified by Google Books, semester expiry set', async () => {
  const seller = await newUser(api, 'Seller');
  const res = await api.post('/api/listings', book({ isbn: '978-0-262-03384-8', courseCode: 'cs 101' }), { token: seller.token });
  assert.equal(res.status, 201);
  assert.equal(res.body.courseCode, 'CS101', 'course code normalised');
  assert.equal(res.body.isbn, FAKE_BOOK_ISBN);
  assert.equal(res.body.isbnVerified, true);
  assert.ok(res.body.coverUrl);
  assert.ok(new Date(res.body.expiresAt) > new Date());
  assert.match(res.body.semester, /^(Fall|Spring|Summer) \d{4}$/);
});

test('listings: ISBN lookup endpoint (external API) and invalid ISBN', async () => {
  const u = await newUser(api, 'Look');
  const ok = await api.get(`/api/books/isbn/${FAKE_BOOK_ISBN}`, { token: u.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Introduction to Algorithms');
  assert.equal((await api.get('/api/books/isbn/9780262033849', { token: u.token })).status, 400, 'bad check digit');
  assert.equal((await api.get('/api/books/isbn/9780306406157', { token: u.token })).status, 404, 'valid but unknown');
});

test('listings: search by course code, price filter, sort', async () => {
  const s = await newUser(api, 'Search');
  await api.post('/api/listings', book({ courseCode: 'PHY210', price: 300 }), { token: s.token });
  await api.post('/api/listings', book({ courseCode: 'PHY210', price: 150, condition: 'Fair' }), { token: s.token });
  await api.post('/api/listings', book({ courseCode: 'PHY210', price: 900 }), { token: s.token });
  const res = await api.get('/api/listings?courseCode=phy210&maxPrice=500&sort=price_asc');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.items.map((l) => l.price), [150, 300]);
  const fair = await api.get('/api/listings?courseCode=PHY210&condition=Fair');
  assert.equal(fair.body.total, 1);
});

test('listings: validation errors return 400', async () => {
  const s = await newUser(api, 'Val');
  for (const bad of [book({ courseCode: 'X1' }), book({ price: -5 }), book({ price: 99999 }), book({ condition: 'Mint' }), book({ isbn: '123' })]) {
    const res = await api.post('/api/listings', bad, { token: s.token });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
});

test('listings: status workflow and edit rules', async () => {
  const s = await newUser(api, 'Flow');
  const l = (await api.post('/api/listings', book(), { token: s.token })).body;
  assert.equal((await api.patch(`/api/listings/${l.id}/status`, { status: 'Reserved' }, { token: s.token })).status, 200);
  const edit = await api.put(`/api/listings/${l.id}`, book({ price: 10 }), { token: s.token });
  assert.equal(edit.status, 409, 'reserved listing cannot be edited');
  assert.equal((await api.patch(`/api/listings/${l.id}/status`, { status: 'Sold' }, { token: s.token })).status, 200);
  const back = await api.patch(`/api/listings/${l.id}/status`, { status: 'Available' }, { token: s.token });
  assert.equal(back.status, 409);
  assert.equal(back.body.error.code, 'INVALID_TRANSITION');
  assert.equal((await api.del(`/api/listings/${l.id}`, { token: s.token })).status, 409, 'sold listing kept');
});

test('listings: duplicate ISBN and active listing limit', async () => {
  const s = await newUser(api, 'Limit');
  assert.equal((await api.post('/api/listings', book({ isbn: FAKE_BOOK_ISBN }), { token: s.token })).status, 201);
  const dup = await api.post('/api/listings', book({ isbn: FAKE_BOOK_ISBN }), { token: s.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_LISTING');
  for (let i = 0; i < 14; i += 1) await api.post('/api/listings', book(), { token: s.token });
  const over = await api.post('/api/listings', book(), { token: s.token });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'LISTING_LIMIT_REACHED');
});

test('listings: expiry at end of semester, job, renew once', async () => {
  const s = await newUser(api, 'Exp');
  const admin = await newAdmin(api);
  const l = (await api.post('/api/listings', book({ courseCode: 'BIO150' }), { token: s.token })).body;
  // move the expiry date into the past (simulates the end of the semester)
  const { tables } = require('../src/store');
  const stored = await tables.listings.get(l.id);
  await tables.listings.update({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() }, stored.version);

  const search = await api.get('/api/listings?courseCode=BIO150');
  assert.equal(search.body.total, 0, 'expired listing hidden from search');
  const job = await api.post('/api/admin/jobs/run', undefined, { token: admin.token });
  assert.equal(job.status, 200);
  assert.ok(job.body.expiredListings >= 1);
  const renewed = await api.post(`/api/listings/${l.id}/renew`, undefined, { token: s.token });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.status, 'Available');
  assert.equal(renewed.body.renewals, 1);
  const s2 = await tables.listings.get(l.id);
  await tables.listings.update({ ...s2, expiresAt: new Date(Date.now() - 1000).toISOString() }, s2.version);
  const again = await api.post(`/api/listings/${l.id}/renew`, undefined, { token: s.token });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'RENEWAL_LIMIT');
});

test('listings: photo upload (magic bytes checked) and download', async () => {
  const s = await newUser(api, 'Photo');
  const l = (await api.post('/api/listings', book(), { token: s.token })).body;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a48f0000000049454e44ae426082', 'hex');
  const up = await api.post(`/api/listings/${l.id}/photo`, { data: png.toString('base64') }, { token: s.token });
  assert.equal(up.status, 200);
  assert.equal(up.body.hasPhoto, true);
  const down = await api.get(`/api/listings/${l.id}/photo`);
  assert.equal(down.status, 200);
  assert.equal(down.body.contentType, 'image/png');
  const fake = await api.post(`/api/listings/${l.id}/photo`, { data: Buffer.from('<script>alert(1)</script>').toString('base64') }, { token: s.token });
  assert.equal(fake.status, 400, 'non-image rejected');
});

test('listings: price guide calculates sold prices', async () => {
  const s = await newUser(api, 'Guide');
  for (const price of [200, 300]) {
    const l = (await api.post('/api/listings', book({ courseCode: 'ECO101', price }), { token: s.token })).body;
    await api.patch(`/api/listings/${l.id}/status`, { status: 'Sold' }, { token: s.token });
  }
  const g = await api.get('/api/listings/price-guide?courseCode=ECO101');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.sold, { count: 2, min: 200, max: 300, average: 250 });
});

// ---------------- Service 3: Requests (works with Listings + Identity) ----------------
test('requests: full buy flow - request, accept (reserves), complete (sold), contact shared', async () => {
  const seller = await newUser(api, 'Seller');
  const buyer = await newUser(api, 'Buyer');
  const other = await newUser(api, 'Other');
  const l = (await api.post('/api/listings', book({ price: 500 }), { token: seller.token })).body;

  const r1 = await api.post('/api/requests', { listingId: l.id, offerPrice: 450, message: 'Can meet at the library' }, { token: buyer.token });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.status, 'Pending');
  assert.equal(r1.body.contact, undefined, 'no contact details before acceptance');
  const r2 = await api.post('/api/requests', { listingId: l.id }, { token: other.token });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.offerPrice, 500, 'default offer = asking price');

  const sellerNotes = await api.get('/api/notifications', { token: seller.token });
  assert.equal(sellerNotes.body.unread, 2);

  const incoming = await api.get('/api/requests?box=incoming', { token: seller.token });
  assert.equal(incoming.body.length, 2);

  const acc = await api.patch(`/api/requests/${r1.body.id}/status`, { status: 'Accepted' }, { token: seller.token });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.status, 'Accepted');
  assert.equal(acc.body.contact.seller.email, seller.email, 'contact shared after acceptance');

  const listing = await api.get(`/api/listings/${l.id}`);
  assert.equal(listing.body.status, 'Reserved');
  const otherReq = await api.get(`/api/requests/${r2.body.id}`, { token: other.token });
  assert.equal(otherReq.body.status, 'Declined', 'other pending requests auto-declined');

  const done = await api.patch(`/api/requests/${r1.body.id}/status`, { status: 'Completed' }, { token: seller.token });
  assert.equal(done.status, 200);
  const sold = await api.get(`/api/listings/${l.id}`, { token: seller.token });
  assert.equal(sold.body.status, 'Sold');
  assert.equal(sold.body.soldPrice, 450, 'sold at the agreed offer price');
});

test('requests: business rules - own listing, offer range, duplicates, limit, unavailable', async () => {
  const seller = await newUser(api, 'S');
  const buyer = await newUser(api, 'B');
  const l = (await api.post('/api/listings', book({ price: 400 }), { token: seller.token })).body;

  assert.equal((await api.post('/api/requests', { listingId: l.id }, { token: seller.token })).status, 403, 'own listing');
  const low = await api.post('/api/requests', { listingId: l.id, offerPrice: 100 }, { token: buyer.token });
  assert.equal(low.status, 400, 'offer below 50%');
  assert.equal((await api.post('/api/requests', { listingId: l.id, offerPrice: 401 }, { token: buyer.token })).status, 400, 'offer above price');
  assert.equal((await api.post('/api/requests', { listingId: l.id }, { token: buyer.token })).status, 201);
  const dup = await api.post('/api/requests', { listingId: l.id }, { token: buyer.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_REQUEST');

  for (let i = 0; i < 4; i += 1) {
    const li = (await api.post('/api/listings', book(), { token: seller.token })).body;
    assert.equal((await api.post('/api/requests', { listingId: li.id }, { token: buyer.token })).status, 201);
  }
  const l6 = (await api.post('/api/listings', book(), { token: seller.token })).body;
  const limit = await api.post('/api/requests', { listingId: l6.id }, { token: buyer.token });
  assert.equal(limit.status, 409);
  assert.equal(limit.body.error.code, 'REQUEST_LIMIT_REACHED');

  await api.patch(`/api/listings/${l6.id}/status`, { status: 'Sold' }, { token: seller.token });
  const buyer2 = await newUser(api, 'B2');
  const na = await api.post('/api/requests', { listingId: l6.id }, { token: buyer2.token });
  assert.equal(na.status, 409);
  assert.equal(na.body.error.code, 'LISTING_NOT_AVAILABLE');
});

test('requests: buyer cancels accepted request -> book Available again', async () => {
  const seller = await newUser(api, 'S');
  const buyer = await newUser(api, 'B');
  const l = (await api.post('/api/listings', book(), { token: seller.token })).body;
  const r = (await api.post('/api/requests', { listingId: l.id }, { token: buyer.token })).body;
  await api.patch(`/api/requests/${r.id}/status`, { status: 'Accepted' }, { token: seller.token });
  const c = await api.patch(`/api/requests/${r.id}/status`, { status: 'Cancelled' }, { token: buyer.token });
  assert.equal(c.status, 200);
  assert.equal((await api.get(`/api/listings/${l.id}`)).body.status, 'Available');
});

test('requests: reservation expires after 72 hours (job)', async () => {
  const seller = await newUser(api, 'S');
  const buyer = await newUser(api, 'B');
  const admin = await newAdmin(api);
  const l = (await api.post('/api/listings', book(), { token: seller.token })).body;
  const r = (await api.post('/api/requests', { listingId: l.id }, { token: buyer.token })).body;
  await api.patch(`/api/requests/${r.id}/status`, { status: 'Accepted' }, { token: seller.token });
  const { tables } = require('../src/store');
  const stored = await tables.requests.get(r.id);
  await tables.requests.update({ ...stored, reservedUntil: new Date(Date.now() - 1000).toISOString() }, stored.version);
  const job = await api.post('/api/admin/jobs/run', undefined, { token: admin.token });
  assert.ok(job.body.expiredReservations >= 1);
  assert.equal((await api.get(`/api/requests/${r.id}`, { token: buyer.token })).body.status, 'Expired');
  assert.equal((await api.get(`/api/listings/${l.id}`)).body.status, 'Available');
});

test('requests: seller marks listing Sold by hand -> accepted request completed, others declined', async () => {
  const seller = await newUser(api, 'S');
  const b1 = await newUser(api, 'B');
  const l = (await api.post('/api/listings', book(), { token: seller.token })).body;
  const r1 = (await api.post('/api/requests', { listingId: l.id }, { token: b1.token })).body;
  await api.patch(`/api/listings/${l.id}/status`, { status: 'Sold' }, { token: seller.token });
  assert.equal((await api.get(`/api/requests/${r1.id}`, { token: b1.token })).body.status, 'Declined');
});

test('admin: suspend user -> logged out, listings removed, stats', async () => {
  const admin = await newAdmin(api);
  const bad = await newUser(api, 'Spam');
  const l = (await api.post('/api/listings', book(), { token: bad.token })).body;
  const res = await api.patch(`/api/admin/users/${bad.id}/status`, { status: 'suspended', reason: 'spam' }, { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal((await api.get('/api/users/me', { token: bad.token })).status, 401);
  const login = await api.post('/api/auth/login', { email: bad.email, password: PASSWORD });
  assert.equal(login.status, 403);
  assert.equal((await api.get(`/api/listings/${l.id}`)).status, 404, 'listing hidden');
  const stats = await api.get('/api/admin/stats', { token: admin.token });
  assert.equal(stats.status, 200);
  assert.ok(stats.body.users.suspended >= 1);
  assert.ok(stats.body.monitoring.requests > 0);
});

test('admin: cannot demote last admin / change self', async () => {
  const admin = await newAdmin(api);
  const self = await api.patch(`/api/admin/users/${admin.id}/role`, { role: 'student' }, { token: admin.token });
  assert.equal(self.status, 409);
});

test('health + unknown route', async () => {
  assert.equal((await api.get('/api/health')).body.status, 'ok');
  assert.equal((await api.get('/api/nothing')).status, 404);
});
