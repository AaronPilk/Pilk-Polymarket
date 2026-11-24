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

- `src/crypto.ts`: the bitcoin feed and traders (Durable Object, always on). Holds Polymarket's market-data stream (signed with the read key) plus Coinbase's bitcoin ticker and Gemini's top of book open (Kraken's socket refuses Cloudflare Workers), re-checks a market within a quarter second of any update, and runs the bitcoin paper strategies with their own accounts. The bot's price is each exchange's mid shifted onto the official CF Benchmarks index by an offset it re-learns at every window start (from Polymarket's published start price), averaged. Every 30 s it checkpoints what its math and the market said; every half hour it grades the finished windows at fixed moments (5m: 4, 2.5 and 1 minute left; 15m and 1h: early, middle and late), with hours as the unit for every "is it real?" test since windows in the same hour move together. From that it fits how to weigh the math against the market on the log-odds scale (the blend sizes every bet; adopted at 100 windows, pulled toward "the market is right" until the evidence says otherwise) and steps its volatility scale one notch at a time, only on strong evidence (100+ windows, t ≥ 2). Volatility blends the last 15 minutes, hour and two hours, shifted by an hour-of-day profile it learns from its own prices. New entries need fresh stream prices from bitcoin and Polymarket both, and pause while Coinbase and Gemini disagree by more than 2.5 bp, for 20 s after a 4-sigma jump, and in any window that runs into a jobs, CPI or Fed release (`EVENTS` in `src/cryptomath.ts`, refresh each quarter). The Bot tab also scores every early sell against how its window settled. Sizing takes the bigger of Kelly on the blended chance and Kelly on the strategy's own record (return per dollar minus one standard error, hours as the unit, from 50+ trades over 10+ hours; `recordKelly` in `src/fairvalue.ts`), always inside the ladder; when the math flags a trade that neither backs, a paper strategy still buys one contract (a probe, never with real money) so it keeps learning. `crypto_fair_maker` tests resting exits (a sell kept at fair + 3¢, no fee) against `crypto_fair_v1`'s sells at the bid. `src/replica.ts` rebuilds the settlement index from Coinbase, Gemini and Bitstamp order books (average price of the first bitcoin on each side) in shadow mode and scores it, next to the bot's own price, against every official start price (brain `btc_replica`).
- Late favorites: buy the favorite near the end and hold it to the result, betting the market's own lean rather than the math (they skip the math and blend checks and size only on their own record, one contract until it earns more). `crypto_fav_late` (95–98¢, 90–120 s left) and `crypto_fav_last` (95–98¢, 30–90 s left) were retired the night they launched: `scripts/fav_replay.py` replayed them on 30 days of Polymarket's own prices (12,090 windows; the public price-history endpoint, where each point shows the book at the end of its minute) and found break-even at 2 minutes and −1.2¢ a contract at 1 minute. `crypto_fav_98` tests the one cut that held up: the 98–99¢ side with about 3 minutes left (99.5% of 1,893, +0.6¢ a contract after fees).
- Price vs math replay (`scripts/pvm_replay.py`, Nov 23): `crypto_hold_v1`'s entry (4+ minutes left, the 50/50 blend check) rebuilt on Coinbase one-minute prices lined up onto the index and Polymarket's own quotes for 12,089 windows over 30 days: 2,456 bets, −2.6¢ a contract after fees (t −2.9). On the side it picked the math said 46%, the market 36%, and it won 36%. Buying the cheaper side early with no math (8,749 bets) loses about the fee. One price a minute, so the replay can't copy the live bot's timing, but it picked the same side as the live bot in most shared windows. On that evidence `crypto_fair_v1`, `crypto_hold_v1` and `crypto_cheap_v1` (5–20¢ with a 2× sell: −5.8¢ a contract over 1,192 bets) were retired; `crypto_fair_strict` (10¢+ edges: +2.0¢ over 342, t 0.9) keeps testing.
- Strategy and maker replay (`scripts/strategy_replay.py`, Nov 23 evening): the same data with each strategy's exits (2× resting sells, sells over the blend + fee, resting exits), and resting maker buys. 12,157 windows over 30 days. With its exits, price vs math still lost (2,488 bets, −2.8¢ a contract, t −3.3, both halves of the month), resting exits too (−2.8¢), the cheap side −5.3¢ (t −9.9): the early sells trim losses on bets that lose overall, so those retirements stand. Strict: 352 bets, +1.9¢ (t 0.95; first half +5.3¢, second −4.5¢), keeps testing. The lag rule reacts to 30-second moves and the history has one point a minute, so it can't be replayed; a one-minute proxy was flat (235 bets, +0.6¢) and the live test continues. Maker buys at the bid lose 10¢ a fill when a fill needs the price to trade down to the order (3,314 fills, t −13.7); filled instantly, with no adverse selection, they make +0.6¢ at best. A paper test fills by the same rule, so it couldn't say more; no maker strategy was added. The replay drops history points with a crossed book (Up ask + Down ask under $1, impossible on the exchange: 0.1–0.7% of Bitcoin points, 2–9% of XRP's), and also replays `crypto_fav_98` (Bitcoin: 1,868 bets, +0.5¢ a contract, t 3.3, both halves up).
- XRP (`strategy_replay.py 30 --asset xrp`, Nov 23): Polymarket US lists XRP Up/Down 5m / 15m / 1h windows (`cpcxrp-xrp-updown-*`, settled on CF Benchmarks' XRPUSD_RTI). Their books are thinner than Bitcoin's (median spread 4¢ on 5m, 7¢ on 1h, against 1¢), and none of the bot's rules makes money on them. On 5m: strict −4.8¢ a contract (110 bets), price vs math −0.6¢ (769), the cheap side −4.5¢ (t −4.0), the 98–99¢ favorite −2.3¢ (635 bets, t −3.2), resting buys −13¢ a fill. A first run showed a big edge on XRP 1h that came entirely from crossed quotes in the history; with those points dropped it's gone. No XRP bot was started.
- Sell half at a double (`scripts/scale_out_replay.py`, Nov 23 night): buy a side at 15–25¢ with 40%+ of the window left, then hold, sell all at 2×, or sell half at 2× and hold the rest. 30 days of bitcoin (7,133 entries) and gold (`cpausp-gold-updown-*`, Chainlink XAU/USD, 15m / 1h / daily, no 5m; 1,647 entries). When a cheap side doubled its price was fair (bitcoin 59.9¢ → won 60.4%, gold 53.1¢ → 54.6%), so selling half is the average of holding and selling minus one sell fee (bitcoin: hold −2.2¢ a contract, sell half −2.6¢; gold −3.7¢ vs −4.3¢), with fewer losing trades (about 80% → 73%). Risk control, not an edge, and the cheap entry loses on its own.
- Chart rules (`scripts/chart_replay.py`, Nov 23 night): at each window start, breakouts of the 30m / 1h / 4h range, fading them, trend vs the average, RSI over/undersold and streaks, read off the official start prices and bought at the ask 1–3 minutes in. Following breakouts loses on both assets in every time frame (bitcoin 30m break −5.3¢ a contract over 5,666 bets, t −7.3: worse than a random side, the market prices continuation and short-term breaks snap back). Fading wins more often than its price but only by about the fee (bitcoin 4h fade +1.4¢, t 1.0). No simple chart rule beats the price after fees.
- Per-second record (`src/seconds.ts`, table `btc_sec`, Nov 23 evening): the bot reacts to every price as it arrives but saved only 30-second marks; now it also keeps one row a second with its index estimate, Coinbase's and Gemini's raw mids, and each open 5m / 15m / 1h window's Up bid, ask, shares at each and the math's fair value (about 15 MB a day, kept 60 days). It's for replaying rules that act within seconds (beat the lag, the 0.6 s hold, resting-order fills), since Polymarket's public history has one point a minute and no trades. Recording only: no trading decision reads it, and it's written in its own batch so a failed write can't touch the bot's other writes.
- Price streams stay open (Nov 23 evening): every stream used to drop and reconnect every ~10 s, because the 8-second timeout meant for the connect step stayed attached to the open socket. The timeout now covers only the connect, so Polymarket, Gemini and the three order books hold one connection. Coinbase's ticker, held open from a Worker, sends one message and then goes quiet (it streams fine from elsewhere), so the bot's Coinbase price now comes from the Coinbase order book it already keeps for the index copy: best bid and best ask, read at most 4 times a second, the same mid the ticker gave. The ticker is only the fallback, for when the books are off or down. Before this, Coinbase reached the bot about 1 second in 7 and the bot priced off Gemini alone most of the time, which also left the Coinbase-vs-Gemini disagreement check with nothing to compare.
- Bot tab: a plain-words card at the top ("Where things stand") lists what's proven, promising, testing and retired for the selected bot, and how to read Run vs All and the sell-early card.
- Quick score (`QUICK_SQL`, `quickScore` in `src/research.ts`): how far the side's price moved, mid to mid, in the minute after each bet, from the bot's 30-second marks, averaged per strategy with hours as the unit. Shown on the research board next to each verdict as an early read; the verdicts still go by money.
- Research board (`src/research.ts`, brain `lab_btc` / `lab_sports`, every 5 minutes): every strategy is judged on its bets under the current rules (positions carrying `meta.rules >= RULES`), as a return per dollar with hours (bitcoin) or games (sports) as the unit. Retired: losing beyond luck (mean + 1.64 standard errors below zero after 30 bets), nothing to show after 90 bets (t under 0.5) once it has at least 10 of its rarer result (a 98¢ favorite loses about twice in 100 bets, so 90 bets held 3 losses and one more or fewer decided the call; crypto_fav_98 was retired that way on Nov 23 and put back on test the same night), or contradicted by the evidence (`crypto_fade_v1`, `crypto_late_v1`); it stops betting. Testing: one contract a bet until it can be judged, and while the answer is unclear. Promising (ahead even in its worst case, mean − 1.64 standard errors above zero, the mirror of the retire rule; a one-standard-error bar re-checked every 5 minutes is one a no-edge strategy clears by luck too often): normal size. Proven (t ≥ 2 over 200 bitcoin or 100 sports bets): normal size and record sizing. Moving up, proof, the ranking and record sizing all use the record with one more full loss counted (`withOneLoss` in `src/ready.ts`), so a strategy that rarely loses, like a 97¢ favorite that wins 3¢ again and again, can't size up on a streak; retiring uses the real record. Bets are judged with fees priced at full size (`AT_SIZE_SQL`): Polymarket rounds each fill's fee to the cent, which swings a one-contract fee by up to 30% (and to zero under about 5¢), so the exact formula fee replaces the charged one for the verdict and the record Kelly; the P&L itself keeps the real fees. The Bot tab shows the board and the top three, and its headline defaults to this run (bets on the current rules), with the all-time total beside it.
- Fee check: an entry must beat the price after the taker fee on the blend (math and market as learned), not on the raw math, and early sells must beat holding after their fee. Bitcoin learns the blend separately for bets with 4+ minutes left and the last 4 minutes (`bandOf` in `src/cryptomath.ts`), each adopted at 100 windows of its own. A strategy still testing (1-contract paper bets) keeps the 50/50 start with 4+ minutes left (`judgingBlend`), for its entries and its early sells, so the early fit can't end a test before the research board reaches a verdict (Nov 23: that fit swung from 0.92 to 0.78 to 0.90 market weight in four hours, then shut off every early bet of the board's leaders when it was adopted). Promoted strategies, sizing and real money use the fitted blend; each test bet records which one it cleared (`meta.gate`: `fit` or `start`). The grading files each checkpoint by the moment it stands for (`target` in `selectCheckpoints`), so a 5m window's 4-minute check marked at 3:58 counts in the early band.
- Data check: no entry unless the price is fresh off a live exchange stream, none when the math is more than 15 points from the market's mid (that's bad data, not an edge), and no re-entry into a window after a losing exit.
- Real money (`LIVE_TRADING=on`): one strategy (`LIVE_STRATEGY`, default `crypto_fair_v1`) also trades the live account through `src/orders.ts`: IOC limit buys at the price it saw, fills and fees from the exchange, a preview check before its first order after each start, never a window where the account already holds something or has orders it didn't place. The Bot tab's "Ready for real money?" card shows five checks on that strategy's paper record, each asking whether the result could be luck: the math beats the market over 300+ graded windows with t ≥ 2; 200+ trades; profitable with t ≥ 2 on the return per dollar bet, hours as the unit; the newest of the last three 50-trade blocks up and two of three; never 20% under its high. (Sports: 40+ games, 100+ trades, profit t ≥ 2 per game, blocks of 30.) The Sports bot's math gets the same scorecard: a checkpoint per game at 75%, 50%, 25% and 10% of regulation left (`hoops_marks`), graded on finished games every half hour (`src/sportsgrade.ts`, brain `hoops_model`). The switch stays yours.
- `src/live.ts`: the Sports bot: the live game feed and the basketball paper traders (NBA and college), sized by the same risk ladder (one game counts as one bet). Paper only so far; `SPORTS=off` puts it to sleep.
- `src/cryptomath.ts`, `src/fairvalue.ts`, `src/ready.ts`, `src/sportsgrade.ts`, `src/replica.ts`: the pure math (fair value, grading, sizing, the risk ladder, readiness, sports grading, the index copy), unit-tested in `test/`.
- `scripts/btc_backtest.py`: grades the bitcoin math on past windows (Polymarket's official starting prices and results plus Coinbase minute prices).

Cloudflare variables (Settings → Variables and Secrets), all optional. `keep_vars` in wrangler.jsonc keeps them across Git deploys:

| Name | Default | What it does |
|---|---|---|
| `BOT_ALLOCATION` | `100` | Each account's starting money, in dollars (each paper strategy, and the live bankroll) |
| `BOT_MAX_BET` | none | Your cap on any single bet. Bets otherwise grow with each account, inside the risk ladder |
| `BTC_STREAM` | on | `off` turns the live streams off; the bot polls every 5 s and makes no new entries |
| `BTC_REPLICA` | on | `off` closes the three order books behind the index copy (shadow mode, never trades) |
| `LIVE_TRADING` | off | `on` lets the Bitcoin bot place real orders with the live account. It never deposits |
| `LIVE_STRATEGY` | `crypto_fair_v1` | Which bitcoin strategy trades real money |
| `SPORTS` | on | `off` puts the Sports bot to sleep (game feed, minute recorder, basketball paper traders) |
| `SPORTS_STRATEGY` | `hoops_trailer_v1` | Which sports strategy the Sports bot's readiness card follows |

The risk ladder (`riskLimits()` in `src/fairvalue.ts`). Kelly picks each bet from the edge over the blended probability (math and market, weighted by the grading), then these limits apply, sliding smoothly between rungs:

| Account high | One bet | All open bets | Gives back from its high | Day stop |
|---|---|---|---|---|
| $100 | 10% | 30% | 50% | 25% |
| $1,000 | 8% | 25% | 40% | 20% |
| $10,000 | 4% | 15% | 30% | 15% |
| $100,000 | 1.5% | 8% | 20% | 10% |

Below its high, every bet shrinks in step toward the floor (half way down, half size), so a bad run can't dig a deep hole, and at the high nothing holds it back. Also capped at a quarter of what's offered at the best price.
