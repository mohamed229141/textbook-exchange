// Textbook Exchange frontend (plain JavaScript, no framework).
// Every piece of user data is put on the page with textContent, never innerHTML (XSS).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// el('div', { class: 'x', onclick: fn }, 'text', childNode)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const money = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP`;
const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

let toastTimer;
function toast(message, kind = 'ok') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// Run an async action; show API errors as a toast (or inside a form)
async function attempt(fn, errorTarget) {
  try {
    return await fn();
  } catch (err) {
    if (errorTarget) errorTarget.textContent = err.message;
    else toast(err.message, 'error');
    return undefined;
  }
}

// ------------------------------------------------------------------ session UI
function refreshAuthUi() {
  const user = session.user;
  document.body.classList.toggle('logged-in', Boolean(user));
  document.body.classList.toggle('is-admin', Boolean(user && user.role === 'admin'));
  $('#profile-btn').textContent = user ? `${user.displayName}${user.role === 'admin' ? ' (admin)' : ''}` : '';
  if (!user) {
    const active = $('.tab.active');
    if (active && active.dataset.view !== 'browse') showView('browse');
  }
}

window.addEventListener('tbx:logged-out', () => {
  refreshAuthUi();
  toast('Your session ended. Please log in again.', 'error');
});

// ------------------------------------------------------------------ navigation
function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  const loaders = { browse: loadBrowse, sell: loadSemesterNote, mine: loadMine, requests: loadRequests, alerts: loadAlerts, admin: loadAdmin };
  if (loaders[name]) loaders[name]();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

// ------------------------------------------------------------------ health
async function checkHealth() {
  const status = $('#api-status');
  try {
    const h = await api('GET', '/api/health');
    status.textContent = `API online - ${h.runtime} / ${h.storage}${h.function ? ` / ${h.function}` : ''}`;
    status.className = 'api-status ok';
  } catch {
    status.textContent = `API offline (${API_ROOT}). Start the backend or check js/config.js.`;
    status.className = 'api-status error';
  }
}

// ------------------------------------------------------------------ cover / photo
const photoCache = new Map();
function coverFor(listing) {
  const box = el('div', { class: 'cover' }, el('span', { class: 'cover-code' }, listing.courseCode));
  if (listing.hasPhoto) {
    const load = photoCache.get(listing.id) || api('GET', `/api/listings/${encodeURIComponent(listing.id)}/photo`)
      .then((p) => `data:${p.contentType};base64,${p.data}`);
    photoCache.set(listing.id, load);
    load.then((src) => { box.replaceChildren(el('img', { src, alt: `Photo of ${listing.title}` })); })
      .catch(() => photoCache.delete(listing.id));
  } else if (listing.coverUrl && listing.coverUrl.startsWith('https://books.google.com/')) {
    box.replaceChildren(el('img', { src: listing.coverUrl, alt: `Cover of ${listing.title}`, loading: 'lazy', referrerpolicy: 'no-referrer' }));
  }
  return box;
}

function statusPill(status) {
  return el('span', { class: `pill pill-${status.toLowerCase().replace(/\s/g, '-')}` }, status);
}

// ------------------------------------------------------------------ BROWSE
function searchParams() {
  const data = new FormData($('#search-form'));
  const params = new URLSearchParams();
  for (const [k, v] of data.entries()) if (String(v).trim()) params.set(k, String(v).trim());
  return params;
}

async function loadBrowse() {
  const params = searchParams();
  const grid = $('#listing-grid');
  const result = await attempt(() => api('GET', `/api/listings?${params}`));
  if (!result) return;
  $('#result-count').textContent = `${result.total} book${result.total === 1 ? '' : 's'} available`;
  grid.replaceChildren(...result.items.map(listingCard));
  if (!result.items.length) grid.append(el('p', { class: 'empty' }, 'No books match. Try another course code.'));
  const course = params.get('courseCode');
  if (course) showPriceGuide(course, $('#price-guide')); else $('#price-guide').classList.add('hidden');
}

