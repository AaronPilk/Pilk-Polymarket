// Live game feed and the bot's attention. One Durable Object that wakes every 5 seconds
// while any tracked game is live or about to start. Read-only: it never places orders.
//
// It splits its attention the way a person watching a slate of games does:
//   Glance   Every live game. One batched quote call covers 40 games, so this costs the same
//            for 2 games or 60. ESPN once every 30 s per league. Per-game depth once a minute.
//   Focus    A trigger fired in the last 5 minutes: the favorite fading from its tip-off price,
//            a 6-cent swing in 2 minutes, a cheap side spiking 50%, or a close game late.
//            ESPN every 10 s for that league, per-game depth every tick.
//   Locked   The bot holds a position on the game (paper or live): full attention every tick.
// Each trigger is logged to `signals` with the price at that moment, so every pattern gets
// graded against how the game actually ended.
//
//   Quotes      A row in `ticks` only when bid/ask/status or the last trade changed.
//   Game state  A row in `game_states` when score, period, possession or down changes, plus a
//               30 s heartbeat so the clock is never more than 30 s stale.
//   Lines       The DraftKings line ESPN shows in the last 10 minutes before start (closing line).
//
// When nothing is live it sleeps until 10 minutes before the next game (at most 5 minutes).

import { DurableObject } from 'cloudflare:workers';
import { ESPN_PATHS, fetchScoreboard, gameLine, gameState, longSide, matchEvent } from './espn';
import { LEAGUE, dailyStopHit, drawdownScale, edgeFloor, isBlowout, riskLimits, shareLeft, sportFair, stakeFor } from './fairvalue';
import { addToPosition, bankroll, closePosition, loadOpen, openPosition, settlePosition, type Position } from './paper';
import { SPORTS_POINTS, SPORTS_POINT_TOL } from './sportsgrade';
import { RULES, statusOf, type Status } from './research';

const GATEWAY = 'https://gateway.polymarket.us';
const UA = { 'User-Agent': 'pilk-bets/1.0' };
const TICK = 5_000;
const SCORE_EVERY = 10_000;          // ESPN refresh for a league with a game in focus
const SCAN_SCORE_EVERY = 30_000;     // ESPN refresh when nothing in the league is in focus
const SCAN_DEEP_EVERY = 60_000;      // per-game depth call for games at a glance
const WATCH_FOR = 5 * 60_000;        // how long a trigger keeps a game in focus
const SIGNAL_COOLDOWN = 10 * 60_000; // same trigger on the same game is logged at most this often
const HEARTBEAT = 30_000;
const DEEP_PER_TICK = 6;
const LIST_CHUNK = 40;
const AFTER_FINAL = 10 * 60_000;
const RELOAD_EVERY = 30_000;
const FLUSH_EVERY = 60_000;
const MAX_SLEEP = 5 * 60_000;
const MIN = 60_000;

interface LiveEnv { DB: D1Database; BOT_ALLOCATION?: string; BOT_MAX_BET?: string; SPORTS?: string }
// Aaron's own cap per bet, when he's set one (a Cloudflare variable). None by default in paper.
const ceiling = (env: LiveEnv): number | null => { const v = Number(env.BOT_MAX_BET); return v > 0 ? v : null; };

