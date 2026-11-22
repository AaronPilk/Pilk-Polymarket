// Crypto feed and the bitcoin paper traders: a Durable Object that runs around the clock for
// Polymarket US bitcoin "Up or Down" windows (5-minute, 15-minute, 1-hour) and the hourly, daily
// and weekly "BTC above $X" price ladders. It never places a real order.
//
//   Live data   Two streams stay open: Polymarket's market-data stream (best bid and ask about
//               ten times a second, signed with the dashboard's read key) and Coinbase's public
//               bitcoin ticker. Every update re-checks that market within a quarter second, so a
//               take-profit or a sell above fair happens on the move, not on the next poll.
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
//               then we use our own one-second Coinbase average, which has landed within $2.
//   Fair value  fairUp(): where bitcoin sits vs. the strike, realized volatility times a scale
//               the bot tunes itself, time left, and the averaging at the end.
//   Learning    Every 30 s each open window gets a checkpoint (what the math and the market said).
//               After settlement the checkpoints are graded: is the math sharper than the market,
//               and which volatility scale would have scored best. Every half hour the bot adopts
//               the best scale (0.7x to 2.6x) once 40+ windows have been graded.
//   Sizing      stakeFor(): Kelly on each strategy's current account ($100 start plus everything
//               won or lost), so bets grow as it grows: up to a sixth of the account per window, a quarter of what's offered at the best
//               price, and Aaron's BOT_MAX_BET when he sets one. A strategy stops for the day
//               after losing a third of what it started the day with.
//   Settlement  After a window ends, the result is read back from the gateway.

import { DurableObject } from 'cloudflare:workers';
import { fairUp, gradeModel, parseWindow, windowEnd, windowSlug, type Mark } from './cryptomath';
import { dailyStopHit, stakeFor } from './fairvalue';
import { bankroll, closePosition, loadOpenBySlug, openPosition, settlePosition, type Bankroll, type Position } from './paper';
import { signedHeaders, type PmEnv } from './polymarket';

const GATEWAY = 'https://gateway.polymarket.us';
const PM_API = 'https://api.polymarket.us';
const PM_WS_PATH = '/v1/ws/markets';
const CB_WS = 'https://ws-feed.exchange.coinbase.com';
const SPOT_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
const UA = { 'User-Agent': 'pilk-bets/1.0' };
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
const EVAL_EVERY = 250;         // each market re-checked at most 4 times a second
const HOLD_FOR = 600;           // stream trades: the price has to still be there after this long
const REENTER_AFTER = 15_000;   // after a sell, wait this long before re-entering that window
const MARK_EVERY = 30_000;
const TUNE_EVERY = 30 * MIN;
const MAX_EDGE = 0.3;           // an "edge" bigger than this is bad data, not a gift
const COEF = 0.095;             // taker fee coefficient (app rate; the API program is cheaper)
const MAX_LIVE_WINDOWS = 3;     // per strategy: one each of 5m, 15m and 1h at most
const LADDER = 'crypto_ladder_v1';
const LADDER_EVERY = 60_000;
const LADDER_MAX_OPEN = 3;
const feePer = (p: number) => COEF * p * (1 - p);

