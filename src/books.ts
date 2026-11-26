// Pregame order-book recorder (Nov 26). Recording only: nothing here places an order, feeds a strategy or
// touches the 10-day test. Its own Durable Object, so a bug here can't stall the Sports bot.
//
// Why: Aaron saw the Polymarket app chart spike before tip-off (Georgetown vs Texas, Nov 26) and asked whether
// a bot could catch those moves. The chart alone can't answer it: on one book the two sides must add to about
// 100¢, and in that screenshot one line jumped while the other stayed flat, which looks like a drawing problem,
// not a trade. Real dips do happen in thin pregame books, but the only way to get one is an order already
// resting there, and those orders fill most often when the drop is real news (a starter out). The recorder
// keeps what's needed to tell the two apart and to replay resting bids with an honest fill model:
//
//   book_quotes  every change of best bid / ask / the app's displayed price (currentPx) / state, and depth or
//                last-trade changes at most every 5 s per game (MARKET_DATA_LITE)
//   book_levels  the top 8 price levels each side (MARKET_DATA): on every change of the best price, otherwise
//                at most every 10 s per game. Queue size at each price is what a fill model needs.
//   book_trades  every trade print with the taker's side (TRADE). Spikes that really traded show up here.
//
// Basketball (NBA and college) from 6 hours before tip-off to 15 minutes after, so the tip-off handover is
// covered too. One Polymarket stream connection, up to 100 games per subscription (their limit). BOOKS=off or
// SPORTS=off puts it to sleep. Rows older than 30 days are deleted hourly; a daily row cap protects D1.

import { DurableObject } from 'cloudflare:workers';
import { signedHeaders, type PmEnv } from './polymarket';

interface BooksEnv extends PmEnv { DB: D1Database; SPORTS?: string; BOOKS?: string }

const PM_API = 'https://api.polymarket.us';
const PM_WS_PATH = '/v1/ws/markets';
const MIN = 60_000;
const HOUR = 60 * MIN;
export const BOOK_LEAGUES = ['nba', 'cbb'];
export const PRE_WINDOW = 6 * HOUR;      // start recording this long before tip-off
export const POST_WINDOW = 15 * MIN;     // ...and stop this long after
const TICK = 5_000;                      // alarm loop while any game is in the window
const RELOAD_EVERY = MIN;                // re-read which games are in the window
const QUIET_RECONNECT = 5 * MIN;         // no message at all on the connection for this long: reconnect
const QUOTE_SIDE_EVERY = 5_000;          // depth / last-trade only changes: at most one row per game per 5 s
const LEVELS_EVERY = 10_000;             // book shape changes without a new best price: one row per game per 10 s
const LEVELS_KEEP = 8;                   // price levels kept per side
const SLUGS_PER_SUB = 100;               // Polymarket's limit per subscription
const MAX_SLEEP = 5 * MIN;
const KEEP_DAYS = 30;
export const DAY_CAP = 1_500_000;        // rows a day across the three tables; quotes and levels stop first
const MAX_PARAMS = 100;                  // D1's bound-parameter limit per statement
const SUB_TYPES = ['SUBSCRIPTION_TYPE_MARKET_DATA_LITE', 'SUBSCRIPTION_TYPE_MARKET_DATA', 'SUBSCRIPTION_TYPE_TRADE'] as const;

export const BOOKS_DDL = [
  `CREATE TABLE IF NOT EXISTS book_quotes (slug TEXT NOT NULL, ts INTEGER NOT NULL, bid REAL, ask REAL, bid_depth REAL, ask_depth REAL,
    cur REAL, last REAL, vol REAL, state TEXT, pre INTEGER, PRIMARY KEY (slug, ts))`,
  `CREATE TABLE IF NOT EXISTS book_levels (slug TEXT NOT NULL, ts INTEGER NOT NULL, bids TEXT, asks TEXT, pre INTEGER, PRIMARY KEY (slug, ts))`,
  `CREATE TABLE IF NOT EXISTS book_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, ts INTEGER NOT NULL, recv INTEGER,
    price REAL, qty REAL, taker_side TEXT, taker_intent TEXT, maker_intent TEXT, pre INTEGER)`,
  'CREATE INDEX IF NOT EXISTS idx_book_trades_slug ON book_trades(slug, ts)',
];