function listingCard(l) {
  const me = session.user;
  const own = me && me.id === l.sellerId;
  const actions = el('div', { class: 'card-actions' });
  if (!me) actions.append(el('button', { class: 'ghost', type: 'button', onclick: () => openAuth('login') }, 'Log in to request'));
  else if (own) actions.append(el('span', { class: 'muted' }, 'Your listing'));
  else if (l.status === 'Available') actions.append(el('button', { class: 'primary', type: 'button', onclick: () => openRequest(l) }, 'Request book'));
  if (me && !own) actions.append(el('button', { class: 'link report-link', type: 'button', onclick: () => openReport(l) }, 'Report'));

  return el('article', { class: 'card' },
    coverFor(l),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-top' }, el('span', { class: 'code' }, l.courseCode), statusPill(l.status)),
      el('h3', {}, l.title),
      el('p', { class: 'author' }, l.author, l.edition ? `, ${l.edition} ed.` : ''),
      el('p', { class: 'meta' }, `${l.condition} condition`, l.isbnVerified ? el('span', { class: 'verified', title: `ISBN ${l.isbn} verified with Google Books` }, ' ISBN verified') : ''),
      l.description ? el('p', { class: 'desc' }, l.description) : null,
      el('p', { class: 'price' }, money(l.price)),
      el('p', { class: 'seller muted' }, `Sold by ${l.sellerName} - listed ${date(l.createdAt)} - expires ${date(l.expiresAt)}`),
      actions));
}

async function showPriceGuide(courseCode, box) {
  const g = await api('GET', `/api/listings/price-guide?courseCode=${encodeURIComponent(courseCode)}`).catch(() => null);
  if (!g) { box.classList.add('hidden'); return; }
  const part = (label, s) => (s.count ? `${label}: ${s.count} book(s), ${money(s.min)} - ${money(s.max)}, average ${money(s.average)}` : `${label}: none yet`);
  box.replaceChildren(el('strong', {}, `Price guide ${g.courseCode}`), el('span', {}, part('Sold', g.sold)), el('span', {}, part('On sale now', g.available)));
  box.classList.remove('hidden');
}

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); loadBrowse(); });

// ------------------------------------------------------------------ REQUEST dialog
function openRequest(listing) {
  const form = $('#request-form');
  form.reset();
  form.listingId.value = listing.id;
  form.offerPrice.value = listing.price;
  form.offerPrice.max = listing.price;
  form.offerPrice.min = Math.ceil(listing.price * 0.5);
  $('#offer-hint').textContent = `Asking price ${money(listing.price)}. Offers from ${money(Math.ceil(listing.price * 0.5))} are accepted.`;
  $('#request-book').textContent = `${listing.courseCode} - ${listing.title} (${listing.condition})`;
  $('[data-error]', form).textContent = '';
  $('#request-dialog').showModal();
}

$('#request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const ok = await attempt(() => api('POST', '/api/requests', {
    listingId: form.listingId.value,
    offerPrice: Number(form.offerPrice.value),
    message: form.message.value.trim() || undefined
  }), $('[data-error]', form));
  if (ok) {
    $('#request-dialog').close();
    toast('Request sent. The seller has been notified.');
    loadBrowse();
  }
});

// ------------------------------------------------------------------ SELL
const sellForm = $('#sell-form');

