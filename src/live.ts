// Live game feed. One Durable Object that wakes every 5 seconds while any tracked game is
// live or about to start. Read-only: it never places orders.
//
//   Quotes      One batched call to the public market list covers every live game. The
//               gateway is CDN-cached for 30 s, so each call carries a cache-buster. A few
//               games per tick also get the per-game quote call (last trade, volume, depth),
//               in rotation. A row is written only when something changed.
//   Game state  One ESPN scoreboard per tick, rotating through the live leagues, so each
//               league refreshes about every 10 s. Written when the score, period,
//               possession or down changes, plus a 30 s heartbeat so the clock is never
//               more than 30 s stale.
//   Lines       The DraftKings moneyline ESPN shows during the last 10 minutes before start,
//               i.e. the closing line every trade gets measured against.
//
// When nothing is live it sleeps until 10 minutes before the next game (at most 5 minutes).

import { DurableObject } from 'cloudflare:workers';
import { ESPN_PATHS, fetchScoreboard, gameLine, gameState, matchEvent } from './espn';

const GATEWAY = 'https://gateway.polymarket.us';
const UA = { 'User-Agent': 'pilk-bets/1.0' };
const TICK = 5_000;
const SCORE_EVERY = 10_000;
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
  game_start: string; espn_id: string | null;
}

type Kind = 'ticks' | 'game_states' | 'lines';

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
  private counts: Record<Kind, number> = { ticks: 0, game_states: 0, lines: 0 };
  private lastAt: Record<Kind, number> = { ticks: 0, game_states: 0, lines: 0 };
  private flushedAt = 0;
  private reportedLive = -1;

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
        await this.flush(now, 0, true);
        await this.sleepUntilNextGame(now);
        return;
      }
      const stmts: D1PreparedStatement[] = [];
      await this.recordQuotes(games, now, stmts);
      await this.recordGame(games, now, stmts);
      for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      await this.flush(now, active, false);
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
      'SELECT slug, league, long_team, short_team, game_start, espn_id FROM markets WHERE result IS NULL AND game_start <= ? AND game_start >= ? ORDER BY game_start',
    ).bind(new Date(now + 10 * MIN).toISOString(), new Date(now - 5 * 60 * MIN).toISOString()).all<LiveMarket>();
    const linked = new Map(this.live.map((m) => [m.slug, m.espn_id]));
    this.live = results.map((m) => ({ ...m, espn_id: m.espn_id || linked.get(m.slug) || null }));
    this.liveAt = now;
  }

  private async sleepUntilNextGame(now: number) {
    const next = await this.env.DB.prepare('SELECT MIN(game_start) AS t FROM markets WHERE result IS NULL AND game_start > ?')
      .bind(new Date(now).toISOString()).first<{ t: string | null }>();
    const wake = next?.t ? Date.parse(next.t) - 10 * MIN : now + MAX_SLEEP;
    await this.ctx.storage.setAlarm(Math.max(now + MIN, Math.min(wake, now + MAX_SLEEP)));
  }

  private async recordQuotes(games: LiveMarket[], now: number, stmts: D1PreparedStatement[]) {
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

    // Last trade, volume and depth for the games checked least recently.
    const deep = [...games]
      .sort((a, b) => (this.deepAt.get(a.slug) || 0) - (this.deepAt.get(b.slug) || 0))
      .slice(0, DEEP_PER_TICK);
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
    for (const m of games) {
      const q = quotes.get(m.slug);
      const d = deepData.get(m.slug);
      if (!q && !d) continue;
      const bid = q ? q.bid : num(d.bestBid);
      const ask = q ? q.ask : num(d.bestAsk);
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
  }

  private async recordGame(games: LiveMarket[], now: number, stmts: D1PreparedStatement[]) {
    // One scoreboard per tick: the live league refreshed longest ago, once it is due.
    const league = [...new Set(games.map((m) => m.league))]
      .filter((l) => ESPN_PATHS[l] && now - (this.leagueAt.get(l) || 0) >= SCORE_EVERY)
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

  private bump(kind: Kind, now: number) {
    this.counts[kind]++;
    this.lastAt[kind] = now;
  }

  // Running counters for the dashboard, written at most once a minute.
  private async flush(now: number, active: number, idle: boolean) {
    const pending = this.counts.ticks + this.counts.game_states + this.counts.lines;
    if (idle ? this.reportedLive === 0 && !pending : now - this.flushedAt < FLUSH_EVERY) return;
    const add = this.env.DB.prepare(
      'INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n, last = excluded.last',
    );
    const set = this.env.DB.prepare(
      'INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, last = excluded.last',
    );
    const stmts: D1PreparedStatement[] = [];
    for (const k of ['ticks', 'game_states', 'lines'] as Kind[]) {
      if (this.counts[k]) stmts.push(add.bind(k, this.counts[k], this.lastAt[k]));
    }
    stmts.push(set.bind('live_now', active, now));
    await this.env.DB.batch(stmts);
    this.counts = { ticks: 0, game_states: 0, lines: 0 };
    this.flushedAt = now;
    this.reportedLive = active;
  }
}