const COLS = {
  book_quotes: ['slug', 'ts', 'bid', 'ask', 'bid_depth', 'ask_depth', 'cur', 'last', 'vol', 'state', 'pre'],
  book_levels: ['slug', 'ts', 'bids', 'asks', 'pre'],
  book_trades: ['slug', 'ts', 'recv', 'price', 'qty', 'taker_side', 'taker_intent', 'maker_intent', 'pre'],
} as const;
type Table = keyof typeof COLS;
type Val = string | number | null;

export const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : null;
};

// [[price, qty], ...] best first, at most LEVELS_KEEP, from the stream's [{px: {value}, qty}] levels.
export function topLevels(levels: any): Array<[number, number]> {
  if (!Array.isArray(levels)) return [];
  const out: Array<[number, number]> = [];
  for (const l of levels) {
    const px = num(l?.px), qty = num(l?.qty);
    if (px == null || qty == null) continue;
    out.push([px, qty]);
    if (out.length >= LEVELS_KEEP) break;
  }
  return out;
}

// Multi-row inserts under D1's parameter limit.
export function insertsFor(table: Table, rows: Val[][]): Array<{ sql: string; params: Val[] }> {
  const cols = COLS[table];
  const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const one = `(${cols.map(() => '?').join(',')})`;
  const verb = table === 'book_trades' ? 'INSERT' : 'INSERT OR IGNORE';
  const out: Array<{ sql: string; params: Val[] }> = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push({ sql: `${verb} INTO ${table} (${cols.join(', ')}) VALUES ${chunk.map(() => one).join(', ')}`, params: chunk.flat() });
  }
  return out;
}

// Which games to watch at `now`: basketball from PRE_WINDOW before tip-off to POST_WINDOW after.
export function inWindow(gameStart: string, now: number): boolean {
  const t = Date.parse(gameStart);
  return Number.isFinite(t) && now >= t - PRE_WINDOW && now <= t + POST_WINDOW;
}

interface Game { slug: string; start: number }
interface Conn { ws: WebSocket; slugs: string[]; at: number; last: number; n: number }
interface LastQuote { key: string; side: string; at: number }
// key / best: the shape and best prices of the last row written; pending: a newer shape waiting out the 10 s.
interface LastLevels { best: string; key: string; at: number; pending: { ts: number; bids: string; asks: string; key: string; best: string } | null }

export class BookFeed extends DurableObject<BooksEnv> {
  private games = new Map<string, Game>();
  private gamesAt = 0;
  private conn: Conn | null = null;
  private connects = 0;
  private lastQuote = new Map<string, LastQuote>();
  private lastLevels = new Map<string, LastLevels>();
  private buf: Record<Table, Val[][]> = { book_quotes: [], book_levels: [], book_trades: [] };
  private written: Record<Table, number> = { book_quotes: 0, book_levels: 0, book_trades: 0 };
  private msgs: Record<string, number> = { lite: 0, full: 0, trade: 0, other: 0 };
  private day = '';
  private dayRows = 0;
  private capped = false;
  private ready = false;
  private cleanedAt = 0;
  private statsAt = 0;
  private others: string[] = [];          // the first few messages we didn't recognise (subscription answers, errors)
  private errors: string[] = [];