$('#isbn-lookup').addEventListener('click', async () => {
  const isbn = sellForm.isbn.value.trim();
  const box = $('#isbn-result');
  if (!isbn) { toast('Type an ISBN first.', 'error'); return; }
  box.textContent = 'Looking up the book on Google Books...';
  box.classList.remove('hidden');
  try {
    const book = await api('GET', `/api/books/isbn/${encodeURIComponent(isbn)}`);
    if (book.title && !sellForm.title.value) sellForm.title.value = book.title;
    if (book.authors.length && !sellForm.author.value) sellForm.author.value = book.authors.join(', ');
    box.replaceChildren(
      book.coverUrl ? el('img', { src: book.coverUrl, alt: '', referrerpolicy: 'no-referrer' }) : '',
      el('div', {}, el('strong', {}, book.title || 'Untitled'), el('br'),
        book.authors.join(', '), el('br'),
        el('span', { class: 'muted' }, [book.publishers.join(', '), book.publishDate].filter(Boolean).join(' - ')), el('br'),
        el('span', { class: 'verified' }, 'Found on Google Books - your listing will be marked ISBN verified')));
  } catch (err) {
    box.textContent = err.message;
  }
});

sellForm.courseCode.addEventListener('change', () => {
  const code = sellForm.courseCode.value.trim();
  if (code) showPriceGuide(code, $('#sell-guide'));
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resetSellForm() {
  sellForm.reset();
  sellForm.id.value = '';
  $('#sell-title').textContent = 'Sell a textbook';
  $('#sell-submit').textContent = 'Publish listing';
  $('#sell-cancel').classList.add('hidden');
  $('#isbn-result').classList.add('hidden');
  $('#sell-guide').classList.add('hidden');
}
$('#sell-cancel').addEventListener('click', () => { resetSellForm(); showView('mine'); });

sellForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = sellForm;
  const photo = f.photo.files[0];
  if (photo && photo.size > 1024 * 1024) { toast('Photo must be at most 1 MB.', 'error'); return; }
  const body = {
    courseCode: f.courseCode.value.trim(),
    title: f.title.value.trim(),
    author: f.author.value.trim(),
    condition: f.condition.value,
    price: Number(f.price.value)
  };
  if (f.isbn.value.trim()) body.isbn = f.isbn.value.trim();
  if (f.edition.value.trim()) body.edition = f.edition.value.trim();
  if (f.description.value.trim()) body.description = f.description.value.trim();

  const editing = f.id.value;
  const listing = await attempt(() => (editing
    ? api('PUT', `/api/listings/${encodeURIComponent(editing)}`, body)
    : api('POST', '/api/listings', body)));
  if (!listing) return;
  if (photo) {
    await attempt(async () => {
      const data = await fileToBase64(photo);
      await api('POST', `/api/listings/${encodeURIComponent(listing.id)}/photo`, { data });
      photoCache.delete(listing.id);
    });
  }
  toast(editing ? 'Listing updated.' : `Listing published${listing.isbnVerified ? ' (ISBN verified)' : ''}. It expires on ${date(listing.expiresAt)}.`);
  resetSellForm();
  showView('mine');
});

// ------------------------------------------------------------------ MY LISTINGS
async function loadMine() {
  const list = $('#mine-list');
  const items = await attempt(() => api('GET', '/api/listings/mine'));
  if (!items) return;
  list.replaceChildren(...items.map(mineRow));
  if (!items.length) list.append(el('p', { class: 'empty' }, 'You have no listings yet. Use "Sell a book".'));
}

function listingAction(label, fn, cls = 'ghost') {
  return el('button', { class: cls, type: 'button', onclick: fn }, label);
}

async function setListingStatus(l, status) {
  if (await attempt(() => api('PATCH', `/api/listings/${encodeURIComponent(l.id)}/status`, { status }))) {
    toast(`Listing is now ${status}.`);
    loadMine();
  }
}

function startEdit(l) {
  showView('sell');
  const f = sellForm;
  f.id.value = l.id;
  ['courseCode', 'title', 'author', 'condition', 'price'].forEach((k) => { f[k].value = l[k]; });
  f.isbn.value = l.isbn || '';
  f.edition.value = l.edition || '';
  f.description.value = l.description || '';
  $('#sell-title').textContent = `Edit: ${l.title}`;
  $('#sell-submit').textContent = 'Save changes';
  $('#sell-cancel').classList.remove('hidden');
}

