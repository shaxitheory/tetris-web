// Friends: search players, send/accept/decline requests, list friends.
import express from 'express';
import { prisma } from './db.js';
import { requireAuth } from './auth.js';

export const friendsRouter = express.Router();

// Trimmed-down public view used in lists.
function miniUser(u) {
  return { id: u.id, username: u.username, avatar: u.avatar || null, rating: u.rating, isGuest: u.isGuest };
}

// Postgres supports case-insensitive `contains`; SQLite's LIKE is already
// case-insensitive for ASCII, and including `mode` there throws — so only add it
// when we're actually on Postgres.
const PG = (process.env.DATABASE_URL || '').includes('postgres');
const insensitive = PG ? { mode: 'insensitive' } : {};

// --- Search players by username --------------------------------------------
friendsRouter.get('/users-search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const meId = req.user.id;

  const users = await prisma.user.findMany({
    where: { username: { contains: q, ...insensitive }, NOT: { id: meId } },
    orderBy: { rating: 'desc' },
    take: 20,
  });

  // figure out my relationship to each result in one query
  const links = await prisma.friendship.findMany({
    where: { OR: [{ requesterId: meId }, { addresseeId: meId }] },
  });
  const statusFor = (uid) => {
    const f = links.find(
      (x) => (x.requesterId === meId && x.addresseeId === uid) ||
             (x.addresseeId === meId && x.requesterId === uid)
    );
    if (!f) return 'none';
    if (f.status === 'accepted') return 'friends';
    return f.requesterId === meId ? 'requested' : 'incoming';
  };

  res.json({ results: users.map((u) => ({ ...miniUser(u), status: statusFor(u.id) })) });
});

// --- Incoming pending requests ---------------------------------------------
friendsRouter.get('/friends/requests', requireAuth, async (req, res) => {
  const reqs = await prisma.friendship.findMany({
    where: { addresseeId: req.user.id, status: 'pending' },
    include: { requester: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ requests: reqs.map((r) => ({ id: r.id, user: miniUser(r.requester) })) });
});

// --- My accepted friends ---------------------------------------------------
friendsRouter.get('/friends', requireAuth, async (req, res) => {
  const meId = req.user.id;
  const links = await prisma.friendship.findMany({
    where: { status: 'accepted', OR: [{ requesterId: meId }, { addresseeId: meId }] },
    include: { requester: true, addressee: true },
    orderBy: { createdAt: 'desc' },
  });
  const friends = links.map((f) => (f.requesterId === meId ? f.addressee : f.requester));
  res.json({ friends: friends.map(miniUser) });
});

// --- Send a friend request -------------------------------------------------
friendsRouter.post('/friends/request', requireAuth, async (req, res) => {
  const meId = req.user.id;
  const target = await prisma.user.findUnique({ where: { username: req.body?.username || '' } });
  if (!target) return res.status(404).json({ error: 'No such player' });
  if (target.id === meId) return res.status(400).json({ error: "You can't add yourself" });

  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: meId, addresseeId: target.id },
        { requesterId: target.id, addresseeId: meId },
      ],
    },
  });
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    if (existing.requesterId === meId) return res.status(409).json({ error: 'Request already sent' });
    // they already requested me -> accepting their request
    await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'accepted' } });
    return res.json({ status: 'friends' });
  }

  await prisma.friendship.create({ data: { requesterId: meId, addresseeId: target.id } });
  res.json({ status: 'requested' });
});

// --- Accept / decline a request --------------------------------------------
friendsRouter.post('/friends/respond', requireAuth, async (req, res) => {
  const meId = req.user.id;
  const { id, accept } = req.body || {};
  const fr = await prisma.friendship.findUnique({ where: { id: id || '' } });
  if (!fr || fr.addresseeId !== meId || fr.status !== 'pending') {
    return res.status(404).json({ error: 'No such request' });
  }
  if (accept) {
    await prisma.friendship.update({ where: { id: fr.id }, data: { status: 'accepted' } });
    return res.json({ status: 'friends' });
  }
  await prisma.friendship.delete({ where: { id: fr.id } });
  res.json({ status: 'declined' });
});

// --- Remove a friend (or cancel an outgoing request) -----------------------
friendsRouter.delete('/friends/:userId', requireAuth, async (req, res) => {
  const meId = req.user.id;
  const other = req.params.userId;
  await prisma.friendship.deleteMany({
    where: {
      OR: [
        { requesterId: meId, addresseeId: other },
        { requesterId: other, addresseeId: meId },
      ],
    },
  });
  res.json({ ok: true });
});
