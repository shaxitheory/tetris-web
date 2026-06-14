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
  const online = new Map();      // userId -> ws (for presence + routing challenges)
  const challenges = new Map();  // challengeId -> { from, to, timer }
  let challengeSeq = 1;

  const isBusy = (ws) => !!ws.opponent || waiting === ws;
  const registerOnline = (ws) => { if (ws.userId) online.set(ws.userId, ws); };
  const clearOnline = (ws) => { if (ws.userId && online.get(ws.userId) === ws) online.delete(ws.userId); };

  // Drop any pending challenges involving this socket, telling the other party.
  function cleanupChallenges(ws) {
    for (const [id, c] of challenges) {
      if (c.from === ws || c.to === ws) {
        clearTimeout(c.timer);
        challenges.delete(id);
        const other = c.from === ws ? c.to : c.from;
        send(other, { type: 'challengeFailed', error: 'Challenge cancelled' });
      }
    }
  }

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
        // Sent once on connect so we know who is online (to route challenges).
        case 'hello': {
          const payload = msg.token && verifyToken(msg.token);
          if (payload) {
            const user = await prisma.user.findUnique({ where: { id: payload.id } });
            if (user) { ws.userId = user.id; ws.username = user.username; registerOnline(ws); }
          }
          break;
        }

        // Which of these user ids are currently online?
        case 'presence': {
          const ids = Array.isArray(msg.ids) ? msg.ids : [];
          send(ws, { type: 'presence', online: ids.filter((id) => online.has(id)) });
          break;
        }

        // Invite a friend to a private 1v1.
        case 'challenge': {
          if (!ws.userId) { send(ws, { type: 'challengeFailed', error: 'Log in to challenge' }); break; }
          const target = online.get(msg.toUserId);
          if (!target || target === ws) { send(ws, { type: 'challengeFailed', error: 'That player is offline' }); break; }
          if (isBusy(ws)) { send(ws, { type: 'challengeFailed', error: 'Finish your current match first' }); break; }
          if (isBusy(target)) { send(ws, { type: 'challengeFailed', error: 'That player is busy' }); break; }
          // only friends can be challenged
          const friend = await prisma.friendship.findFirst({
            where: { status: 'accepted', OR: [
              { requesterId: ws.userId, addresseeId: msg.toUserId },
              { requesterId: msg.toUserId, addresseeId: ws.userId },
            ] },
          });
          if (!friend) { send(ws, { type: 'challengeFailed', error: 'You can only challenge friends' }); break; }

          const id = String(challengeSeq++);
          const timer = setTimeout(() => {
            if (challenges.delete(id)) send(ws, { type: 'challengeDeclined', name: target.username });
          }, 30000);
          challenges.set(id, { from: ws, to: target, timer });
          send(target, { type: 'challenged', challengeId: id, fromUserId: ws.userId, fromName: ws.username });
          send(ws, { type: 'challengeSent', toName: target.username });
          break;
        }

        // Accept or decline an incoming challenge.
        case 'challengeRespond': {
          const c = challenges.get(String(msg.challengeId));
          if (!c || c.to !== ws) break;
          clearTimeout(c.timer);
          challenges.delete(String(msg.challengeId));
          const { from } = c;
          if (!msg.accept) { send(from, { type: 'challengeDeclined', name: ws.username }); break; }
          if (from.readyState !== from.OPEN) { send(ws, { type: 'challengeFailed', error: 'Challenger left' }); break; }
          if (isBusy(from) || isBusy(ws)) {
            send(ws, { type: 'challengeFailed', error: 'Someone is busy now' });
            send(from, { type: 'challengeFailed', error: 'Challenge could not start' });
            break;
          }
          startMatch(from, ws);
          break;
        }

        case 'queue': {
          const payload = msg.token && verifyToken(msg.token);
          if (payload) {
            const user = await prisma.user.findUnique({ where: { id: payload.id } });
            if (user) { ws.userId = user.id; ws.username = user.username; registerOnline(ws); }
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

    ws.on('close', () => { leaveQueueAndRoom(ws); cleanupChallenges(ws); clearOnline(ws); });
    ws.on('error', () => { leaveQueueAndRoom(ws); cleanupChallenges(ws); clearOnline(ws); });
  });
}
