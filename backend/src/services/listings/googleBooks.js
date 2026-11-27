// EXTERNAL API: Google Books API (https://developers.google.com/books/docs/v1/using)
//   GET https://www.googleapis.com/books/v1/volumes?q=isbn:<ISBN>
// Real job in the workflow:
//  1. "Sell a book" form: the seller types an ISBN and the form is filled in
//     automatically (title, authors, publisher, cover).
//  2. Creating / editing a listing with an ISBN: the server checks the ISBN exists and
//     marks the listing "ISBN verified" + stores the cover image URL (fights fake listings).
// No API key is needed for ISBN lookups. Optional: GOOGLE_BOOKS_API_KEY (environment / Secrets
// Manager) raises the quota. Results are cached in memory for 1 hour.
const config = require('../../config');
const { AppError, errors } = require('../../lib/http');
const { log } = require('../../lib/logger');

const cache = new Map();
const TTL = 60 * 60 * 1000;

// Accepts ISBN-10 or ISBN-13 with or without dashes; returns digits only, or null
function normalizeIsbn(raw) {
  if (typeof raw !== 'string') return null;
  const isbn = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((s, ch, i) => s + (ch === 'X' ? 10 : Number(ch)) * (10 - i), 0);
    return sum % 11 === 0 ? isbn : null;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce((s, ch, i) => s + Number(ch) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? isbn : null;
  }
  return null;
}

// Google returns http:// thumbnail links: use https so the browser does not block them
const httpsUrl = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : null);

async function lookupIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) throw errors.validation('ISBN is not valid (check digit failed).');

  const hit = cache.get(isbn);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const params = new URLSearchParams({ q: `isbn:${isbn}`, maxResults: '1', printType: 'books' });
  if (config.googleBooksApiKey) params.set('key', config.googleBooksApiKey);
  const url = `${config.googleBooksBaseUrl}/books/v1/volumes?${params}`;
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(config.externalTimeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    log('warn', 'Google Books unavailable', { isbn, error: err.message });
    throw new AppError(503, 'EXTERNAL_SERVICE_UNAVAILABLE', 'The book lookup service is not available right now. Enter the details by hand.');
  }

  const book = data.totalItems > 0 && data.items && data.items[0] && data.items[0].volumeInfo;
  if (!book) throw errors.notFound('Book with this ISBN');
  const images = book.imageLinks || {};
  const value = {
    isbn,
    title: book.title || null,
    subtitle: book.subtitle || null,
    authors: (book.authors || []).slice(0, 5),
    publishers: book.publisher ? [book.publisher] : [],
    publishDate: book.publishedDate || null,
    pages: book.pageCount || null,
    coverUrl: httpsUrl(images.thumbnail || images.smallThumbnail),
    source: 'Google Books'
  };
  cache.set(isbn, { at: Date.now(), value });
  return value;
}

module.exports = { lookupIsbn, normalizeIsbn };