// The bitcoin lineup. Each strategy trades its own paper account of BOT_ALLOCATION dollars, so the
// results compare cleanly; the winners are the ones that would get real money.
//   crypto_fair_v1      buy a side 5c+ under the math (after fees); sell if it gets 3c over fair
//   crypto_fair_strict  same, 10c+ edge
//   crypto_fair_max     the fair_v1 picks at full size (half Kelly on the full edge), to see what
//                       bigger bets do to the swings
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
  kelly?: { fraction: number; trust: number };
}
const CRYPTO_STRATEGIES: CryptoStrategy[] = [
  { id: 'crypto_fair_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75 },
  { id: 'crypto_fair_strict', minEdge: 0.1, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75 },
  { id: 'crypto_fair_max', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15, exitAbove: 0.03, tauMin: 75, kelly: { fraction: 0.5, trust: 1 } },
  { id: 'crypto_hold_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0, exitAbove: null, tauMin: 75 },
  { id: 'crypto_double_v1', minEdge: 0.02, priceMin: 0.1, priceMax: 0.45, tpBelow: 0.46, exitAbove: null, tauMin: 90 },
  { id: 'crypto_cheap_v1', minEdge: 0.03, priceMin: 0.05, priceMax: 0.2, tpBelow: 0.2, exitAbove: 0.03, tauMin: 75 },
  { id: 'crypto_late_v1', minEdge: 0.06, priceMin: 0.05, priceMax: 0.95, tpBelow: 0, exitAbove: 0.03, tauMin: 20, tauMax: 120, live: true },
  { id: 'crypto_lag_v1', minEdge: 0.04, priceMin: 0.05, priceMax: 0.9, tpBelow: 0, exitAbove: 0.02, tauMin: 45, live: true, trigger: 'lag' },
  { id: 'crypto_fade_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0, exitAbove: 0.02, tauMin: 45, live: true, trigger: 'fade' },
];
const BY_ID = new Map(CRYPTO_STRATEGIES.map((s) => [s.id, s]));

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
}
type Side = 'long' | 'short';
type Src = 'stream' | 'poll';
type Kind = 'crypto_ticks' | 'crypto_signals' | 'spot';
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

export class CryptoFeed extends DurableObject<CryptoEnv> {
  // Spot: the latest price, 1-second samples (strike and end averages, last 10 minutes), and
  // 5-second samples (volatility, last 2 hours).
  private spot: { price: number; ts: number; src: Src } | null = null;
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
  // Streams
  private pm: Conn | null = null;
  private cb: Conn | null = null;
  private pmRetryAt = 0; private pmFails = 0;
  private cbRetryAt = 0; private cbFails = 0;
  private pmMsgs = 0; private cbMsgs = 0; private pmConnects = 0;
  // Housekeeping
  private booted = false;
  private settledAt = 0;
  private ladderAt = 0;
  private tunedAt = 0;
  private counts: Record<Kind, number> = { crypto_ticks: 0, crypto_signals: 0, spot: 0 };
  private lastAt: Record<Kind, number> = { crypto_ticks: 0, crypto_signals: 0, spot: 0 };
  private flushedAt = 0;

  async fetch(_req: Request): Promise<Response> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + 2 * MIN) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({ ok: true, alarm, spot: this.spot?.price ?? null, stream: !!this.pm, ticker: !!this.cb, mult: this.mult });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    try {
      await this.boot(now);
      await this.ensureStreams(now);
      const stmts: D1PreparedStatement[] = [];
      await this.readSpot(now, stmts);
      this.current = new Map(this.windowsAt(now).map((w) => [w.slug, w]));
      if (now - this.openAt > 30_000) await this.serial(() => this.reloadOpen(now));
      await this.recordWindows([...this.current.values()], now, stmts);
      if (now - this.settledAt >= MIN) { this.settledAt = now; await this.settle(now, stmts); }
      if (now - this.ladderAt >= LADDER_EVERY) {
        this.ladderAt = now;
        try { await this.ladderScan(now); } catch (e) { console.log('ladder error', String((e as any)?.message || e)); }
      }
      if (now - this.tunedAt >= TUNE_EVERY) {
        this.tunedAt = now;
        try { await this.tune(now); } catch (e) { console.log('tune error', String((e as any)?.message || e)); }
      }
      stmts.push(...this.pendingStmts.splice(0));
      for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      await this.flush(now);
    } catch (e) {
      console.log('crypto feed error', String((e as any)?.message || e));
    } finally {
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Math.max(now + TICK, Date.now() + 1_000));
    }
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
      if (saved?.ready && Number(saved.mult) > 0) this.mult = Number(saved.mult);
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
    if (this.env.BTC_STREAM === 'off') { this.drop('pm'); this.drop('cb'); return; }
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
    const cbOk = this.cb && now - this.cb.last < STREAM_STALE;
    if (!cbOk && now >= this.cbRetryAt) {
      try { await this.connectCb(now); this.cbFails = 0; }
      catch (e) {
        this.cbFails++;
        this.cbRetryAt = now + Math.min(60_000, 2_000 * 2 ** this.cbFails);
        console.log('ticker error', String((e as any)?.message || e));
      }
    }
  }

  private drop(which: 'pm' | 'cb') {
    const c = this[which];
    this[which] = null;
    if (c) try { c.ws.close(1000, 'off'); } catch {}
  }

  // Polymarket's market-data stream. A new window means a new subscription: open the new
  // connection first, then close the old one, so there's no gap.
  private async connectPm(slugs: string[], now: number) {
    const res = await fetch(PM_API + PM_WS_PATH, { headers: { ...(await signedHeaders(this.env as PmEnv, 'GET', PM_WS_PATH)), Upgrade: 'websocket' }, signal: AbortSignal.timeout(8_000) });
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
    this.kick(d.marketSlug);
  }

  // Coinbase's public ticker: the bitcoin mid on every trade. Each update also re-checks the open
  // windows, since a bitcoin move is exactly when the market's price goes stale.
  private async connectCb(now: number) {
    const res = await fetch(CB_WS, { headers: { ...UA, Upgrade: 'websocket' }, signal: AbortSignal.timeout(8_000) });
    const ws = res.webSocket;
    if (!ws) throw new Error(`ticker refused: HTTP ${res.status}`);
    ws.accept();
    const conn: Conn = { ws, slugs: [], at: now, last: now, n: 0 };
    ws.addEventListener('message', (e) => this.onCb(conn, e.data));
    const gone = () => { if (this.cb === conn) this.cb = null; };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    const old = this.cb;
    this.cb = conn;
    if (old) try { old.ws.close(1000, 'reconnected'); } catch {}
  }

  private onCb(conn: Conn, data: unknown) {
    const now = Date.now();
    conn.last = now; conn.n++; this.cbMsgs++;
    if (typeof data !== 'string') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j?.type !== 'ticker') return;
    const bid = Number(j.best_bid), ask = Number(j.best_ask), px = Number(j.price);
    const price = bid > 0 && ask >= bid ? (bid + ask) / 2 : px;
    if (!(price > 0)) return;
    this.spot = { price, ts: now, src: 'stream' };
    this.sample(now, price);
    for (const slug of this.current.keys()) this.kick(slug);
  }

  private sample(now: number, price: number) {
    const sec = Math.floor(now / 1000);
    if (sec === this.lastSec) return;
    this.lastSec = sec;
    this.spotSec.push([now, price]);
    while (this.spotSec.length && this.spotSec[0][0] < now - 10 * MIN) this.spotSec.shift();
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
      try {
        const res = await fetch(SPOT_URL, { headers: UA });
        if (res.ok) price = num(((await res.json()) as any).price);
      } catch {}
      if (price != null) { this.spot = { price, ts: now, src: 'poll' }; this.sample(now, price); }
    }
    if (price == null) return null;
    this.spotHist.push([now, price]);
    while (this.spotHist.length && this.spotHist[0][0] < now - 120 * MIN) this.spotHist.shift();
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
    if (k != null) this.pendingStmts.push(this.env.DB.prepare('UPDATE windows SET strike = ? WHERE slug = ? AND strike IS NULL').bind(k, w.slug));
  }

  private fairFor(w: Win, now: number): Fair | null {
    const s = this.spotNow(now);
    if (!s) return null;
    this.ensureStrike(w, now);
    const strike = this.strike.get(w.slug);
    const raw = this.sigmaRaw(now);
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
        stmts.push(this.env.DB.prepare('UPDATE windows SET strike = ? WHERE slug = ?').bind(k, m.slug));
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
      await this.exitWindow(p, q, f?.fair ?? null, tau, now, src);
    }
    if (!f) return;

    const live = q.src === 'stream' && now - q.ts <= QUOTE_LIVE && f.live;
    const len = (w.end - w.start) / 1000;
    for (const st of CRYPTO_STRATEGIES) {
      const key = `${st.id}|${w.slug}`;
      if ((st.live && !live) || tau < st.tauMin || tau > (st.tauMax ?? len - 30)) { this.seen.delete(key); continue; }
      const mine = this.open.filter((x) => x.status === 'open' && x.strategy === st.id);
      if (mine.some((x) => x.market_slug === w.slug)) continue;
      if (mine.filter((x) => (windowEnd(x.market_slug) ?? 0) > now).length >= MAX_LIVE_WINDOWS) continue;
      if (now - (this.exitedAt.get(key) || 0) < REENTER_AFTER) continue;

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
      // On the stream, the price has to still be there 0.6 s later, like a real order landing.
      if (src === 'stream') {
        const s = this.seen.get(key);
        if (!s || s.side !== best.side) { this.seen.set(key, { side: best.side, at: now }); continue; }
        if (now - s.at < HOLD_FOR) continue;
      }
      this.seen.delete(key);

      const bank = await this.bank(st.id, now);
      if (dailyStopHit(bank.equity, bank.today)) continue;
      const stake = stakeFor({
        fair: best.fair, price: best.ask, equity: bank.equity, available: bank.available,
        fraction: st.kelly?.fraction, trust: st.kelly?.trust, depth: best.depth, ceiling: this.ceiling(),
      });
      const qty = Math.floor(stake / best.ask);
      if (qty < 1) continue;
      const pos = await openPosition(this.env.DB, {
        strategy: st.id, slug: w.slug, title: `BTC Up or Down ${w.series}`, side: best.side,
        sideName: `BTC ${w.series} ${best.side === 'long' ? 'Up' : 'Down'}`, ask: best.ask, qty, coef: COEF,
        reason: `fair ${cents(best.fair)} vs ask ${cents(best.ask)}, ${leftText(tau)}${src === 'stream' ? ', live' : ''}`, now, tpBelow: st.tpBelow,
        meta: { fair: r4(best.fair), edge: r4(best.edge), spot: r2(f.spot), strike: r2(f.strike), tau: Math.round(tau), sigma: f.sigma, mult: this.mult, src, equity: r2(bank.equity) },
      });
      this.open.push(pos);
      this.bankCache.delete(st.id);
    }
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
    if (!st || st.exitAbove == null || fair == null || tau < (st.tauMax != null ? 8 : 20)) return;
    const fairSide = p.side === 'long' ? fair : 1 - fair;
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
    this.exitedAt.set(`${p.strategy}|${p.market_slug}`, now);
    this.bankCache.delete(p.strategy);
    this.open = this.open.filter((x) => x.status === 'open');
  }

  private allocation() { return Number(this.env.BOT_ALLOCATION || 100) || 100; }
  private ceiling(): number | null { const v = Number(this.env.BOT_MAX_BET); return v > 0 ? v : null; }

  private async bank(strategy: string, now: number): Promise<Bankroll> {
    const c = this.bankCache.get(strategy);
    if (c && now - c.at < 15_000) return c.bank;
    const bank = await bankroll(this.env.DB, this.allocation(), now, strategy);
    this.bankCache.set(strategy, { at: now, bank });
    return bank;
  }

  private async reloadOpen(now: number) {
    try {
      this.open = (await this.env.DB.prepare("SELECT * FROM bot_positions WHERE mode = 'paper' AND status = 'open' AND strategy LIKE 'crypto_%'").all<Position>()).results;
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
          if (dailyStopHit(bank.equity, bank.today)) continue;
          const stake = stakeFor({ fair: best.fair, price: best.ask, equity: bank.equity, available: bank.available, ceiling: this.ceiling() });
          const qty = Math.floor(stake / best.ask);
          if (qty < 1) continue;
          const pos = await openPosition(db, {
            strategy: LADDER, slug: m.slug, title: `BTC at ${when}`, side: best.side,
            sideName: `BTC ${best.side === 'long' ? 'above' : 'below'} ${k}`, ask: best.ask, qty, coef: COEF,
            reason: `fair ${cents(best.fair)} vs ask ${cents(best.ask)}, BTC ${Math.round(spot).toLocaleString('en-US')}, ${Math.round(tau / 60)} min left`, now: t,
            meta: { fair: r4(best.fair), edge: r4(best.edge), spot: r2(spot), strike, end, tau: Math.round(tau), sigma: raw, mult: this.mult, equity: r2(bank.equity) },
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
        for (const p of held) { await settlePosition(this.env.DB, p, { won: (p.side === 'long') === (up === 1), now }); this.bankCache.delete(p.strategy); }
        if (held.length) this.open = this.open.filter((p) => p.market_slug !== m.slug);
        this.strike.delete(m.slug); this.official.delete(m.slug); this.hist.delete(m.slug); this.track.delete(m.slug); this.quotes.delete(m.slug);
      }
    });
  }

  // Grade the last week of checkpoints from settled windows and adopt the best volatility scale.
  private async tune(now: number) {
    const { results } = await this.env.DB.prepare(`SELECT m.slug, m.tau, m.fair, m.bid, m.ask, m.spot, m.strike, m.sigma, m.avg_obs AS avgObs, w.result
        FROM crypto_marks m JOIN windows w ON w.slug = m.slug
        WHERE w.result IS NOT NULL AND m.ts > ? AND m.spot IS NOT NULL AND m.strike IS NOT NULL AND m.sigma > 0
        ORDER BY m.ts DESC LIMIT 6000`).bind(now - 7 * 86_400_000).all<Mark>();
    const g = gradeModel(results, this.mult);
    const ready = g.windows >= 40 && g.marks >= 400;
    if (ready) this.mult = g.next;
    await this.env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind('btc_model', JSON.stringify({ ...g, mult: this.mult, ready, need: 40 }), now).run();
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
    for (const k of ['crypto_ticks', 'crypto_signals', 'spot'] as Kind[]) if (this.counts[k]) stmts.push(add.bind(k, this.counts[k], this.lastAt[k]));
    if (this.spot) stmts.push(set.bind('btc_cents', Math.round(this.spot.price * 100), now));
    const pmLive = !!this.pm && now - this.pm.last < STREAM_STALE, cbLive = !!this.cb && now - this.cb.last < STREAM_STALE;
    stmts.push(set.bind('pm_stream', pmLive ? Math.round((this.pmMsgs / secs) * 10) : 0, now));  // updates per 10 s
    stmts.push(set.bind('cb_stream', cbLive ? Math.round((this.cbMsgs / secs) * 10) : 0, now));
    stmts.push(set.bind('btc_mult', Math.round(this.mult * 100), now));
    await this.env.DB.batch(stmts);
    this.counts = { crypto_ticks: 0, crypto_signals: 0, spot: 0 };
    this.pmMsgs = 0; this.cbMsgs = 0;
    this.flushedAt = now;
  }
}

// Exported for tests.
export const _strategies = CRYPTO_STRATEGIES;
export { parseWindow };
