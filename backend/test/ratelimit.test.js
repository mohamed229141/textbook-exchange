// ST-15 rate limiting on the login endpoint (separate process: low limit)
process.env.RATE_LIMIT_AUTH = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, client } = require('../test-support/helpers');

test('ST-15 login is rate limited per IP (429 + Retry-After)', async () => {
  const server = await startApi();
  const api = client(server.base);
  const codes = [];
  for (let i = 0; i < 7; i += 1) {
    codes.push((await api.post('/api/auth/login', { email: 'x@student.edu', password: 'Wrong-pass1' })).status);
  }
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429);
  const last = await api.post('/api/auth/login', { email: 'x@student.edu', password: 'Wrong-pass1' });
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  await server.close();
});

test('unit: ISBN check digits and semester calendar', () => {
  const { normalizeIsbn } = require('../src/services/listings/googleBooks');
  assert.equal(normalizeIsbn('978-0-262-03384-8'), '9780262033848');
  assert.equal(normalizeIsbn('0-306-40615-2'), '0306406152');
  assert.equal(normalizeIsbn('9780262033849'), null);
  const { semesterFor } = require('../src/lib/semester');
  assert.equal(semesterFor(new Date('2026-11-27')).name, 'Fall 2026');
  assert.equal(semesterFor(new Date('2026-11-27')).endsAt.toISOString().slice(0, 10), '2027-01-31');
  assert.equal(semesterFor(new Date('2027-01-15')).name, 'Fall 2026');
  assert.equal(semesterFor(new Date('2027-03-01')).name, 'Spring 2027');
  assert.equal(semesterFor(new Date('2027-07-10')).name, 'Summer 2027');
});