function mineRow(l) {
  const actions = el('div', { class: 'row-actions' });
  if (l.status === 'Available') {
    actions.append(
      listingAction('Edit', () => startEdit(l)),
      listingAction('Mark reserved', () => setListingStatus(l, 'Reserved')),
      listingAction('Mark sold', () => setListingStatus(l, 'Sold')));
  }
  if (l.status === 'Reserved') {
    actions.append(
      listingAction('Make available', () => setListingStatus(l, 'Available')),
      listingAction('Mark sold', () => setListingStatus(l, 'Sold')));
  }
  if (l.status === 'Expired' && l.renewals < 1) {
    actions.append(listingAction('Renew for this semester', async () => {
      if (await attempt(() => api('POST', `/api/listings/${encodeURIComponent(l.id)}/renew`))) { toast('Listing renewed.'); loadMine(); }
    }, 'primary'));
  }
  if (['Available', 'Expired'].includes(l.status)) {
    actions.append(listingAction('Delete', async () => {
      if (!window.confirm(`Delete "${l.title}"? This cannot be undone.`)) return;
      if (await attempt(() => api('DELETE', `/api/listings/${encodeURIComponent(l.id)}`))) { toast('Listing deleted.'); loadMine(); }
    }, 'danger'));
  }
  return el('article', { class: 'row' },
    coverFor(l),
    el('div', { class: 'row-main' },
      el('div', { class: 'card-top' }, el('span', { class: 'code' }, l.courseCode), statusPill(l.status)),
      el('h3', {}, l.title),
      el('p', { class: 'muted' }, `${l.condition} - ${money(l.price)} - ${l.semester} - expires ${date(l.expiresAt)}`),
      l.status === 'Reserved' && l.reservedUntil ? el('p', { class: 'note' }, `Reserved for a buyer until ${dateTime(l.reservedUntil)}`) : null,
      l.status === 'Sold' ? el('p', { class: 'note' }, `Sold for ${money(l.soldPrice || l.price)} on ${date(l.soldAt)}`) : null,
      l.status === 'Removed' ? el('p', { class: 'note error' }, `Removed: ${l.removedReason || ''}`) : null,
      l.status === 'UnderReview' ? el('p', { class: 'note error' }, l.reviewNote || 'Hidden while a moderator reviews reports.') : null,
      actions));
}

// ------------------------------------------------------------------ REQUESTS
let currentBox = 'incoming';
$$('.subtab').forEach((b) => b.addEventListener('click', () => {
  currentBox = b.dataset.box;
  $$('.subtab').forEach((x) => x.classList.toggle('active', x === b));
  loadRequests();
}));

async function loadRequests() {
  const list = $('#request-list');
  const items = await attempt(() => api('GET', `/api/requests?box=${currentBox}`));
  if (!items) return;
  list.replaceChildren(...items.map((r) => requestRow(r)));
  if (!items.length) list.append(el('p', { class: 'empty' }, currentBox === 'incoming' ? 'No one has requested your books yet.' : 'You have not requested any book yet.'));
}

async function setRequestStatus(r, status, after = loadRequests) {
  if (status === 'Cancelled' && !window.confirm('Cancel this request?')) return;
  if (await attempt(() => api('PATCH', `/api/requests/${encodeURIComponent(r.id)}/status`, { status }))) {
    toast(`Request ${status.toLowerCase()}.`);
    after();
    refreshBell();
  }
}

function contactBlock(contact, role) {
  if (!contact) return null;
  const other = role === 'seller' ? contact.buyer : contact.seller;
  if (!other) return null;
  return el('p', { class: 'contact' }, `Contact ${other.displayName}: ${other.email}${other.phone ? ` - ${other.phone}` : ''}`);
}

