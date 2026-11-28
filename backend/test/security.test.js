// Security tests ST-01 .. ST-14 (documented in docs/FINAL_REPORT.md, section 10).
// Run locally:          npm test
// Run against Floci:    API_URL=http://<api-id>.execute-api.localhost.floci.io:4566 \
//                       ADMIN_EMAIL=... ADMIN_PASSWORD=... node --test test/security.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startApi, client, newUser, book, PASSWORD } = require('../test-support/helpers');

let server;
let api;
let alice; // seller
let bob;   // buyer
let eve;   // attacker (normal student account)
let listing;
let request;

test.before(async () => {
  server = await startApi();
  api = client(server.base);
  alice = await newUser(api, 'Alice');
  bob = await newUser(api, 'Bob');
  eve = await newUser(api, 'Eve');
  listing = (await api.post('/api/listings', book({ price: 300 }), { token: alice.token })).body;
  request = (await api.post('/api/requests', { listingId: listing.id, message: 'hi' }, { token: bob.token })).body;
});
test.after(async () => server.close());

test('ST-01 protected endpoints reject requests without a token (401)', async () => {
  const calls = [
    api.get('/api/users/me'),
    api.post('/api/listings', book()),
    api.get('/api/listings/mine'),
    api.post('/api/requests', { listingId: listing.id }),
    api.get('/api/requests'),
    api.get('/api/notifications'),
    api.get('/api/admin/users')
  ];
  for (const res of await Promise.all(calls)) {
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  }
});

test('ST-02 tampered, "alg:none" and garbage tokens are rejected (401)', async () => {
  const [h, p, s] = alice.token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  for (const token of [`${h}.${forged}.${s}`, `${none}.${forged}.`, 'abc.def.ghi', 'x'.repeat(5000)]) {
    assert.equal((await api.get('/api/users/me', { token })).status, 401);
  }
});

test('ST-03 expired token is rejected (401)', { skip: Boolean(process.env.API_URL) && 'needs the signing secret' }, async () => {
  const jwt = require('../src/lib/jwt');
  const token = jwt.sign({ sub: alice.id, role: 'student', tv: 1 }, process.env.JWT_SECRET, -10);
  assert.equal((await api.get('/api/users/me', { token })).status, 401);
});

test('ST-04 a student cannot use admin functions (403, enforced in the backend)', async () => {
  for (const res of [
    await api.get('/api/admin/users', { token: eve.token }),
    await api.patch(`/api/admin/users/${eve.id}/role`, { role: 'admin' }, { token: eve.token }),
    await api.patch(`/api/admin/users/${alice.id}/status`, { status: 'suspended' }, { token: eve.token }),
    await api.get('/api/admin/stats', { token: eve.token }),
    await api.get('/api/requests?box=all', { token: eve.token })
  ]) {
    assert.equal(res.status, 403);
  }
});

test('ST-05 IDOR: another user cannot edit, change status, upload a photo to or delete my listing (403)', async () => {
  assert.equal((await api.put(`/api/listings/${listing.id}`, book({ price: 1 }), { token: eve.token })).status, 403);
  assert.equal((await api.patch(`/api/listings/${listing.id}/status`, { status: 'Sold' }, { token: eve.token })).status, 403);
  assert.equal((await api.post(`/api/listings/${listing.id}/photo`, { data: 'AAAA' }, { token: eve.token })).status, 403);
  assert.equal((await api.del(`/api/listings/${listing.id}`, { token: eve.token })).status, 403);
  const after = await api.get(`/api/listings/${listing.id}`);
  assert.equal(after.body.price, 300);
  assert.equal(after.body.status, 'Available');
});

test('ST-06 IDOR: a third user cannot read or change a request, or read/mark another user\'s notifications (403)', async () => {
  assert.equal((await api.get(`/api/requests/${request.id}`, { token: eve.token })).status, 403);
  assert.equal((await api.patch(`/api/requests/${request.id}/status`, { status: 'Cancelled' }, { token: eve.token })).status, 403);
  const notes = await api.get('/api/notifications', { token: alice.token });
  const noteId = notes.body.items[0].id;
  assert.equal((await api.patch(`/api/notifications/${noteId}/read`, undefined, { token: eve.token })).status, 403);
  const eveNotes = await api.get('/api/notifications', { token: eve.token });
  assert.equal(eveNotes.body.items.length, 0, 'eve only sees her own notifications');
});

