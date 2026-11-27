# Second opinion: how Codex works with this bot

Claude built and runs the Pilk Bets bots. Codex is the second pair of eyes: it reads the code and
the data, looks for bugs and better ideas, and writes them down here. Claude reads this folder at
every 30-minute review, checks each point against the data, and replies. Good advice gets used.
Aaron has the final say on everything.

## What Codex can do
- Read anything in the repo.
- Read the bot's data with SELECT queries only (see "Data" below).
- Write findings to `codex/advice.md`, newest at the top.
- Propose a code change on its own branch (`codex/<topic>`), pushed for Claude to review.

## What Codex must never do
- Push to `main`, deploy, or run `wrangler deploy`.
- Run anything but SELECT against the database (no INSERT, UPDATE, DELETE, DROP, ALTER).
- Touch Cloudflare settings: LIVE_TRADING, LIVE_STRATEGY, LIVE_MAX_BET, BOT_ALLOCATION, secrets.
- Place, cancel or change real Polymarket orders, or touch the Polymarket account.
- Change strategy rules during the 10-day paper test (Nov 25 4 PM ET to Dec 5 4 PM ET). Ideas for
  after the test go in advice.md, tagged "after day 10".

## Data
D1 database `pilk-polymarket` (id 43cb2ffb-75a3-4472-9b28-41b2a9429ea0). From this folder:

    npx wrangler d1 execute pilk-polymarket --remote --command "SELECT ..."

Main tables:
- `bot_positions`: every bet. `mode` = 'paper' or 'live'; `strategy`; `market_slug`; `side`;
  `avg_entry`; `qty`; `cost`; `fees`; `pnl`; `status` ('open', 'closed', 'settled');
  `opened_at`/`closed_at` (epoch ms); `meta` (JSON: fair, edge, spot, strike, tau, equity...).
  Finished bets are `status != 'open'` (closed AND settled both count).
- `live_events`: what the real-money bot did (preview, buy, miss, error, pause, skip).
- `brain`: `k`/`v`/`at`. `lab_btc`, `lab_sports`, `lab_cricket` hold the research board
  (each strategy's n, P&L, t-stat, status: testing / promising / proven / retired).
- `windows`: Bitcoin up/down windows (slug, strike, end_ts). `spot`: Bitcoin prices.

Account sizes: each strategy has a $100 version plus `_1k`, `_lock_1k`, `_5k`, `_10k` copies.
The 10-day test counts bets closed after 1795640400000 (Nov 25 4 PM ET).

Real money right now: `crypto_fav_98` (buys the Bitcoin 5/15/60-minute favorite at 98¢ late in the
window), $100 account, capped at $3 a bet.

## How to write advice
In `codex/advice.md`, one entry per point:

    ## 2026-11-27 09:00 ET - short title
    What: the finding in a sentence or two.
    Evidence: the query you ran and the numbers it returned.
    Suggestion: what to change, or "after day 10".
    Risk: what could go wrong if we do it.

Points without evidence from the data will be read but weighed less.
