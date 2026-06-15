// UI flow: auth -> menu -> matchmaking / solo -> game -> result, plus leaderboard.
import { Game } from './game.js';
import { Net } from './net.js';
import { api, auth } from './api.js';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

const screens = {
  auth: $('auth'), menu: $('menu'), leaderboard: $('leaderboard'),
  profile: $('profile'), friends: $('friends'), room: $('room'),
  searching: $('searching'), game: $('game'), result: $('result'),
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Paint a user's picture into a circle element: image if set, else initial.
function paintAvatar(el, user) {
  if (user && user.avatar) {
    el.style.backgroundImage = `url("${user.avatar}")`;
    el.classList.add('has-img');
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-img');
    el.textContent = (user?.username?.[0] || '?').toUpperCase();
  }
}
function goto(name) {
  for (const s of Object.values(screens)) hide(s);
  show(screens[name]);
}

let game = null;
let net = null;
let mode = 'solo';
let me = null;          // current logged-in user object
let room = null;        // { code, youId, hostId, members } when in a private room

// ---- Profile / menu ------------------------------------------------------
function renderProfile() {
  if (!me) return;
  $('profileName').textContent = me.username + (me.isGuest ? ' (guest)' : '');
  $('profileMeta').textContent = `${me.rating} · ${me.wins}W / ${me.losses}L · best ${me.bestScore}`;
  paintAvatar($('avatar'), me);
}

async function refreshProfile() {
  try { me = (await api.me()).user; auth.save(null, me); renderProfile(); } catch {}
}

function enterMenu(user) {
  me = user;
  auth.save(null, user);
  renderProfile();
  refreshFriendBadge();
  ensureNet();               // go online so friends can challenge us
  goto('menu');
}

// ---- Auth screen ---------------------------------------------------------
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('tabLogin').classList.toggle('active', m === 'login');
  $('tabRegister').classList.toggle('active', m === 'register');
  $('authEmail').classList.toggle('hidden', m === 'login');
  $('authSubmit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('authError').textContent = '';
}

$('tabLogin').addEventListener('click', () => setAuthMode('login'));
$('tabRegister').addEventListener('click', () => setAuthMode('register'));

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const email = $('authEmail').value.trim();
  try {
    const res = authMode === 'login'
      ? await api.login(username, password)
      : await api.register(username, email, password);
    auth.save(res.token, res.user);
    enterMenu(res.user);
  } catch (err) {
    $('authError').textContent = err.message;
  }
});

$('guestBtn').addEventListener('click', async () => {
  try {
    const res = await api.guest();
    auth.save(res.token, res.user);
    enterMenu(res.user);
  } catch (err) {
    $('authError').textContent = err.message;
  }
});

$('logoutBtn').addEventListener('click', () => {
  loggingOut = true;
  teardownNet();
  loggingOut = false;
  auth.clear();
  me = null;
  goto('auth');
});

// ---- Stats sink ----------------------------------------------------------
function statsSink(s) {
  $('score').textContent = s.score;
  $('lines').textContent = s.lines;
  $('pending').textContent = s.pending;
}

function buildGame(withNet, onEnd) {
  return new Game({
    canvas: $('board'), holdCanvas: $('hold'), nextCanvas: $('next'), oppCanvas: $('oppBoard'),
    net: withNet ? net : null, onStats: statsSink, onEnd, onPause: showPaused,
  });
}

// Reflect the game's paused state in the UI (overlay + button label).
function showPaused(paused) {
  const overlay = $('pauseOverlay');
  const btn = $('pauseBtn');
  if (paused) { show(overlay); } else { hide(overlay); }
  btn.textContent = paused ? '▶ Resume' : '⏸ Pause';
}

// ---- Persistent lobby connection ----------------------------------------
// One WebSocket stays open while you're logged in so the server knows you're
// online and can deliver friend challenges. It's reused for queueing + matches.
let netConnecting = false;
let loggingOut = false;
let incomingChallenge = null;   // { challengeId, fromName }

