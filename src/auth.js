// Authentication: register, login, guest accounts, and JWT helpers.
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const TOKEN_TTL = '30d';

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: TOKEN_TTL });
}

// Verify a token string -> payload, or null if invalid/expired.
export function verifyToken(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

// What we send to the client about a user (never the password hash).
export function publicUser(u) {
  return {
    id: u.id, username: u.username, isGuest: u.isGuest, rating: u.rating,
    gamesPlayed: u.gamesPlayed, wins: u.wins, losses: u.losses,
    totalLines: u.totalLines, bestScore: u.bestScore, avatar: u.avatar || null,
  };
}

// Express middleware: require a valid token, attach req.user.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user) return res.status(401).json({ error: 'User not found' });
  req.user = user;
  next();
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export const authRouter = express.Router();

// --- Register a permanent account -----------------------------------------
authRouter.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username must be 3-16 letters, numbers, or _' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const exists = await prisma.user.findUnique({ where: { username } });
  if (exists) return res.status(409).json({ error: 'Username already taken' });
  if (email) {
    const e = await prisma.user.findUnique({ where: { email } });
    if (e) return res.status(409).json({ error: 'Email already registered' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { username, email: email || null, passwordHash, isGuest: false },
  });
  res.json({ token: makeToken(user), user: publicUser(user) });
});

// --- Log in ----------------------------------------------------------------
authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { username: username || '' } });
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: makeToken(user), user: publicUser(user) });
});

// --- Play as guest (no password; stats still tracked while the account lives)
authRouter.post('/guest', async (req, res) => {
  // generate a unique guest name without Math.random collisions getting in the way
  let username, tries = 0;
  do {
    const n = await prisma.user.count();
    username = `Guest${n + 1 + tries}`;
    tries++;
  } while (await prisma.user.findUnique({ where: { username } }));
  const user = await prisma.user.create({ data: { username, isGuest: true } });
  res.json({ token: makeToken(user), user: publicUser(user) });
});

// --- Who am I (refresh profile) --------------------------------------------
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// --- Set / clear profile picture -------------------------------------------
// The client sends a small (resized) image as a data URL, or null to remove it.
authRouter.put('/avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body || {};
  if (avatar != null) {
    if (typeof avatar !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) {
      return res.status(400).json({ error: 'Invalid image' });
    }
    if (avatar.length > 400000) return res.status(413).json({ error: 'Image too large' });
  }
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatar: avatar || null },
  });
  res.json({ user: publicUser(user) });
});