// Basketball paper traders (football waits for a better model: touchdowns come in 7s and the
// smooth-scoring model undervalues late comebacks). A lineup of strategies (HOOPS_STRATEGIES),
// each with its own paper account. The main two:
//
//   hoops_trailer_v1, his style (primary). Only a team that is behind, in the first three
//     quarters, priced 20-65c and at least 5c under its tip-off price. The model only gets a
//     veto: it must agree the drop went too far (fair at least 2c over the ask after fees, 3c
//     in the third quarter). From his history: first-half trailing buys won 19 of 23; buys in
//     the last quarter were break-even and only fast exits saved them.
//   hoops_value_v1, model value (test, one game max). Either side when the price is 4c+ under
//     fair after fees; a team that is ahead needs 8c+. Tests whether the market misprices leads.
//
// Both: add only on a deeper discount (never under 10c, never in a blowout, not late while down
// more than one score; the trailer also only while still behind). Sell when the bid climbs 4c
// (after fees) over fair, or at the 2x take-profit on entries under 15c; otherwise hold to the
// final. No new positions in the last quarter. Act only on a fresh scoreboard and a price that
// has held still for 20 seconds, because the market hears about a basket before our feed does.
// Size: quarter Kelly on half the model's edge, at most $10 per game.
interface HoopsStrategy {
  id: string; maxOpen: number;
  trailing: boolean;            // only a team that is behind
  maxProgress: number;          // latest share of the game for a new position
  minDiscount: number;          // at least this far under its tip-off price (trailing only)
  veto: (progress: number) => number;  // model edge (after fees) required to enter
  leaderEdge?: number;          // extra bar for a team that is ahead
  priceMin: number; priceMax: number;
  favoriteOnly?: boolean;       // only the team that was favored at tip-off
  comeback?: number;            // cash out once it wins back this share of the drop since tip-off...
  comebackMin?: number;         // ...or at least this many cents over the entry (a resting sell, no fee)
  maxAdds?: number;             // adds allowed (default 2)
  addBefore?: number;           // adds only before this share of the game (default: any time the rules allow)
  oneShot?: boolean;            // one position per game: no buying back in after it closes
  lateWindow?: [number, number];  // new positions only with this many minutes left (from, to)
  deficit?: [number, number];     // ...and only when behind by this many points (from, to)
  fixedShare?: number;            // bet this share of the account (inside the ladder) instead of Kelly
  target2x?: boolean;             // a resting sell at twice the entry (no fee)
  stopHalf?: boolean;             // sell at the bid if the price falls to half the entry
}
// Each runs its own paper account and can hold its own position in any game.
const HOOPS_STRATEGIES: HoopsStrategy[] = [
  { id: 'hoops_trailer_v1', maxOpen: 2, trailing: true, maxProgress: 0.75, minDiscount: 0.05, veto: (p) => (p < 0.5 ? 0.02 : 0.03), priceMin: 0.2, priceMax: 0.65 },
  { id: 'hoops_trailer_h1', maxOpen: 2, trailing: true, maxProgress: 0.5, minDiscount: 0.05, veto: () => 0.02, priceMin: 0.2, priceMax: 0.65 },
  { id: 'hoops_trailer_deep', maxOpen: 2, trailing: true, maxProgress: 0.75, minDiscount: 0.1, veto: () => 0.04, priceMin: 0.15, priceMax: 0.6 },
  { id: 'hoops_value_v1', maxOpen: 1, trailing: false, maxProgress: 0.75, minDiscount: 0, veto: (p) => (p > 0.5 ? 0.06 : 0.04), leaderEdge: 0.08, priceMin: 0.15, priceMax: 0.85 },
  // Aaron's comeback play, with the limits his own record points to: the team favored at tip-off,
  // behind and 8¢+ under its tip-off price in the first three quarters; at most one add, only in
  // the first half and never under 10¢ (his adds under 10¢: 0 of 8 historically, 4 more lost on
  // Nov 22); cash out into the comeback (half the drop won back, at least 8¢ over the entry); and
  // once out, done with that game (his Nov 22 Pistons re-buy after cashing out lost $38.86).
  { id: 'hoops_comeback_v1', maxOpen: 2, trailing: true, favoriteOnly: true, maxProgress: 0.75, minDiscount: 0.08, veto: () => 0.02, priceMin: 0.15, priceMax: 0.7,
    comeback: 0.5, comebackMin: 0.08, maxAdds: 1, addBefore: 0.5, oneShot: true },
  // Aaron's late swing: 3-12 minutes left, a team down 3-9 at 8-25¢, bought for the next run rather
  // than the result and cashed out at 2x with a resting sell; no adds, one position per game, a fixed
  // 2% of the account so the three compare on equal terms, and no model exit (2x, the stop or the
  // final only). His record so far argues against it: 25 such buys (trailing, last 25% of the game,
  // under 25¢) touched 2x 7 times where fair prices would have 12.5, while his first-half trailing buys
  // touched it 20 times against 11.6. So three versions: his raw play (the math only blocks prices it
  // rates 8¢+ rich, which is more likely bad data), the same with his "protect the account" cut at
  // half the entry, and one where the math must rate the price 3¢ cheap after fees.
  { id: 'hoops_swing_v1', maxOpen: 2, trailing: true, maxProgress: 1, minDiscount: 0, veto: () => -0.08, priceMin: 0.08, priceMax: 0.25,
    lateWindow: [3, 12], deficit: [3, 9], fixedShare: 0.02, target2x: true, maxAdds: 0, oneShot: true },
  { id: 'hoops_swing_stop', maxOpen: 2, trailing: true, maxProgress: 1, minDiscount: 0, veto: () => -0.08, priceMin: 0.08, priceMax: 0.25,
    lateWindow: [3, 12], deficit: [3, 9], fixedShare: 0.02, target2x: true, stopHalf: true, maxAdds: 0, oneShot: true },
  { id: 'hoops_swing_model', maxOpen: 2, trailing: true, maxProgress: 1, minDiscount: 0, veto: () => 0.03, priceMin: 0.08, priceMax: 0.25,
    lateWindow: [3, 12], deficit: [3, 9], fixedShare: 0.02, target2x: true, maxAdds: 0, oneShot: true },
];
export const HOOPS_IDS = HOOPS_STRATEGIES.map((s) => s.id);
const MAX_EDGE = 0.12;          // a bigger "edge" is more likely our data being stale than a gift
// Our scoreboard can lag the market, worst around the buzzer, when ESPN posts the last baskets
// late. In live play the score must have held 15 s (plus the price steady for 20 s); at a
// break (clock 0:00) a full minute, since nobody scores then; and nothing new in the last 30 s
// of a period.
const SETTLE_LIVE = 15_000;
const SETTLE_BREAK = 60_000;
const HOOPS = new Set(['nba', 'cbb']);
const COEF = 0.095;
// Sizing grows with each strategy's account, Kelly-sized inside the same risk ladder as the
// Bitcoin bot (fairvalue.ts riskLimits): one game counts as one bet, so starter plus adds stay
// inside the ladder's per-bet share ($10 at $100), all open games inside its open share, bets
// shrink toward the floor under the account's high, a day stop, and BOT_MAX_BET over all of it.
const feePer = (p: number) => COEF * p * (1 - p);

interface LiveMarket {
  slug: string; league: string; long_team: string | null; short_team: string | null;
  game_start: string; espn_id: string | null; start_mid: number | null;
}