function registerNetHandlers() {
  net.on('queued', () => { $('searchText').textContent = 'Waiting for an opponent…'; });
  net.on('matched', (msg) => {
    mode = 'versus';
    hideChallenge();
    show($('oppPanel'));
    hide($('pauseBtn'));
    $('oppName').textContent = msg.opponentName || 'Opponent';
    $('vsName').textContent = `vs ${msg.opponentName || 'Opponent'}`;
    goto('game');
    game = buildGame(true, () => {});  // result driven by server win/lose
    game.start(msg.seed);
  });
  net.on('oppState', (msg) => { if (game) game.setOppBoard(msg.board); });
  net.on('garbage', (msg) => { if (game) game.receiveGarbage(msg.amount); });
  net.on('win', (msg) => { endMatch(true, null, msg.ratingChange); refreshProfile(); });
  net.on('lose', (msg) => { endMatch(false, null, msg.ratingChange); refreshProfile(); });
  net.on('oppLeft', () => endMatch(true, 'Opponent left the match.'));

  // challenges
  net.on('challenged', (msg) => showChallenge(msg));
  net.on('challengeSent', (msg) => toast(`Challenge sent to ${msg.toName} ⚔`));
  net.on('challengeDeclined', (msg) => toast(`${msg.name} declined your challenge`));
  net.on('challengeFailed', (msg) => toast(msg.error || 'Challenge failed'));
  net.on('presence', (msg) => markOnline(msg.online || []));

  // private rooms
  net.on('roomCreated', (msg) => { room = msg; $('chatLog').innerHTML = ''; renderRoom(); });
  net.on('roomJoined', (msg) => { room = msg; $('chatLog').innerHTML = ''; renderRoom(); });
  net.on('roomUpdate', (msg) => { if (room) { room.hostId = msg.hostId; room.members = msg.members; renderRoom(); } });
  net.on('roomChat', (msg) => addChat(msg));
  net.on('roomError', (msg) => {
    if (room) toast(msg.error);
    else { $('roomError').textContent = msg.error; }
  });

  net.on('close', () => {
    if (mode === 'versus' && !screens.searching.classList.contains('hidden')) {
      $('searchText').textContent = 'Disconnected. Reconnecting…';
    }
    // keep presence/challenges alive: reconnect while still logged in
    if (me && !loggingOut) setTimeout(ensureNet, 2000);
  });
}

// Resolves true once the socket is open (and we've announced ourselves).
function ensureNet() {
  return new Promise((resolve) => {
    if (net && net.ws && net.ws.readyState === WebSocket.OPEN) return resolve(true);
    if (netConnecting) return resolve(false);
    netConnecting = true;
    net = new Net();
    registerNetHandlers();
    net.connect()
      .then(() => { net.send({ type: 'hello', token: auth.token() }); netConnecting = false; resolve(true); })
      .catch(() => { netConnecting = false; resolve(false); });
  });
}

function teardownNet() {
  if (net && net.ws) { try { net.ws.close(); } catch {} }
  net = null;
}

// Mark which friend rows are currently online (green dot on their avatar).
function markOnline(ids) {
  const set = new Set(ids);
  document.querySelectorAll('#friendList .person[data-uid]').forEach((el) => {
    el.classList.toggle('online', set.has(el.dataset.uid));
  });
}

// ---- Toast + challenge modal --------------------------------------------
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function showChallenge(msg) {
  incomingChallenge = { challengeId: msg.challengeId, fromName: msg.fromName };
  $('chName').textContent = msg.fromName || 'Someone';
  $('chAv').textContent = (msg.fromName?.[0] || '?').toUpperCase();
  $('challengeModal').classList.remove('hidden');
}
function hideChallenge() { $('challengeModal').classList.add('hidden'); incomingChallenge = null; }

function respondChallenge(accept) {
  if (!incomingChallenge || !net) return hideChallenge();
  net.send({ type: 'challengeRespond', challengeId: incomingChallenge.challengeId, accept });
  hideChallenge();
  if (accept) { mode = 'versus'; goto('searching'); $('searchText').textContent = 'Starting match…'; }
}

async function challengeFriend(userId, name) {
  const ok = await ensureNet();
  if (!ok) return toast('Not connected to server');
  net.send({ type: 'challenge', toUserId: userId });
}

$('chAccept').addEventListener('click', () => respondChallenge(true));
$('chDecline').addEventListener('click', () => respondChallenge(false));