function requestRow(r, after) {
  const actions = el('div', { class: 'row-actions' });
  if (r.myRole === 'seller' && r.status === 'Pending') {
    actions.append(
      listingAction('Accept (reserve 72 h)', () => setRequestStatus(r, 'Accepted', after), 'primary'),
      listingAction('Decline', () => setRequestStatus(r, 'Declined', after), 'danger'));
  }
  if (r.myRole === 'seller' && r.status === 'Accepted') {
    actions.append(listingAction('Mark completed (sold)', () => setRequestStatus(r, 'Completed', after), 'primary'));
  }
  if (r.myRole === 'buyer' && ['Pending', 'Accepted'].includes(r.status)) {
    actions.append(listingAction('Cancel request', () => setRequestStatus(r, 'Cancelled', after), 'danger'));
  }
  const who = r.myRole === 'seller' ? `From ${r.buyerName}` : r.myRole === 'buyer' ? `Seller ${r.sellerName}` : `${r.buyerName} -> ${r.sellerName}`;
  return el('article', { class: 'row request' },
    el('div', { class: 'row-main' },
      el('div', { class: 'card-top' }, el('span', { class: 'code' }, r.courseCode), statusPill(r.status)),
      el('h3', {}, r.listingTitle),
      el('p', {}, `${who} - offer ${money(r.offerPrice)} (asking ${money(r.askingPrice)})`),
      r.message ? el('blockquote', {}, r.message) : null,
      r.status === 'Accepted' && r.reservedUntil ? el('p', { class: 'note' }, `Reserved until ${dateTime(r.reservedUntil)}`) : null,
      contactBlock(r.contact, r.myRole),
      el('p', { class: 'muted small' }, `Updated ${dateTime(r.updatedAt)}`),
      actions));
}

// ------------------------------------------------------------------ NOTIFICATIONS
async function refreshBell() {
  if (!session.token) return;
  const data = await api('GET', '/api/notifications?unread=true').catch(() => null);
  const badge = $('#bell-count');
  if (data && data.unread) { badge.textContent = data.unread; badge.classList.remove('hidden'); } else badge.classList.add('hidden');
}

async function openDrawer() {
  const list = $('#notification-list');
  const data = await attempt(() => api('GET', '/api/notifications'));
  if (!data) return;
  list.replaceChildren(...data.items.map((n) => el('div', {
    class: `notification ${n.read ? 'read' : ''}`,
    onclick: async () => { if (!n.read) { await attempt(() => api('PATCH', `/api/notifications/${encodeURIComponent(n.id)}/read`)); openDrawer(); refreshBell(); } }
  }, el('p', {}, n.message), el('span', { class: 'muted small' }, dateTime(n.createdAt)))));
  if (!data.items.length) list.append(el('p', { class: 'empty' }, 'No notifications yet.'));
  $('#drawer').classList.remove('hidden');
}
$('#bell').addEventListener('click', openDrawer);
$('#drawer-close').addEventListener('click', () => $('#drawer').classList.add('hidden'));
$('#read-all').addEventListener('click', async () => { await attempt(() => api('POST', '/api/notifications/read-all')); openDrawer(); refreshBell(); });