type Kind = 'ticks' | 'game_states' | 'lines' | 'signals';
type Side = 'long' | 'short';
interface Quote { bid: number | null; ask: number | null; mid: number | null }
interface Situation {
  home: string | null; away: string | null; homeScore: number | null; awayScore: number | null;
  period: number | null; clock: string | null; state: string | null; at: number;
  scoreSince: number;           // when the score last changed (our feed)
}

const midOf = (bid: number | null, ask: number | null): number | null =>
  bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? null;
const askOf = (q: Quote, side: Side) => (side === 'long' ? q.ask : q.bid != null ? +(1 - q.bid).toFixed(4) : null);
const bidOf = (q: Quote, side: Side) => (side === 'long' ? q.bid : q.ask != null ? +(1 - q.ask).toFixed(4) : null);
const cents = (x: number) => `${Math.round(x * 100)}¢`;

// "4:35" → 275, "45.3" → 45.3
function clockSeconds(clock: string | null): number | null {
  if (!clock) return null;
  const parts = clock.split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
}

// Last 5 minutes of regulation or overtime, within one score.
export function lateAndClose(league: string, g: Situation): boolean {
  if (g.state !== 'in' || g.period == null || g.homeScore == null || g.awayScore == null) return false;
  const football = league === 'nfl' || league === 'cfb';
  const finalPeriod = league === 'cbb' ? g.period >= 2 : g.period >= 4;
  const secs = clockSeconds(g.clock);
  const margin = Math.abs(g.homeScore - g.awayScore);
  return finalPeriod && secs != null && secs <= 300 && margin <= (football ? 8 : 6);
}

// Gateway numbers arrive as {value, currency}, plain strings or numbers.
const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : null;
};

export class LiveFeed extends DurableObject<LiveEnv> {
  private live: LiveMarket[] = [];
  private liveAt = 0;
  private lastQuote = new Map<string, string>();
  private lastTrade = new Map<string, string>();
  private lastStatus = new Map<string, string>();
  private deepAt = new Map<string, number>();
  private leagueAt = new Map<string, number>();
  private lastState = new Map<string, { key: string; at: number; clock: string | null }>();
  private lastLine = new Map<string, string>();
  private finishedAt = new Map<string, number>();
  private marked = new Set<string>();                        // slug|point: the grading checkpoint is written
  private counts: Record<Kind, number> = { ticks: 0, game_states: 0, lines: 0, signals: 0 };
  private lastAt: Record<Kind, number> = { ticks: 0, game_states: 0, lines: 0, signals: 0 };
  private flushedAt = 0;
  private reportedLive = -1;
  // Attention
  private hist = new Map<string, Array<[number, number]>>(); // slug → [ts, mid], last 10 minutes
  private startMid = new Map<string, number>();              // slug → long-side mid at tip-off
  private startTried = new Set<string>();
  private attention = new Map<string, { until: number; reason: string }>();
  private locked = new Set<string>();                        // slugs the bot holds (paper or live)
  private signalAt = new Map<string, number>();
  private situation = new Map<string, Situation>();          // espn id → latest game state
  private longHome = new Map<string, boolean>();             // slug → long team is the home team
  private open: Position[] = [];                             // open basketball paper positions
  // The research board's verdicts (index.ts writes them every 5 minutes): retired strategies stop
  // opening positions, testing ones bet one contract.
  private lab: { strategies?: Record<string, { status?: Status }> } | null = null;
  private labAt = 0;
  private openAt = 0;