function endMatch(won, note, ratingChange) {
  if (game) game.stop();
  $('resultTitle').textContent = won ? 'You Win! 🏆' : 'Game Over';
  $('resultTitle').style.color = won ? '#4ade80' : '#f87171';
  $('resultNote').textContent = note || (mode === 'versus'
    ? (won ? 'Your opponent topped out.' : 'You topped out.')
    : 'Better luck next time.');
  const rc = $('ratingChange');
  if (typeof ratingChange === 'number' && ratingChange !== 0) {
    rc.textContent = `${ratingChange > 0 ? '+' : ''}${ratingChange} rating`;
    rc.style.color = ratingChange > 0 ? '#4ade80' : '#f87171';
  } else { rc.textContent = ''; }
  $('finalScore').textContent = game ? game.engine.score : 0;
  $('finalLines').textContent = game ? game.engine.lines : 0;
  $('againBtn').textContent = room ? '↩ Back to Room' : 'Back to Menu';
  goto('result');
}

// ---- Solo ----------------------------------------------------------------
function startSolo() {
  mode = 'solo';
  if (net) net.send({ type: 'leave' });   // drop any queue/room, keep the socket
  hide($('oppPanel'));
  show($('pauseBtn'));                     // pausing only makes sense in solo
  $('vsName').textContent = 'Practice';
  goto('game');
  game = buildGame(false, async () => {
    try { me = (await api.postSolo(game.engine.score, game.engine.lines)).user; auth.save(null, me); renderProfile(); } catch {}
    endMatch(false, 'Solo run complete.');
  });
  game.start((Math.random() * 2 ** 31) >>> 0);
}

// ---- Versus (quick match) -----------------------------------------------
async function startVersus() {
  mode = 'versus';
  goto('searching');
  $('searchText').textContent = 'Connecting…';
  const ok = await ensureNet();
  if (!ok) { $('searchText').textContent = 'Could not reach server. Is it running?'; return; }
  $('searchText').textContent = 'Waiting for an opponent…';
  net.send({ type: 'queue', name: me?.username, token: auth.token() });
}

