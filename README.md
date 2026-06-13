# TETRA — Multiplayer Tetris

A real-time 1v1 multiplayer Tetris in the browser, inspired by tetr.io/jstris.
Pure JavaScript (no game framework), HTML5 Canvas, and a Node WebSocket server.

## Features

- **Accounts** — register/login (bcrypt + JWT) or play as a guest; stats persist either way.
- **Persistent stats & ELO ranking** — every ranked match updates your rating, W/L,
  best score, and totals, stored in a database (SQLite, via Prisma).
- **Leaderboard & profiles** — global top-25 by rating; per-player match history.
- **Online 1v1 versus** — automatic matchmaking; clearing lines sends garbage to your opponent.
- **Shared piece sequence** — both players get the same 7-bag order (seeded RNG) for fairness.
- **Live opponent board** — watch your rival's stack in real time.
- **Modern mechanics** — SRS rotation + wall kicks, ghost piece, hold, 5-piece next queue,
  hard/soft drop, lock delay with reset limit.
- **Attack system** — T-spins, Tetrises, back-to-back, combos, perfect clears, and
  garbage cancelling (your attacks eat incoming garbage first).
- **Solo practice** mode (best score saved to your profile).

## Run it

```bash
npm install          # also runs `prisma generate` automatically
npm run setup        # creates the SQLite database (prisma/dev.db)
npm start
```

Then open **http://localhost:3000**, register an account (or click *Play as Guest*),
and play. `npm run setup` only needs to be run once.

> **Database:** uses SQLite out of the box — zero config. To move to PostgreSQL later,
> change `provider` to `"postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL`
> in `.env` at your Postgres instance, and re-run `npm run setup`. Inspect the data
> any time with `npm run db:studio`.

To play multiplayer, open the page in **two browser tabs/windows** (or two devices on the
same network — others connect via `http://<your-ip>:3000`), click **Play Online** in both,
and you'll be matched.

## Controls

| Key | Action |
|-----|--------|
| ← / → | Move |
| ↓ | Soft drop |
| Space | Hard drop |
| ↑ or X | Rotate clockwise |
| Z | Rotate counter-clockwise |
| A | Rotate 180° |
| C or Shift | Hold |

## Project layout

```
server.js              Entry: env, static host, REST API mount, WebSocket server
prisma/schema.prisma   Database models: User, Match, MatchPlayer
src/
  db.js                Shared Prisma client
  auth.js              /api/auth routes (register/login/guest/me), JWT, bcrypt
  stats.js             /api/leaderboard, /api/users/:name, recordMatch()
  rating.js            ELO calculation
  matchmaking.js       WebSocket matchmaking + relay; records results on game over
public/
  index.html           Screens: auth, menu, leaderboard, searching, game, result
  css/style.css
  js/
    engine.js          Headless Tetris logic (SRS, 7-bag, scoring, garbage)
    game.js            Canvas rendering, input (DAS/ARR), game loop
    net.js             WebSocket client wrapper
    api.js             REST client + token storage
    main.js            UI flow & wiring
```

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` | Create an account |
| POST | `/api/auth/login` | Log in, get a JWT |
| POST | `/api/auth/guest` | Create a guest account |
| GET | `/api/auth/me` | Current profile (auth) |
| GET | `/api/leaderboard` | Top 25 by rating |
| GET | `/api/users/:username` | Public profile + recent matches |
| POST | `/api/solo` | Record a solo run (auth) |

## How multiplayer works

The server is a thin relay: it pairs the first two players in the queue, hands them a
shared RNG seed, then forwards three things between them — board snapshots (for the live
mini-view), garbage amounts, and game-over. All game simulation runs client-side; the
server holds no authoritative game state. Good enough for friendly play; not cheat-proof.
