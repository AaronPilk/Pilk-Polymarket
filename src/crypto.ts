// Crypto windows feed. A second Durable Object that runs around the clock for Polymarket US
// bitcoin "Up or Down" markets in 5-minute, 15-minute and 1-hour windows. Read-only.
//
//   Every 5 s   One batched quote call for the open windows (cache-busted) and one bitcoin
//               spot price from Coinbase. A tick row when a window's quote changes, a spot row
//               when the price changes.
//   Strike      A window settles Up if the CF Benchmarks index (60 readings in the final minute)
//               ends at or above the same average taken in the minute before the window opened.
//               We estimate that start average from our own spot readings in that minute.
//   Fair value  The chance of Up from where bitcoin sits vs. the strike, how fast it has been
//               moving, and the time left, including the averaging at the end. See fairUp().
//   Signals     cheap_spike: a side under 15c up 50% within the lookback (the cash-out move).
//               fair_gap: a side priced 10c+ below what the math says.
//   Settlement  After a window ends, the result is read back from the gateway.

import { DurableObject } from 'cloudflare:workers';
import { fairUp, windowEnd, windowSlug } from './cryptomath';
import { kellyStake } from './fairvalue';
import { bankroll, closePosition, loadOpen, loadOpenBySlug, openPosition, settlePosition, type Position } from './paper';

const GATEWAY = 'https://gateway.polymarket.us';
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

// Paper traders, each with its own $30 account: buy a side priced under the math (after fees),
// sized by quarter Kelly, at most $3 per window and 2 live windows at once. Sell if the bid
// climbs 3c (after fees) above fair, or at the 2x take-profit on cheap entries; otherwise hold
// to the result.
//   crypto_fair_v1      5c+ edge
//   crypto_fair_strict  10c+ edge
//   crypto_cheap_v1     his idea: a cheap side (under 20c) the math doesn't call overpriced
//                       (3c+ edge), with a 2x sell order from the fill
interface CryptoStrategy { id: string; minEdge: number; priceMin: number; priceMax: number; tpBelow: number }
const CRYPTO_STRATEGIES: CryptoStrategy[] = [
  { id: 'crypto_fair_v1', minEdge: 0.05, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15 },
  { id: 'crypto_fair_strict', minEdge: 0.1, priceMin: 0.05, priceMax: 0.9, tpBelow: 0.15 },
  { id: 'crypto_cheap_v1', minEdge: 0.03, priceMin: 0.05, priceMax: 0.2, tpBelow: 0.2 },
];
const COEF = 0.095;               // taker fee coefficient (app rate; API program is cheaper)
const MAX_PER_WINDOW = 3;
const MAX_LIVE_WINDOWS = 2;
const DAILY_STOP = 10;
const feePer = (p: number) => COEF * p * (1 - p);

interface CryptoEnv { DB: D1Database; BOT_ALLOCATION?: string }
type Side = 'long' | 'short';
type Kind = 'crypto_ticks' | 'crypto_signals' | 'spot';

interface Window { slug: string; series: string; start: number; end: number; lookback: number }

const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : null;
};
const cents = (x: number) => `${Math.round(x * 100)}¢`;
const pad = (n: number) => String(n).padStart(2, '0');

export class CryptoFeed extends DurableObject<CryptoEnv> {
  private spotHist: Array<[number, number]> = [];          // [ts, price], last 20 minutes
  private hist = new Map<string, Array<[number, number]>>(); // slug → [ts, mid]
  private lastQuote = new Map<string, string>();
  private strike = new Map<string, number | null>();
  private known = new Set<string>();
  private signalAt = new Map<string, number>();
  private lastSpot: number | null = null;
  private settledAt = 0;
  private open: Position[] = [];
  private openAt = 0;
  private counts: Record<Kind, number> = { crypto_ticks: 0, crypto_signals: 0, spot: 0 };
  private lastAt: Record<Kind, number> = { crypto_ticks: 0, crypto_signals: 0, spot: 0 };
  private flushedAt = 0;

