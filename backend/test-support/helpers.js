// Test helpers: start the real Express app on a random port with an in-memory
// database and a fake Google Books server, then call it over HTTP with fetch.
// Set API_URL to run the same tests against a deployed API instead (e.g. Floci).
const http = require('http');
const crypto = require('crypto');

const FAKE_BOOK_ISBN = '9780262033848';

// Answers like https://www.googleapis.com/books/v1/volumes?q=isbn:<ISBN>
function startFakeGoogleBooks() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const q = url.searchParams.get('q');
      const body = q === `isbn:${FAKE_BOOK_ISBN}` ? {
        totalItems: 1,
        items: [{
          volumeInfo: {
            title: 'Introduction to Algorithms',
            authors: ['Thomas H. Cormen'],
            publisher: 'MIT Press',
            publishedDate: '2009',
            pageCount: 1292,
            imageLinks: { thumbnail: 'http://books.google.com/books/content?id=x&img=1' }
          }
        }]
      } : { totalItems: 0 };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    server.listen(0, () => resolve(server));
  });
}

async function startApi() {
  if (process.env.API_URL) return { base: process.env.API_URL.replace(/\/$/, ''), close: async () => {} };
  const fake = await startFakeGoogleBooks();
  // Tests must not touch real AWS/Floci even if this shell ran "source infra/_lib.sh"
  for (const k of ['PHOTO_BUCKET', 'TOPIC_ARN', 'QUEUE_URL', 'AUDIT_LOG_GROUP', 'SECRETS_ID', 'DYNAMODB_TABLE_PREFIX', 'DATABASE_URL', 'ALLOWED_EMAIL_DOMAINS']) delete process.env[k];
  Object.assign(process.env, {
    STORAGE: 'memory',
    NODE_ENV: 'test',
    LOG_SILENT: '1',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    GOOGLE_BOOKS_URL: `http://127.0.0.1:${fake.address().port}`,
    CORS_ORIGINS: 'http://localhost:8080',
    RATE_LIMIT_AUTH: process.env.RATE_LIMIT_AUTH || '1000',
    RATE_LIMIT_GENERAL: process.env.RATE_LIMIT_GENERAL || '100000',
    RATE_LIMIT_REPORTS: '1000'
  });
  const app = require('../app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.close(); fake.close(); }
  };
}

function client(base) {
  async function call(method, path, { token, body, headers = {}, raw } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && raw === undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  return {
    get: (p, o) => call('GET', p, o),
    post: (p, b, o = {}) => call('POST', p, { ...o, body: b }),
    put: (p, b, o = {}) => call('PUT', p, { ...o, body: b }),
    patch: (p, b, o = {}) => call('PATCH', p, { ...o, body: b }),
    del: (p, o) => call('DELETE', p, o),
    call
  };
}

const PASSWORD = 'Test-Passw0rd';
let counter = 0;
async function newUser(api, name = 'User') {
  counter += 1;
  const email = `${name.toLowerCase()}${counter}.${Date.now()}@student.edu`;
  const res = await api.post('/api/auth/register', { email, password: PASSWORD, displayName: `${name} ${counter}` });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.token, email };
}

// Admin accounts can only be created by the seed script: promote directly in the store
async function newAdmin(api) {
  if (process.env.API_URL) { // deployed API: use the admin created with npm run seed:admin
    const login = await api.post('/api/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    if (login.status !== 200) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD to the seeded admin account.');
    return { ...login.body.user, token: login.body.token, email: process.env.ADMIN_EMAIL };
  }
  const user = await newUser(api, 'Admin');
  const { tables } = require('../src/store');
  const stored = await tables.users.get(user.id);
  await tables.users.update({ ...stored, role: 'admin' }, stored.version);
  const login = await api.post('/api/auth/login', { email: user.email, password: PASSWORD });
  return { ...login.body.user, token: login.body.token, email: user.email };
}

const book = (over = {}) => ({
  courseCode: 'CS101', title: 'Data Structures in JavaScript', author: 'Jane Doe',
  condition: 'Good', price: 400, description: 'Light pencil notes', ...over
});

module.exports = { startApi, client, newUser, newAdmin, book, PASSWORD, FAKE_BOOK_ISBN };
