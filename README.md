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

Live order placement is intentionally not wired up.

## The bots

Two bots, one database, separate books: the **Bitcoin bot** (`src/crypto.ts`, strategies `crypto_*`) and the **Sports bot** (`src/live.ts`, strategies `hoops_*`). Each keeps its own paper accounts, learning, risk ladder and readiness card, and the Bot tab shows one at a time with a head-to-head comparing them on the same rules (return on money bet, record). Nothing adds the two together.

- `src/crypto.ts`: the bitcoin feed and traders (Durable Object, always on). Holds Polymarket's market-data stream (signed with the read key) plus Coinbase's bitcoin ticker and Gemini's top of book open (Kraken's socket refuses Cloudflare Workers), re-checks a market within a quarter second of any update, and runs the bitcoin paper strategies with their own accounts. The bot's price is each exchange's mid shifted onto the official CF Benchmarks index by an offset it re-learns at every window start (from Polymarket's published start price), averaged. Every 30 s it checkpoints what its math and the market said; every half hour it grades the finished windows, tunes its volatility scale and learns how much of the math to trust over the market (that trust sizes every bet).
- Data check: no entry unless the price is fresh off a live exchange stream, none when the math is more than 15 points from the market's mid (that's bad data, not an edge), and no re-entry into a window after a losing exit.
- Real money (`LIVE_TRADING=on`): one strategy (`LIVE_STRATEGY`, default `crypto_fair_v1`) also trades the live account through `src/orders.ts`: IOC limit buys at the price it saw, fills and fees from the exchange, a preview check before its first order after each start, never a window where the account already holds something or has orders it didn't place. The Bot tab's "Ready for real money?" card shows five checks on that strategy's paper record (math beats the market, 100+ trades, profitable, two of the last three 30-trade blocks up, never 20% under its high). The switch stays yours.
- `src/live.ts`: the Sports bot: the live game feed and the basketball paper traders (NBA and college), sized by the same risk ladder (one game counts as one bet). Paper only so far; `SPORTS=off` puts it to sleep.
- `src/cryptomath.ts`, `src/fairvalue.ts`, `src/ready.ts`: the pure math (fair value, grading, sizing, the risk ladder, readiness), unit-tested in `test/`.
- `scripts/btc_backtest.py`: grades the bitcoin math on past windows (Polymarket's official starting prices and results plus Coinbase minute prices).

Cloudflare variables (Settings → Variables and Secrets), all optional. `keep_vars` in wrangler.jsonc keeps them across Git deploys:

| Name | Default | What it does |
|---|---|---|
| `BOT_ALLOCATION` | `100` | Each account's starting money, in dollars (each paper strategy, and the live bankroll) |
| `BOT_MAX_BET` | none | Your cap on any single bet. Bets otherwise grow with each account, inside the risk ladder |
| `BTC_STREAM` | on | `off` turns the live streams off; the bot polls every 5 s and makes no new entries |
| `LIVE_TRADING` | off | `on` lets the Bitcoin bot place real orders with the live account. It never deposits |
| `LIVE_STRATEGY` | `crypto_fair_v1` | Which bitcoin strategy trades real money |
| `SPORTS` | on | `off` puts the Sports bot to sleep (game feed, minute recorder, basketball paper traders) |
| `SPORTS_STRATEGY` | `hoops_trailer_v1` | Which sports strategy the Sports bot's readiness card follows |

The risk ladder (`riskLimits()` in `src/fairvalue.ts`). Kelly picks each bet from the edge and the learned trust, then these limits apply, sliding smoothly between rungs:

| Account high | One bet | All open bets | Gives back from its high | Day stop |
|---|---|---|---|---|
| $100 | 10% | 30% | 50% | 25% |
| $1,000 | 8% | 25% | 40% | 20% |
| $10,000 | 4% | 15% | 30% | 15% |
| $100,000 | 1.5% | 8% | 20% | 10% |

Below its high, every bet shrinks in step toward the floor (half way down, half size), so a bad run can't dig a deep hole, and at the high nothing holds it back. Also capped at a quarter of what's offered at the best price.