  async fetch(req: Request): Promise<Response> {
    const off = this.env.SPORTS === 'off' || this.env.BOOKS === 'off';
    if (off) { await this.ctx.storage.deleteAlarm(); this.drop(); return Response.json({ ok: true, books: 'off' }); }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + MAX_SLEEP) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    if (new URL(req.url).pathname === '/status') return Response.json(this.status());
    return Response.json({ ok: true, alarm, games: this.games.size, stream: !!this.conn });
  }

  private status() {
    const now = Date.now();
    return {
      games: [...this.games.values()].map((g) => ({ slug: g.slug, minsToTip: Math.round((g.start - now) / MIN) })),
      stream: this.conn ? { slugs: this.conn.slugs.length, since: new Date(this.conn.at).toISOString(), lastMsgSecs: Math.round((now - this.conn.last) / 1000), msgs: this.conn.n } : null,
      connects: this.connects, msgs: this.msgs, written: this.written, buffered: { q: this.buf.book_quotes.length, l: this.buf.book_levels.length, t: this.buf.book_trades.length },
      day: this.day, dayRows: this.dayRows, capped: this.capped, others: this.others, errors: this.errors,
    };
  }

  async alarm(): Promise<void> {
    if (this.env.SPORTS === 'off' || this.env.BOOKS === 'off') { this.drop(); return; }
    const now = Date.now();
    let next = now + TICK;
    try {
      if (!this.ready) { for (const sql of BOOKS_DDL) await this.env.DB.prepare(sql).run(); this.ready = true; }
      if (now - this.gamesAt >= RELOAD_EVERY || !this.games.size) await this.loadGames(now);
      if (!this.games.size) {
        this.drop();
        await this.flush(now);
        next = await this.nextWake(now);
      } else {
        await this.ensureStream(now);
        this.duePending(now);
        await this.flush(now);
      }
      if (now - this.cleanedAt >= HOUR) await this.cleanup(now);
    } catch (e) {
      this.note('alarm', e);
    } finally {
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000));
    }
  }

  private async loadGames(now: number) {
    this.gamesAt = now;
    const { results } = await this.env.DB.prepare(
      `SELECT slug, game_start FROM markets WHERE result IS NULL AND league IN (${BOOK_LEAGUES.map(() => '?').join(',')})
         AND game_start <= ? AND game_start >= ? ORDER BY game_start`,
    ).bind(...BOOK_LEAGUES, new Date(now + PRE_WINDOW).toISOString(), new Date(now - POST_WINDOW).toISOString())
      .all<{ slug: string; game_start: string }>();
    this.games = new Map(results.filter((r) => inWindow(r.game_start, now)).map((r) => [r.slug, { slug: r.slug, start: Date.parse(r.game_start) }]));
  }

  private async nextWake(now: number): Promise<number> {
    const r = await this.env.DB.prepare(
      `SELECT MIN(game_start) AS t FROM markets WHERE result IS NULL AND league IN (${BOOK_LEAGUES.map(() => '?').join(',')}) AND game_start > ?`,
    ).bind(...BOOK_LEAGUES, new Date(now).toISOString()).first<{ t: string | null }>();
    const wake = r?.t ? Date.parse(r.t) - PRE_WINDOW : now + MAX_SLEEP;
    return Math.max(now + MIN, Math.min(wake, now + MAX_SLEEP));
  }

  // One connection for every watched game. A changed game list means a new connection: the new one opens
  // first, then the old one closes, so nothing is missed.
  private async ensureStream(now: number) {
    const want = [...this.games.keys()].sort();
    const c = this.conn;
    const same = !!c && c.slugs.length === want.length && c.slugs.every((s, i) => s === want[i]);
    if (c && same && now - c.last < QUIET_RECONNECT) return;
    try { await this.openStream(want, now); } catch (e) { this.note('connect', e); }
  }

  private async openStream(slugs: string[], now: number) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    let res: Response;
    try {
      res = await fetch(PM_API + PM_WS_PATH, { headers: { ...(await signedHeaders(this.env, 'GET', PM_WS_PATH)), Upgrade: 'websocket' }, signal: ac.signal });
    } finally { clearTimeout(timer); }
    const ws = res.webSocket;
    if (!ws) throw new Error(`stream refused: HTTP ${res.status}`);
    ws.accept();
    const conn: Conn = { ws, slugs, at: now, last: now, n: 0 };
    ws.addEventListener('message', (e) => this.onMessage(conn, e.data));
    const gone = () => { if (this.conn === conn) this.conn = null; };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    SUB_TYPES.forEach((type, ti) => {
      for (let i = 0; i < slugs.length; i += SLUGS_PER_SUB) {
        ws.send(JSON.stringify({ subscribe: { requestId: `bk${ti}-${i}-${now}`, subscriptionType: type, marketSlugs: slugs.slice(i, i + SLUGS_PER_SUB) } }));
      }
    });
    const old = this.conn;
    this.conn = conn;
    this.connects++;
    if (old) try { old.ws.close(1000, 'resubscribed'); } catch {}
  }

  private drop() {
    const c = this.conn;
    this.conn = null;
    if (c) try { c.ws.close(1000, 'off'); } catch {}
  }

  // Rows are keyed by (game, ms). Two updates inside one millisecond (a sweep) each keep their row.
  private lastTs = new Map<string, number>();
  private uniq(table: Table, slug: string, ts: number): number {
    const k = `${table}|${slug}`;
    const prev = this.lastTs.get(k);
    const t = prev != null && ts <= prev ? prev + 1 : ts;
    this.lastTs.set(k, t);
    return t;
  }

  private pre(slug: string, ts: number): number | null {
    const g = this.games.get(slug);
    return g ? (ts < g.start ? 1 : 0) : null;
  }

  private onMessage(conn: Conn, data: unknown) {
    const now = Date.now();
    conn.last = now; conn.n++;
    if (typeof data !== 'string') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    try {
      if (j?.marketDataLite?.marketSlug) { this.msgs.lite++; this.onLite(j.marketDataLite, now); return; }
      if (j?.marketData?.marketSlug) { this.msgs.full++; this.onFull(j.marketData, now); return; }
      if (j?.trade?.marketSlug) { this.msgs.trade++; this.onTrade(j.trade, now); return; }
      this.msgs.other++;
      if (this.others.length < 6) this.others.push(data.slice(0, 300));
    } catch (e) { this.note('message', e); }
  }

  // Best bid/ask, the app's displayed price and state: every change. Depth, last trade, volume: every 5 s at most.
  private onLite(d: any, now: number) {
    const slug: string = d.marketSlug;
    const bid = num(d.bestBid), ask = num(d.bestAsk), cur = num(d.currentPx), state = d.state || null;
    const bd = num(d.bidDepth), ad = num(d.askDepth), last = num(d.lastTradePx), vol = num(d.sharesTraded);
    const key = `${bid}|${ask}|${cur}|${state}`;
    const side = `${bd}|${ad}|${last}|${vol}`;
    const prev = this.lastQuote.get(slug);
    const moved = !prev || prev.key !== key;
    const sideMoved = !!prev && prev.side !== side && now - prev.at >= QUOTE_SIDE_EVERY;
    if (!moved && !sideMoved) return;
    this.lastQuote.set(slug, { key, side, at: now });
    this.push('book_quotes', [slug, this.uniq('book_quotes', slug, now), bid, ask, bd, ad, cur, last, vol, state, this.pre(slug, now)]);
  }

  // The top 8 levels each side: right away when the best price moves, otherwise at most every 10 s (the latest
  // shape waits as `pending` and goes in once 10 s have passed, so the final state of a quiet book is never lost).
  private onFull(d: any, now: number) {
    const slug: string = d.marketSlug;
    const bids = topLevels(d.bids), asks = topLevels(d.offers);
    const bj = JSON.stringify(bids), aj = JSON.stringify(asks);
    const best = `${bids[0]?.[0] ?? ''}|${asks[0]?.[0] ?? ''}`;
    const key = `${bj}|${aj}`;
    const prev = this.lastLevels.get(slug);
    // Back to the shape we last wrote: nothing new to keep.
    if (prev && prev.key === key) { prev.pending = null; return; }
    if (!prev || prev.best !== best || now - prev.at >= LEVELS_EVERY) {
      this.lastLevels.set(slug, { best, key, at: now, pending: null });
      this.push('book_levels', [slug, this.uniq('book_levels', slug, now), bj, aj, this.pre(slug, now)]);
    } else if (prev.pending?.key !== key) {
      // Keep the time this shape first appeared.
      prev.pending = { ts: now, bids: bj, asks: aj, key, best };
    }
  }

  private duePending(now: number) {
    for (const [slug, l] of this.lastLevels) {
      if (!l.pending || now - l.at < LEVELS_EVERY) continue;
      const p = l.pending;
      this.lastLevels.set(slug, { best: p.best, key: p.key, at: now, pending: null });
      this.push('book_levels', [slug, this.uniq('book_levels', slug, p.ts), p.bids, p.asks, this.pre(slug, p.ts)]);
    }
  }

  private onTrade(t: any, now: number) {
    const ts = Date.parse(t.tradeTime) || now;
    this.push('book_trades', [t.marketSlug, ts, now, num(t.price), num(t.quantity), t.taker?.side || null, t.taker?.intent || null, t.maker?.intent || null, this.pre(t.marketSlug, ts)]);
  }

  private push(table: Table, row: Val[]) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.dayRows = 0; this.capped = false; }
    if (this.dayRows >= DAY_CAP) {
      this.capped = true;
      if (table !== 'book_trades') return;    // past the cap only trade prints are kept
    }
    this.dayRows++;
    this.buf[table].push(row);
  }

  private async flush(now: number) {
    const stmts: D1PreparedStatement[] = [];
    const counts: Partial<Record<Table, number>> = {};
    const taken: Partial<Record<Table, Val[][]>> = {};
    for (const table of Object.keys(COLS) as Table[]) {
      const rows = this.buf[table].splice(0);
      if (!rows.length) continue;
      taken[table] = rows;
      counts[table] = rows.length;
      for (const { sql, params } of insertsFor(table, rows)) stmts.push(this.env.DB.prepare(sql).bind(...params));
    }
    if (stmts.length) {
      try {
        for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
        for (const [t, n] of Object.entries(counts)) this.written[t as Table] += n as number;
      } catch (e) {
        this.note('flush', e);
        // Put the rows back (newest first to go if writes keep failing), up to a few minutes' worth.
        for (const [t, rows] of Object.entries(taken)) {
          const b = this.buf[t as Table];
          b.unshift(...(rows as Val[][]));
          if (b.length > 20_000) b.splice(0, b.length - 20_000);
        }
      }
    }
    if (now - this.statsAt >= MIN) {
      this.statsAt = now;
      const add = this.env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n, last = excluded.last');
      const set = this.env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, last = excluded.last');
      const s: D1PreparedStatement[] = [set.bind('books_now', this.games.size, now)];
      for (const t of Object.keys(COLS) as Table[]) {
        const n = this.written[t] - (this.reported[t] || 0);
        if (n > 0) s.push(add.bind(t, n, now));
        this.reported[t] = this.written[t];
      }
      await this.env.DB.batch(s).catch((e) => this.note('stats', e));
    }
  }
  private reported: Partial<Record<Table, number>> = {};

  private async cleanup(now: number) {
    this.cleanedAt = now;
    const cut = now - KEEP_DAYS * 24 * HOUR;
    for (const t of Object.keys(COLS) as Table[]) await this.env.DB.prepare(`DELETE FROM ${t} WHERE ts < ?`).bind(cut).run().catch((e) => this.note('cleanup', e));
  }

  private note(where: string, e: unknown) {
    const msg = `${new Date().toISOString()} ${where}: ${String((e as any)?.message || e).slice(0, 200)}`;
    console.log('books', msg);
    this.errors.push(msg);
    while (this.errors.length > 10) this.errors.shift();
  }
}