  // The minute cron calls this so the loop restarts if it ever stopped. This is the Sports bot;
  // SPORTS=off (a Cloudflare variable) puts it to sleep without touching the Bitcoin bot.
  async fetch(_req: Request): Promise<Response> {
    if (this.env.SPORTS === 'off') { await this.ctx.storage.deleteAlarm(); return Response.json({ ok: true, sports: 'off' }); }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + MAX_SLEEP) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({ ok: true, alarm, live: this.reportedLive });
  }

  async alarm(): Promise<void> {
    if (this.env.SPORTS === 'off') { await this.ctx.storage.deleteAlarm(); return; }
    const now = Date.now();
    let active = 0;
    try {
      if (!this.live.length || now - this.liveAt > RELOAD_EVERY) await this.loadLive(now);
      const games = this.live.filter((m) => {
        const done = this.finishedAt.get(m.slug);
        return done == null || now - done < AFTER_FINAL;
      });
      active = games.length;
      if (!active) {
        await this.flush(now, 0, true, 0);
        await this.sleepUntilNextGame(now);
        return;
      }
      const stmts: D1PreparedStatement[] = [];
      const quotes = await this.recordQuotes(games, now, stmts);
      await this.recordGame(games, now, stmts);
      this.triage(games, quotes, now, stmts);
      try { await this.paperHoops(games, quotes, now, stmts); } catch (e) { console.log('hoops paper error', String((e as any)?.message || e)); }
      for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      await this.flush(now, active, false, games.filter((m) => this.inFocus(m.slug, now)).length);
    } catch (e) {
      console.log('live feed error', String((e as any)?.message || e));
    } finally {
      if ((await this.ctx.storage.getAlarm()) == null) {
        await this.ctx.storage.setAlarm(active ? Math.max(now + TICK, Date.now() + 1_000) : Date.now() + MIN);
      }
    }
  }

  private async loadLive(now: number) {
    const { results } = await this.env.DB.prepare(
      'SELECT slug, league, long_team, short_team, game_start, espn_id, start_mid FROM markets WHERE result IS NULL AND game_start <= ? AND game_start >= ? ORDER BY game_start',
    ).bind(new Date(now + 10 * MIN).toISOString(), new Date(now - 5 * 60 * MIN).toISOString()).all<LiveMarket>();
    const linked = new Map(this.live.map((m) => [m.slug, m.espn_id]));
    this.live = results.map((m) => ({ ...m, espn_id: m.espn_id || linked.get(m.slug) || null }));
    this.liveAt = now;

    const open = await this.env.DB.prepare("SELECT DISTINCT market_slug AS slug FROM bot_positions WHERE status = 'open'")
      .all<{ slug: string }>().catch(() => null);
    this.locked = new Set((open?.results || []).map((r) => r.slug));

    // Tip-off reference price. Games already under way when we first see them fall back to
    // the recorder's last pre-game price point.
    for (const m of this.live) {
      if (m.start_mid != null) { this.startMid.set(m.slug, m.start_mid); continue; }
      if (this.startMid.has(m.slug) || this.startTried.has(m.slug) || now < Date.parse(m.game_start) + 3 * MIN) continue;
      this.startTried.add(m.slug);
      const p = await this.env.DB.prepare('SELECT bid, ask FROM prices WHERE slug = ? AND live = 0 ORDER BY t DESC LIMIT 1')
        .bind(m.slug).first<{ bid: number | null; ask: number | null }>().catch(() => null);
      const mid = p ? midOf(p.bid, p.ask) : null;
      if (mid == null) continue;
      this.startMid.set(m.slug, mid);
      await this.env.DB.prepare('UPDATE markets SET start_mid = ? WHERE slug = ? AND start_mid IS NULL').bind(mid, m.slug).run();
    }
  }

  private inFocus(slug: string, now: number): boolean {
    return this.locked.has(slug) || (this.attention.get(slug)?.until || 0) > now;
  }

  // Long-side mid about `ago` ms back, if we have a point within a minute of that moment.
  private midAgo(slug: string, now: number, ago: number): number | null {
    const h = this.hist.get(slug);
    if (!h) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      const [ts, mid] = h[i];
      if (ts <= now - ago) return ts >= now - ago - MIN ? mid : null;
    }
    return null;
  }

  private async sleepUntilNextGame(now: number) {
    const next = await this.env.DB.prepare('SELECT MIN(game_start) AS t FROM markets WHERE result IS NULL AND game_start > ?')
      .bind(new Date(now).toISOString()).first<{ t: string | null }>();
    const wake = next?.t ? Date.parse(next.t) - 10 * MIN : now + MAX_SLEEP;
    await this.ctx.storage.setAlarm(Math.max(now + MIN, Math.min(wake, now + MAX_SLEEP)));
  }

  private async recordQuotes(games: LiveMarket[], now: number, stmts: D1PreparedStatement[]): Promise<Map<string, Quote>> {
    const bust = `_=${now}`;

    // Best bid/ask (long side) for every live game, 40 games per call.
    const quotes = new Map<string, { bid: number | null; ask: number | null; status: string | null }>();
    for (let i = 0; i < games.length; i += LIST_CHUNK) {
      const chunk = games.slice(i, i + LIST_CHUNK);
      const qs = chunk.map((m) => `slug=${encodeURIComponent(m.slug)}`).join('&');
      try {
        const res = await fetch(`${GATEWAY}/v1/markets?${qs}&limit=${chunk.length}&${bust}`, { headers: UA });
        if (!res.ok) continue;
        for (const m of (((await res.json()) as any).markets || []) as any[]) {
          quotes.set(m.slug, { bid: num(m.bestBidQuote), ask: num(m.bestAskQuote), status: m.status || null });
        }
      } catch {}
    }

    // Last trade, volume and depth: games in focus first, then glance games once a minute.
    const byAge = (a: LiveMarket, b: LiveMarket) => (this.deepAt.get(a.slug) || 0) - (this.deepAt.get(b.slug) || 0);
    const focus = games.filter((m) => this.inFocus(m.slug, now)).sort(byAge);
    const glance = games.filter((m) => !this.inFocus(m.slug, now) && now - (this.deepAt.get(m.slug) || 0) >= SCAN_DEEP_EVERY).sort(byAge);
    const deep = [...focus, ...glance].slice(0, DEEP_PER_TICK);
    const deepData = new Map<string, any>();
    await Promise.all(deep.map(async (m) => {
      this.deepAt.set(m.slug, now);
      try {
        const res = await fetch(`${GATEWAY}/v1/markets/${encodeURIComponent(m.slug)}/bbo?${bust}`, { headers: UA });
        if (res.ok) deepData.set(m.slug, ((await res.json()) as any).marketData || null);
      } catch {}
    }));

    const insert = this.env.DB.prepare(
      'INSERT OR IGNORE INTO ticks (slug, ts, bid, ask, last, vol, bid_depth, ask_depth, state) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const out = new Map<string, Quote>();
    for (const m of games) {
      const q = quotes.get(m.slug);
      const d = deepData.get(m.slug);
      if (!q && !d) continue;
      const bid = q ? q.bid : num(d.bestBid);
      const ask = q ? q.ask : num(d.bestAsk);
      const mid = midOf(bid, ask);
      out.set(m.slug, { bid, ask, mid });
      if (mid != null) {
        const h = this.hist.get(m.slug) || [];
        h.push([now, mid]);
        while (h.length && h[0][0] < now - 10 * MIN) h.shift();
        this.hist.set(m.slug, h);
      }
      if (q?.status) this.lastStatus.set(m.slug, q.status);
      const status = this.lastStatus.get(m.slug) || null;
      const last = d ? num(d.lastTradePx) : null;
      const vol = d ? num(d.sharesTraded) : null;
      const quoteKey = `${bid}|${ask}|${status}`;
      const tradeKey = d ? `${last}|${vol}` : null;
      const quoteMoved = this.lastQuote.get(m.slug) !== quoteKey;
      const traded = tradeKey != null && this.lastTrade.get(m.slug) !== tradeKey;
      if (!quoteMoved && !traded) continue;
      this.lastQuote.set(m.slug, quoteKey);
      if (tradeKey != null) this.lastTrade.set(m.slug, tradeKey);
      stmts.push(insert.bind(m.slug, now, bid, ask, last, vol, d ? num(d.bidDepth) : null, d ? num(d.askDepth) : null, status));
      this.bump('ticks', now);
    }
    return out;
  }

  private async recordGame(games: LiveMarket[], now: number, stmts: D1PreparedStatement[]) {
    // One scoreboard per tick: the live league refreshed longest ago, once it is due.
    // Leagues with a game in focus refresh every 10 s, the rest every 30 s.
    const hot = new Set(games.filter((m) => this.inFocus(m.slug, now)).map((m) => m.league));
    const league = [...new Set(games.map((m) => m.league))]
      .filter((l) => ESPN_PATHS[l] && now - (this.leagueAt.get(l) || 0) >= (hot.has(l) ? SCORE_EVERY : SCAN_SCORE_EVERY))
      .sort((a, b) => (this.leagueAt.get(a) || 0) - (this.leagueAt.get(b) || 0))[0];
    if (!league) return;
    this.leagueAt.set(league, now);
    const events = await fetchScoreboard(league);
    if (!events) return;

    const inLeague = games.filter((m) => m.league === league);
    const link = this.env.DB.prepare('UPDATE markets SET espn_id = ? WHERE slug = ?');
    for (const m of inLeague) {
      if (m.espn_id) continue;
      const ev = matchEvent(m, events);
      if (!ev) continue;
      m.espn_id = String(ev.id);
      stmts.push(link.bind(m.espn_id, m.slug));
    }

    const insState = this.env.DB.prepare(`INSERT OR IGNORE INTO game_states
      (espn_id, ts, league, home, away, home_score, away_score, period, clock, state, possession, down, distance, yard_line, last_play)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insLine = this.env.DB.prepare(`INSERT OR IGNORE INTO lines
      (espn_id, ts, provider, home, away, home_ml, away_ml, home_ml_open, away_ml_open, spread, total)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const byId = new Map(events.map((e: any) => [String(e.id), e]));
    const seen = new Set<string>();
    for (const m of inLeague) {
      const id = m.espn_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ev = byId.get(id);
      const s = ev ? gameState(ev) : null;
      if (!s) continue;

      if (s.state === 'pre') {
        const line = gameLine(ev);
        const key = line ? JSON.stringify(line) : null;
        if (line && this.lastLine.get(id) !== key) {
          this.lastLine.set(id, key!);
          stmts.push(insLine.bind(id, now, line.provider, line.home, line.away, line.homeMl, line.awayMl,
            line.homeMlOpen, line.awayMlOpen, line.spread, line.total));
          this.bump('lines', now);
        }
        continue;
      }

      const prevSit = this.situation.get(id);
      const scoreSince = prevSit && prevSit.homeScore === s.homeScore && prevSit.awayScore === s.awayScore ? prevSit.scoreSince : now;
      this.situation.set(id, { home: s.home, away: s.away, homeScore: s.homeScore, awayScore: s.awayScore, period: s.period, clock: s.clock, state: s.state, at: now, scoreSince });
      for (const g of inLeague) {
        if (g.espn_id !== id || this.longHome.has(g.slug)) continue;
        const side = longSide(g, ev);
        if (side) this.longHome.set(g.slug, side === 'home');
      }
      if (s.state === 'post') {
        for (const g of inLeague) if (g.espn_id === id && !this.finishedAt.has(g.slug)) this.finishedAt.set(g.slug, now);
      }
      const key = JSON.stringify([s.homeScore, s.awayScore, s.period, s.state, s.possession, s.down, s.distance, s.yardLine]);
      const prev = this.lastState.get(id);
      const changed = !prev || prev.key !== key;
      const heartbeat = !!prev && now - prev.at >= HEARTBEAT && prev.clock !== s.clock;
      if (!changed && !heartbeat) continue;
      this.lastState.set(id, { key, at: now, clock: s.clock });
      stmts.push(insState.bind(id, now, league, s.home, s.away, s.homeScore, s.awayScore, s.period, s.clock, s.state,
        s.possession, s.down, s.distance, s.yardLine, s.lastPlay));
      this.bump('game_states', now);
    }
  }

  // The glance: cheap checks on every live game, using numbers already in memory. A trigger
  // puts the game in focus for 5 minutes and logs a signal.
  private triage(games: LiveMarket[], quotes: Map<string, Quote>, now: number, stmts: D1PreparedStatement[]) {
    const log = this.env.DB.prepare('INSERT OR IGNORE INTO signals (slug, ts, kind, side, price, ref, detail) VALUES (?,?,?,?,?,?,?)');
    const setStart = this.env.DB.prepare('UPDATE markets SET start_mid = ? WHERE slug = ? AND start_mid IS NULL');
    for (const m of games) {
      const q = quotes.get(m.slug);
      if (!q || q.mid == null) continue;
      const start = Date.parse(m.game_start);
      if (!this.startMid.has(m.slug) && now >= start && now - start <= 3 * MIN) {
        this.startMid.set(m.slug, q.mid);
        stmts.push(setStart.bind(q.mid, m.slug));
      }
      const g = m.espn_id ? this.situation.get(m.espn_id) : undefined;
      if (g?.state === 'post' || q.mid >= 0.97 || q.mid <= 0.03) continue; // decided
      const team = (side: Side) => (side === 'long' ? m.long_team : m.short_team) || side;
      const fire = (kind: string, side: Side | null, price: number | null, ref: number | null, detail: string) => {
        this.attention.set(m.slug, { until: now + WATCH_FOR, reason: kind });
        const key = `${m.slug}|${kind}`;
        if (now - (this.signalAt.get(key) || 0) < (kind === 'late_close' ? 60 * MIN : SIGNAL_COOLDOWN)) return;
        this.signalAt.set(key, now);
        const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10_000) / 10_000);
        stmts.push(log.bind(m.slug, now, kind, side, r4(price), r4(ref), detail));
        this.bump('signals', now);
      };

      // Favorite fading: the side priced 60c+ at tip-off is down 15c or more from there.
      const s0 = this.startMid.get(m.slug);
      if (s0 != null && now >= start && (s0 >= 0.6 || s0 <= 0.4)) {
        const fav: Side = s0 >= 0.6 ? 'long' : 'short';
        const was = fav === 'long' ? s0 : 1 - s0;
        const nowP = fav === 'long' ? q.mid : 1 - q.mid;
        if (was - nowP >= 0.15) fire('favorite_fade', fav, askOf(q, fav), was, `${team(fav)} ${cents(was)} → ${cents(nowP)}`);
      }

      const past = this.midAgo(m.slug, now, 2 * MIN);
      if (past != null) {
        // Big swing: 6c or more in about 2 minutes. Logged on the side that fell (the dip).
        if (Math.abs(q.mid - past) >= 0.06) {
          const fell: Side = q.mid < past ? 'long' : 'short';
          fire('swing', fell, askOf(q, fell), fell === 'long' ? past : 1 - past, `${team(fell)} ${cents(fell === 'long' ? past : 1 - past)} → ${cents(fell === 'long' ? q.mid : 1 - q.mid)} in 2 min`);
        }
        // Cheap side spiking: under 15c and up 50% in about 2 minutes. Logged at the bid (a sell).
        for (const side of ['long', 'short'] as Side[]) {
          const was = side === 'long' ? past : 1 - past;
          const nowP = side === 'long' ? q.mid : 1 - q.mid;
          if (was < 0.15 && nowP >= was * 1.5 && nowP - was >= 0.03) fire('cheap_spike', side, bidOf(q, side), was, `${team(side)} ${cents(was)} → ${cents(nowP)}`);
        }
      }

      // Close and late.
      if (g && lateAndClose(m.league, g)) fire('late_close', null, q.mid, null, `P${g.period} ${g.clock} ${g.away} ${g.awayScore} - ${g.home} ${g.homeScore}`);
    }
  }

  private async paperHoops(games: LiveMarket[], quotes: Map<string, Quote>, now: number, stmts: D1PreparedStatement[]) {
    const db = this.env.DB;
    const allocation = Number(this.env.BOT_ALLOCATION || 100) || 100;
    if (now - this.labAt >= 5 * 60_000) {
      this.labAt = now;
      const lb = await db.prepare("SELECT v FROM brain WHERE k = 'lab_sports'").first<{ v: string }>().catch(() => null);
      if (lb) { try { this.lab = JSON.parse(lb.v); } catch { /* keep the last board */ } }
    }
    if (now - this.openAt > 30_000) {
      this.open = [];
      for (const st of HOOPS_STRATEGIES) this.open.push(...(await loadOpen(db, st.id)));
      this.openAt = now;
      // Positions on games we're no longer watching: settle from the market result if it's in.
      for (const p of this.open.filter((x) => !games.some((g) => g.slug === x.market_slug))) {
        const r = await db.prepare('SELECT result FROM markets WHERE slug = ?').bind(p.market_slug).first<{ result: number | null }>();
        if (r?.result === 0 || r?.result === 1) await settlePosition(db, p, { won: (p.side === 'long') === (r.result === 1), now });
      }
      this.open = this.open.filter((x) => x.status === 'open');
    }
    for (const m of games) {
      const g = m.espn_id ? this.situation.get(m.espn_id) : undefined;
      const lh = this.longHome.get(m.slug);
      const heldHere = this.open.filter((p) => p.market_slug === m.slug && p.status === 'open');

      // Final whistle: settle everything held on this game.
      if (heldHere.length && g?.state === 'post' && g.homeScore != null && g.awayScore != null && lh != null && g.homeScore !== g.awayScore) {
        const longWon = lh ? g.homeScore > g.awayScore : g.awayScore > g.homeScore;
        for (const p of heldHere) await settlePosition(db, p, { won: (p.side === 'long') === longWon, now });
        continue;
      }
      if (!HOOPS.has(m.league)) continue;
      const q = quotes.get(m.slug);
      const s0 = this.startMid.get(m.slug);
      if (!q || q.bid == null || q.ask == null || q.mid == null || !g || g.state !== 'in' || lh == null || s0 == null) continue;
      if (g.homeScore == null || g.awayScore == null) continue;
      const left = shareLeft(m.league, g.period, g.clock);
      if (left == null) continue;
      const spec = LEAGUE[m.league];
      const minsLeft = left * spec.periods * spec.periodMin;
      const prog = 1 - left;
      const leadLong = lh ? g.homeScore - g.awayScore : g.awayScore - g.homeScore;
      const fairLong = sportFair({ league: m.league, lead: leadLong, left, startPrice: s0 });
      const fresh = now - g.at <= 25_000;
      // Grading checkpoints (sportsgrade.ts): once per game at each fixed point, the first time the
      // game is just past it, what the math said and the market's quote.
      if (fresh) for (const pt of SPORTS_POINTS) {
        const k = `${m.slug}|${pt}`;
        if (this.marked.has(k) || left > pt || left < pt - SPORTS_POINT_TOL) continue;
        this.marked.add(k);
        stmts.push(db.prepare('INSERT OR IGNORE INTO hoops_marks (slug, point, ts, league, share_left, lead, fair, bid, ask, start) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(m.slug, pt, now, m.league, Math.round(left * 10_000) / 10_000, leadLong, Math.round(fairLong * 10_000) / 10_000, q.bid, q.ask, s0));
      }
      const secs = clockSeconds(g.clock);
      const settled = now - g.scoreSince >= (secs === 0 ? SETTLE_BREAK : SETTLE_LIVE);
      const buzzer = secs != null && secs > 0 && secs <= 30;
      const m20 = this.midAgo(m.slug, now, 20_000);
      const calm = m20 != null && Math.abs(q.mid - m20) <= 0.03;
      const view = (s: Side) => {
        const ask = s === 'long' ? q.ask! : +(1 - q.bid!).toFixed(4);
        const fair = s === 'long' ? fairLong : 1 - fairLong;
        return {
          side: s, ask, bid: s === 'long' ? q.bid! : +(1 - q.ask!).toFixed(4), fair,
          lead: s === 'long' ? leadLong : -leadLong, start: s === 'long' ? s0 : 1 - s0,
          team: (s === 'long' ? m.long_team : m.short_team) || s, edge: fair - ask - feePer(ask),
        };
      };
      const where = (lead: number) => `${lead > 0 ? `up ${lead}` : lead < 0 ? `down ${-lead}` : 'tied'}, ${m.league === 'cbb' ? 'H' : 'Q'}${g.period} ${g.clock}`;

      for (const st of HOOPS_STRATEGIES) {
        const status = statusOf(this.lab, st.id);
        const held = heldHere.find((p) => p.strategy === st.id && p.status === 'open');
        if (held) {
          const v = view(held.side);
          if (held.take_profit != null && v.bid >= held.take_profit) {
            await closePosition(db, held, { price: held.take_profit, coef: COEF, maker: true, reason: `take-profit at ${cents(held.take_profit)}`, now });
            continue;
          }
          if (st.target2x && held.avg_entry != null) {
            const target = Math.min(0.99, Math.round(held.avg_entry * 2 * 100) / 100);
            if (v.bid >= target) {
              await closePosition(db, held, { price: target, coef: COEF, maker: true, reason: `2x cash-out at ${cents(target)} (in at ${cents(held.avg_entry)}), ${where(v.lead)}`, now });
              continue;
            }
          }
          if (st.stopHalf && held.avg_entry != null && v.bid > 0 && v.bid <= held.avg_entry * 0.5 && fresh) {
            await closePosition(db, held, { price: v.bid, coef: COEF, maker: false, reason: `cut at half: bid ${cents(v.bid)} (in at ${cents(held.avg_entry)}), ${where(v.lead)}`, now });
            continue;
          }
          if (st.comeback != null && held.avg_entry != null) {
            const target = Math.min(0.99, Math.round((held.avg_entry + Math.max(st.comebackMin ?? 0, st.comeback * (v.start - held.avg_entry))) * 100) / 100);
            if (v.bid >= target) {
              await closePosition(db, held, { price: target, coef: COEF, maker: true, reason: `comeback cash-out at ${cents(target)} (in at ${cents(held.avg_entry)}, tip-off ${cents(v.start)}), ${where(v.lead)}`, now });
              continue;
            }
          }
          // The model's own sell when the price runs above its fair. The comeback and late-swing plays exit only
          // on their own rules (or the final): the model selling them into a growing deficit isn't Aaron's method.
          if (!st.target2x && st.comeback == null && fresh && calm && settled && minsLeft > 3 && v.bid >= v.fair + feePer(v.bid) + 0.04) {
            await closePosition(db, held, { price: v.bid, coef: COEF, maker: false, reason: `above fair: bid ${cents(v.bid)} vs fair ${cents(v.fair)}, ${where(v.lead)}`, now });
            continue;
          }
          const blocked = !fresh || !calm || !settled || buzzer || minsLeft <= 3 || held.adds >= (st.maxAdds ?? 2) || prog >= (st.addBefore ?? 1) || isBlowout(m.league, v.lead, g.period, g.clock)
            || (prog >= 0.75 && v.lead < -9) || (st.trailing && v.lead >= 0) || v.edge > MAX_EDGE;
          if (!blocked && v.ask >= 0.1 && v.ask <= held.avg_entry - 0.05 && v.edge >= 0.06) {
            const bank = await bankroll(db, allocation, now, st.id);
            // One game is one bet: starter plus adds stay inside the ladder's share of the account.
            const room = bank.equity * riskLimits(bank.peak).bet - held.cost;
            const stake = Math.min(stakeFor({ fair: v.fair, price: v.ask, equity: bank.equity, available: bank.available, peak: bank.peak, openNet: bank.openNet, ceiling: ceiling(this.env) }), room);
            const qty = status === 'testing' ? Math.min(1, Math.floor(stake / v.ask)) : Math.floor(stake / v.ask);
            if (status !== 'retired' && qty >= 1 && !dailyStopHit(bank.equity, bank.today, bank.peak)) {
              await addToPosition(db, held, { ask: v.ask, qty, coef: COEF, reason: `fair ${cents(v.fair)} vs ask ${cents(v.ask)}, ${where(v.lead)}`, now });
            }
          }
          continue;
        }

        // New position: first part of the game, fresh, calm, settled data only, and not retired.
        if (status === 'retired') continue;
        if (!fresh || !calm || !settled || buzzer || prog >= st.maxProgress || minsLeft <= 3) continue;
        if (this.open.filter((p) => p.strategy === st.id && p.status === 'open').length >= st.maxOpen) continue;
        if (st.lateWindow && (minsLeft < st.lateWindow[0] || minsLeft > st.lateWindow[1])) continue;
        const pick = (['long', 'short'] as Side[]).map(view)
          .filter((v) => !isBlowout(m.league, v.lead, g.period, g.clock) && v.ask >= st.priceMin && v.ask <= st.priceMax && v.edge <= MAX_EDGE)
          .filter((v) => (st.trailing ? v.lead < 0 && v.ask <= v.start - st.minDiscount : true))
          .filter((v) => !st.favoriteOnly || v.start >= 0.5)
          .filter((v) => !st.deficit || (-v.lead >= st.deficit[0] && -v.lead <= st.deficit[1]))
          .filter((v) => v.edge >= edgeFloor(st, prog, v.lead))
          .sort((x, y) => y.edge - x.edge)[0];
        if (!pick) continue;
        if (st.oneShot && await db.prepare("SELECT 1 FROM bot_positions WHERE strategy = ? AND market_slug = ? AND status != 'open' LIMIT 1").bind(st.id, m.slug).first()) continue;
        const bank = await bankroll(db, allocation, now, st.id);
        if (dailyStopHit(bank.equity, bank.today, bank.peak)) continue;
        let stake: number;
        if (st.fixedShare) {
          const peak = Math.max(bank.peak, bank.equity), lim = riskLimits(peak), cap = ceiling(this.env);
          stake = Math.min(bank.equity * st.fixedShare * drawdownScale(bank.equity, peak, lim.dd), bank.available, bank.equity * lim.bet,
            Math.max(0, bank.equity * lim.open - bank.openNet), cap ?? Infinity);
        } else {
          stake = stakeFor({ fair: pick.fair, price: pick.ask, equity: bank.equity, available: bank.available, peak: bank.peak, openNet: bank.openNet, ceiling: ceiling(this.env) });
        }
        // Testing: one contract a bet until the board has enough to judge.
        const qty = status === 'testing' ? Math.min(1, Math.floor(stake / pick.ask)) : Math.floor(stake / pick.ask);
        if (qty < 1) continue;
        const why = st.trailing
          ? `behind and ${cents(pick.start - pick.ask)} under tip-off; fair ${cents(pick.fair)} vs ask ${cents(pick.ask)}, ${where(pick.lead)}`
          : `fair ${cents(pick.fair)} vs ask ${cents(pick.ask)}, ${where(pick.lead)}`;
        const pos = await openPosition(db, {
          strategy: st.id, slug: m.slug, title: `${m.long_team || 'Home'} vs. ${m.short_team || 'Away'}`, side: pick.side,
          sideName: pick.team, ask: pick.ask, qty, coef: COEF, reason: why, now, tpBelow: st.target2x ? 1 : undefined, meta: { rules: RULES, status },
        });
        this.open.push(pos);
        heldHere.push(pos);
      }
    }
    this.open = this.open.filter((p) => p.status === 'open');
  }

  private bump(kind: Kind, now: number) {
    this.counts[kind]++;
    this.lastAt[kind] = now;
  }

  // Running counters for the dashboard, written at most once a minute.
  private async flush(now: number, active: number, idle: boolean, focus: number) {
    const pending = this.counts.ticks + this.counts.game_states + this.counts.lines + this.counts.signals;
    if (idle ? this.reportedLive === 0 && !pending : now - this.flushedAt < FLUSH_EVERY) return;
    const add = this.env.DB.prepare(
      'INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n, last = excluded.last',
    );
    const set = this.env.DB.prepare(
      'INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, last = excluded.last',
    );
    const stmts: D1PreparedStatement[] = [];
    for (const k of ['ticks', 'game_states', 'lines', 'signals'] as Kind[]) {
      if (this.counts[k]) stmts.push(add.bind(k, this.counts[k], this.lastAt[k]));
    }
    stmts.push(set.bind('live_now', active, now));
    stmts.push(set.bind('focus_now', focus, now));
    await this.env.DB.batch(stmts);
    this.counts = { ticks: 0, game_states: 0, lines: 0, signals: 0 };
    this.flushedAt = now;
    this.reportedLive = active;
  }
}
