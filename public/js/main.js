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
  searching: $('searching'), game: $('game'), result: $('result'),
};
function goto(name) {
  for (const s of Object.values(screens)) hide(s);
  show(screens[name]);
}

let game = null;
let net = null;
let mode = 'solo';
let me = null;          // current logged-in user object

// ---- Profile / menu ------------------------------------------------------
function renderProfile() {
  if (!me) return;
  $('profileName').textContent = me.username + (me.isGuest ? ' (guest)' : '');
  $('profileMeta').textContent = `${me.rating} · ${me.wins}W / ${me.losses}L · best ${me.bestScore}`;
  $('avatar').textContent = me.username[0]?.toUpperCase() || '?';
}

async function refreshProfile() {
  try { me = (await api.me()).user; auth.save(null, me); renderProfile(); } catch {}
}

function enterMenu(user) {
  me = user;
  auth.save(null, user);
  renderProfile();
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
    net: withNet ? net : null, onStats: statsSink, onEnd,
  });
}

function teardownNet() {
  if (net && net.ws) { try { net.ws.close(); } catch {} }
  net = null;
}

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
  goto('result');
}

// ---- Solo ----------------------------------------------------------------
function startSolo() {
  mode = 'solo';
  teardownNet();
  hide($('oppPanel'));
  $('vsName').textContent = 'Practice';
  goto('game');
  game = buildGame(false, async () => {
    try { me = (await api.postSolo(game.engine.score, game.engine.lines)).user; auth.save(null, me); renderProfile(); } catch {}
    endMatch(false, 'Solo run complete.');
  });
  game.start((Math.random() * 2 ** 31) >>> 0);
}

// ---- Versus --------------------------------------------------------------
async function startVersus() {
  mode = 'versus';
  goto('searching');
  $('searchText').textContent = 'Connecting…';

  net = new Net();
  try { await net.connect(); }
  catch { $('searchText').textContent = 'Could not reach server. Is it running?'; return; }

  net.on('queued', () => { $('searchText').textContent = 'Waiting for an opponent…'; });
  net.on('matched', (msg) => {
    show($('oppPanel'));
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
  net.on('close', () => {
    if (mode === 'versus' && !screens.searching.classList.contains('hidden')) {
      $('searchText').textContent = 'Disconnected from server.';
    }
  });

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
      return `<tr${meRow}><td>${r.rank}</td><td>${r.username}</td><td>${r.rating}</td>` +
             `<td>${r.wins}</td><td>${r.losses}</td><td>${r.bestScore}</td></tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6">${e.message}</td></tr>`;
  }
}

// ---- Buttons -------------------------------------------------------------
$('soloBtn').addEventListener('click', startSolo);
$('versusBtn').addEventListener('click', startVersus);
$('leaderboardBtn').addEventListener('click', openLeaderboard);
$('lbBack').addEventListener('click', () => goto('menu'));
$('cancelSearch').addEventListener('click', () => {
  if (net) net.send({ type: 'leave' });
  teardownNet();
  goto('menu');
});
$('againBtn').addEventListener('click', () => {
  if (game) game.destroy();
  teardownNet();
  goto('menu');
});
$('quitBtn').addEventListener('click', () => {
  if (game) { game.stop(); game.destroy(); }
  if (net) net.send({ type: 'leave' });
  teardownNet();
  goto('menu');
});

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
