// Entry point: loads env, serves the client, mounts the REST API, and starts
// the WebSocket game server.
import process from 'node:process';
// Read .env for local dev (Node 20.6+). On hosts like Render there is no .env file
// (env vars come from the platform), so ignore a missing file.
try { process.loadEnvFile?.(); } catch { /* no .env present — use real env vars */ }

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { authRouter, requireAuth, publicUser } from './src/auth.js';
import { statsRouter } from './src/stats.js';
import { setupGameServer } from './src/matchmaking.js';
import { prisma } from './src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// REST API
app.use('/api/auth', authRouter);
app.use('/api', statsRouter);

// Record a finished solo game (best score / totals only, no rating change).
app.post('/api/solo', requireAuth, async (req, res) => {
  const score = req.body?.score | 0;
  const lines = req.body?.lines | 0;
  const u = req.user;
  const updated = await prisma.user.update({
    where: { id: u.id },
    data: {
      gamesPlayed: { increment: 1 },
      totalLines: { increment: lines },
      totalScore: { increment: score },
      bestScore: Math.max(u.bestScore, score),
    },
  });
  res.json({ user: publicUser(updated) });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });
setupGameServer(wss);

server.listen(PORT, () => {
  console.log(`\n  TETRA running:  http://localhost:${PORT}\n`);
});
