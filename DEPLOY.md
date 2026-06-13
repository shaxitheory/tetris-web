# Deploying TETRA to Render

This app needs an **always-on Node process** (for WebSocket multiplayer) and a
**Postgres database**. Render provides both on its free tier. Local dev still uses
SQLite — nothing about your local setup changes.

## How the DB switch works
- **Locally:** `prisma/schema.prisma` says `provider = "sqlite"` and `DATABASE_URL`
  points at `prisma/dev.db`. Run things exactly as before.
- **On Render:** the build runs `node scripts/set-db.mjs postgres`, which flips the
  provider to `postgresql` before generating the client and creating the tables
  against Render's Postgres. (Render checks out a fresh copy each build, so this
  never affects your local file.)

---

## Option A — One-click Blueprint (easiest)

1. **Push the code to GitHub** (see "Putting it on GitHub" below).
2. Go to **https://dashboard.render.com** → **New +** → **Blueprint**.
3. Connect your GitHub and select this repo. Render reads `render.yaml` and proposes
   a web service **tetra** + a Postgres database **tetra-db**.
4. Click **Apply**. Render will:
   - create the Postgres database,
   - inject `DATABASE_URL` automatically,
   - generate a random `JWT_SECRET`,
   - build (switch to Postgres, generate client, create tables) and start the server.
5. When it goes live you get a URL like **https://tetra.onrender.com** — open it,
   register, and play. Open it in two tabs/devices for multiplayer.

## Option B — Manual setup (if you prefer clicking through)

1. **New +** → **PostgreSQL** → name it `tetra-db`, plan **Free** → **Create**.
   Copy its **Internal Connection String**.
2. **New +** → **Web Service** → connect the repo. Set:
   - **Runtime:** Node
   - **Build Command:**
     `npm install && node scripts/set-db.mjs postgres && npx prisma generate && npx prisma db push`
   - **Start Command:** `npm start`
3. Under **Environment**, add:
   - `DATABASE_URL` = the connection string from step 1
   - `JWT_SECRET` = any long random string
   - `NODE_VERSION` = `22`
4. **Create Web Service**. First deploy takes a few minutes.

---

## Putting it on GitHub

```bash
git add .
git commit -m "Prepare TETRA for deployment"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<your-username>/tetris-web.git
git branch -M main
git push -u origin main
```

(`git init` and the first commit were already made for you.)

---

## Good to know about the free tier
- **Cold starts:** a free web service sleeps after ~15 min idle; the first request
  after that takes ~30s to wake. Fine for a personal/portfolio project.
- **Free Postgres** is capped in size and expires after 90 days — plenty for
  learning; upgrade or recreate it when needed.
- **WebSockets** work on Render's free tier out of the box (no extra config).
- To change `JWT_SECRET` later, edit it in the Render dashboard → the service
  redeploys. Existing login tokens become invalid (everyone just logs in again).

## Other hosts
The same setup works on **Railway** and **Fly.io** — both run persistent Node
processes with WebSockets. You'd just set the same three env vars and the same
build/start commands. Render is recommended here because the Blueprint makes it
one click.
