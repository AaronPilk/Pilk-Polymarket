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
import { ESPN_PATHS, fetchScoreboard, gameLine, gameState, matchEvent } from './espn';

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

interface LiveEnv { DB: D1Database }

interface LiveMarket {
  slug: string; league: string; long_team: string | null; short_team: string | null;
  game_start: string; espn_id: string | null; start_mid: number | null;
}

type Kind = 'ticks' | 'game_states' | 'lines' | 'signals';
type Side = 'long' | 'short';
interface Quote { bid: number | null; ask: number | null; mid: number | null }
interface Situation {
  home: string | null; away: string | null; homeScore: number | null; awayScore: number | null;
  period: number | null; clock: string | null; state: string | null;
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
  private counts: Record<Kind, number> = { ticks: 0, game_states: 0, lines: 0, signals: 0 };
  private lastAt: Record<Kind, number> = { ticks: 0, game_states: 0, lines: 0, signals: 0 };
  private flushedAt = 0;
  private reportedLive = -1;
  // Attention
  private hist = new Map<string, Array<[number, number]>>(); // slug → [ts, mid], last 10 minutes
  private startMid = new Map<string, number>();              // slug → long-side mid at tip-off
  private startTried = new Set<string>();
  private attention = new Map<string, { until: number; reason: string }>();
  private locked = new Set<string>();                        // slugs with an open paper trade
  private signalAt = new Map<string, number>();
  private situation = new Map<string, Situation>();          // espn id → latest game state

  // The minute cron calls this so the loop restarts if it ever stopped.
  async fetch(_req: Request): Promise<Response> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + MAX_SLEEP) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({ ok: true, alarm, live: this.reportedLive });
  }

  async alarm(): Promise<void> {
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

      this.situation.set(id, { home: s.home, away: s.away, homeScore: s.homeScore, awayScore: s.awayScore, period: s.period, clock: s.clock, state: s.state });
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