// ---- Leaderboard ---------------------------------------------------------
async function openLeaderboard() {
  goto('leaderboard');
  const body = $('lbBody');
  body.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try {
    const { leaderboard } = await api.leaderboard();
    if (!leaderboard.length) { body.innerHTML = '<tr><td colspan="6">No players yet.</td></tr>'; return; }
    body.innerHTML = leaderboard.map((r) => {
      const meRow = me && r.username === me.username ? ' class="me"' : '';
      const av = r.avatar
        ? `<span class="lb-av has-img" style="background-image:url('${r.avatar}')"></span>`
        : `<span class="lb-av">${(r.username[0] || '?').toUpperCase()}</span>`;
      return `<tr${meRow}><td>${r.rank}</td>` +
             `<td><div class="lb-user">${av}${r.username}</div></td><td>${r.rating}</td>` +
             `<td>${r.wins}</td><td>${r.losses}</td><td>${r.bestScore}</td></tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6">${e.message}</td></tr>`;
  }
}

// ---- Profile + display picture -------------------------------------------
function openProfile() {
  if (!me) return;
  paintAvatar($('dpImg'), me);
  $('pfName').textContent = me.username + (me.isGuest ? ' (guest)' : '');
  $('pfMeta').textContent = me.isGuest ? 'Guest account' : `Joined player`;
  $('pfRating').textContent = me.rating;
  $('pfGames').textContent = me.gamesPlayed;
  $('pfBest').textContent = me.bestScore;
  $('dpError').textContent = '';
  $('dpRemove').classList.toggle('hidden', !me.avatar);
  goto('profile');
}

// Shrink + center-crop an image file to a small square data URL (keeps payloads tiny).
function fileToAvatar(file, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2, sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

$('avatar').addEventListener('click', openProfile);
$('profileBtn').addEventListener('click', openProfile);
$('profileBack').addEventListener('click', () => goto('menu'));
$('dpUpload').addEventListener('click', () => $('dpFile').click());
$('dpFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  $('dpError').textContent = '';
  try {
    const dataUrl = await fileToAvatar(file);
    me = (await api.updateAvatar(dataUrl)).user;
    auth.save(null, me);
    paintAvatar($('dpImg'), me);
    paintAvatar($('avatar'), me);
    $('dpRemove').classList.remove('hidden');
  } catch (err) {
    $('dpError').textContent = err.message;
  }
});
$('dpRemove').addEventListener('click', async () => {
  try {
    me = (await api.updateAvatar(null)).user;
    auth.save(null, me);
    paintAvatar($('dpImg'), me);
    paintAvatar($('avatar'), me);
    $('dpRemove').classList.add('hidden');
  } catch (err) { $('dpError').textContent = err.message; }
});

// ---- Friends -------------------------------------------------------------
// Builds one person row. `actions` is HTML for the right-hand buttons/labels.
function personRow(u, actions) {
  const img = u.avatar
    ? `style="background-image:url('${u.avatar}')" class="person-av has-img"`
    : `class="person-av"`;
  const initial = u.avatar ? '' : (u.username[0] || '?').toUpperCase();
  return `<div class="person" data-uid="${u.id}">
    <div ${img}>${initial}</div>
    <div class="person-info"><b>${u.username}</b><span>${u.rating} rating${u.isGuest ? ' · guest' : ''}</span></div>
    <div class="person-actions">${actions}</div>
  </div>`;
}

const searchAction = {
  none:      (u) => `<button class="btn small" data-act="add" data-username="${u.username}">Add</button>`,
  requested: ()  => `<span class="muted tag">Requested</span>`,
  incoming:  (u) => `<button class="btn small primary" data-act="add" data-username="${u.username}">Accept</button>`,
  friends:   ()  => `<span class="muted tag">✓ Friends</span>`,
};

async function refreshFriendBadge() {
  if (!me) return;
  try {
    const { requests } = await api.friendRequests();
    const n = requests.length;
    const badge = $('friendsBadge');
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
    return requests;
  } catch { return []; }
}

async function renderRequestsAndFriends() {
  // requests
  const requests = (await refreshFriendBadge()) || [];
  $('reqCount').textContent = requests.length ? `(${requests.length})` : '';
  $('requestList').innerHTML = requests.length
    ? requests.map((r) => personRow(r.user,
        `<button class="btn small primary" data-act="accept" data-id="${r.id}">Accept</button>` +
        `<button class="btn small ghost" data-act="decline" data-id="${r.id}">✕</button>`)).join('')
    : '<p class="muted empty">No pending requests.</p>';

  // friends
  try {
    const { friends } = await api.friends();
    $('friendList').innerHTML = friends.length
      ? friends.map((u) => personRow(u,
          `<button class="btn small primary" data-act="challenge" data-id="${u.id}" data-name="${u.username}">⚔ Challenge</button>` +
          `<button class="btn small ghost" data-act="remove" data-id="${u.id}">Remove</button>`)).join('')
      : '<p class="muted empty">No friends yet — search above to add some.</p>';
    // light up who's online
    const ids = friends.map((f) => f.id);
    if (ids.length) ensureNet().then((ok) => { if (ok) net.send({ type: 'presence', ids }); });
  } catch {}
}

async function openFriends() {
  $('friendSearch').value = '';
  $('searchResults').innerHTML = '';
  goto('friends');
  renderRequestsAndFriends();
}

let searchTimer = null;
async function doSearch(q) {
  if (!q) { $('searchResults').innerHTML = ''; return; }
  try {
    const { results } = await api.searchUsers(q);
    $('searchResults').innerHTML = results.length
      ? results.map((u) => personRow(u, (searchAction[u.status] || searchAction.none)(u))).join('')
      : '<p class="muted empty">No players found.</p>';
  } catch (e) {
    $('searchResults').innerHTML = `<p class="error">${e.message}</p>`;
  }
}

$('friendSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(q), 250);
});

// One delegated handler for all add/accept/decline/remove buttons.
$('friends').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id, username, name } = btn.dataset;
  if (act === 'challenge') { challengeFriend(id, name); return; }
  btn.disabled = true;
  try {
    if (act === 'add')      await api.sendFriendRequest(username);
    else if (act === 'accept')  await api.respondFriendRequest(id, true);
    else if (act === 'decline') await api.respondFriendRequest(id, false);
    else if (act === 'remove')  await api.removeFriend(id);
    // refresh whichever lists are showing
    const q = $('friendSearch').value.trim();
    if (q) doSearch(q);
    renderRequestsAndFriends();
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
});

$('friendsBtn').addEventListener('click', openFriends);
$('friendsBack').addEventListener('click', () => goto('menu'));

// ---- Private rooms -------------------------------------------------------
function renderRoom() {
  const inRoom = !!room;
  $('roomEntry').classList.toggle('hidden', inRoom);
  $('roomLobby').classList.toggle('hidden', !inRoom);
  if (!inRoom) return;
  $('roomCodeLabel').textContent = room.code;
  $('roomMembers').innerHTML = room.members.map((m) =>
    `<span class="room-chip${m.host ? ' host' : ''}">${m.host ? '👑 ' : ''}${escapeHtml(m.name)}</span>`).join('');
  const isHost = room.youId === room.hostId;
  const startBtn = $('roomStart');
  startBtn.classList.toggle('hidden', !isHost);
  const ready = room.members.length === 2;
  startBtn.disabled = !ready;
  startBtn.textContent = ready ? '⚔ Start Match' : 'Waiting for a player…';
}

