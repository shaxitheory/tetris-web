// Tiny REST client + token storage for auth, stats, and leaderboard.
const TOKEN_KEY = 'tetra_token';
const USER_KEY = 'tetra_user';

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  user: () => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
  save(token, user) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
};

function headers(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  const t = auth.token();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: headers(!!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  register: (username, email, password) =>
    req('POST', '/api/auth/register', { username, email, password }),
  login: (username, password) =>
    req('POST', '/api/auth/login', { username, password }),
  guest: () => req('POST', '/api/auth/guest'),
  me: () => req('GET', '/api/auth/me'),
  leaderboard: () => req('GET', '/api/leaderboard'),
  profile: (username) => req('GET', `/api/users/${encodeURIComponent(username)}`),
  postSolo: (score, lines) => req('POST', '/api/solo', { score, lines }),
};
