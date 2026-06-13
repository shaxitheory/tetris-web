// Leaderboard + profile routes, and the function that records a finished match.
import express from 'express';
import { prisma } from './db.js';
import { publicUser } from './auth.js';
import { eloDelta } from './rating.js';

export const statsRouter = express.Router();

// Top players by rating.
statsRouter.get('/leaderboard', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: [{ rating: 'desc' }, { wins: 'desc' }],
    take: 25,
  });
  res.json({
    leaderboard: users.map((u, i) => ({
      rank: i + 1, username: u.username, rating: u.rating,
      wins: u.wins, losses: u.losses, gamesPlayed: u.gamesPlayed, bestScore: u.bestScore,
    })),
  });
});

// Public profile + recent matches.
statsRouter.get('/users/:username', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { username: req.params.username } });
  if (!user) return res.status(404).json({ error: 'No such player' });
  const recent = await prisma.matchPlayer.findMany({
    where: { userId: user.id },
    orderBy: { id: 'desc' },
    take: 10,
    include: { match: true },
  });
  res.json({
    user: publicUser(user),
    recent: recent.map((m) => ({
      mode: m.match.mode, won: m.won, score: m.score, lines: m.lines,
      ratingChange: m.ratingChange, endedAt: m.match.endedAt,
    })),
  });
});

/**
 * Persist a finished 1v1 match and update both players' lifetime stats + rating.
 * winner/loser are { userId, score, lines }.
 * A null userId (e.g. an unauthenticated client) is skipped gracefully.
 */
export async function recordMatch({ mode = 'versus', winner, loser }) {
  const wUser = winner.userId ? await prisma.user.findUnique({ where: { id: winner.userId } }) : null;
  const lUser = loser.userId ? await prisma.user.findUnique({ where: { id: loser.userId } }) : null;

  // rating change only when both sides are known
  let wDelta = 0, lDelta = 0;
  if (wUser && lUser) {
    wDelta = eloDelta(wUser.rating, lUser.rating, true);
    lDelta = eloDelta(lUser.rating, wUser.rating, false);
  }

  const match = await prisma.match.create({ data: { mode } });

  const ops = [];
  if (wUser) {
    ops.push(prisma.matchPlayer.create({ data: {
      matchId: match.id, userId: wUser.id, score: winner.score | 0,
      lines: winner.lines | 0, won: true, ratingChange: wDelta,
    }}));
    ops.push(prisma.user.update({ where: { id: wUser.id }, data: {
      rating: { increment: wDelta },
      gamesPlayed: { increment: 1 },
      wins: { increment: 1 },
      totalLines: { increment: winner.lines | 0 },
      totalScore: { increment: winner.score | 0 },
      bestScore: Math.max(wUser.bestScore, winner.score | 0),
    }}));
  }
  if (lUser) {
    ops.push(prisma.matchPlayer.create({ data: {
      matchId: match.id, userId: lUser.id, score: loser.score | 0,
      lines: loser.lines | 0, won: false, ratingChange: lDelta,
    }}));
    ops.push(prisma.user.update({ where: { id: lUser.id }, data: {
      rating: { increment: lDelta },
      gamesPlayed: { increment: 1 },
      losses: { increment: 1 },
      totalLines: { increment: loser.lines | 0 },
      totalScore: { increment: loser.score | 0 },
      bestScore: Math.max(lUser.bestScore, loser.score | 0),
    }}));
  }
  await prisma.$transaction(ops);
  return { wDelta, lDelta };
}
