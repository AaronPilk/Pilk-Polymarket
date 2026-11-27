// Crypto feed and the bitcoin paper traders: a Durable Object that runs around the clock for
// Polymarket US bitcoin "Up or Down" windows (5-minute, 15-minute, 1-hour) and the hourly, daily
// and weekly "BTC above $X" price ladders. It never places a real order.
//
//   Live data   Three streams stay open: Polymarket's market-data stream (best bid and ask about
//               ten times a second, signed with the dashboard's read key), Coinbase's public
//               bitcoin ticker and Gemini's top of book (pushed on every best bid/offer
//               change; Kraken refuses Cloudflare Workers with HTTP 526). Every update
//               re-checks that market within a quarter second, so a take-profit or a sell above
//               fair happens on the move, not on the next poll.
//   Price       The windows settle on the CF Benchmarks index, a blend of exchanges, not on any
//               one of them. Each exchange's mid is shifted by an offset the bot learns at every
//               window start: Polymarket publishes the official start price a few seconds in, and
//               the gap between it and that exchange's own average over the same minute is the
//               offset (smoothed). The bot's price is the average of the fresh, shifted mids.
//               Nov 22: Coinbase alone read $2-6 above the index and flipped a window decided
//               by $1.74.
//               BTC_STREAM=off (a Cloudflare variable) turns the streams off; if one drops, the
//               5-second loop polls instead until it reconnects.
//   Honest fills Buys at the ask, sells at the bid, full taker fee. On stream data a buy or a
//               market sell only fills if the price is still there 0.6 s after the bot first saw
//               it, about how long a real order takes to land; a resting 2x sell fills only once
//               the bid reaches it.
//   Every 5 s   Stream health, a spot reading (polled if the ticker is quiet), tick rows for the
//               record, signals, checkpoints, and the polling fallback.
//   Strike      A window settles Up if the CF Benchmarks index (60 one-second readings in its
//               final minute) ends at or above the same average in the minute before it opened.
//               Polymarket publishes that starting price (priceToBeat) a few seconds in; until
//               then we use our own one-second average of the bot's price.
//   Fair value  fairUp(): where bitcoin sits vs. the strike, realized volatility times a scale
//               the bot tunes itself, time left, and the averaging at the end.
//   Learning    Every 30 s each open window gets a checkpoint (what the math and the market said).
//               After settlement the checkpoints are graded: is the math sharper than the market,
//               which volatility scale would have scored best, and how much of the math to trust
//               over the market's own price (the blend that scores best). Every half hour, once
//               40+ windows are graded, the bot adopts the best scale and that trust; the trust
//               sizes every bet, so bets grow only as fast as the math proves itself.
//   Data check  No entry unless the bot's price is fresh off a live exchange stream, and none when
//               the math is more than 15 points from the market's mid: a gap that big is our data
//               being off, not the market (Nov 22: 1 win in 9 such bets). After a losing exit a
//               strategy stays out of that window.
//   Sizing      stakeFor(): Kelly on each account's current value ($100 start plus everything won
//               or lost) times the learned trust, so bets grow as the account grows, inside the
//               risk ladder (fairvalue.ts): per-bet and all-open caps and a floor under the peak
//               that tighten as the account gets bigger (10% a bet at $100, 1.5% at $100K), bets
//               shrinking in step as the account falls toward the floor. Also capped at a quarter
//               of what's offered at the best price and Aaron's BOT_MAX_BET when he sets one, with
//               a day stop from the same ladder.
//   Settlement  After a window ends, the result is read back from the gateway.
//   Real money  With LIVE_TRADING=on, one strategy (LIVE_STRATEGY, default crypto_fair_v1) also
//               trades the live account: the same decision, then a real IOC limit order at the price
//               it saw (never worse), its actual fills and fees recorded, a resting 2x take-profit
//               where that strategy uses one, and IOC sells at the bid. Before its first real order
//               after each start the bot sends that order to Polymarket's preview endpoint and only
//               goes on if it checks out. It never trades a window where the account holds a
//               position or orders it didn't place (Aaron's own trades), stops for the day after
//               losing a third of the day's starting account, and pauses 15 minutes after three
//               order errors in a row. Every action lands in live_events for the app.

import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_BLEND, SCORE_POINTS, bandOf, blendProb, eventFor, fairUp, gradeModel, judgingBlend, learnOffset, parseWindow, windowEnd, windowSlug, type Band, type Blend, type Mark } from './cryptomath';
import { RULES, statusOf, parentOf, type Status, AT_SIZE_SQL } from './research';
import { dailyStopHit, drawdownScale, recordKelly, riskLimits, stakeFor, testStake } from './fairvalue';
import { BOOK_FRESH, Book, applyBitstamp, applyCoinbase, applyGemini, replicaPrice } from './replica';
import { bankroll, closePosition, liveSell, loadOpenBySlug, markLiveOrder, openLivePosition, openPosition, recordLiveTakeProfit, settlePosition, takeProfitFor, type Bankroll, type Position } from './paper';
import { signedHeaders, type PmEnv } from './polymarket';
import { accountPosition, cancelOrder, getOrder, openOrders, placeOrder, previewOrder, type OrderSpec } from './orders';
import { SEC_BUFFER, SEC_DDL, SEC_KEEP_DAYS, SEC_SERIES, secInserts, type SecRow } from './seconds';

const GATEWAY = 'https://gateway.polymarket.us';
const PM_API = 'https://api.polymarket.us';
const PM_WS_PATH = '/v1/ws/markets';
const CB_WS = 'https://ws-feed.exchange.coinbase.com';
// Gemini's public market data, top of book only: a best bid or ask change per message. Gemini is
// one of the exchanges in the CF Benchmarks index. (Kraken's socket answers Workers with 526.)
const GM_WS = 'https://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=false&auctions=false&heartbeat=true';
const SPOT_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
const UA = { 'User-Agent': 'pilk-bets/1.0' };
// Full order books for the index copy (replica.ts), shadow mode. BTC_REPLICA=off turns them off.
const BOOK_FEEDS = {
  cb: { name: 'Coinbase', url: CB_WS, sub: { type: 'subscribe', product_ids: ['BTC-USD'], channels: ['level2_batch'] }, apply: applyCoinbase },
  gm: { name: 'Gemini', url: 'https://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=false&trades=false&auctions=false&heartbeat=true', sub: null, apply: applyGemini },
  bs: { name: 'Bitstamp', url: 'https://ws.bitstamp.net', sub: { event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } }, apply: applyBitstamp },
} as const;
type BookFeed = keyof typeof BOOK_FEEDS;
const BOOK_IDS = Object.keys(BOOK_FEEDS) as BookFeed[];
const TICK = 5_000;
const MIN = 60_000;
const ASSET = 'btc';
const SERIES = [
  { key: '5m', mins: 5, lookback: 60_000 },
  { key: '15m', mins: 15, lookback: 2 * MIN },
  { key: '1h', mins: 60, lookback: 2 * MIN },
];
const SIGNAL_COOLDOWN = 2 * MIN;
const FLUSH_EVERY = MIN;
const QUOTE_LIVE = 2_500;       // a stream quote this fresh counts as live
const SPOT_LIVE = 3_000;        // ...and a ticker price this fresh
const SPOT_OK = 8_000;          // older than this, no fair value at all
const STREAM_STALE = 20_000;    // a stream silent this long gets reconnected
const CB_BOOK_EVERY = 250;      // Coinbase's price is read off its order book at most this often (ms)
const EVAL_EVERY = 250;         // each market re-checked at most 4 times a second
const HOLD_FOR = 600;           // stream trades: the price has to still be there after this long
const REENTER_AFTER = 15_000;   // after a sell, wait this long before re-entering that window
const MARK_EVERY = 30_000;
const TUNE_EVERY = 30 * MIN;
const MAX_EDGE = 0.3;           // an "edge" bigger than this is bad data, not a gift
const MAX_GAP = 0.15;           // math this far over the market's mid: our data is off (1 win in 9, Nov 22)
// A bet has to clear the fee on the bot's best estimate, not on the raw math: the blend of math and
// market the grading has learned (50/50 until it is fitted at 100 windows) must beat the price by this
// much after the taker fee. Nov 22: entries flagged by the raw math alone paid ~6% of every dollar in
// fees (11% on cheap round trips) while the market's price was the sharper of the two.
const BLEND_EDGE = 0.01;
const BASIS_ALPHA = 0.3;        // how fast each exchange's learned offset follows new official prices
const BASIS_MAX = 50;           // a gap bigger than $50 is a broken feed, not an offset
const FEED_GAP_BP = 2.5e-4;    // Coinbase and Gemini (both lined up with the index) more than 2.5 bp apart (~$15 at
const FEED_GAP_MIN = 10;       // $60K, never under $10): the data is unsure, so no new entries until they agree
const JUMP_Z = 4;               // a move this many standard deviations in ~10 s is a jump: entries pause...
const JUMP_PAUSE = 20_000;      // ...for this long, while the market catches up and the quotes settle
const TOD_EVERY = 3_600_000;    // recompute (and save) the hour-of-day volatility profile this often
const FEEDS = ['cb', 'gm'] as const;
type Feed = typeof FEEDS[number];
const COEF = 0.095;             // taker fee coefficient (app rate; the API program is cheaper)
const MAX_LIVE_WINDOWS = 3;     // per strategy: one each of 5m, 15m and 1h at most
const LADDER = 'crypto_ladder_v1';
const LADDER_EVERY = 60_000;
const LADDER_MAX_OPEN = 3;
const feePer = (p: number) => COEF * p * (1 - p);
const LIVE_COEF = 0.0695;       // API taker coefficient through Dec 31 2026 (70% of it rebated weekly)
const feeLive = (p: number) => LIVE_COEF * p * (1 - p);