function addChat(msg) {
  const log = $('chatLog');
  const div = document.createElement('div');
  if (msg.system) {
    div.className = 'chat-system';
    div.textContent = msg.text;
  } else {
    const mine = room && msg.fromId === room.youId;
    div.className = 'chat-msg' + (mine ? ' mine' : '');
    div.innerHTML = `<span class="chat-name">${mine ? 'You' : escapeHtml(msg.fromName)}</span>` +
                    `<span class="chat-text">${escapeHtml(msg.text)}</span>`;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function openRoom() {
  $('roomError').textContent = '';
  ensureNet();
  renderRoom();
  goto('room');
}

function leaveRoomNow() {
  if (net && room) net.send({ type: 'roomLeave' });
  room = null;
}

$('roomBtn').addEventListener('click', openRoom);
$('roomCreate').addEventListener('click', async () => {
  $('roomError').textContent = '';
  if (!(await ensureNet())) return ($('roomError').textContent = 'Could not reach server.');
  net.send({ type: 'roomCreate' });
});
$('roomJoinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('roomCodeInput').value.toUpperCase().trim();
  $('roomError').textContent = '';
  if (!code) return;
  if (!(await ensureNet())) return ($('roomError').textContent = 'Could not reach server.');
  net.send({ type: 'roomJoin', code });
});
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !net) return;
  net.send({ type: 'roomChat', text });
  $('chatInput').value = '';
});
$('roomStart').addEventListener('click', () => { if (net) net.send({ type: 'roomStart' }); });
$('roomCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(room.code); toast('Code copied'); }
  catch { toast(room.code); }
});
$('roomLeave').addEventListener('click', () => { leaveRoomNow(); renderRoom(); });
$('roomBack').addEventListener('click', () => { leaveRoomNow(); goto('menu'); });

// ---- Buttons -------------------------------------------------------------
$('soloBtn').addEventListener('click', startSolo);
$('versusBtn').addEventListener('click', startVersus);
$('leaderboardBtn').addEventListener('click', openLeaderboard);
$('lbBack').addEventListener('click', () => goto('menu'));
$('cancelSearch').addEventListener('click', () => {
  if (net) net.send({ type: 'leave' });   // leave the queue, stay online
  goto('menu');
});
$('againBtn').addEventListener('click', () => {
  if (game) game.destroy();
  refreshFriendBadge();
  if (room) { renderRoom(); goto('room'); } else goto('menu');
});
$('quitBtn').addEventListener('click', () => {
  if (game) { game.stop(); game.destroy(); }
  if (net) net.send({ type: 'leave' });   // leave the match, stay online
  if (room) { renderRoom(); goto('room'); } else goto('menu');
});

// ---- Pause (solo) --------------------------------------------------------
$('pauseBtn').addEventListener('click', () => { if (game) game.togglePause(); });
$('pauseOverlay').addEventListener('click', () => { if (game) game.togglePause(); });

// ---- Touch controls (bound once; they target whatever game is active) ----
function bindTouchControls() {
  document.querySelectorAll('#touchControls .tc-btn').forEach((btn) => {
    const act = btn.dataset.act;
    const start = (e) => { e.preventDefault(); game && game.touchAction(act, 'start'); };
    const end = (e) => { e.preventDefault(); game && game.touchAction(act, 'end'); };
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('touchend', end, { passive: false });
    btn.addEventListener('touchcancel', end);
    // mouse fallback so the buttons also work when testing on desktop
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', end);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}
bindTouchControls();

// ---- Sound ---------------------------------------------------------------
const muteBtn = $('muteBtn');
muteBtn.textContent = audio.muted ? '🔇' : '🔊';
muteBtn.addEventListener('click', () => {
  const muted = audio.toggleMute();
  muteBtn.textContent = muted ? '🔇' : '🔊';
});
// Browsers block audio until the first gesture — unlock on the first interaction.
function unlockAudio() {
  audio.unlock();
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// ---- Boot ----------------------------------------------------------------
async function boot() {
  setAuthMode('login');
  if (auth.token()) {
    try { enterMenu((await api.me()).user); return; }
    catch { auth.clear(); }
  }
  goto('auth');
}
boot();
