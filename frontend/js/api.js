// Small API client. The login token is kept in sessionStorage (cleared when the
// tab closes) and sent as "Authorization: Bearer <token>".
// NOTE: hiding buttons in the UI is only for convenience; every permission is
// checked again by the backend (401/403).
const session = {
  get token() { return sessionStorage.getItem('tbx_token'); },
  get user() {
    try { return JSON.parse(sessionStorage.getItem('tbx_user') || 'null'); } catch { return null; }
  },
  save(token, user) {
    if (token) sessionStorage.setItem('tbx_token', token);
    if (user) sessionStorage.setItem('tbx_user', JSON.stringify(user));
  },
  clear() { sessionStorage.removeItem('tbx_token'); sessionStorage.removeItem('tbx_user'); }
};

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error && body.error.message) || `Request failed (${status})`);
    this.status = status;
    this.code = body && body.error && body.error.code;
  }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`${API_ROOT}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json();
  if (res.status === 401 && session.token) {
    session.clear();
    window.dispatchEvent(new Event('tbx:logged-out'));
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
