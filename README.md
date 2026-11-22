# Pilk Bets

Personal Polymarket US dashboard and bot lab. Runs on Cloudflare (Worker + D1), installs to the iPhone home screen.

- **Overview**: all-time profit, a P&L curve you can scrub with your finger, win rate, return on stakes, fees, streaks, and breakdowns by sport, entry price, bet type, and exit.
- **Bets**: every position grouped by day, filterable and searchable. Tap one for the full trade-by-trade breakdown.
- **Activity**: every trade, payout, deposit, and withdrawal.
- **Bot Lab**: API status, sync, and paper trades (the bot logs calls here before any real money moves).

Your trade history lives in D1, never in this repo. The repo is public; `data/`, `.dev.vars` and secrets are gitignored.

## How it fits together

```
iPhone (home-screen app) ──> Cloudflare Worker ──> D1 (activities, snapshots, paper_trades)
                                   │
                                   └── cron every 15 min ──> api.polymarket.us (Ed25519-signed)
```

- `src/index.ts`: routes, password login, sync job, paper-trade API
- `src/polymarket.ts`: request signing (`X-PM-Access-Key`, `X-PM-Timestamp`, `X-PM-Signature`) and activity normalization
- `public/`: the app (no build step). `analytics.js` holds all the math and is unit-tested
- `schema.sql`: D1 tables

## Setup

D1 database `pilk-polymarket` already exists and has the schema applied (id in `wrangler.jsonc`).

```bash
npm install

# Secrets go straight into Cloudflare. Paste each value when prompted.
npx wrangler secret put POLYMARKET_KEY_ID
npx wrangler secret put POLYMARKET_SECRET_KEY
npx wrangler secret put DASH_PASSWORD        # what you type to unlock the app
npx wrangler secret put SESSION_SECRET       # any long random string, e.g. `openssl rand -hex 32`

npx wrangler deploy
```

Open the URL Wrangler prints, unlock with your password, and tap **Sync now** in Bot Lab. The first sync backfills your whole history. After that the cron keeps it current.

**Put it on your home screen:** open the URL in Safari, tap Share, then **Add to Home Screen**. It launches full screen with no browser bars. You stay logged in for a year.

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in
npm run db:init:local
npm run dev
```

`npm test` runs the analytics tests. `npm run typecheck` checks the Worker.

## Paper trades API

A strategy logs a call instead of placing it:

```bash
curl -X POST "$URL/api/paper" -b "pm_session=..." -H 'content-type: application/json' \
  -d '{"strategy":"coinflip-cfb","market_slug":"aec-cfb-...","title":"Texas","side":"yes","price":0.42,"stake":25,"rationale":"..."}'
```

Grading settled paper trades against market results is the next piece to build. Live order placement is intentionally not wired up.