// The bitcoin lineup. Each strategy trades its own paper account of BOT_ALLOCATION dollars, so the
// results compare cleanly; the winners are the ones that would get real money.
//   crypto_fair_v1      buy a side 5c+ under the math (after fees); sell if it gets 3c over fair
//   crypto_fair_strict  same, 10c+ edge
//   crypto_fair_max     the fair_v1 picks at twice the Kelly fraction, to see what bigger bets do
//                       to the swings (trust is the learned one, like everyone else's)
//   crypto_hold_v1      the fair_v1 picks held to the result, never sold early: tests whether the
//                       early sells help
//   crypto_double_v1    his move: a side at 10-45c the math calls fair or cheap, with a sell order
//                       at 2x from the fill; if it never doubles, hold to the result
//   crypto_cheap_v1     a cheap side under 20c the math doesn't call overpriced, sell at 2x
//   crypto_late_v1      only the final two minutes, when part of the settlement average is
//                       already in and the math knows more than early on
//   crypto_lag_v1       the math jumped 6+ points in 30 s (bitcoin moved) and the market hasn't
//                       caught up: buy the move before it reprices
//   crypto_fade_v1      the market jumped 8c+ in 15 s while the math barely moved: buy the side
//                       that got cheap
//   crypto_ladder_v1    the price ladders (see ladderScan)
//   crypto_fav_late     the late favorite (Aaron's read, Nov 22): with 90-120 s left, buy the side at
//                       95-98c and hold it to the result. Late in a window the favorite wins more often
//                       than its price says (95c+ favorites won 35 of 35 at ~90 s left; the 3c side never
//                       did), so it bets the market's own lean, not the math
//   crypto_fav_last     the same with 30-90 s left, to see which timing holds up
//                       Both retired the same night: a replay on 30 days of Polymarket's own prices
//                       (scripts/fav_replay.py, 12,090 windows) found no edge at 2 minutes and a loss at 1
//   crypto_fav_98       the one cut that held up in that replay: the side at 98-99c with about 3
//                       minutes left won 99.5% of 1,893 times at 98.8c (+0.6c a contract after fees, t 3.4),
//                       and the bot's own quotes show a real seller there. Wins a cent, loses 99c, so the
//                       board's one-more-loss rule keeps it at test size for a long time. Retired on
//                       3 losses in 90 bets on Nov 23 and put back on test that night: the board now waits
//                       for 10 losses before it calls a bet that rarely loses (research.ts RARE)
interface CryptoStrategy {
  id: string;
  minEdge: number;            // fair − ask − fee, per contract
  priceMin: number; priceMax: number;
  tpBelow: number;            // resting 2x sell for entries under this price (0 = none)
  exitAbove: number | null;   // sell once the bid is this far over fair (after fees); null = hold
  tauMin: number;             // entries need at least this many seconds left
  tauMax?: number;            // ...and at most this many (default: 30 s after the open)
  live?: boolean;             // only on live stream data
  trigger?: 'lag' | 'fade';
  kelly?: { fraction: number };
  makerExit?: boolean;        // exit with a resting sell at fair + exitAbove (no fee) instead of selling at the bid
  fav?: boolean;              // the late favorite: no math or blend check, and it sizes only on its own record
  series?: string[];          // only these window lengths (default: all)
  calm?: number;              // only while the window's mid has moved this much or less over the last 30 s
  bank?: number;              // paper only: this account starts with this much instead of BOT_ALLOCATION
  stopAt?: number;            // sell at the bid as soon as it falls to this price or under (a stop-loss)
  lock?: number;              // paper only: share of every new high set aside for good (profit lock)
}
const CRYPTO_STRATEGIES: CryptoStrategy[] = [
  { id: 'crypto_fair_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75 },
  { id: 'crypto_fair_strict', minEdge: 0.1, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75 },
  { id: 'crypto_fair_max', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75, kelly: { fraction: 0.5 } },
  { id: 'crypto_fair_maker', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75, makerExit: true },
  { id: 'crypto_hold_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0, exitAbove: null, tauMin: 75 },
  { id: 'crypto_double_v1', minEdge: 0.02, priceMin: 0.1, priceMax: 0.45, tpBelow: 0.46, exitAbove: null, tauMin: 90 },
  { id: 'crypto_cheap_v1', minEdge: 0.03, priceMin: 0.05, priceMax: 0.2, tpBelow: 0.2, exitAbove: 0.03, tauMin: 75 },
  { id: 'crypto_late_v1', minEdge: 0.06, priceMin: 0.05, priceMax: 0.95, tpBelow: 0, exitAbove: 0.03, tauMin: 20, tauMax: 120, live: true },
  { id: 'crypto_lag_v1', minEdge: 0.04, priceMin: 0.05, priceMax: 0.9, tpBelow: 0, exitAbove: 0.02, tauMin: 45, live: true, trigger: 'lag' },
  { id: 'crypto_fade_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0, exitAbove: 0.02, tauMin: 45, live: true, trigger: 'fade' },
  { id: 'crypto_fav_late', minEdge: -1, priceMin: 0.95, priceMax: 0.98, tpBelow: 0, exitAbove: null, tauMin: 90, tauMax: 120, fav: true },
  { id: 'crypto_fav_last', minEdge: -1, priceMin: 0.95, priceMax: 0.98, tpBelow: 0, exitAbove: null, tauMin: 30, tauMax: 90, fav: true },
  { id: 'crypto_fav_98', minEdge: -1, priceMin: 0.98, priceMax: 0.99, tpBelow: 0, exitAbove: null, tauMin: 150, tauMax: 210, fav: true },
  // Nov 24, Aaron: "max out the testing". scripts/crypto_screen.py scored 595 price-only rules on 32 days of
  // Bitcoin, XRP and gold windows (26,795 windows); the only ones up in both halves of the month were the
  // 98-99c favorite at different moments, so these test its timing on its own accounts:
  //   crypto_fav_99_1m   the 98-99c side with about a minute left (5m: 5,474 bets, +0.43c a contract,
  //                      t 4.3; 15m: 2,221, +0.63c, t 5.3; 1h: 625, +0.61c). The live fill needs a real ask
  //                      with size, which the replay's minute points can't promise this close to the end
  //   crypto_fav_98_1h   the 98-99c side of the hourly window with 3.5-14 minutes left (438 of 438 won at
  //                      4-3 minutes, 155 of 155 at 14-5)
  //   crypto_fav_98_calm crypto_fav_98's moment, but only when the window's price has held within 1c for
  //                      30 s: live, crypto_fav_98 lost 3 of 112 where the replay says about 0.6, which looks
  //                      like buying favorites while they're sliding through 98c
  //   crypto_fav_96_15m  the 95-98c side of a 15-minute window with 5-9 minutes left (139 bets, 99.3% won at
  //                      95.9c, +3.0c, t 4.2; the second half's t was 1.9, a near miss)
  { id: 'crypto_fav_99_1m', minEdge: -1, priceMin: 0.98, priceMax: 0.99, tpBelow: 0, exitAbove: null, tauMin: 50, tauMax: 140, fav: true },
  { id: 'crypto_fav_98_1h', minEdge: -1, priceMin: 0.98, priceMax: 0.99, tpBelow: 0, exitAbove: null, tauMin: 210, tauMax: 840, fav: true, series: ['1h'] },
  { id: 'crypto_fav_98_calm', minEdge: -1, priceMin: 0.98, priceMax: 0.99, tpBelow: 0, exitAbove: null, tauMin: 150, tauMax: 210, fav: true, calm: 0.01 },
  { id: 'crypto_fav_96_15m', minEdge: -1, priceMin: 0.95, priceMax: 0.98, tpBelow: 0, exitAbove: null, tauMin: 300, tauMax: 540, fav: true, series: ['15m'] },
];
// Nov 24-25, Aaron: the three favorites that hadn't lost yet, run again as if the account started at $1,000,
// $5,000 and $10,000. Same rules, their own paper accounts (the _1k / _5k / _10k ids), each sized off its own
// bankroll that grows or shrinks with its results, on the ladder's rung for that size. Paper only: real money
// only ever trades LIVE_STRATEGY on BOT_ALLOCATION.
// Nov 25, Aaron ("test them all"): the 1-minute favorite's three overnight losses were all 5-minute windows
// (176-3 there, 53-0 on 15-minute and hourly), so a copy that skips 5-minute windows runs next to it. Thin
// evidence (three losses), which is why it's a separate test and the original keeps running unchanged.
CRYPTO_STRATEGIES.push({ ...CRYPTO_STRATEGIES.find((s) => s.id === 'crypto_fav_99_1m')!, id: 'crypto_fav_99_1m_long', series: ['15m', '1h'] });
// Nov 25, Aaron: the same 1-minute favorite with a stop-loss. If the 98c side's bid falls to 90c it sells at the
// bid right away, so a loss costs about 8-10% of the bet instead of all of it. The catch it tests: with a minute
// left the price can jump past 90c in one move, so the sale lands at whatever the bid is when the bot sees it.
CRYPTO_STRATEGIES.push({ ...CRYPTO_STRATEGIES.find((s) => s.id === 'crypto_fav_99_1m')!, id: 'crypto_fav_99_1m_stop', stopAt: 0.9 });
export const BIG_BANKS: [string, number][] = [['1k', 1000], ['5k', 5000], ['10k', 10000]];
// Nov 25, Aaron ("why are we not testing the 1K banks half, 5K and 10K on every strategy?"): every strategy
// runs four bigger copies next to its $100 account, fed the same signals: $1,000, $1,000 that sets aside half
// of every new high (bankroll's `lock`), $5,000 and $10,000. A copy bets, stops and sizes up on its $100
// version's verdict (research.ts board), so one card is one test. Locked for the 10-day test (TEST_PLAN).
export const COPIES: { suffix: string; bank: number; lock?: number }[] = [
  { suffix: '1k', bank: 1000 }, { suffix: 'lock_1k', bank: 1000, lock: 0.5 }, { suffix: '5k', bank: 5000 }, { suffix: '10k', bank: 10000 },
];
for (const base of CRYPTO_STRATEGIES.slice()) {
  for (const c of COPIES) {
    const id = `${base.id}_${c.suffix}`;
    if (!CRYPTO_STRATEGIES.some((s) => s.id === id)) CRYPTO_STRATEGIES.push({ ...base, id, bank: c.bank, lock: c.lock });
  }
}
const BY_ID = new Map(CRYPTO_STRATEGIES.map((s) => [s.id, s]));
export const CRYPTO_IDS = [...CRYPTO_STRATEGIES.map((s) => s.id), 'crypto_ladder_v1'];

function etParts(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, h: Number(p.hour) % 24, wd: p.weekday };
}

// Event slugs for the ladders worth watching right now: the next hourly settlement at least 5
// minutes away, today's 5 PM ET (tomorrow's after 5 PM) and the coming Friday's 5 PM ET.
export function ladderEvents(now: number): string[] {
  const H = 3_600_000;
  const next = new Date(Math.ceil((now + 5 * MIN) / H) * H);
  const hr = `btc-above-hr-${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}-${pad(next.getUTCHours())}00z`;
  const et = etParts(now);
  const d1 = etParts(et.h >= 17 ? now + 86_400_000 : now);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(et.wd);
  let add = (5 - wd + 7) % 7;
  if (add === 0 && et.h >= 17) add = 7;
  const d7 = etParts(now + add * 86_400_000);
  return [hr, `btc-above-day-${d1.y}-${d1.m}-${d1.d}`, `btc-above-wk-${d7.y}-${d7.m}-${d7.d}`];
}

interface CryptoEnv extends Partial<PmEnv> {
  DB: D1Database;
  BOT_ALLOCATION?: string;  // each paper strategy's starting account (default 100)
  BOT_MAX_BET?: string;     // Aaron's cap per bet, when set
  BTC_STREAM?: string;      // "off" turns the live streams off (polling only)
  BTC_REPLICA?: string;     // "off" turns off the order books behind the index copy (shadow mode)
  LIVE_TRADING?: string;    // "on" lets the bot place real orders with the live account (Aaron sets it)
  LIVE_STRATEGY?: string;   // which strategy trades real money (default crypto_fair_v1)
  LIVE_MAX_BET?: string;    // cap per real-money bet only (Nov 26); BOT_MAX_BET would also cap every paper account
}
type Side = 'long' | 'short';
type Src = 'stream' | 'poll';
type Kind = 'crypto_ticks' | 'crypto_signals' | 'spot' | 'gap_skips' | 'feed_skips' | 'jump_skips' | 'event_skips' | 'fee_skips';
interface Win { slug: string; series: string; start: number; end: number; lookback: number }
interface Quote { bid: number | null; ask: number | null; ts: number; src: Src; state: string | null; bidShares: number | null; askShares: number | null }
interface Conn { ws: WebSocket; slugs: string[]; at: number; last: number; n: number }
interface Fair { fair: number; spot: number; strike: number; sigma: number; avgObs: number | null; live: boolean }
interface Cand { side: Side; ask: number; fair: number; edge: number; depth: number | null }

const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : null;
};
const cents = (x: number) => `${Math.round(x * 100)}¢`;
const pad = (n: number) => String(n).padStart(2, '0');
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const leftText = (tau: number) => `${Math.floor(tau / 60)}:${pad(Math.floor(tau % 60))} left`;
const isOpen = (state: string | null) => !state || /OPEN/.test(state);

// A WebSocket upgrade with an 8 s limit on the handshake only. Passing AbortSignal.timeout(8_000) to
// the fetch also closed the socket itself 8 s later: every stream (Polymarket, Coinbase, Gemini and
// the three books) reconnected every 10 s and the bot heard no prices for 1-2 s each time (found
// Nov 23 with the per-second record). The timer is cleared once the upgrade answers.
// cycle = true keeps the old behaviour (the socket closes 8 s in and the next loop reconnects): held
// open, the Coinbase ticker went quiet after its first message (Nov 23, ~1 message per 10 s against
// ~10 a second when tested outside the Worker), while its old 8-second cycle delivered prices. Until
// that's understood, the ticker keeps its cycle and everything else stays connected.
async function upgrade(url: string, headers: Record<string, string>, cycle = false): Promise<Response> {
  if (cycle) return fetch(url, { headers: { ...headers, Upgrade: 'websocket' }, signal: AbortSignal.timeout(8_000) });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try { return await fetch(url, { headers: { ...headers, Upgrade: 'websocket' }, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

export class CryptoFeed extends DurableObject<CryptoEnv> {
  // Spot: the latest price, 1-second samples (strike and end averages, last 10 minutes), and
  // 5-second samples (volatility, last 2 hours).
  private spot: { price: number; ts: number; src: Src } | null = null;
  // Exchange feeds: each one's latest raw mid, raw 1-second samples (last 10 minutes), and its
  // learned offset to the official index (official − exchange, smoothed over window starts).
  private feed: Record<Feed, { price: number; ts: number } | null> = { cb: null, gm: null };
  private feedSec: Record<Feed, Array<[number, number]>> = { cb: [], gm: [] };
  private basis: Record<Feed, number> = { cb: 0, gm: 0 };
  private basisN: Record<Feed, number> = { cb: 0, gm: 0 };
  private basisLog: Array<{ ts: number; official: number; cb: number | null; gm: number | null }> = [];
  private gmBook: { bid: number | null; ask: number | null } = { bid: null, ask: null };
  private basisAt = new Set<number>();
  private spotSec: Array<[number, number]> = [];
  private spotHist: Array<[number, number]> = [];
  private lastSec = 0;
  private lastLogged: number | null = null;
  // Markets
  private current = new Map<string, Win>();
  private quotes = new Map<string, Quote>();
  private hist = new Map<string, Array<[number, number]>>();          // slug → [ts, mid] at the 5 s loop
  private track = new Map<string, Array<[number, number, number]>>(); // slug → [ts, fair, mid], twice a second
  private lastQuote = new Map<string, string>();
  private strike = new Map<string, number | null>();
  private official = new Set<string>();   // windows whose strike is Polymarket's own priceToBeat
  private known = new Set<string>();
  private signalAt = new Map<string, number>();
  private markAt = new Map<string, number>();
  private pendingStmts: D1PreparedStatement[] = [];
  // Positions and decisions
  private open: Position[] = [];
  private openAt = 0;
  private seen = new Map<string, { side: Side; at: number }>();
  private exitedAt = new Map<string, number>();
  private bankCache = new Map<string, { at: number; bank: Bankroll }>();
  private chain: Promise<void> = Promise.resolve();
  private pending = new Set<string>();
  private evalAt = new Map<string, number>();
  private mult = 1;
  // How the math and the market are weighed (learned), one blend for bets with 4+ minutes left and one
  // for the last 4 minutes; each starts 50/50 and is replaced once its band has 100 graded windows.
  private blends: Record<Band, Blend> = { early: { ...DEFAULT_BLEND }, late: { ...DEFAULT_BLEND } };
  // The research board's verdicts (index.ts writes them every 5 minutes): retired strategies stop
  // betting, testing ones bet TEST_SHARE of their account (3%, fairvalue.ts).
  private lab: { strategies?: Record<string, { status?: Status }> } | null = null;
  private labAt = 0;
  private feedGap: number | null = null;  // how far apart Coinbase and Gemini read right now (both lined up)
  private jumpUntil = 0;                  // entries pause until then after a jump
  private guardAt = new Map<string, number>();
  private sigCache: { sec: number; v: number | null } = { sec: 0, v: null };
  private blendCache: { sec: number; v: number | null } = { sec: 0, v: null };
  private tod: number[] = Array(24).fill(1); // hour-of-day volatility factors (variance, 1 = average)
  private todAt = 0;
  private todBins: Record<string, { rv: number[]; t: number[] }> = {}; // UTC day -> per hour: squared returns, seconds
  private records = new Map<string, { f: number; mean: number | null; se: number | null; t: number | null; n: number; hours: number }>();
  // The index copy (shadow): full books, 1 s samples, and its score at each window start
  private bk: Record<BookFeed, { book: Book; conn: Conn | null; retryAt: number; fails: number; msgs: number }> = {
    cb: { book: new Book(), conn: null, retryAt: 0, fails: 0, msgs: 0 },
    gm: { book: new Book(), conn: null, retryAt: 0, fails: 0, msgs: 0 },
    bs: { book: new Book(), conn: null, retryAt: 0, fails: 0, msgs: 0 },
  };
  private repSec: Array<[number, number]> = [];
  private bookBusy = new Set<BookFeed>();
  private prunedAt = 0;
  private repLastSec = 0;
  private rep = { n: 0, offset: 0, offN: 0, abs: { comp: 0, raw: 0, corr: 0 }, log: [] as Array<Record<string, number | null>> };
  private todPrev: [number, number] | null = null;
  private lostIn = new Set<string>();     // strategy|window (L: for live) closed at a loss: stay out
  private gapAt = new Map<string, number>();
  // Live trading
  private liveVerified = false;                                  // a preview has checked out since start
  private livePausedUntil = 0;
  private liveErrors = 0;
  private liveOrderIds = new Set<string>();                      // every exchange order id the bot placed
  private liveTp = new Map<string, { id: string; price: number }>(); // live position id → resting take-profit
  private tpFilled = new Map<string, number>();                  // take-profit order id → contracts already recorded
  private tpCheckAt = new Map<string, number>();
  private liveSkip = new Map<string, number>();                  // slug → skip until (Aaron trades it)
  // Streams
  private pm: Conn | null = null;
  private cb: Conn | null = null;
  private gm: Conn | null = null;
  private pmRetryAt = 0; private pmFails = 0;
  private cbRetryAt = 0; private cbFails = 0;
  private gmRetryAt = 0; private gmFails = 0; private gmMsgs = 0;
  private pmMsgs = 0; private cbMsgs = 0; private pmConnects = 0;
  private cbBookPxAt = 0;   // when Coinbase's price was last read off its order book
  // Housekeeping
  private booted = false;
  private settledAt = 0;
  private ladderAt = 0;
  private tunedAt = 0;
  // The per-second record (seconds.ts): rows waiting to be written, the last second taken
  private secRows: SecRow[] = [];
  private recSec = 0;
  private secReady = false;
  private secPrunedAt = 0;
  // Diagnostics (noteEvent, flushLoop): stream message gaps and loop step times
  private evtAt = 0;
  private evtGaps: Array<[number, number, string, string, number]> = [];
  private evtLast: [string, number] = ['', 0];
  private pxAt = 0;
  private pxGaps: Array<[number, number, string]> = [];   // gaps 0.8 s+ between price events (the ones that feed the record)
  private cbConnects = 0; private gmConnects = 0; private bookConnects = 0;
  private loopSteps: Array<Record<string, number>> = [];
  private loopAt = 0;
  private counts: Record<Kind, number> = { crypto_ticks: 0, crypto_signals: 0, spot: 0, gap_skips: 0, feed_skips: 0, jump_skips: 0, event_skips: 0, fee_skips: 0 };
  private lastAt: Record<Kind, number> = { crypto_ticks: 0, crypto_signals: 0, spot: 0, gap_skips: 0, feed_skips: 0, jump_skips: 0, event_skips: 0, fee_skips: 0 };
  private flushedAt = 0;

  async fetch(_req: Request): Promise<Response> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + 2 * MIN) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({ ok: true, alarm, spot: this.spot?.price ?? null, stream: !!this.pm, ticker: !!this.cb, gemini: !!this.gm, mult: this.mult, blend: this.blends, lab: this.lab, basis: this.basis, tod: this.tod,
      replica: { price: this.repSec.at(-1)?.[1] ?? null, books: Object.fromEntries(BOOK_IDS.map((x) => [x, { up: !!this.bk[x].conn, at: this.bk[x].book.at, bids: this.bk[x].book.bids.size, asks: this.bk[x].book.asks.size, msgs: this.bk[x].msgs }])), n: this.rep.n } });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // Diagnostics: how long each step of the loop takes (ms), kept for the last 24 loops.
    const step: Record<string, number> = { at: now };
    let last = now;
    const lap = (k: string) => { const t = Date.now(); step[k] = t - last; last = t; };
    try {
      await this.boot(now); lap('boot');
      // The research board's statuses come first: until they're read, a strategy the board retired
      // looks like a fresh test, and right after a restart the ladder scan or the first stream prices
      // could bet on it (the ladder did, once, at the Nov 23 10:15 PM restart).
      if (!this.lab || now - this.labAt >= 5 * MIN) {
        this.labAt = now;
        try {
          const lb = await this.env.DB.prepare("SELECT v FROM brain WHERE k = 'lab_btc'").first<{ v: string }>();
          if (lb) this.lab = JSON.parse(lb.v);
        } catch (e) { console.log('lab error', String((e as any)?.message || e)); }
        lap('lab');
      }
      await this.ensureStreams(now); lap('streams');
      step.pmc = this.pmConnects; step.cbc = this.cbConnects; step.gmc = this.gmConnects; step.bkc = this.bookConnects;
      const stmts: D1PreparedStatement[] = [];
      await this.readSpot(now, stmts); lap('spot');
      this.current = new Map(this.windowsAt(now).map((w) => [w.slug, w]));
      if (now - this.openAt > 30_000) { await this.serial(() => this.reloadOpen(now)); lap('reload'); }
      await this.recordWindows([...this.current.values()], now, stmts); lap('record');
      if (now - this.settledAt >= MIN) { this.settledAt = now; await this.settle(now, stmts); lap('settle'); }
      if (now - this.ladderAt >= LADDER_EVERY) {
        this.ladderAt = now;
        try { await this.ladderScan(now); } catch (e) { console.log('ladder error', String((e as any)?.message || e)); }
        lap('ladder');
      }
      if (now - this.todAt >= TOD_EVERY) {
        this.todAt = now;
        try { this.learnTod(now); } catch (e) { console.log('tod error', String((e as any)?.message || e)); }
        lap('tod');
      }
      if (now - this.tunedAt >= TUNE_EVERY) {
        this.tunedAt = now;
        try { await this.tune(now); } catch (e) { console.log('tune error', String((e as any)?.message || e)); }
        lap('tune');
      }
      stmts.push(...this.pendingStmts.splice(0));
      step.stmts = stmts.length;
      for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      lap('batch');
      await this.flush(now); lap('flush');
      await this.flushSeconds(now); lap('secs');
      await this.flushLoop(now);
    } catch (e) {
      console.log('crypto feed error', String((e as any)?.message || e));
    } finally {
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Math.max(now + TICK, Date.now() + 1_000));
      lap('alarm');
      step.total = Date.now() - now;
      this.loopSteps.push(step);
      if (this.loopSteps.length > 24) this.loopSteps.shift();
    }
  }

  // Diagnostics (Nov 23): the per-second record showed the bot hearing nothing for 1-2 s every 10 s
  // around this loop. Gaps of 0.8 s+ between incoming stream messages and each loop step's time go
  // to brain btc_loop once a minute, to find the cause. Nothing reads it to trade.
  // Each gap: [start ms, length ms, the message that ended it, the one before it, that one's size].
  private noteEvent(now: number, src: string, data: unknown) {
    if (this.evtAt && now - this.evtAt >= 800) {
      this.evtGaps.push([this.evtAt, now - this.evtAt, src, this.evtLast[0], this.evtLast[1]]);
      if (this.evtGaps.length > 60) this.evtGaps.shift();
    }
    this.evtAt = now;
    this.evtLast = [src, typeof data === 'string' ? data.length : 0];
  }

  private async flushLoop(now: number) {
    if (now - this.loopAt < MIN) return;
    this.loopAt = now;
    try {
      await this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
        .bind('btc_loop', JSON.stringify({ gaps: this.evtGaps, px: this.pxGaps, steps: this.loopSteps }), now).run();
    } catch (e) { console.log('loop log error', String((e as any)?.message || e)); }
  }

  // ---------- start-up: pick up where the last run left off, so a deploy doesn't blind the bot
  // for half an hour while it rebuilds two hours of price history.
  private async boot(now: number) {
    if (this.booted) return;
    this.booted = true;
    this.tunedAt = now - TUNE_EVERY + 3 * MIN; // first grading 3 minutes in
    try {
      const sp = await this.env.DB.prepare('SELECT ts, price FROM spot WHERE asset = ? AND ts > ? ORDER BY ts')
        .bind(ASSET, now - 120 * MIN).all<{ ts: number; price: number }>();
      this.spotHist = sp.results.map((r) => [r.ts, r.price] as [number, number]);
      this.spotSec = this.spotHist.filter(([ts]) => ts >= now - 10 * MIN);
      const ws = await this.env.DB.prepare('SELECT slug, strike FROM windows WHERE end_ts > ? AND strike IS NOT NULL')
        .bind(now).all<{ slug: string; strike: number }>();
      for (const r of ws.results) { this.strike.set(r.slug, r.strike); this.known.add(r.slug); }
      const b = await this.env.DB.prepare("SELECT v FROM brain WHERE k = 'btc_model'").first<{ v: string }>();
      const saved = b ? JSON.parse(b.v) : null;
      const ab = saved?.active;
      const okB = (x: any) => !!x && [x.a, x.b, x.c].every((v: unknown) => Number.isFinite(Number(v)));
      const toB = (x: any): Blend => ({ a: Number(x.a), b: Number(x.b), c: Number(x.c) });
      if (okB(ab?.early)) this.blends.early = toB(ab.early);
      if (okB(ab?.late)) this.blends.late = toB(ab.late);
      else if (okB(ab)) this.blends.late = toB(ab); // before the bands: the one fitted blend, mostly late checkpoints
      if (saved && Number(saved.mult) > 0) this.mult = Number(saved.mult);
      const tb = await this.env.DB.prepare("SELECT v, at FROM brain WHERE k = 'btc_tod'").first<{ v: string; at: number }>();
      const st = tb ? JSON.parse(tb.v) : null;
      if (Array.isArray(st?.f) && st.f.length === 24) { this.tod = st.f.map((x: unknown) => Number(x) || 1); this.todAt = tb!.at; }
      if (st?.bins && typeof st.bins === 'object') this.todBins = st.bins;
      else {
        // First run: seed the week from the prices already on record.
        const old = await this.env.DB.prepare('SELECT ts, price FROM spot WHERE asset = ? AND ts > ? ORDER BY ts')
          .bind(ASSET, now - 7 * 86_400_000).all<{ ts: number; price: number }>();
        for (const r of old.results) this.todAdd(r.ts, r.price);
        this.todPrev = null;
        this.todAt = 0;
      }
      const rb = await this.env.DB.prepare("SELECT v FROM brain WHERE k = 'btc_replica'").first<{ v: string }>();
      const sr = rb ? JSON.parse(rb.v) : null;
      if (sr && Number(sr.n) > 0 && sr.abs) {
        this.rep = { n: Number(sr.n), offset: Number(sr.offset) || 0, offN: Number(sr.offN) || 0, abs: { comp: Number(sr.abs.comp) || 0, raw: Number(sr.abs.raw) || 0, corr: Number(sr.abs.corr) || 0 }, log: Array.isArray(sr.log) ? sr.log : [] };
      }
      const rec = await this.env.DB.prepare("SELECT v FROM brain WHERE k = 'btc_records'").first<{ v: string }>();
      const srec = rec ? JSON.parse(rec.v) : null;
      if (srec && typeof srec === 'object') for (const [id, r] of Object.entries(srec)) this.records.set(id, r as any);
      const bb = await this.env.DB.prepare("SELECT v FROM brain WHERE k = 'btc_basis'").first<{ v: string }>();
      const sb = bb ? JSON.parse(bb.v) : null;
      if (sb) for (const f of FEEDS) {
        if (Number.isFinite(Number(sb[f]))) this.basis[f] = Number(sb[f]);
        if (Number.isFinite(Number(sb.n?.[f]))) this.basisN[f] = Number(sb.n[f]);
      }
      if (Array.isArray(sb?.log)) { this.basisLog = sb.log.filter((r: any) => r && (r.cb != null || r.gm != null)).slice(-24); for (const r of this.basisLog) this.basisAt.add(r.ts); }
    } catch (e) {
      console.log('crypto boot error', String((e as any)?.message || e));
    }
  }

  // ---------- streams

  private wantSlugs(now: number): string[] {
    const out = new Set<string>();
    for (const s of SERIES) {
      const len = s.mins * MIN;
      const start = Math.floor(now / len) * len;
      out.add(windowSlug(ASSET, s.key, start));
      if (start + len - now <= 20_000) out.add(windowSlug(ASSET, s.key, start + len)); // about to open
    }
    for (const p of this.open) if (p.status === 'open' && p.strategy === LADDER) out.add(p.market_slug);
    return [...out].sort();
  }

  private async ensureStreams(now: number) {
    if (this.env.BTC_STREAM === 'off') { this.drop('pm'); this.drop('cb'); this.drop('gm'); this.dropBooks(); return; }
    const want = this.wantSlugs(now);
    const pmOk = this.pm && now - this.pm.last < STREAM_STALE && want.every((s) => this.pm!.slugs.includes(s));
    if (!pmOk && now >= this.pmRetryAt && this.env.POLYMARKET_KEY_ID && this.env.POLYMARKET_SECRET_KEY) {
      try { await this.connectPm(want, now); this.pmFails = 0; }
      catch (e) {
        this.pmFails++;
        this.pmRetryAt = now + Math.min(60_000, 2_000 * 2 ** this.pmFails);
        console.log('pm stream error', String((e as any)?.message || e));
      }
    }
    // Coinbase's price comes from its order book while that's live (the ticker goes quiet when held
    // open from a Worker); the ticker is only the fallback, for when the books are off or down.
    const cbOk = this.cbBookLive(now) || (this.cb && now - this.cb.last < STREAM_STALE);
    if (!cbOk && now >= this.cbRetryAt) {
      try { await this.connectCb(now); this.cbFails = 0; }
      catch (e) {
        this.cbFails++;
        this.cbRetryAt = now + Math.min(60_000, 2_000 * 2 ** this.cbFails);
        console.log('ticker error', String((e as any)?.message || e));
      }
    }
    const gmOk = this.gm && now - this.gm.last < STREAM_STALE;
    if (!gmOk && now >= this.gmRetryAt) {
      try { await this.connectGm(now); this.gmFails = 0; }
      catch (e) {
        this.gmFails++;
        this.gmRetryAt = now + Math.min(60_000, 2_000 * 2 ** this.gmFails);
        console.log('gemini error', String((e as any)?.message || e));
      }
    }
    this.ensureBooks(now);
  }

  // ---------- the index copy's order books (shadow mode)

  // Coinbase's order book is connected and was heard from in the last BOOK_FRESH.
  private cbBookLive(now: number): boolean {
    const s = this.bk.cb;
    return !!s.conn && s.book.at > 0 && now - s.book.at <= BOOK_FRESH;
  }

  // Connects in the background: a slow exchange never holds up the price streams or the loop.
  private ensureBooks(now: number) {
    if (this.env.BTC_REPLICA === 'off') { this.dropBooks(); return; }
    for (const f of BOOK_IDS) {
      const s = this.bk[f];
      if (this.bookBusy.has(f) || (s.conn && now - s.conn.last < STREAM_STALE) || now < s.retryAt) continue;
      this.bookBusy.add(f);
      void this.connectBook(f, now)
        .then(() => { s.fails = 0; }, (e) => {
          s.fails++;
          s.retryAt = Date.now() + Math.min(5 * MIN, 5_000 * 2 ** s.fails);
          console.log(`${BOOK_FEEDS[f].name} book error`, String((e as any)?.message || e));
        })
        .finally(() => this.bookBusy.delete(f));
    }
  }

  private dropBooks() {
    for (const f of BOOK_IDS) {
      const c = this.bk[f].conn;
      this.bk[f].conn = null;
      if (c) try { c.ws.close(1000, 'off'); } catch {}
    }
  }

  private async connectBook(f: BookFeed, now: number) {
    const spec = BOOK_FEEDS[f];
    const res = await upgrade(spec.url, { ...UA });
    const ws = res.webSocket;
    if (!ws) throw new Error(`refused: HTTP ${res.status}`);
    ws.accept();
    const conn: Conn = { ws, slugs: [], at: now, last: now, n: 0 };
    const s = this.bk[f];
    this.bookConnects++;
    s.book.clear();
    s.book.at = 0;
    ws.addEventListener('message', (e) => this.onBook(f, conn, e.data));
    const gone = () => { if (s.conn === conn) s.conn = null; };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    if (spec.sub) ws.send(JSON.stringify(spec.sub));
    const old = s.conn;
    s.conn = conn;
    if (old) try { old.ws.close(1000, 'reconnected'); } catch {}
  }

  private onBook(f: BookFeed, conn: Conn, data: unknown) {
    const now = Date.now();
    this.noteEvent(now, `book_${f}`, data);
    conn.last = now; conn.n++;
    const s = this.bk[f];
    if (s.conn !== conn || typeof data !== 'string') return;
    s.msgs++;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j?.event === 'bts:request_reconnect') { s.conn = null; try { conn.ws.close(1000, 'reconnect'); } catch {} return; }
    try { if (BOOK_FEEDS[f].apply(s.book, j)) s.book.at = now; } catch { return; }
    // Coinbase's price for the bot: the book's best bid and ask, the same mid its ticker gave.
    if (f === 'cb' && s.book.at === now && now - this.cbBookPxAt >= CB_BOOK_EVERY) {
      const mid = s.book.topMid();
      if (mid != null) { this.cbBookPxAt = now; this.cbMsgs++; this.onPrice('cb', mid, now); }
    }
    // One sample of the copy a second.
    const sec = Math.floor(now / 1000);
    if (sec === this.repLastSec) return;
    this.repLastSec = sec;
    const r = replicaPrice(BOOK_IDS.map((x) => this.bk[x].book), now);
    if (!r) return;
    // Once a minute, drop levels far from the price: the copy only reads the top of each book.
    if (now - this.prunedAt > MIN) { this.prunedAt = now; for (const x of BOOK_IDS) this.bk[x].book.prune(r.price); }
    this.repSec.push([now, r.price]);
    while (this.repSec.length && this.repSec[0][0] < now - 10 * MIN) this.repSec.shift();
  }

  // At each window start: how far the copy's last-minute average (as is, and with its own learned
  // offset) and the bot's own price landed from Polymarket's official start price.
  private scoreReplica(start: number, official: number, now: number) {
    const avg = (pts: Array<[number, number]>) => pts.reduce((a, [, p]) => a + p, 0) / pts.length;
    const rp = this.repSec.filter(([ts]) => ts >= start - MIN && ts < start);
    const cp = this.spotSec.filter(([ts]) => ts >= start - MIN && ts < start);
    if (rp.length < 30 || cp.length < 30) return;
    const ravg = avg(rp), cavg = avg(cp);
    const raw = official - ravg, comp = official - cavg, corr = official - (ravg + this.rep.offset);
    if (Math.abs(raw) > BASIS_MAX || Math.abs(comp) > BASIS_MAX) return;
    const R = this.rep;
    R.n++;
    R.abs.comp += Math.abs(comp); R.abs.raw += Math.abs(raw); R.abs.corr += Math.abs(corr);
    R.offset = learnOffset(R.offset, R.offN, raw, BASIS_ALPHA);
    R.offN++;
    R.log.push({ ts: start, official: r2(official), comp: r2(comp), raw: r2(raw), corr: r2(corr), books: BOOK_IDS.filter((x) => now - this.bk[x].book.at <= 10_000).length });
    while (R.log.length > 24) R.log.shift();
    this.pendingStmts.push(this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('btc_replica', JSON.stringify({
        n: R.n, offset: r2(R.offset), offN: R.offN, abs: R.abs,
        mae: { comp: r2(R.abs.comp / R.n), raw: r2(R.abs.raw / R.n), corr: r2(R.abs.corr / R.n) }, log: R.log,
      }), now));
  }

  private drop(which: 'pm' | 'cb' | 'gm') {
    const c = this[which];
    this[which] = null;
    if (c) try { c.ws.close(1000, 'off'); } catch {}
  }

  // Polymarket's market-data stream. A new window means a new subscription: open the new
  // connection first, then close the old one, so there's no gap.
  private async connectPm(slugs: string[], now: number) {
    const res = await upgrade(PM_API + PM_WS_PATH, { ...(await signedHeaders(this.env as PmEnv, 'GET', PM_WS_PATH)) });
    const ws = res.webSocket;
    if (!ws) throw new Error(`stream refused: HTTP ${res.status}`);
    ws.accept();
    const conn: Conn = { ws, slugs, at: now, last: now, n: 0 };
    ws.addEventListener('message', (e) => this.onPm(conn, e.data));
    const gone = () => { if (this.pm === conn) this.pm = null; };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    ws.send(JSON.stringify({ subscribe: { requestId: `w${now}`, subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs: slugs } }));
    const old = this.pm;
    this.pm = conn;
    this.pmConnects++;
    if (old) try { old.ws.close(1000, 'resubscribed'); } catch {}
  }

  private onPm(conn: Conn, data: unknown) {
    const now = Date.now();
    this.noteEvent(now, 'pm', data);
    conn.last = now; conn.n++; this.pmMsgs++;
    if (typeof data !== 'string') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    const d = j?.marketDataLite;
    if (!d?.marketSlug) return;
    this.quotes.set(d.marketSlug, {
      bid: num(d.bestBid), ask: num(d.bestAsk), ts: now, src: 'stream', state: d.state || null,
      bidShares: num(d.bidShares), askShares: num(d.askShares),
    });
    this.secTick(now, 'pm');
    this.kick(d.marketSlug);
  }

  // Coinbase's public ticker: the bitcoin mid on every trade. Each update also re-checks the open
  // windows, since a bitcoin move is exactly when the market's price goes stale.
  private async connectCb(now: number) {
    const res = await upgrade(CB_WS, { ...UA }, true);
    const ws = res.webSocket;
    if (!ws) throw new Error(`ticker refused: HTTP ${res.status}`);
    ws.accept();
    const conn: Conn = { ws, slugs: [], at: now, last: now, n: 0 };
    ws.addEventListener('message', (e) => this.onCb(conn, e.data));
    const gone = () => { if (this.cb === conn) this.cb = null; };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    this.cbConnects++;
    const old = this.cb;
    this.cb = conn;
    if (old) try { old.ws.close(1000, 'reconnected'); } catch {}
  }

  private onCb(conn: Conn, data: unknown) {
    const now = Date.now();
    this.noteEvent(now, 'cb', data);
    conn.last = now; conn.n++; this.cbMsgs++;
    if (typeof data !== 'string') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j?.type !== 'ticker') return;
    const bid = Number(j.best_bid), ask = Number(j.best_ask), px = Number(j.price);
    const price = bid > 0 && ask >= bid ? (bid + ask) / 2 : px;
    if (!(price > 0)) return;
    this.onPrice('cb', price, now);
  }

  // Gemini's top of book: each message moves the best bid or ask. The second exchange in the bot's
  // price, and the steady one (Coinbase's ticker only speaks on trades, and goes quiet).
  private async connectGm(now: number) {
    const res = await upgrade(GM_WS, { ...UA });
    const ws = res.webSocket;
    if (!ws) throw new Error(`gemini refused: HTTP ${res.status}`);
    ws.accept();
    const conn: Conn = { ws, slugs: [], at: now, last: now, n: 0 };
    this.gmBook = { bid: null, ask: null };
    this.gmConnects++;
    ws.addEventListener('message', (e) => this.onGm(conn, e.data));
    const gone = () => { if (this.gm === conn) this.gm = null; };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    const old = this.gm;
    this.gm = conn;
    if (old) try { old.ws.close(1000, 'reconnected'); } catch {}
  }

  private onGm(conn: Conn, data: unknown) {
    const now = Date.now();
    this.noteEvent(now, 'gm', data);
    conn.last = now; conn.n++; this.gmMsgs++;   // heartbeats count too: they keep the connection fresh
    if (this.gm !== conn || typeof data !== 'string') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j?.type !== 'update' || !Array.isArray(j.events)) return;
    for (const e of j.events) {
      if (e?.type !== 'change' || !(Number(e.remaining) > 0)) continue;  // remaining 0: that level is gone
      const px = Number(e.price);
      if (!(px > 0)) continue;
      if (e.side === 'bid') this.gmBook.bid = px;
      else if (e.side === 'ask') this.gmBook.ask = px;
    }
    const { bid, ask } = this.gmBook;
    if (bid != null && ask != null && ask >= bid && ask - bid < 50) this.onPrice('gm', (bid + ask) / 2, now);
  }

  // A new exchange price: keep its raw one-second samples (to learn its offset), rebuild the bot's
  // price and re-check the open windows.
  private onPrice(f: Feed, price: number, now: number) {
    this.feed[f] = { price, ts: now };
    this.feedSample(f, price, now);
    const c = this.composite(now);
    if (c == null) return;
    this.spot = { price: c, ts: now, src: 'stream' };
    this.sample(now, c);
    this.secTick(now, f);
    // A jump: the price moved JUMP_Z standard deviations in about 10 seconds. The market reprices
    // faster than the bot can, so entries pause for a moment.
    const sig = this.sigma15(now);
    if (sig) {
      let ago: [number, number] | null = null;
      for (let i = this.spotSec.length - 1; i >= 0; i--) { if (this.spotSec[i][0] <= now - 10_000) { ago = this.spotSec[i]; break; } }
      if (ago && now - ago[0] <= 20_000) {
        const z = Math.abs(Math.log(c / ago[1])) / (sig * Math.sqrt((now - ago[0]) / 1000));
        if (z > JUMP_Z) this.jumpUntil = now + JUMP_PAUSE;
      }
    }
    for (const slug of this.current.keys()) this.kick(slug);
  }

  private feedSample(f: Feed, price: number, now: number) {
    const s = this.feedSec[f];
    if (!s.length || Math.floor(s[s.length - 1][0] / 1000) !== Math.floor(now / 1000)) s.push([now, price]);
    while (s.length && s[0][0] < now - 10 * MIN) s.shift();
  }

  // The bot's read of the settlement index right now: every exchange mid from the last 3 seconds,
  // each shifted by its learned offset, averaged. If one exchange goes quiet the other carries it
  // without a jump, since both are already lined up with the index.
  private composite(now: number): number | null {
    let sum = 0, n = 0;
    const vals: number[] = [];
    for (const f of FEEDS) {
      const x = this.feed[f];
      if (x && now - x.ts <= SPOT_LIVE) { sum += x.price + this.basis[f]; n++; vals.push(x.price + this.basis[f]); }
    }
    this.feedGap = vals.length === 2 ? Math.abs(vals[0] - vals[1]) : null;
    return n ? sum / n : null;
  }

  // Polymarket just published a window's official start price: the index's average over the minute
  // before `start`. Compare each exchange's own average over that minute and move its offset a step
  // toward the gap. Windows of different lengths that start together share one start price, so each
  // start is learned once.
  private learnBasis(start: number, official: number, now: number) {
    if (this.basisAt.has(start) || now - start > 10 * MIN) return;
    this.basisAt.add(start);
    try { this.scoreReplica(start, official, now); } catch (e) { console.log('replica score error', String((e as any)?.message || e)); }
    const row: { ts: number; official: number; cb: number | null; gm: number | null } = { ts: start, official: r2(official), cb: null, gm: null };
    for (const f of FEEDS) {
      const pts = this.feedSec[f].filter(([ts]) => ts >= start - MIN && ts < start);
      if (pts.length < 10) continue;
      const gap = official - pts.reduce((a, [, p]) => a + p, 0) / pts.length;
      row[f] = r2(gap);
      if (Math.abs(gap) > BASIS_MAX) continue;
      this.basis[f] = learnOffset(this.basis[f], this.basisN[f], gap, BASIS_ALPHA);
      this.basisN[f]++;
    }
    if (row.cb == null && row.gm == null) return;   // no readings of our own for that minute (just started)
    this.basisLog.push(row);
    while (this.basisLog.length > 24) this.basisLog.shift();
    for (const ts of this.basisAt) if (ts < now - 3 * 3_600_000) this.basisAt.delete(ts);
    this.pendingStmts.push(this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('btc_basis', JSON.stringify({ cb: r2(this.basis.cb), gm: r2(this.basis.gm), n: this.basisN, log: this.basisLog }), now));
  }

  private sample(now: number, price: number) {
    const sec = Math.floor(now / 1000);
    if (sec === this.lastSec) return;
    this.lastSec = sec;
    this.spotSec.push([now, price]);
    while (this.spotSec.length && this.spotSec[0][0] < now - 10 * MIN) this.spotSec.shift();
  }

  // The per-second record (seconds.ts): on the first price or quote of each new second, a copy of
  // what the bot sees. Recording only; nothing reads it back to trade, and errors are swallowed.
  private secTick(now: number, src: string) {
    if (this.pxAt && now - this.pxAt >= 800) {
      this.pxGaps.push([this.pxAt, now - this.pxAt, src]);
      if (this.pxGaps.length > 60) this.pxGaps.shift();
    }
    this.pxAt = now;
    const sec = Math.floor(now / 1000);
    if (sec <= this.recSec) return;
    this.recSec = sec;
    try {
      const fresh = (x: { price: number; ts: number } | null) => (x && now - x.ts <= SPOT_LIVE ? r2(x.price) : null);
      const spot = this.spot && this.spot.src === 'stream' && now - this.spot.ts <= SPOT_LIVE ? r2(this.spot.price) : null;
      const row: SecRow = [sec, spot, fresh(this.feed.cb), fresh(this.feed.gm)];
      const wins = this.windowsAt(now);
      for (const s of SEC_SERIES) {
        const w = wins.find((x) => x.series === s);
        const q = w ? this.quotes.get(w.slug) : undefined;
        const ok = !!q && q.src === 'stream' && !!this.pm && now - q.ts <= STREAM_STALE && isOpen(q.state);
        const f = w ? this.fairFor(w, now, false) : null;
        row.push(ok ? q!.bid : null, ok ? q!.ask : null, ok ? q!.bidShares : null, ok ? q!.askShares : null, f ? r4(f.fair) : null);
      }
      this.secRows.push(row);
      if (this.secRows.length > SEC_BUFFER) this.secRows.splice(0, this.secRows.length - SEC_BUFFER);
    } catch {}
  }

  // Written every loop in a batch of its own, so a failure here can't drop the bot's other writes.
  // On an error the rows go back in line (up to SEC_BUFFER); once an hour, rows past SEC_KEEP_DAYS go.
  private async flushSeconds(now: number) {
    if (!this.secRows.length) return;
    const rows = this.secRows.splice(0);
    try {
      if (!this.secReady) { await this.env.DB.prepare(SEC_DDL).run(); this.secReady = true; }
      const ins = secInserts(rows).map((s) => this.env.DB.prepare(s.sql).bind(...s.params));
      for (let i = 0; i < ins.length; i += 50) await this.env.DB.batch(ins.slice(i, i + 50));
      if (now - this.secPrunedAt >= 3_600_000) {
        this.secPrunedAt = now;
        await this.env.DB.prepare('DELETE FROM btc_sec WHERE sec < ?').bind(Math.floor(now / 1000) - SEC_KEEP_DAYS * 86_400).run();
      }
    } catch (e) {
      this.secRows = [...rows, ...this.secRows].slice(-SEC_BUFFER);
      console.log('second record error', String((e as any)?.message || e));
    }
  }

  // Re-check one market soon: at most every 250 ms, never two checks queued for the same market.
  private kick(slug: string) {
    const now = Date.now();
    if (this.pending.has(slug) || now - (this.evalAt.get(slug) || 0) < EVAL_EVERY) return;
    this.pending.add(slug);
    void this.serial(async () => {
      this.pending.delete(slug);
      const t = Date.now();
      this.evalAt.set(slug, t);
      const w = this.current.get(slug);
      if (w) await this.evaluate(w, t, 'stream');
      else await this.ladderFast(slug, t);
    });
  }

  // Everything that touches positions runs one at a time, in order.
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((e) => console.log('crypto task error', String((e as any)?.message || e)));
    this.chain = next;
    return next;
  }

  // ---------- spot, volatility, strike, fair value

  private async readSpot(now: number, stmts: D1PreparedStatement[]): Promise<number | null> {
    let price = this.spot && this.spot.src === 'stream' && now - this.spot.ts <= SPOT_LIVE ? this.spot.price : null;
    if (price == null) {
      // No live stream: Coinbase's REST ticker, shifted by Coinbase's learned offset. Fair values
      // still work on it, but no new entries (they need a live stream).
      try {
        const res = await fetch(SPOT_URL, { headers: UA });
        if (res.ok) {
          const j = (await res.json()) as any;
          const bid = num(j.bid), ask = num(j.ask), px = num(j.price);
          const raw = bid && ask && ask >= bid ? (bid + ask) / 2 : px;
          if (raw) { this.feed.cb = { price: raw, ts: now }; this.feedSample('cb', raw, now); price = raw + this.basis.cb; }
        }
      } catch {}
      if (price != null) { this.spot = { price, ts: now, src: 'poll' }; this.sample(now, price); }
    }
    if (price == null) return null;
    this.spotHist.push([now, price]);
    while (this.spotHist.length && this.spotHist[0][0] < now - 120 * MIN) this.spotHist.shift();
    this.todAdd(now, price);
    if (price !== this.lastLogged) {
      this.lastLogged = price;
      stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO spot (asset, ts, price) VALUES (?,?,?)').bind(ASSET, now, price));
      this.bump('spot', now);
    }
    return price;
  }

  private spotNow(now: number): { price: number; live: boolean } | null {
    if (!this.spot || now - this.spot.ts > SPOT_OK) return null;
    return { price: this.spot.price, live: this.spot.src === 'stream' && now - this.spot.ts <= SPOT_LIVE };
  }

  // Volatility per sqrt(second) from the 5-second readings over the last `minutes`; null until at
  // least `need` seconds of readings exist. (One-second trade prices would add bid-ask noise.)
  private sigmaRaw(now: number, minutes = 15, need = 120): number | null {
    let sum = 0, time = 0;
    const h = this.spotHist.filter(([ts]) => ts >= now - minutes * MIN);
    for (let i = 1; i < h.length; i++) {
      const dt = (h[i][0] - h[i - 1][0]) / 1000;
      if (dt <= 0 || dt > 30) continue;
      const r = Math.log(h[i][1] / h[i - 1][1]);
      sum += r * r;
      time += dt;
    }
    return time >= need ? Math.sqrt(sum / time) : null;
  }

  private sigma15(now: number): number | null {
    const sec = Math.floor(now / 1000);
    if (this.sigCache.sec !== sec) this.sigCache = { sec, v: this.sigmaRaw(now) };
    return this.sigCache.v;
  }

  // The volatility to price with: the last 15 minutes blended with the last hour and two hours
  // (volatility clusters, and 15 minutes alone is a noisy read), then moved from the hours the
  // lookback covered to the hours the window covers, using the hour-of-day profile.
  private sigmaFor(now: number, end: number): number | null {
    const sec = Math.floor(now / 1000);
    if (this.blendCache.sec !== sec) {
      const s15 = this.sigma15(now);
      let v: number | null = null;
      if (s15 != null) {
        let sum = 0.5 * s15 * s15, wt = 0.5;
        const s60 = this.sigmaRaw(now, 60, 15 * 60), s120 = this.sigmaRaw(now, 120, 30 * 60);
        if (s60 != null) { sum += 0.3 * s60 * s60; wt += 0.3; }
        if (s120 != null) { sum += 0.2 * s120 * s120; wt += 0.2; }
        v = Math.sqrt(sum / wt);
      }
      this.blendCache = { sec, v };
    }
    return this.blendCache.v == null ? null : this.blendCache.v * this.todRatio(now, end);
  }

  private todRatio(now: number, end: number): number {
    const hr = (t: number) => new Date(t).getUTCHours();
    let fut = 0, nf = 0, past = 0, np = 0;
    for (let t = now; t <= Math.max(now, end); t += 15 * MIN) { fut += this.tod[hr(t)]; nf++; }
    for (let t = now - 2 * 3_600_000; t <= now; t += 15 * MIN) { past += this.tod[hr(t)]; np++; }
    if (!nf || !np || past <= 0) return 1;
    return Math.min(1.4, Math.max(0.7, Math.sqrt((fut / nf) / (past / np))));
  }

  // The hour-of-day volatility profile, kept from the bot's own 5-second prices as they come in:
  // squared returns and seconds per UTC day and hour, a week of them (saved with the profile, so a
  // deploy doesn't lose them).
  private todAdd(now: number, price: number) {
    const prev = this.todPrev;
    this.todPrev = [now, price];
    if (!prev) return;
    const dt = (now - prev[0]) / 1000;
    if (dt <= 0 || dt > 30) return;
    const r = Math.log(price / prev[1]);
    const d = new Date(now), day = d.toISOString().slice(0, 10), h = d.getUTCHours();
    const bin = (this.todBins[day] ||= { rv: Array(24).fill(0), t: Array(24).fill(0) });
    bin.rv[h] += r * r;
    bin.t[h] += dt;
  }

  // Each hour's realized variance over the average across hours, pulled toward 1 until that hour
  // has several days behind it (one day: a quarter of the way, a week: 70%). Needs 6+ hours seen.
  private learnTod(now: number) {
    const cutoff = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
    for (const day of Object.keys(this.todBins)) if (day < cutoff) delete this.todBins[day];
    const per = Array.from({ length: 24 }, (_, h) => {
      let rv = 0, t = 0, days = 0;
      for (const b of Object.values(this.todBins)) if (b.t[h] >= 30 * 60) { rv += b.rv[h]; t += b.t[h]; days++; }
      return t > 0 ? { v: rv / t, days } : null;
    });
    const known = per.filter(Boolean) as Array<{ v: number; days: number }>;
    if (known.length >= 6) {
      const mean = known.reduce((a, x) => a + x.v, 0) / known.length;
      this.tod = per.map((x) => (x ? 1 + (x.v / mean - 1) * (x.days / (x.days + 3)) : 1)).map((f) => Math.round(Math.min(3, Math.max(0.33, f)) * 1000) / 1000);
    }
    const bins = Object.fromEntries(Object.entries(this.todBins).map(([d, b]) => [d, { rv: b.rv.map((x) => Number(x.toPrecision(6))), t: b.t.map((x) => Math.round(x)) }]));
    this.pendingStmts.push(this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('btc_tod', JSON.stringify({ f: this.tod, days: per.map((x) => x?.days ?? 0), bins }), now));
  }

  // Average spot over [from, to): one-second samples when there are enough, else the 5 s ones.
  private avgSpot(from: number, to: number): { avg: number; n: number } | null {
    const fine = this.spotSec.filter(([ts]) => ts >= from && ts < to);
    const pts = fine.length >= 10 ? fine : this.spotHist.filter(([ts]) => ts >= from && ts < to);
    if (!pts.length) return null;
    return { avg: pts.reduce((a, [, p]) => a + p, 0) / pts.length, n: pts.length };
  }

  private ensureStrike(w: Win, now: number) {
    if (this.strike.has(w.slug) || now < w.start) return;
    const pre = this.avgSpot(w.start - MIN, w.start);
    const k = pre && pre.n >= 3 ? pre.avg : null;
    this.strike.set(w.slug, k);
    if (k != null) this.pendingStmts.push(this.env.DB.prepare('INSERT INTO windows (slug, asset, series, start_ts, end_ts, strike) VALUES (?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET strike = COALESCE(windows.strike, excluded.strike)')
      .bind(w.slug, ASSET, w.series, w.start, w.end, k));
  }

  // ensure = false (the per-second record) only reads the strike, never sets the estimate.
  private fairFor(w: Win, now: number, ensure = true): Fair | null {
    const s = this.spotNow(now);
    if (!s) return null;
    if (ensure) this.ensureStrike(w, now);
    const strike = this.strike.get(w.slug);
    const raw = this.sigmaFor(now, w.end);
    if (strike == null || raw == null) return null;
    const tau = (w.end - now) / 1000;
    const avgObs = tau < 60 ? this.avgSpot(w.end - MIN, now)?.avg ?? null : null;
    const fair = fairUp({ spot: s.price, strike, sigma: raw * this.mult, tau, avgObs });
    return fair == null ? null : { fair, spot: s.price, strike, sigma: raw, avgObs, live: s.live };
  }

  private windowsAt(now: number): Win[] {
    return SERIES.map((s) => {
      const len = s.mins * MIN;
      const start = Math.floor(now / len) * len;
      return { slug: windowSlug(ASSET, s.key, start), series: s.key, start, end: start + len, lookback: s.lookback };
    });
  }

  private async fetchMarkets(slugs: string[], now: number): Promise<any[]> {
    if (!slugs.length) return [];
    const qs = slugs.map((s) => `slug=${encodeURIComponent(s)}`).join('&');
    try {
      const res = await fetch(`${GATEWAY}/v1/markets?${qs}&limit=${slugs.length}&_=${now}`, { headers: UA });
      if (res.ok) return (((await res.json()) as any).markets || []) as any[];
    } catch {}
    return [];
  }

  // ---------- the 5-second record: ticks, strike, signals, checkpoints, polling fallback

  private async recordWindows(windows: Win[], now: number, stmts: D1PreparedStatement[]) {
    // Poll the windows the stream isn't covering, plus any that just opened and don't have
    // Polymarket's official starting price yet (priceToBeat: the CF Benchmarks average the window
    // settles against). Until it's published, the strike is our own estimate (within $2 so far).
    const stale = new Set(windows.filter((w) => { const q = this.quotes.get(w.slug); return !q || q.src !== 'stream' || now - q.ts > QUOTE_LIVE; }).map((w) => w.slug));
    const needStrike = windows.filter((w) => now >= w.start + 2_000 && !this.official.has(w.slug)).map((w) => w.slug);
    for (const m of await this.fetchMarkets([...new Set([...stale, ...needStrike])], now)) {
      if (stale.has(m.slug)) {
        this.quotes.set(m.slug, { bid: num(m.bestBidQuote), ask: num(m.bestAskQuote), ts: now, src: 'poll', state: m.status || null, bidShares: null, askShares: null });
      }
      const k = num(m.assetPriceTerms?.priceToBeat);
      if (k && k > 0 && !this.official.has(m.slug)) {
        this.official.add(m.slug);
        this.strike.set(m.slug, k);
        const pw = parseWindow(m.slug);
        if (pw) {
          // An upsert, so it lands whether or not the window's row exists yet (the old UPDATE could
          // run first and miss, leaving our estimate in the record).
          stmts.push(this.env.DB.prepare('INSERT INTO windows (slug, asset, series, start_ts, end_ts, strike, official) VALUES (?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET strike = excluded.strike, official = excluded.official')
            .bind(m.slug, ASSET, pw.series, pw.start, pw.end, k, k));
          this.learnBasis(pw.start, k, now);
        }
      }
    }
    const tick = this.env.DB.prepare('INSERT OR IGNORE INTO ticks (slug, ts, bid, ask, last, vol, bid_depth, ask_depth, state) VALUES (?,?,?,?,?,?,?,?,?)');
    const sig = this.env.DB.prepare('INSERT OR IGNORE INTO signals (slug, ts, kind, side, price, ref, detail) VALUES (?,?,?,?,?,?,?)');
    const mark = this.env.DB.prepare('INSERT OR IGNORE INTO crypto_marks (slug, ts, tau, fair, bid, ask, spot, strike, sigma, avg_obs, src) VALUES (?,?,?,?,?,?,?,?,?,?,?)');

    for (const w of windows) {
      if (!this.known.has(w.slug)) {
        this.known.add(w.slug);
        stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO windows (slug, asset, series, start_ts, end_ts) VALUES (?,?,?,?,?)')
          .bind(w.slug, ASSET, w.series, w.start, w.end));
      }
      this.ensureStrike(w, now);
      const q = this.quotes.get(w.slug);
      if (!q) continue;
      const { bid, ask } = q;
      const key = `${bid}|${ask}|${q.state}`;
      if (this.lastQuote.get(w.slug) !== key) {
        this.lastQuote.set(w.slug, key);
        stmts.push(tick.bind(w.slug, now, bid, ask, null, null, q.bidShares, q.askShares, q.state));
        this.bump('crypto_ticks', now);
      }
      const mid = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? null;
      if (mid == null || !isOpen(q.state)) continue;
      const h = this.hist.get(w.slug) || [];
      h.push([now, mid]);
      while (h.length && h[0][0] < now - 10 * MIN) h.shift();
      this.hist.set(w.slug, h);

      const tau = (w.end - now) / 1000;
      const f = this.fairFor(w, now);
      const left = leftText(tau);
      const where = f ? `, BTC ${Math.round(f.spot).toLocaleString('en-US')} vs ${Math.round(f.strike).toLocaleString('en-US')} start` : '';
      const name = (side: Side) => `BTC ${w.series} ${side === 'long' ? 'Up' : 'Down'}`;
      const fire = (kind: string, side: Side, price: number | null, ref: number | null, detail: string) => {
        const ck = `${w.slug}|${kind}|${side}`;
        if (now - (this.signalAt.get(ck) || 0) < SIGNAL_COOLDOWN) return;
        this.signalAt.set(ck, now);
        stmts.push(sig.bind(w.slug, now, kind, side, price == null ? null : r4(price), ref == null ? null : r4(ref), detail));
        this.bump('crypto_signals', now);
      };
      // Cheap side spiking: the cash-out move.
      const past = this.midAgo(w.slug, now, w.lookback);
      if (past != null) {
        for (const side of ['long', 'short'] as Side[]) {
          const was = side === 'long' ? past : 1 - past;
          const nowP = side === 'long' ? mid : 1 - mid;
          const sellAt = side === 'long' ? bid : ask != null ? 1 - ask : null;
          if (was < 0.15 && nowP >= was * 1.5 && nowP - was >= 0.03) fire('cheap_spike', side, sellAt, was, `${name(side)} ${cents(was)} → ${cents(nowP)}, ${left}${where}`);
        }
      }
      // Price vs. the math: a side's ask 10c or more under its fair value.
      if (f && tau > 20) {
        const upAsk = ask, downAsk = bid != null ? 1 - bid : null;
        if (upAsk != null && f.fair - upAsk >= 0.1) fire('fair_gap', 'long', upAsk, f.fair, `${name('long')} ask ${cents(upAsk)} vs fair ${cents(f.fair)}, ${left}${where}`);
        if (downAsk != null && (1 - f.fair) - downAsk >= 0.1) fire('fair_gap', 'short', downAsk, 1 - f.fair, `${name('short')} ask ${cents(downAsk)} vs fair ${cents(1 - f.fair)}, ${left}${where}`);
      }
      // Checkpoint for grading the math later.
      if (f && tau > 2 && now - (this.markAt.get(w.slug) || 0) >= MARK_EVERY) {
        this.markAt.set(w.slug, now);
        stmts.push(mark.bind(w.slug, now, r2(tau), r4(f.fair), bid, ask, f.spot, r2(f.strike), f.sigma, f.avgObs, q.src));
      }
      // No live stream for this window: trade off the poll.
      if (q.src !== 'stream' || now - q.ts > QUOTE_LIVE) await this.serial(() => this.evaluate(w, now, 'poll'));
    }
  }

  private midAgo(slug: string, now: number, ago: number): number | null {
    const h = this.hist.get(slug);
    if (!h) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      const [ts, mid] = h[i];
      if (ts <= now - ago) return ts >= now - ago - 30_000 ? mid : null;
    }
    return null;
  }

  // How far the math and the market moved over the last `secs` seconds on this window.
  private moves(slug: string, now: number, secs: number): { dFair: number; dMid: number } | null {
    const t = this.track.get(slug);
    if (!t || t.length < 2) return null;
    const target = now - secs * 1000;
    let best: [number, number, number] | null = null;
    for (const row of t) if (Math.abs(row[0] - target) <= 2_000 && (!best || Math.abs(row[0] - target) < Math.abs(best[0] - target))) best = row;
    if (!best) return null;
    const last = t[t.length - 1];
    return { dFair: last[1] - best[1], dMid: last[2] - best[2] };
  }

  private trackPush(slug: string, now: number, fair: number, mid: number) {
    const t = this.track.get(slug) || [];
    if (t.length && now - t[t.length - 1][0] < 500) t[t.length - 1] = [t[t.length - 1][0], fair, mid];
    else t.push([now, fair, mid]);
    while (t.length && t[0][0] < now - 3 * MIN) t.shift();
    this.track.set(slug, t);
  }

  // ---------- trading the windows

  private sides(q: Quote, fair: number): Cand[] {
    const out: Array<Omit<Cand, 'edge'>> = [];
    if (q.ask != null) out.push({ side: 'long', ask: q.ask, fair, depth: q.askShares });
    if (q.bid != null) out.push({ side: 'short', ask: r4(1 - q.bid), fair: 1 - fair, depth: q.bidShares });
    return out.map((o) => ({ ...o, edge: o.fair - o.ask - feePer(o.ask) }));
  }

  private async evaluate(w: Win, now: number, src: Src) {
    const q = this.quotes.get(w.slug);
    if (!q || !isOpen(q.state)) return;
    const tau = (w.end - now) / 1000;
    if (tau <= 1) return;
    const f = this.fairFor(w, now);
    if (f && q.bid != null && q.ask != null) this.trackPush(w.slug, now, f.fair, (q.bid + q.ask) / 2);

    for (const p of this.open) {
      if (p.status !== 'open' || p.market_slug !== w.slug) continue;
      if (p.mode === 'live') await this.liveExit(p, q, f?.fair ?? null, tau, now, src);
      else await this.exitWindow(p, q, f?.fair ?? null, tau, now, src);
    }
    // Entries only on a price fresh off a live exchange stream, and a live Polymarket quote (never a
    // polled one); exits above still run on anything. A pause also restarts the edge's hold timer,
    // so an edge seen before it has to show again, for the full hold, after it.
    const forget = () => { for (const st of CRYPTO_STRATEGIES) this.seen.delete(`${st.id}|${w.slug}`); };
    if (!f || !f.live || q.src !== 'stream' || now - q.ts > QUOTE_LIVE) { forget(); return; }
    const guard = this.guardFor(w, now);
    if (guard) { forget(); this.guardSkip(guard, w, now); return; }
    const mid = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null;
    const len = (w.end - w.start) / 1000;
    const liveId = this.liveOn() && now >= this.livePausedUntil && now >= (this.liveSkip.get(w.slug) || 0) ? this.liveStrategy() : null;
    for (const st of CRYPTO_STRATEGIES) {
      const key = `${st.id}|${w.slug}`;
      if (tau < st.tauMin || tau > (st.tauMax ?? len - 30) || (st.series && !st.series.includes(w.series))) { this.seen.delete(key); continue; }
      // The research board: a retired strategy no longer bets; a testing one bets 3% of its account.
      const status = statusOf(this.lab, st.id);
      if (status === 'retired') { this.seen.delete(key); continue; }
      // Is there room for a paper entry, a live entry, or both?
      const paperMine = this.open.filter((x) => x.status === 'open' && x.mode !== 'live' && x.strategy === st.id);
      const paperFree = !paperMine.some((x) => x.market_slug === w.slug)
        && paperMine.filter((x) => (windowEnd(x.market_slug) ?? 0) > now).length < MAX_LIVE_WINDOWS
        && now - (this.exitedAt.get(key) || 0) >= REENTER_AFTER
        && !this.lostIn.has(key);
      let liveFree = false;
      if (liveId === st.id) {
        const liveMine = this.open.filter((x) => x.status === 'open' && x.mode === 'live');
        liveFree = !liveMine.some((x) => x.market_slug === w.slug)
          && liveMine.filter((x) => (windowEnd(x.market_slug) ?? 0) > now).length < MAX_LIVE_WINDOWS
          && now - (this.exitedAt.get(`L:${key}`) || 0) >= REENTER_AFTER
          && !this.lostIn.has(`L:${key}`);
      }
      if (!paperFree && !liveFree) continue;

      let cands = this.sides(q, f.fair);
      if (st.trigger) {
        const mv = this.moves(w.slug, now, st.trigger === 'lag' ? 30 : 15);
        let dir: Side | null = null;
        if (mv && st.trigger === 'lag') {
          if (mv.dFair >= 0.06 && mv.dMid <= mv.dFair / 2) dir = 'long';
          else if (mv.dFair <= -0.06 && mv.dMid >= mv.dFair / 2) dir = 'short';
        } else if (mv && Math.abs(mv.dMid) >= 0.08 && Math.abs(mv.dFair) <= 0.03) dir = mv.dMid > 0 ? 'short' : 'long';
        cands = cands.filter((c) => c.side === dir);
      }
      const best = cands.filter((c) => c.ask >= st.priceMin && c.ask <= st.priceMax && c.edge >= st.minEdge && c.edge <= MAX_EDGE)
        .sort((a, b) => b.edge - a.edge)[0];
      if (!best) { this.seen.delete(key); continue; }
      if (st.calm != null) {
        const mv = this.moves(w.slug, now, 30);
        if (!mv || Math.abs(mv.dMid) > st.calm) { this.seen.delete(key); continue; }
      }
      // The data check: math way over the market's mid means our price is off, not a gift.
      const midSide = mid == null ? null : best.side === 'long' ? mid : 1 - mid;
      if (midSide != null && best.fair - midSide > MAX_GAP) { this.seen.delete(key); this.gapSkip(w, best, midSide, f, tau, now); continue; }
      // The fee check: on the blend (what the bot actually believes), the bet must still beat the
      // price after the fee. With the market the sharper one, this is what stops it paying fees for nothing.
      // The late favorite skips it: its bet is the market's own lean late in a window, not the math, and
      // its price band is the whole rule (each arm's ceiling leaves at least a cent a win after the fee).
      // A paper test bet is judged on judgingBlend: with 4+ minutes left that's the 50/50
      // start until the board decides. Real money always has to clear the fitted blend.
      const cost = best.ask + feePer(best.ask);
      const fitOk = !!st.fav || this.sizingProb(best, mid, tau) - cost >= BLEND_EDGE;
      const testOk = fitOk || (status === 'testing' && this.probOn(judgingBlend(this.blends, bandOf(tau), true), best, mid) - cost >= BLEND_EDGE);
      const paperGo = paperFree && testOk, liveGo = liveFree && fitOk;
      if (!paperGo && !liveGo) { this.seen.delete(key); this.guardSkip('fee_skips', w, now); continue; }
      // On the stream, the price has to still be there 0.6 s later, like a real order landing.
      if (src === 'stream') {
        const s = this.seen.get(key);
        if (!s || s.side !== best.side) { this.seen.set(key, { side: best.side, at: now }); continue; }
        if (now - s.at < HOLD_FOR) continue;
      }
      this.seen.delete(key);

      if (paperGo) {
        const bank = await this.bank(st.id, now);
        if (!dailyStopHit(bank.equity, bank.today, bank.peak)) {
          const stake = stakeFor({
            fair: st.fav ? best.ask : this.sizingProb(best, mid, tau), price: best.ask, equity: bank.equity, available: bank.available, peak: bank.peak, openNet: bank.openNet,
            fraction: st.kelly?.fraction, trust: 1, depth: best.depth, ceiling: this.ceiling(), recordKelly: this.records.get(parentOf(st.id) ?? st.id)?.f ?? 0,
          });
          // A test bet is TEST_SHARE of the account (fairvalue.ts); a promising or proven strategy bets
          // its own size, never less than a test bet. Both stay inside the ladder and the book.
          const test = Math.floor(testStake({ equity: bank.equity, peak: bank.peak, available: bank.available, openNet: bank.openNet, ceiling: this.ceiling(), depth: best.depth, price: best.ask }) / best.ask);
          let qty = status === 'testing' ? test : Math.max(test, Math.floor(stake / best.ask));
          // A probe: the stake rounds to under one contract. On paper it still buys one, so the strategy
          // keeps learning. It stays inside the ladder: room under the one-bet and all-open limits, and
          // none at the floor.
          const lim = riskLimits(Math.max(bank.peak, bank.equity));
          const room = Math.min(bank.available, bank.equity * lim.bet, Math.max(0, bank.equity * lim.open - bank.openNet));
          const probe = qty < 1 && best.ask <= room && drawdownScale(bank.equity, Math.max(bank.peak, bank.equity), lim.dd) > 0 && (best.depth == null || best.depth >= 1);
          if (probe) qty = 1;
          if (qty >= 1) {
            const pos = await openPosition(this.env.DB, {
              strategy: st.id, slug: w.slug, title: `BTC Up or Down ${w.series}`, side: best.side,
              sideName: `BTC ${w.series} ${best.side === 'long' ? 'Up' : 'Down'}`, ask: best.ask, qty, coef: COEF,
              reason: `${probe ? 'probe: ' : ''}${st.fav ? `favorite at ${cents(best.ask)}` : `fair ${cents(best.fair)} vs ask ${cents(best.ask)}`}, ${leftText(tau)}${src === 'stream' ? ', on stream' : ''}`, now, tpBelow: st.tpBelow,
              meta: { fair: r4(best.fair), edge: r4(best.edge), mid: midSide == null ? null : r4(midSide), spot: r2(f.spot), strike: r2(f.strike), tau: Math.round(tau), sigma: f.sigma, mult: this.mult, band: bandOf(tau), blend: this.blends[bandOf(tau)], p: r4(this.sizingProb(best, mid, tau)), record: this.records.get(parentOf(st.id) ?? st.id)?.f ?? 0, probe, feeds: this.feedsNow(now), src, equity: r2(bank.equity), rules: RULES, status, gate: fitOk ? 'fit' : 'start' },
            });
            pos.mode = 'paper';
            this.open.push(pos);
            this.bankCache.delete(st.id);
          }
        }
      }
      if (liveGo) await this.liveEnter(w, st, best, f, tau, now, mid);
    }
  }

  // ---------- real money

  private async liveEnter(w: Win, st: CryptoStrategy, best: Cand, f: Fair, tau: number, now: number, mid: number | null) {
    const db = this.env.DB, env = this.env as PmEnv;
    const name = `BTC ${w.series} ${best.side === 'long' ? 'Up' : 'Down'}`;
    const bank = await this.bank('live', now);
    if (dailyStopHit(bank.equity, bank.today, bank.peak)) return;
    const stake = stakeFor({
      fair: this.sizingProb(best, mid, tau), price: best.ask, equity: bank.equity, available: bank.available, peak: bank.peak, openNet: bank.openNet,
      fraction: st.kelly?.fraction, trust: 1, depth: best.depth, ceiling: this.liveCeiling(), recordKelly: this.records.get(parentOf(st.id) ?? st.id)?.f ?? 0,
    });
    // Aaron's real-money cap, checked twice: once inside stakeFor and again here on the contract
    // count, and if a cap is set but can't be read the bot skips the bet instead of betting full size
    // (Nov 26: the first real bet came out at $9.82 with LIVE_MAX_BET = 3).
    const cap = this.liveCeiling();
    const rawCap = (this.env as any).LIVE_MAX_BET;
    if (rawCap != null && String(rawCap).trim() !== '' && cap == null) {
      this.liveEvent(now, 'error', w.slug, `${name}: LIVE_MAX_BET is set (${JSON.stringify(rawCap)}) but couldn't be read as dollars, skipped`);
      return;
    }
    let qty = Math.floor(stake / best.ask);
    if (cap != null) qty = Math.min(qty, Math.floor(cap / best.ask));
    if (qty < 1) return;   // real money: no probes
    // Never trade a window where the account holds anything, or has orders the bot didn't place:
    // those are Aaron's, and the exchange would net them against the bot's.
    const [held, orders] = await Promise.all([accountPosition(env, w.slug), openOrders(env, w.slug)]);
    if (held == null || orders == null) { this.liveEvent(now, 'skip', w.slug, `${name}: couldn't read the account, skipped`); return; }
    if (Math.abs(held) > 1e-9) { this.liveSkip.set(w.slug, w.end); this.liveEvent(now, 'skip', w.slug, `${name}: the account already holds ${held} contracts here, skipped this window`); return; }
    if (orders.some((o) => !this.liveOrderIds.has(o.id))) { this.liveSkip.set(w.slug, w.end); this.liveEvent(now, 'skip', w.slug, `${name}: you have orders open here, skipped this window`); return; }

    const spec: OrderSpec = { slug: w.slug, side: best.side, action: 'buy', sidePx: best.ask, qty, tif: 'ioc' };
    if (!this.liveVerified) {
      const pv = await previewOrder(env, spec);
      this.liveEvent(now, pv.ok ? 'preview' : 'error', w.slug, `${pv.ok ? 'Preview checked out' : 'Preview failed'}: buy ${qty} ${name} at ${cents(best.ask)}. ${pv.detail}`);
      if (!pv.ok) { this.livePausedUntil = now + 10 * MIN; return; }
      this.liveVerified = true;
    }
    const r = await placeOrder(env, spec);
    if (r.id) this.liveOrderIds.add(r.id);
    if (r.error || r.reject) {
      this.liveEvent(now, 'error', w.slug, `Buy ${qty} ${name} at ${cents(best.ask)} failed: ${r.error || r.reject}`);
      if (++this.liveErrors >= 3) { this.liveErrors = 0; this.livePausedUntil = now + 15 * MIN; this.liveEvent(now, 'pause', null, 'Three order errors in a row: paused real trading for 15 minutes'); }
      return;
    }
    this.liveErrors = 0;
    if (r.filled <= 0 || r.avgSidePx == null) { this.liveEvent(now, 'miss', w.slug, `No fill: buy ${qty} ${name} at ${cents(best.ask)}, the price moved first`); return; }
    const pos = await openLivePosition(db, {
      strategy: st.id, slug: w.slug, title: `BTC Up or Down ${w.series}`, side: best.side, sideName: name,
      qty: r.filled, avgPx: r.avgSidePx, fee: r.fee, limitPx: best.ask, exchangeId: r.id,
      reason: `fair ${cents(best.fair)} vs ask ${cents(best.ask)}, ${leftText(tau)}`, now,
      meta: { fair: r4(best.fair), edge: r4(best.edge), spot: r2(f.spot), strike: r2(f.strike), tau: Math.round(tau), sigma: f.sigma, mult: this.mult, band: bandOf(tau), blend: this.blends[bandOf(tau)], p: r4(this.sizingProb(best, mid, tau)), feeds: this.feedsNow(now), equity: r2(bank.equity), asked: qty, stake: r2(stake), cap, capRaw: rawCap == null ? null : String(rawCap), rules: RULES },
    });
    this.open.push(pos);
    this.bankCache.delete('live');
    this.liveEvent(now, 'buy', w.slug, `Bought ${r.filled} ${name} at ${cents(r.avgSidePx)} for $${(r.filled * r.avgSidePx + r.fee).toFixed(2)} (fee $${r.fee.toFixed(2)}); math says ${cents(best.fair)}; cap ${cap != null ? '$' + cap : 'none'}`);
    // His 2x idea where this strategy uses it: a resting sell at double the fill, maker only.
    const tp = takeProfitFor(r.avgSidePx, st.tpBelow);
    if (tp != null) {
      const t = await placeOrder(env, { slug: w.slug, side: best.side, action: 'sell', sidePx: tp, qty: r.filled, tif: 'gtc', postOnly: true });
      if (t.id && !t.error && !t.reject) {
        this.liveOrderIds.add(t.id);
        await recordLiveTakeProfit(db, pos, { price: tp, qty: r.filled, exchangeId: t.id, now });
        this.liveTp.set(pos.id, { id: t.id, price: tp });
        this.tpFilled.set(t.id, 0);
      } else this.liveEvent(now, 'error', w.slug, `Take-profit at ${cents(tp)} not placed: ${t.error || t.reject}`);
    }
  }

  private async liveExit(p: Position, q: Quote, fair: number | null, tau: number, now: number, src: Src) {
    const bidSide = p.side === 'long' ? q.bid : q.ask != null ? r4(1 - q.ask) : null;
    if (bidSide == null) return;
    const tp = this.liveTp.get(p.id);
    // The resting take-profit: ask the exchange what filled when the market reaches it, and every 15 s.
    if (tp && (bidSide >= tp.price || now - (this.tpCheckAt.get(p.id) || 0) > 15_000)) await this.checkTp(p, tp, now);
    if (p.status !== 'open' || !this.liveOn()) return; // switched off: open positions ride to the result
    const st = BY_ID.get(p.strategy);
    if (!st || st.exitAbove == null || fair == null || tau < (st.tauMax != null ? 8 : 20)) return;
    // Exits judge the bid against the blend too: sell early only when the bid, after its fee, beats what
    // the bot believes holding is worth. Otherwise it rides to the result, which costs no fee.
    const qMid = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null;
    const up = blendProb(this.blends[bandOf(tau)], fair, qMid ?? fair);
    const fairSide = p.side === 'long' ? up : 1 - up;
    const key = `lx|${p.id}`;
    if (bidSide < fairSide + feeLive(bidSide) + st.exitAbove) { this.seen.delete(key); return; }
    if (src === 'stream') {
      const s = this.seen.get(key);
      if (!s) { this.seen.set(key, { side: p.side, at: now }); return; }
      if (now - s.at < HOLD_FOR) return;
    }
    this.seen.delete(key);
    const env = this.env as PmEnv;
    if (tp) {
      await cancelOrder(env, tp.id, p.market_slug);
      await this.checkTp(p, tp, now, true);
      if (p.status !== 'open') return;
    }
    const r = await placeOrder(env, { slug: p.market_slug, side: p.side, action: 'sell', sidePx: bidSide, qty: p.qty, tif: 'ioc' });
    if (r.id) this.liveOrderIds.add(r.id);
    if (r.error || r.reject) { this.liveEvent(now, 'error', p.market_slug, `Sell ${p.qty} ${p.side_name} at ${cents(bidSide)} failed: ${r.error || r.reject}`); return; }
    if (r.filled <= 0 || r.avgSidePx == null) { this.liveEvent(now, 'miss', p.market_slug, `Sell at ${cents(bidSide)} missed, still holding ${p.qty} ${p.side_name}`); return; }
    await liveSell(this.env.DB, p, {
      qty: r.filled, avgPx: r.avgSidePx, fee: r.fee, limitPx: bidSide, exchangeId: r.id, maker: false,
      reason: `above fair: bid ${cents(bidSide)} vs fair ${cents(fairSide)}, ${leftText(tau)}`, now,
    });
    this.liveEvent(now, 'sell', p.market_slug, `Sold ${r.filled} ${p.side_name} at ${cents(r.avgSidePx)} (fee $${r.fee.toFixed(2)})${p.status === 'open' ? `, ${p.qty} still held` : `, P&L $${(p.proceeds - p.cost).toFixed(2)}`}`);
    if (p.status !== 'open') this.closed(p, now);
    else this.bankCache.delete('live');
  }

  // Record whatever the resting take-profit has filled since the last look.
  private async checkTp(p: Position, tp: { id: string; price: number }, now: number, cancelled = false) {
    this.tpCheckAt.set(p.id, now);
    const o = await getOrder(this.env as PmEnv, tp.id, p.side);
    if (!o) return;
    const seen = this.tpFilled.get(tp.id) || 0;
    const fresh = Math.min(p.qty, o.filled - seen);
    if (fresh > 1e-9) {
      this.tpFilled.set(tp.id, o.filled);
      const fee = o.filled > 0 ? Math.round((o.fee * fresh / o.filled) * 100) / 100 : 0;
      await liveSell(this.env.DB, p, { qty: fresh, avgPx: o.avgSidePx ?? tp.price, fee, limitPx: tp.price, exchangeId: tp.id, maker: true, reason: `take-profit at ${cents(tp.price)}`, now });
      this.liveEvent(now, 'sell', p.market_slug, `Take-profit filled: sold ${fresh} ${p.side_name} at ${cents(o.avgSidePx ?? tp.price)}${p.status === 'open' ? `, ${p.qty} still held` : `, P&L $${(p.proceeds - p.cost).toFixed(2)}`}`);
    }
    const done = cancelled || p.status !== 'open' || /^ORDER_STATE_(FILLED|CANCELED|EXPIRED|REJECTED)$/.test(o.state || '');
    if (done) {
      this.liveTp.delete(p.id);
      await markLiveOrder(this.env.DB, tp.id, o.state === 'ORDER_STATE_FILLED' ? 'filled' : 'cancelled', now);
    }
    if (p.status !== 'open') this.closed(p, now);
    else if (fresh > 1e-9) this.bankCache.delete('live');
  }

  private async exitWindow(p: Position, q: Quote, fair: number | null, tau: number, now: number, src: Src) {
    const bidSide = p.side === 'long' ? q.bid : q.ask != null ? r4(1 - q.ask) : null;
    if (bidSide == null) return;
    // A resting 2x sell fills once buyers bid up to it: no fee, no delay.
    if (p.take_profit != null && bidSide >= p.take_profit) {
      await closePosition(this.env.DB, p, { price: p.take_profit, coef: COEF, maker: true, reason: `take-profit at ${cents(p.take_profit)}`, now });
      this.closed(p, now);
      return;
    }
    const st = BY_ID.get(p.strategy);
    // Stop-loss: sell into the bid the moment it is at or under the stop (taker fee charged). If the price
    // gapped past the stop, the sale is at the lower bid, which is the honest fill.
    if (st?.stopAt != null && p.mode === 'paper' && bidSide > 0 && bidSide <= st.stopAt) {
      await closePosition(this.env.DB, p, { price: bidSide, coef: COEF, maker: false, reason: `stop-loss: bid ${cents(bidSide)} at or under ${cents(st.stopAt)}, ${leftText(tau)}`, now });
      this.closed(p, now);
      return;
    }
    if (!st || st.exitAbove == null || fair == null || tau < (st.tauMax != null ? 8 : 20)) return;
    // Exits judge the bid against the blend too: sell early only when the bid, after its fee, beats what
    // the bot believes holding is worth. Otherwise it rides to the result, which costs no fee.
    // A test position is judged on the blend it was entered on (judgingBlend), so its exits follow the
    // same rules as the record the board grades.
    const qMid = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null;
    const up = blendProb(judgingBlend(this.blends, bandOf(tau), statusOf(this.lab, p.strategy) === 'testing'), fair, qMid ?? fair);
    const fairSide = p.side === 'long' ? up : 1 - up;
    if (st.makerExit) {
      // A resting sell kept at fair + exitAbove (re-priced as fair moves). It fills, with no fee,
      // only once buyers bid up to it, the same rule as the 2x take-profit.
      const target = Math.min(0.99, r4(fairSide + st.exitAbove));
      if (bidSide >= target) {
        await closePosition(this.env.DB, p, { price: target, coef: COEF, maker: true, reason: `resting sell at ${cents(target)} (fair ${cents(fairSide)}), ${leftText(tau)}`, now });
        this.closed(p, now);
      }
      return;
    }
    const key = `x|${p.id}`;
    if (bidSide < fairSide + feePer(bidSide) + st.exitAbove) { this.seen.delete(key); return; }
    if (src === 'stream') {
      const s = this.seen.get(key);
      if (!s) { this.seen.set(key, { side: p.side, at: now }); return; }
      if (now - s.at < HOLD_FOR) return;
    }
    this.seen.delete(key);
    await closePosition(this.env.DB, p, { price: bidSide, coef: COEF, maker: false, reason: `above fair: bid ${cents(bidSide)} vs fair ${cents(fairSide)}, ${leftText(tau)}`, now });
    this.closed(p, now);
  }

  private closed(p: Position, now: number) {
    const live = p.mode === 'live';
    const key = `${live ? 'L:' : ''}${p.strategy}|${p.market_slug}`;
    this.exitedAt.set(key, now);
    // Out at a loss: the math was wrong about this window once already, so the strategy stays out of
    // it (Nov 22: three strategies bought back in 18 s after a losing sell and lost $27.53 more).
    if ((p.pnl ?? 0) < 0) this.lostIn.add(key);
    this.bankCache.delete(live ? 'live' : p.strategy);
    if (live) this.liveTp.delete(p.id);
    this.open = this.open.filter((x) => x.status === 'open');
  }

  // The probability bets are sized on: the math and the market's mid weighed on the log-odds scale
  // (cryptomath.ts blendProb). Up is blended, then turned into the side's chance.
  private sizingProb(best: Cand, mid: number | null, tau: number): number {
    return this.probOn(this.blends[bandOf(tau)], best, mid);
  }

  private probOn(bl: Blend, best: Cand, mid: number | null): number {
    const fairUpP = best.side === 'long' ? best.fair : 1 - best.fair;
    const midUp = mid ?? (best.side === 'long' ? best.ask : 1 - best.ask);
    const up = blendProb(bl, fairUpP, midUp);
    return best.side === 'long' ? up : 1 - up;
  }

  // Why entries should wait right now, if they should: the exchanges disagree, bitcoin just jumped,
  // or the window spans a scheduled release.
  private guardFor(w: Win, now: number): Kind | null {
    const px = this.spot?.price ?? 0;
    if (this.feedGap != null && this.feedGap > Math.max(FEED_GAP_MIN, FEED_GAP_BP * px)) return 'feed_skips';
    if (now < this.jumpUntil) return 'jump_skips';
    if (eventFor(w.start, w.end)) return 'event_skips';
    return null;
  }

  private guardSkip(kind: Kind, w: Win, now: number) {
    const k = `${kind}|${w.slug}`;
    if (now - (this.guardAt.get(k) || 0) < 60_000) return;
    this.guardAt.set(k, now);
    this.bump(kind, now);
    if (this.guardAt.size > 500) for (const [key, at] of this.guardAt) if (now - at > 10 * MIN) this.guardAt.delete(key);
  }

  // A trade the data check refused: counted for the app, and flagged once per window side.
  private gapSkip(w: Win, best: Cand, midSide: number, f: Fair, tau: number, now: number) {
    const k = `${w.slug}|${best.side}`;
    if (now - (this.gapAt.get(k) || 0) < 60_000) return;
    this.gapAt.set(k, now);
    this.bump('gap_skips', now);
    const name = `BTC ${w.series} ${best.side === 'long' ? 'Up' : 'Down'}`;
    this.pendingStmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO signals (slug, ts, kind, side, price, ref, detail) VALUES (?,?,?,?,?,?,?)')
      .bind(w.slug, now, 'bad_data', best.side, r4(best.ask), r4(best.fair),
        `Skipped ${name}: math ${cents(best.fair)} vs market ${cents(midSide)}, too far apart to trust, ${leftText(tau)}, BTC ${Math.round(f.spot).toLocaleString('en-US')} vs ${Math.round(f.strike).toLocaleString('en-US')} start`));
  }

  // Each exchange's raw mid and age at this moment, for the trade record.
  private feedsNow(now: number) {
    const out: Record<string, { px: number; age: number } | null> = {};
    for (const fd of FEEDS) { const x = this.feed[fd]; out[fd] = x ? { px: r2(x.price), age: Math.round((now - x.ts) / 100) / 10 } : null; }
    return { ...out, basis: { cb: r2(this.basis.cb), gm: r2(this.basis.gm) } };
  }

  private allocation() { return Number(this.env.BOT_ALLOCATION || 100) || 100; }
  private ceiling(): number | null { const v = Number(this.env.BOT_MAX_BET); return v > 0 ? v : null; }
  // Real money only: the tighter of BOT_MAX_BET and LIVE_MAX_BET, so a first live run can bet small
  // without capping the paper accounts the 10-day test is measuring.
  private liveCeiling(): number | null {
    const caps = [this.ceiling(), Number(this.env.LIVE_MAX_BET) > 0 ? Number(this.env.LIVE_MAX_BET) : null].filter((x): x is number => x != null);
    return caps.length ? Math.min(...caps) : null;
  }

  private async bank(strategy: string, now: number): Promise<Bankroll> {
    const c = this.bankCache.get(strategy);
    if (c && now - c.at < 15_000) return c.bank;
    const bank = strategy === 'live'
      ? await bankroll(this.env.DB, this.allocation(), now, undefined, 'live')
      : await bankroll(this.env.DB, BY_ID.get(strategy)?.bank ?? this.allocation(), now, strategy, 'paper', BY_ID.get(strategy)?.lock ?? 0);
    this.bankCache.set(strategy, { at: now, bank });
    return bank;
  }

  private liveOn() { return this.env.LIVE_TRADING === 'on' && !!this.env.POLYMARKET_KEY_ID && !!this.env.POLYMARKET_SECRET_KEY; }
  private liveStrategy() { return this.env.LIVE_STRATEGY || 'crypto_fair_v1'; }

  private liveEvent(now: number, kind: string, slug: string | null, detail: string) {
    this.pendingStmts.push(this.env.DB.prepare('INSERT INTO live_events (ts, kind, slug, detail) VALUES (?,?,?,?)').bind(now, kind, slug, detail.slice(0, 500)));
    console.log(`live ${kind}: ${detail}`);
  }

  private async reloadOpen(now: number) {
    try {
      this.open = (await this.env.DB.prepare("SELECT * FROM bot_positions WHERE status = 'open' AND strategy LIKE 'crypto_%'").all<Position>()).results;
      if (this.open.some((p) => p.mode === 'live') || this.liveOn()) {
        const rows = (await this.env.DB.prepare(`SELECT position_id, exchange_order_id, price, status, filled_qty, reason FROM bot_orders
            WHERE mode = 'live' AND exchange_order_id IS NOT NULL AND ts > ?`).bind(now - 86_400_000).all<any>()).results;
        const openIds = new Set(this.open.filter((p) => p.mode === 'live').map((p) => p.id));
        const tp = new Map<string, { id: string; price: number }>(), recorded = new Map<string, number>();
        for (const r of rows) {
          this.liveOrderIds.add(r.exchange_order_id);
          if (r.status === 'resting' && r.reason === 'take_profit' && openIds.has(r.position_id)) tp.set(r.position_id, { id: r.exchange_order_id, price: r.price });
          if (r.status === 'filled' && String(r.reason || '').startsWith('take-profit')) recorded.set(r.exchange_order_id, (recorded.get(r.exchange_order_id) || 0) + (r.filled_qty || 0));
        }
        this.liveTp = tp;
        this.tpFilled = recorded;
      }
    } catch {}
    this.openAt = now;
  }

  // ---------- price ladders
  // "BTC above $X at <time>" for the next hourly settlement, today's 5 PM ET and Friday's 5 PM ET.
  // Once a minute, strikes near the money are priced with the same model; a side 5c+ under fair
  // (after fees) is bought. Volatility is bitcoin's realized movement over the last two hours
  // (30+ minutes of it, carried across restarts) times the tuned scale. One position per ladder,
  // and only strikes the model puts between 15% and 85%: cheap crypto tails are the most
  // overpriced contracts in the research.
  private async ladderScan(now: number) {
    const db = this.env.DB;
    const mine = () => this.open.filter((p) => p.strategy === LADDER && p.status === 'open');

    const held = mine();
    if (held.length) {
      const ms = await this.fetchMarkets([...new Set(held.map((p) => p.market_slug))], now);
      await this.serial(async () => {
        for (const m of ms) {
          if (m.status !== 'MARKET_STATUS_RESOLVED') continue;
          let prices: string[] = [];
          try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}
          const sidesArr = Array.isArray(m.marketSides) ? m.marketSides : [];
          const yes = num(prices[Math.max(0, sidesArr.findIndex((x: any) => x.long))]);
          if (yes !== 1 && yes !== 0) continue;
          for (const p of mine().filter((x) => x.market_slug === m.slug)) await settlePosition(db, p, { won: (p.side === 'long') === (yes === 1), now });
        }
        this.open = this.open.filter((p) => p.status === 'open');
        this.bankCache.delete(LADDER);
      });
    }
    const raw = this.sigmaRaw(now, 120, 30 * 60);
    const s = this.spotNow(now);
    if (raw == null || !s) return;

    const events: Array<{ ev: string; markets: any[] }> = [];
    for (const ev of ladderEvents(now)) {
      try {
        const r = await fetch(`${GATEWAY}/v1/events?slug=${ev}&_=${now}`, { headers: UA });
        if (r.ok) events.push({ ev, markets: ((((await r.json()) as any).events || [])[0]?.markets || []) as any[] });
      } catch {}
    }
    await this.serial(async () => {
      const t = Date.now();
      const spot = this.spotNow(t)?.price ?? s.price;
      for (const { ev, markets } of events) {
        for (const m of markets) {
          const apt = m.assetPriceTerms || {};
          if (apt.marketType !== 'ASSET_PRICE_MARKET_TYPE_ABOVE_BELOW' || m.status !== 'MARKET_STATUS_OPEN') continue;
          const strike = num(apt.strike);
          const end = Date.parse(apt.windowEnd || m.endDate);
          if (!strike || !Number.isFinite(end)) continue;
          const tau = (end - t) / 1000;
          const live = this.quotes.get(m.slug);
          const fresh = live && live.src === 'stream' && t - live.ts <= QUOTE_LIVE;
          const bid = fresh ? live!.bid : num(m.bestBidQuote), ask = fresh ? live!.ask : num(m.bestAskQuote);
          const fair = tau > 0 ? fairUp({ spot, strike, sigma: raw * this.mult, tau }) : null;
          if (fair == null) continue;
          const k = `$${Math.round(strike).toLocaleString('en-US')}`;
          const when = String(m.question || ev).replace(/^BTC Price at /, '');
          const held1 = mine().find((p) => p.market_slug === m.slug);
          if (held1) {
            await this.ladderExit(held1, { bid, ask }, fair, tau, spot, t, 'poll');
            continue;
          }
          if (tau < 300 || fair < 0.15 || fair > 0.85 || mine().length >= LADDER_MAX_OPEN) continue;
          if (mine().some((p) => p.market_slug.startsWith(`cpc-${ev}-`))) continue; // one per ladder
          const best = [
            ask != null ? { side: 'long' as const, ask, fair } : null,
            bid != null ? { side: 'short' as const, ask: r4(1 - bid), fair: 1 - fair } : null,
          ].filter((o): o is { side: Side; ask: number; fair: number } => !!o)
            .map((o) => ({ ...o, edge: o.fair - o.ask - feePer(o.ask) }))
            .filter((o) => o.ask >= 0.05 && o.ask <= 0.95 && o.edge >= 0.05 && o.edge <= 0.15)
            .sort((a, b) => b.edge - a.edge)[0];
          if (!best) continue;
          const bank = await this.bank(LADDER, t);
          if (dailyStopHit(bank.equity, bank.today, bank.peak)) continue;
          const stake = stakeFor({ fair: best.fair, price: best.ask, equity: bank.equity, available: bank.available, peak: bank.peak, openNet: bank.openNet, ceiling: this.ceiling() });
          const lstatus = statusOf(this.lab, LADDER);
          if (lstatus === 'retired') continue;
          const test = Math.floor(testStake({ equity: bank.equity, peak: bank.peak, available: bank.available, openNet: bank.openNet, ceiling: this.ceiling() }) / best.ask);
          const qty = lstatus === 'testing' ? test : Math.max(test, Math.floor(stake / best.ask));
          if (qty < 1) continue;
          const pos = await openPosition(db, {
            strategy: LADDER, slug: m.slug, title: `BTC at ${when}`, side: best.side,
            sideName: `BTC ${best.side === 'long' ? 'above' : 'below'} ${k}`, ask: best.ask, qty, coef: COEF,
            reason: `fair ${cents(best.fair)} vs ask ${cents(best.ask)}, BTC ${Math.round(spot).toLocaleString('en-US')}, ${Math.round(tau / 60)} min left`, now: t,
            meta: { fair: r4(best.fair), edge: r4(best.edge), spot: r2(spot), strike, end, tau: Math.round(tau), sigma: raw, mult: this.mult, equity: r2(bank.equity), rules: RULES, status: lstatus },
          });
          this.open.push(pos);
          this.bankCache.delete(LADDER);
        }
      }
    });
  }

  // A held ladder position between scans: re-checked on every stream update for its market.
  private async ladderFast(slug: string, now: number) {
    const p = this.open.find((x) => x.status === 'open' && x.strategy === LADDER && x.market_slug === slug);
    const q = this.quotes.get(slug);
    if (!p || !q || q.src !== 'stream') return;
    let meta: any = null;
    try { meta = p.meta ? JSON.parse(p.meta) : null; } catch {}
    const s = this.spotNow(now), raw = this.sigmaRaw(now, 120, 30 * 60);
    const tau = meta?.end ? (meta.end - now) / 1000 : 0;
    const fair = s && raw != null && meta?.strike && tau > 0 ? fairUp({ spot: s.price, strike: meta.strike, sigma: raw * this.mult, tau }) : null;
    await this.ladderExit(p, q, fair, tau, s?.price ?? null, now, 'stream');
  }

  private async ladderExit(p: Position, q: { bid: number | null; ask: number | null }, fair: number | null, tau: number, spot: number | null, now: number, src: Src) {
    const bidSide = p.side === 'long' ? q.bid : q.ask != null ? r4(1 - q.ask) : null;
    if (bidSide == null) return;
    if (p.take_profit != null && bidSide >= p.take_profit) {
      await closePosition(this.env.DB, p, { price: p.take_profit, coef: COEF, maker: true, reason: `take-profit at ${cents(p.take_profit)}`, now });
      this.closed(p, now);
      return;
    }
    if (fair == null || tau < 120) return;
    const fairSide = p.side === 'long' ? fair : 1 - fair;
    const key = `x|${p.id}`;
    if (bidSide < fairSide + feePer(bidSide) + 0.03) { this.seen.delete(key); return; }
    if (src === 'stream') {
      const s = this.seen.get(key);
      if (!s) { this.seen.set(key, { side: p.side, at: now }); return; }
      if (now - s.at < HOLD_FOR) return;
    }
    this.seen.delete(key);
    await closePosition(this.env.DB, p, { price: bidSide, coef: COEF, maker: false, reason: `above fair: bid ${cents(bidSide)} vs fair ${cents(fairSide)}${spot ? `, BTC ${Math.round(spot).toLocaleString('en-US')}` : ''}`, now });
    this.closed(p, now);
  }

  // ---------- settlement and grading

  // Results for windows that ended at least 2 minutes ago (up to 2 hours back).
  private async settle(now: number, stmts: D1PreparedStatement[]) {
    const { results } = await this.env.DB.prepare('SELECT slug FROM windows WHERE result IS NULL AND end_ts < ? AND end_ts > ? ORDER BY end_ts LIMIT 20')
      .bind(now - 2 * MIN, now - 120 * MIN).all<{ slug: string }>();
    if (!results.length) return;
    const markets = await this.fetchMarkets(results.map((r) => r.slug), now);
    const set = this.env.DB.prepare('UPDATE windows SET result = ?, settled_at = ? WHERE slug = ? AND result IS NULL');
    await this.serial(async () => {
      for (const m of markets) {
        if (m.status !== 'MARKET_STATUS_RESOLVED') continue;
        let prices: string[] = [];
        try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}
        const sidesArr = Array.isArray(m.marketSides) ? m.marketSides : [];
        const up = num(prices[Math.max(0, sidesArr.findIndex((s: any) => s.long))]);
        if (up !== 1 && up !== 0) continue;
        stmts.push(set.bind(up, now, m.slug));
        const held = await loadOpenBySlug(this.env.DB, m.slug);
        for (const p of held) {
          await settlePosition(this.env.DB, p, { won: (p.side === 'long') === (up === 1), now });
          this.bankCache.delete(p.mode === 'live' ? 'live' : p.strategy);
          if (p.mode === 'live') {
            this.liveTp.delete(p.id);
            this.liveEvent(now, 'settle', m.slug, `${p.side_name} ${(p.side === 'long') === (up === 1) ? 'won' : 'lost'}: ${p.qty} contracts paid $${((p.side === 'long') === (up === 1) ? p.qty : 0).toFixed(2)}`);
          }
        }
        if (held.length) this.open = this.open.filter((p) => p.market_slug !== m.slug);
        this.strike.delete(m.slug); this.official.delete(m.slug); this.hist.delete(m.slug); this.track.delete(m.slug); this.quotes.delete(m.slug);
        for (const k of this.lostIn) if (k.endsWith(`|${m.slug}`)) this.lostIn.delete(k);
      }
    });
  }

  // Grade the last week of checkpoints from settled windows and adopt the best volatility scale.
  private async tune(now: number) {
    // Only the checkpoints near each window's scoring points, a week of windows. The lookup goes
    // window by window through the (slug, ts) key, so it reads a few rows per window instead of
    // every mark of the week.
    const targets = Object.entries(SCORE_POINTS).flatMap(([series, sp]) => sp.at.map((at) => `('${series}',${at},${sp.tol})`)).join(',');
    const { results } = await this.env.DB.prepare(`WITH t(series, at, tol) AS (VALUES ${targets})
      SELECT m.slug, m.tau, m.fair, m.bid, m.ask, m.spot, m.strike, m.sigma, m.avg_obs AS avgObs, w.result
        FROM windows w JOIN t ON t.series = w.series
        JOIN crypto_marks m ON m.slug = w.slug AND m.ts BETWEEN w.end_ts - (t.at + t.tol) * 1000 AND w.end_ts - (t.at - t.tol) * 1000
        WHERE w.result IS NOT NULL AND w.end_ts > ? AND m.spot IS NOT NULL AND m.strike IS NOT NULL AND m.sigma > 0`).bind(now - 7 * 86_400_000).all<Mark>();
    const g = gradeModel(results, this.mult);
    // gradeModel only moves the scale one step, with 100+ windows and t >= 2, and only adopts a band's
    // blend once that band has 100+ windows; until then its 50/50 start stays.
    this.mult = g.next;
    if (g.bands.early.next) this.blends.early = g.bands.early.next;
    if (g.bands.late.next) this.blends.late = g.bands.late.next;
    await this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('btc_model', JSON.stringify({ ...g, mult: this.mult, active: this.blends, ready: g.bands.early.windows >= 100 && g.bands.late.windows >= 100, need: 100 }), now).run();
    // Each strategy's own record on the current rules: what it has shown per dollar bet, as a Kelly
    // share it may size on (fairvalue.ts recordKelly).
    // Fees priced at full size, like the research board (research.ts AT_SIZE_SQL).
    const rows = (await this.env.DB.prepare(AT_SIZE_SQL).bind('crypto_%', RULES)
      .all<{ strategy: string; pnl: number; cost: number; hr: number }>()).results;
    const by = new Map<string, Array<{ pnl: number; cost: number; group: number }>>();
    for (const r of rows) { const a = by.get(r.strategy) || []; a.push({ pnl: r.pnl, cost: r.cost, group: r.hr }); by.set(r.strategy, a); }
    this.records = new Map([...by].map(([id, a]) => [id, recordKelly(a)]));
    await this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('btc_records', JSON.stringify(Object.fromEntries(this.records)), now).run();
  }

  // ---------- counters for the dashboard

  private bump(kind: Kind, now: number) {
    this.counts[kind]++;
    this.lastAt[kind] = now;
  }

  private async flush(now: number) {
    if (now - this.flushedAt < FLUSH_EVERY) return;
    const secs = this.flushedAt ? (now - this.flushedAt) / 1000 : 60;
    const add = this.env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n, last = excluded.last');
    const set = this.env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, last = excluded.last');
    const stmts: D1PreparedStatement[] = [];
    for (const k of ['crypto_ticks', 'crypto_signals', 'spot', 'gap_skips', 'feed_skips', 'jump_skips', 'event_skips', 'fee_skips'] as Kind[]) if (this.counts[k]) stmts.push(add.bind(k, this.counts[k], this.lastAt[k]));
    if (this.spot) stmts.push(set.bind('btc_cents', Math.round(this.spot.price * 100), now));
    const pmLive = !!this.pm && now - this.pm.last < STREAM_STALE, cbLive = this.cbBookLive(now) || (!!this.cb && now - this.cb.last < STREAM_STALE);
    stmts.push(set.bind('pm_stream', pmLive ? Math.round((this.pmMsgs / secs) * 10) : 0, now));  // updates per 10 s
    stmts.push(set.bind('cb_stream', cbLive ? Math.round((this.cbMsgs / secs) * 10) : 0, now));
    const gmLive = !!this.gm && now - this.gm.last < STREAM_STALE;
    stmts.push(set.bind('gm_stream', gmLive ? Math.round((this.gmMsgs / secs) * 10) : 0, now));
    stmts.push(set.bind('btc_trust', Math.round(this.blends.late.b * 100), now));   // weight on the math, last 4 minutes, in hundredths
    stmts.push(set.bind('btc_trust_early', Math.round(this.blends.early.b * 100), now));   // ...with 4+ minutes left
    stmts.push(set.bind('btc_mult', Math.round(this.mult * 100), now));
    stmts.push(set.bind('replica_books', BOOK_IDS.filter((x) => now - this.bk[x].book.at <= 10_000).length, now));
    await this.env.DB.batch(stmts);
    this.counts = { crypto_ticks: 0, crypto_signals: 0, spot: 0, gap_skips: 0, feed_skips: 0, jump_skips: 0, event_skips: 0, fee_skips: 0 };
    this.pmMsgs = 0; this.cbMsgs = 0; this.gmMsgs = 0;
    this.flushedAt = now;
  }
}

// Exported for tests.
export const _strategies = CRYPTO_STRATEGIES;
export { parseWindow };