// ------------------------------------------------------------------ ADMIN
async function loadAdmin() {
  const stats = await attempt(() => api('GET', '/api/admin/stats'));
  if (stats) {
    const tile = (label, value, sub) => el('div', { class: 'stat' }, el('span', { class: 'stat-value' }, value), el('span', { class: 'stat-label' }, label), sub ? el('span', { class: 'muted small' }, sub) : null);
    $('#stats').replaceChildren(
      tile('Users', stats.users.total, `${stats.users.admins} admin, ${stats.users.suspended} suspended`),
      tile('Books on sale', stats.listings.byStatus.Available, `${stats.listings.total} listings, ${stats.listings.courses} courses`),
      tile('Books sold', stats.listings.byStatus.Sold, money(stats.listings.soldValue)),
      tile('Requests', stats.requests.total, stats.requests.acceptanceRate === null ? 'no decisions yet' : `${stats.requests.acceptanceRate}% accepted`),
      tile('API requests', stats.monitoring.requests, `${stats.monitoring.errors4xx} 4xx / ${stats.monitoring.errors5xx} 5xx since ${dateTime(stats.monitoring.startedAt)}`),
      tile('Open reports', stats.reports.open, `${stats.reports.openCases} listing(s) to review, ${stats.reports.upheld} upheld`),
      tile('Course alerts', stats.alerts.active, `${stats.alerts.notificationsSent} match notifications sent`),
      tile('Semester', stats.semester.name, `ends ${date(stats.semester.endsAt)} (${stats.semester.source === 'admin' ? 'set by admin' : 'calendar'})`),
      tile('Security events', stats.monitoring.securityEvents, `runtime: ${stats.monitoring.runtime}`));
    const sf = $('#semester-form');
    sf.name.value = stats.semester.name;
    sf.endsAt.value = stats.semester.endsAt.slice(0, 10);
    $('#semester-current').textContent = `Now: ${stats.semester.name}, ends ${date(stats.semester.endsAt)}`;
  }
  const users = await attempt(() => api('GET', '/api/admin/users'));
  if (users) {
    const me = session.user;
    $('#users-table tbody').replaceChildren(...users.map((u) => el('tr', {},
      el('td', {}, u.displayName), el('td', {}, u.email), el('td', {}, u.role), el('td', {}, statusPill(u.status)), el('td', {}, date(u.createdAt)),
      el('td', { class: 'row-actions' }, u.id === me.id ? el('span', { class: 'muted' }, 'you') : [
        listingAction(u.status === 'active' ? 'Suspend' : 'Reactivate', async () => {
          const status = u.status === 'active' ? 'suspended' : 'active';
          const reason = status === 'suspended' ? window.prompt(`Why suspend ${u.displayName}? (their listings will be removed)`) : undefined;
          if (status === 'suspended' && reason === null) return;
          if (await attempt(() => api('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}/status`, { status, ...(reason ? { reason } : {}) }))) loadAdmin();
        }, u.status === 'active' ? 'danger' : 'ghost'),
        listingAction(u.role === 'admin' ? 'Make student' : 'Make admin', async () => {
          if (await attempt(() => api('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}/role`, { role: u.role === 'admin' ? 'student' : 'admin' }))) loadAdmin();
        })
      ]))));
  }
  const queue = await attempt(() => api('GET', '/api/admin/reports?status=Open'));
  if (queue) {
    const reasonText = { fake_listing: 'fake', wrong_details: 'wrong details', scam: 'scam', inappropriate: 'inappropriate', other: 'other' };
    $('#report-queue').replaceChildren(...queue.map((c) => el('article', { class: 'row' }, el('div', { class: 'row-main' },
      el('div', { class: 'card-top' }, el('span', { class: 'code' }, c.courseCode), statusPill(c.listingStatus)),
      el('h3', {}, c.listingTitle),
      el('p', {}, `Seller ${c.sellerName} - ${c.reportCount} report(s): ${Object.entries(c.reasons).map(([k, n]) => `${reasonText[k] || k} x${n}`).join(', ')}`),
      ...c.reports.filter((r) => r.details).slice(0, 3).map((r) => el('blockquote', {}, `${r.reporterName}: ${r.details}`)),
      el('div', { class: 'row-actions' },
        listingAction('Dismiss (keep listing)', async () => {
          if (await attempt(() => api('PATCH', `/api/admin/reports/${encodeURIComponent(c.listingId)}/decision`, { decision: 'dismiss' }))) { toast('Reports dismissed, listing restored.'); loadAdmin(); }
        }),
        listingAction('Uphold (remove listing, strike seller)', async () => {
          const note = window.prompt('Reason shown to the seller (e.g. "Book does not exist"):');
          if (!note) return;
          const r = await attempt(() => api('PATCH', `/api/admin/reports/${encodeURIComponent(c.listingId)}/decision`, { decision: 'uphold', note }));
          if (r) { toast(`Listing removed. Seller strikes: ${r.sellerStrikes}${r.sellerSuspended ? ' - seller suspended' : ''}.`); loadAdmin(); }
        }, 'danger'))))));
    if (!queue.length) $('#report-queue').append(el('p', { class: 'empty' }, 'No open reports.'));
  }
  const reqs = await attempt(() => api('GET', '/api/requests?box=all'));
  if (reqs) $('#admin-requests').replaceChildren(...reqs.slice(0, 30).map((r) => requestRow(r, loadAdmin)));
}

$('#run-jobs').addEventListener('click', async () => {
  const r = await attempt(() => api('POST', '/api/admin/jobs/run'));
  if (r) { toast(`Jobs done: ${r.expiredListings} listing(s) expired, ${r.expiredReservations} reservation(s) released.`); loadAdmin(); }
});

$('#semester-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await attempt(() => api('PUT', '/api/admin/semester', { name: f.name.value.trim(), endsAt: f.endsAt.value }));
  if (r) { toast(`${r.name} now ends ${date(r.endsAt)}. ${r.listingsMoved} listing(s) updated.`); loadAdmin(); }
});

// ------------------------------------------------------------------ SEMESTER note on Sell page
async function loadSemesterNote() {
  const s = await api('GET', '/api/settings/semester').catch(() => null);
  $('#semester-end').textContent = s ? `${s.name}, ${date(s.endsAt)}` : 'end of semester';
}

// ------------------------------------------------------------------ REPORT (Moderation service)
function openReport(listing) {
  const f = $('#report-form');
  f.reset();
  f.listingId.value = listing.id;
  $('#report-book').textContent = `${listing.courseCode} - ${listing.title} (seller ${listing.sellerName})`;
  $('[data-error]', f).textContent = '';
  $('#report-dialog').showModal();
}

$('#report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { listingId: f.listingId.value, reason: f.reason.value };
  if (f.details.value.trim()) body.details = f.details.value.trim();
  const r = await attempt(() => api('POST', '/api/reports', body), $('[data-error]', f));
  if (r) {
    $('#report-dialog').close();
    toast(r.listingHidden ? 'Report sent. The listing is now hidden until a moderator reviews it.' : 'Report sent. Thank you.');
    loadBrowse();
  }
});

// ------------------------------------------------------------------ COURSE ALERTS
async function loadAlerts() {
  const list = $('#alert-list');
  $('#alert-matches').replaceChildren();
  const items = await attempt(() => api('GET', '/api/alerts'));
  if (!items) return;
  list.replaceChildren(...items.map((a) => el('article', { class: 'row' }, el('div', { class: 'row-main' },
    el('div', { class: 'card-top' }, el('span', { class: 'code' }, a.courseCode), statusPill(a.active ? 'Active' : (a.paused ? 'Paused' : 'Expired'))),
    el('h3', {}, `${a.courseCode}${a.maxPrice ? ` up to ${money(a.maxPrice)}` : ''}${a.minCondition ? `, at least ${a.minCondition}` : ''}`),
    el('p', { class: 'muted' }, `${a.matchCount} match notification(s) - ends ${date(a.expiresAt)} (${a.semester})`),
    el('div', { class: 'row-actions' },
      listingAction('Show books on sale now', async () => {
        const m = await attempt(() => api('GET', `/api/alerts/${encodeURIComponent(a.id)}/matches`));
        if (!m) return;
        $('#alert-matches').replaceChildren(...m.map(listingCard));
        if (!m.length) $('#alert-matches').append(el('p', { class: 'empty' }, 'Nothing matches yet - you will be notified.'));
      }, 'primary'),
      a.active || a.paused ? listingAction(a.paused ? 'Resume' : 'Pause', async () => {
        if (await attempt(() => api('PATCH', `/api/alerts/${encodeURIComponent(a.id)}`, { active: a.paused }))) loadAlerts();
      }) : null,
      listingAction('Delete', async () => {
        if (await attempt(() => api('DELETE', `/api/alerts/${encodeURIComponent(a.id)}`))) { toast('Alert deleted.'); loadAlerts(); }
      }, 'danger'))))));
  if (!items.length) list.append(el('p', { class: 'empty' }, 'No alerts yet. Follow a course above.'));
}

$('#alert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { courseCode: f.courseCode.value.trim() };
  if (f.maxPrice.value) body.maxPrice = Number(f.maxPrice.value);
  if (f.minCondition.value) body.minCondition = f.minCondition.value;
  const a = await attempt(() => api('POST', '/api/alerts', body));
  if (a) {
    f.reset();
    toast(`Alert created. ${a.currentMatches} book(s) already match - you'll be notified about new ones.`);
    loadAlerts();
  }
});

// ------------------------------------------------------------------ AUTH dialogs
function openAuth(which) {
  $('#login-form').classList.toggle('hidden', which !== 'login');
  $('#register-form').classList.toggle('hidden', which !== 'register');
  $$('#auth-dialog [data-error]').forEach((p) => { p.textContent = ''; });
  $('#auth-dialog').showModal();
}
$('#login-btn').addEventListener('click', () => openAuth('login'));
$$('[data-switch]').forEach((b) => b.addEventListener('click', () => openAuth(b.dataset.switch)));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

function resetRequestBox() {
  currentBox = 'incoming';
  $$('.subtab').forEach((x) => x.classList.toggle('active', x.dataset.box === 'incoming'));
}

function afterLogin({ token, user }) {
  session.save(token, user);
  resetRequestBox();
  $('#auth-dialog').close();
  refreshAuthUi();
  refreshBell();
  toast(`Welcome, ${user.displayName}!`);
  loadBrowse();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const res = await attempt(() => api('POST', '/api/auth/login', { email: f.email.value.trim(), password: f.password.value }), $('[data-error]', f));
  if (res) { f.reset(); afterLogin(res); }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { displayName: f.displayName.value.trim(), email: f.email.value.trim(), password: f.password.value };
  if (f.phone.value.trim()) body.phone = f.phone.value.trim();
  const res = await attempt(() => api('POST', '/api/auth/register', body), $('[data-error]', f));
  if (res) { f.reset(); afterLogin(res); }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  session.clear();
  refreshAuthUi();
  toast('Logged out.');
  loadBrowse();
});

// ------------------------------------------------------------------ PROFILE
$('#profile-btn').addEventListener('click', async () => {
  const me = await attempt(() => api('GET', '/api/users/me'));
  if (!me) return;
  const f = $('#profile-form');
  f.displayName.value = me.displayName;
  f.phone.value = me.phone || '';
  f.faculty.value = me.faculty || '';
  $('#profile-email').textContent = `${me.email} - ${me.role} - member since ${date(me.createdAt)}`;
  $$('#profile-dialog [data-error]').forEach((p) => { p.textContent = ''; });
  $('#profile-dialog').showModal();
});

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const me = await attempt(() => api('PATCH', '/api/users/me', {
    displayName: f.displayName.value.trim(), phone: f.phone.value.trim(), faculty: f.faculty.value.trim()
  }), $('[data-error]', f));
  if (me) { session.save(null, me); refreshAuthUi(); toast('Profile saved.'); $('#profile-dialog').close(); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const res = await attempt(() => api('PUT', '/api/users/me/password', {
    currentPassword: f.currentPassword.value, newPassword: f.newPassword.value
  }), $('[data-error]', f));
  if (res) { session.save(res.token); f.reset(); toast('Password changed. Other sessions were logged out.'); $('#profile-dialog').close(); }
});

// ------------------------------------------------------------------ start
refreshAuthUi();
checkHealth();
loadBrowse();
refreshBell();
setInterval(refreshBell, 30000);