  async fetch(_req: Request): Promise<Response> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + 2 * MIN) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({ ok: true, alarm, spot: this.lastSpot });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    try {
      const stmts: D1PreparedStatement[] = [];
      const spot = await this.readSpot(now, stmts);
      const windows = SERIES.map((s) => {
        const len = s.mins * MIN;
        const start = Math.floor(now / len) * len;
        return { slug: windowSlug(ASSET, s.key, start), series: s.key, start, end: start + len, lookback: s.lookback };
      });
      if (now - this.openAt > 30_000) {
        try {
          const all: Position[] = [];
          for (const st of CRYPTO_STRATEGIES) all.push(...(await loadOpen(this.env.DB, st.id)));
          this.open = all;
        } catch {}
        this.openAt = now;
      }
      await this.recordWindows(windows, spot, now, stmts);
      if (now - this.settledAt >= MIN) { this.settledAt = now; await this.settle(now, stmts); }
      for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      await this.flush(now);
    } catch (e) {
      console.log('crypto feed error', String((e as any)?.message || e));
    } finally {
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Math.max(now + TICK, Date.now() + 1_000));
    }
  }

  private async readSpot(now: number, stmts: D1PreparedStatement[]): Promise<number | null> {
    let price: number | null = null;
    try {
      const res = await fetch(SPOT_URL, { headers: UA });
      if (res.ok) price = num(((await res.json()) as any).price);
    } catch {}
    if (price == null) return null;
    this.spotHist.push([now, price]);
    while (this.spotHist.length && this.spotHist[0][0] < now - 20 * MIN) this.spotHist.shift();
    if (price !== this.lastSpot) {
      this.lastSpot = price;
      stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO spot (asset, ts, price) VALUES (?,?,?)').bind(ASSET, now, price));
      this.bump('spot', now);
    }
    return price;
  }

  // Volatility per sqrt(second) from spot readings over the last 15 minutes.
  private sigma(now: number): number | null {
    let sum = 0, time = 0;
    const h = this.spotHist.filter(([ts]) => ts >= now - 15 * MIN);
    for (let i = 1; i < h.length; i++) {
      const dt = (h[i][0] - h[i - 1][0]) / 1000;
      if (dt <= 0 || dt > 30) continue;
      const r = Math.log(h[i][1] / h[i - 1][1]);
      sum += r * r;
      time += dt;
    }
    return time >= 120 ? Math.sqrt(sum / time) : null;
  }

  private avgSpot(from: number, to: number): { avg: number; n: number } | null {
    const pts = this.spotHist.filter(([ts]) => ts >= from && ts < to);
    if (!pts.length) return null;
    return { avg: pts.reduce((a, [, p]) => a + p, 0) / pts.length, n: pts.length };
  }

  private async recordWindows(windows: Window[], spot: number | null, now: number, stmts: D1PreparedStatement[]) {
    const qs = windows.map((w) => `slug=${encodeURIComponent(w.slug)}`).join('&');
    let markets: any[] = [];
    try {
      const res = await fetch(`${GATEWAY}/v1/markets?${qs}&limit=${windows.length}&_=${now}`, { headers: UA });
      if (res.ok) markets = (((await res.json()) as any).markets || []) as any[];
    } catch {}
    const bySlug = new Map(markets.map((m) => [m.slug, m]));
    const tick = this.env.DB.prepare('INSERT OR IGNORE INTO ticks (slug, ts, bid, ask, last, vol, bid_depth, ask_depth, state) VALUES (?,?,?,?,?,?,?,?,?)');
    const sig = this.env.DB.prepare('INSERT OR IGNORE INTO signals (slug, ts, kind, side, price, ref, detail) VALUES (?,?,?,?,?,?,?)');
    const sigma = this.sigma(now);

    for (const w of windows) {
      if (!this.known.has(w.slug)) {
        this.known.add(w.slug);
        stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO windows (slug, asset, series, start_ts, end_ts) VALUES (?,?,?,?,?)')
          .bind(w.slug, ASSET, w.series, w.start, w.end));
      }
      // Strike: our average of the minute before the window opened (needs readings from then).
      if (!this.strike.has(w.slug) && now >= w.start) {
        const pre = this.avgSpot(w.start - MIN, w.start);
        const k = pre && pre.n >= 3 ? pre.avg : null;
        this.strike.set(w.slug, k);
        if (k != null) stmts.push(this.env.DB.prepare('UPDATE windows SET strike = ? WHERE slug = ? AND strike IS NULL').bind(k, w.slug));
      }

      const m = bySlug.get(w.slug);
      if (!m) continue;
      const bid = num(m.bestBidQuote), ask = num(m.bestAskQuote);
      const mid = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? null;
      const status = m.status || null;
      const key = `${bid}|${ask}|${status}`;
      if (this.lastQuote.get(w.slug) !== key) {
        this.lastQuote.set(w.slug, key);
        stmts.push(tick.bind(w.slug, now, bid, ask, null, null, null, null, status));
        this.bump('crypto_ticks', now);
      }
      if (mid == null || status !== 'MARKET_STATUS_OPEN') continue;
      const h = this.hist.get(w.slug) || [];
      h.push([now, mid]);
      while (h.length && h[0][0] < now - 10 * MIN) h.shift();
      this.hist.set(w.slug, h);

      const tau = (w.end - now) / 1000;
      const k = this.strike.get(w.slug) ?? null;
      const fair = spot != null && k != null && sigma != null
        ? fairUp({ spot, strike: k, sigma, tau, avgObs: tau < 60 ? this.avgSpot(w.end - MIN, now)?.avg ?? null : null })
        : null;
      const left = `${Math.floor(tau / 60)}:${pad(Math.floor(tau % 60))} left`;
      const where = spot != null && k != null ? `, BTC ${Math.round(spot).toLocaleString('en-US')} vs ${Math.round(k).toLocaleString('en-US')} start` : '';
      const name = (side: Side) => `BTC ${w.series} ${side === 'long' ? 'Up' : 'Down'}`;
      const fire = (kind: string, side: Side, price: number | null, ref: number | null, detail: string) => {
        const ck = `${w.slug}|${kind}|${side}`;
        if (now - (this.signalAt.get(ck) || 0) < SIGNAL_COOLDOWN) return;
        this.signalAt.set(ck, now);
        const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10_000) / 10_000);
        stmts.push(sig.bind(w.slug, now, kind, side, r4(price), r4(ref), detail));
        this.bump('crypto_signals', now);
      };

      // Cheap side spiking: the cash-out move.
      const past = this.midAgo(w.slug, now, w.lookback);
      if (past != null) {
        for (const side of ['long', 'short'] as Side[]) {
          const was = side === 'long' ? past : 1 - past;
          const nowP = side === 'long' ? mid : 1 - mid;
          const sellAt = side === 'long' ? bid : ask != null ? 1 - ask : null;
          if (was < 0.15 && nowP >= was * 1.5 && nowP - was >= 0.03) {
            fire('cheap_spike', side, sellAt, was, `${name(side)} ${cents(was)} → ${cents(nowP)}, ${left}${where}`);
          }
        }
      }
      // Price vs. the math: a side's ask 10c or more under its fair value.
      if (fair != null && tau > 20) {
        const upAsk = ask, downAsk = bid != null ? 1 - bid : null;
        if (upAsk != null && fair - upAsk >= 0.1) fire('fair_gap', 'long', upAsk, fair, `${name('long')} ask ${cents(upAsk)} vs fair ${cents(fair)}, ${left}${where}`);
        if (downAsk != null && (1 - fair) - downAsk >= 0.1) fire('fair_gap', 'short', downAsk, 1 - fair, `${name('short')} ask ${cents(downAsk)} vs fair ${cents(1 - fair)}, ${left}${where}`);
      }
      try { await this.paper(w, { bid, ask, fair, tau, left }, now); } catch (e) { console.log('crypto paper error', String((e as any)?.message || e)); }
    }
  }

  private async paper(w: Window, q: { bid: number | null; ask: number | null; fair: number | null; tau: number; left: string }, now: number) {
    const db = this.env.DB;
    // Exits first, for anything held on this window.
    for (const p of this.open.filter((x) => x.market_slug === w.slug && x.status === 'open')) {
      const bidSide = p.side === 'long' ? q.bid : q.ask != null ? 1 - q.ask : null;
      if (bidSide == null) continue;
      if (p.take_profit != null && bidSide >= p.take_profit) {
        await closePosition(db, p, { price: p.take_profit, coef: COEF, maker: true, reason: `take-profit at ${cents(p.take_profit)}`, now });
        continue;
      }
      const fairSide = q.fair == null ? null : p.side === 'long' ? q.fair : 1 - q.fair;
      if (fairSide != null && q.tau >= 20 && bidSide >= fairSide + feePer(bidSide) + 0.03) {
        await closePosition(db, p, { price: bidSide, coef: COEF, maker: false, reason: `above fair: bid ${cents(bidSide)} vs fair ${cents(fairSide)}, ${q.left}`, now });
      }
    }
    this.open = this.open.filter((x) => x.status === 'open');

    // Entries, per strategy: one position per window each, never in the first 30 s or the last 75 s.
    if (q.fair == null || q.tau < 75 || q.tau > (w.end - w.start) / 1000 - 30) return;
    const allocation = Number(this.env.BOT_ALLOCATION || 30) || 30;
    for (const st of CRYPTO_STRATEGIES) {
      const mine = this.open.filter((x) => x.strategy === st.id);
      if (mine.some((x) => x.market_slug === w.slug)) continue;
      if (mine.filter((x) => (windowEnd(x.market_slug) ?? 0) > now).length >= MAX_LIVE_WINDOWS) continue;
      const best = [
        q.ask != null ? { side: 'long' as const, ask: q.ask, fair: q.fair } : null,
        q.bid != null ? { side: 'short' as const, ask: +(1 - q.bid).toFixed(4), fair: 1 - q.fair } : null,
      ].filter((o): o is { side: 'long' | 'short'; ask: number; fair: number } => !!o)
        .map((o) => ({ ...o, edge: o.fair - o.ask - feePer(o.ask) }))
        .filter((o) => o.ask >= st.priceMin && o.ask <= st.priceMax && o.edge >= st.minEdge)
        .sort((a, b) => b.edge - a.edge)[0];
      if (!best) continue;
      const bank = await bankroll(db, allocation, now, st.id);
      if (bank.today <= -DAILY_STOP) continue;
      const stake = Math.min(kellyStake(best.fair, best.ask, bank.equity), MAX_PER_WINDOW, bank.available);
      const qty = Math.floor(stake / best.ask);
      if (qty < 1) continue;
      const pos = await openPosition(db, {
        strategy: st.id, slug: w.slug, title: `BTC Up or Down ${w.series}`, side: best.side,
        sideName: `BTC ${w.series} ${best.side === 'long' ? 'Up' : 'Down'}`, ask: best.ask, qty, coef: COEF,
        reason: `fair ${cents(best.fair)} vs ask ${cents(best.ask)}, ${q.left}`, now, tpBelow: st.tpBelow,
      });
      this.open.push(pos);
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

  // Results for windows that ended at least 2 minutes ago (up to 2 hours back).
  private async settle(now: number, stmts: D1PreparedStatement[]) {
    const { results } = await this.env.DB.prepare('SELECT slug FROM windows WHERE result IS NULL AND end_ts < ? AND end_ts > ? ORDER BY end_ts LIMIT 20')
      .bind(now - 2 * MIN, now - 120 * MIN).all<{ slug: string }>();
    if (!results.length) return;
    const qs = results.map((r) => `slug=${encodeURIComponent(r.slug)}`).join('&');
    const res = await fetch(`${GATEWAY}/v1/markets?${qs}&limit=${results.length}&_=${now}`, { headers: UA });
    if (!res.ok) return;
    const set = this.env.DB.prepare('UPDATE windows SET result = ?, settled_at = ? WHERE slug = ? AND result IS NULL');
    for (const m of (((await res.json()) as any).markets || []) as any[]) {
      if (m.status !== 'MARKET_STATUS_RESOLVED') continue;
      let prices: string[] = [];
      try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}
      const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
      const longIdx = Math.max(0, sides.findIndex((s: any) => s.long));
      const up = num(prices[longIdx]);
      if (up !== 1 && up !== 0) continue;
      stmts.push(set.bind(up, now, m.slug));
      const held = await loadOpenBySlug(this.env.DB, m.slug);
      for (const p of held) await settlePosition(this.env.DB, p, { won: (p.side === 'long') === (up === 1), now });
      if (held.length) this.open = this.open.filter((p) => p.market_slug !== m.slug);
    }
  }

  private bump(kind: Kind, now: number) {
    this.counts[kind]++;
    this.lastAt[kind] = now;
  }

  private async flush(now: number) {
    if (now - this.flushedAt < FLUSH_EVERY) return;
    const add = this.env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n, last = excluded.last');
    const set = this.env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, last = excluded.last');
    const stmts: D1PreparedStatement[] = [];
    for (const k of ['crypto_ticks', 'crypto_signals', 'spot'] as Kind[]) if (this.counts[k]) stmts.push(add.bind(k, this.counts[k], this.lastAt[k]));
    if (this.lastSpot != null) stmts.push(set.bind('btc_cents', Math.round(this.lastSpot * 100), now));
    if (stmts.length) await this.env.DB.batch(stmts);
    this.counts = { crypto_ticks: 0, crypto_signals: 0, spot: 0 };
    this.flushedAt = now;
  }
}