test('ST-07 workflow roles: the buyer cannot accept their own request; the seller cannot cancel it for the buyer (403)', async () => {
  assert.equal((await api.patch(`/api/requests/${request.id}/status`, { status: 'Accepted' }, { token: bob.token })).status, 403);
  assert.equal((await api.patch(`/api/requests/${request.id}/status`, { status: 'Cancelled' }, { token: alice.token })).status, 403);
});

test('ST-08 mass assignment: role/status cannot be set by the client (400)', async () => {
  const reg = await api.post('/api/auth/register', {
    email: `mass${Date.now()}@student.edu`, password: PASSWORD, displayName: 'Mass', role: 'admin'
  });
  assert.equal(reg.status, 400);
  assert.match(reg.body.error.message, /Unknown field/);
  assert.equal((await api.patch('/api/users/me', { role: 'admin' }, { token: eve.token })).status, 400);
  assert.equal((await api.post('/api/listings', { ...book(), sellerId: alice.id, status: 'Sold' }, { token: eve.token })).status, 400);
  assert.equal((await api.get('/api/users/me', { token: eve.token })).body.role, 'student');
});

test('ST-09 input validation: bad JSON 400, wrong content type 415, huge body 413, control characters 400, bad id 400', async () => {
  const badJson = await api.call('POST', '/api/listings', { token: eve.token, raw: '{"title":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(badJson.status, 400);
  const wrongType = await api.call('POST', '/api/listings', { token: eve.token, raw: 'title=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(wrongType.status, 415);
  const huge = await api.post('/api/listings', { ...book(), description: 'x'.repeat(3 * 1024 * 1024) }, { token: eve.token });
  assert.equal(huge.status, 413);
  const ctrl = await api.post('/api/listings', book({ title: 'Book\u0000\u001b[31m' }), { token: eve.token });
  assert.equal(ctrl.status, 400);
  assert.equal((await api.get('/api/listings/..%2F..%2Fetc')).status, 400);
  assert.equal((await api.get('/api/listings?maxPrice=abc')).status, 400);
});

test('ST-10 stored XSS: HTML is stored as plain text and returned as JSON (frontend renders with textContent)', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const res = await api.post('/api/listings', book({ title: payload }), { token: eve.token });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, payload);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('ST-11 brute force: 5 wrong passwords lock the account (423), even the right password is refused', async () => {
  const victim = await newUser(api, 'Victim');
  for (let i = 0; i < 5; i += 1) {
    const r = await api.post('/api/auth/login', { email: victim.email, password: 'Wrong-pass1' });
    assert.equal(r.status, 401);
  }
  const locked = await api.post('/api/auth/login', { email: victim.email, password: PASSWORD });
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
});

test('ST-12 no user enumeration and no secrets in responses', async () => {
  const unknown = await api.post('/api/auth/login', { email: 'nobody@student.edu', password: 'Wrong-pass1' });
  const wrong = await api.post('/api/auth/login', { email: eve.email, password: 'Wrong-pass1' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.body.error.message, wrong.body.error.message);
  const me = await api.get('/api/users/me', { token: eve.token });
  const text = JSON.stringify(me.body);
  assert.ok(!/passwordHash|passwordSalt|tokenVersion|failedLogins/.test(text));
});

test('ST-13 CORS: only the configured website origin is allowed', async () => {
  const allowedOrigin = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',')[0];
  const ok = await api.call('OPTIONS', '/api/listings', { headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), allowedOrigin);
  const evil = await api.call('OPTIONS', '/api/listings', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('ST-14 security headers and no stack traces on errors', async () => {
  const res = await api.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.ok(!JSON.stringify(res.body).includes('at '), 'no stack trace');
});

test('unit: JWT verify rejects wrong secret', () => {
  const jwt = require('../src/lib/jwt');
  const t = jwt.sign({ sub: 'x' }, 'a'.repeat(40), 60);
  assert.ok(jwt.verify(t, 'a'.repeat(40)));
  assert.equal(jwt.verify(t, crypto.randomBytes(20).toString('hex')), null);
});
