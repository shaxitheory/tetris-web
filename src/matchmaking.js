// WebSocket matchmaking + in-game relay, now aware of logged-in users so it can
// persist results. The server stays a relay; it does not simulate the game.
import { verifyToken } from './auth.js';
import { prisma } from './db.js';
import { recordMatch } from './stats.js';

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function setupGameServer(wss) {
  let waiting = null;
  let nextSeed = 1;

  function startMatch(a, b) {
    const seed = (nextSeed++ * 2654435761) % 2147483647; // shared piece sequence
    a.opponent = b; b.opponent = a;
    a.alive = b.alive = true;
    send(a, { type: 'matched', seed, opponentName: b.username });
    send(b, { type: 'matched', seed, opponentName: a.username });
  }

  function tryQueue(ws) {
    if (waiting && waiting !== ws && waiting.readyState === ws.OPEN) {
      const opp = waiting; waiting = null;
      startMatch(ws, opp);
    } else {
      waiting = ws;
      send(ws, { type: 'queued' });
    }
  }

  function leaveQueueAndRoom(ws, notify = true) {
    if (waiting === ws) waiting = null;
    const opp = ws.opponent;
    if (opp) {
      if (notify) send(opp, { type: 'oppLeft' });
      opp.opponent = null;
    }
    ws.opponent = null;
  }

  async function finishMatch(loser) {
    const winner = loser.opponent;
    if (!winner) return;
    loser.opponent = null;
    winner.opponent = null;

    let wDelta = 0, lDelta = 0;
    try {
      const r = await recordMatch({
        winner: { userId: winner.userId, score: winner.lastScore | 0, lines: winner.lastLines | 0 },
        loser: { userId: loser.userId, score: loser.lastScore | 0, lines: loser.lastLines | 0 },
      });
      wDelta = r.wDelta; lDelta = r.lDelta;
    } catch (e) {
      console.error('recordMatch failed:', e.message);
    }
    send(winner, { type: 'win', ratingChange: wDelta });
    send(loser, { type: 'lose', ratingChange: lDelta });
  }

  wss.on('connection', (ws) => {
    ws.userId = null;
    ws.username = 'Player';
    ws.opponent = null;
    ws.lastScore = 0;
    ws.lastLines = 0;

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      switch (msg.type) {
        case 'queue': {
          const payload = msg.token && verifyToken(msg.token);
          if (payload) {
            const user = await prisma.user.findUnique({ where: { id: payload.id } });
            if (user) { ws.userId = user.id; ws.username = user.username; }
          }
          if (!ws.userId) ws.username = (msg.name || 'Player').slice(0, 16);
          tryQueue(ws);
          break;
        }

        case 'leave':
          leaveQueueAndRoom(ws);
          break;

        case 'state':
          ws.lastScore = msg.score | 0;
          ws.lastLines = msg.lines | 0;
          send(ws.opponent, { type: 'oppState', board: msg.board });
          break;

        case 'garbage':
          send(ws.opponent, { type: 'garbage', amount: msg.amount });
          break;

        case 'gameover':
          ws.lastScore = msg.score | 0;
          ws.lastLines = msg.lines | 0;
          ws.alive = false;
          if (ws.opponent) await finishMatch(ws);
          break;
      }
    });

    ws.on('close', () => leaveQueueAndRoom(ws));
    ws.on('error', () => leaveQueueAndRoom(ws));
  });
}
