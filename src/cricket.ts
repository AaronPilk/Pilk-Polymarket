// The Cricket bot (Nov 25, Aaron: "Cricket on Polymarket has the largest lag time from scoring to market
// updates ... test the Cricket market to see if we find an advantage"). Paper only: it never places orders.
//
// One Durable Object, like the Sports bot. While a cricket match is live it wakes every 3 seconds:
//   Markets    Every 15 minutes it pages the public Polymarket US market list for cricket match-winner
//              markets (sportsMarketType cricket_*) and keeps them in `markets` (league = the slug's code).
//   Score      ESPN's cricket scorepanel, one call for every live match, about every 4 seconds
//              (ESPN caches it up to 8 s, which is part of what this test measures).
//   Quotes     Polymarket best bid/ask for every live cricket market each tick, 40 per call.
//   Record     A row in `cricket_marks` whenever the score or the quote changes, with the model's win
//              chance for the long side, so the lag between a scoring event and the price can be measured.
//
// Strategies (each its own paper account, plus $1K, $1K banking half, $5K and $10K copies like every
// strategy, judged on the research board's 'cricket' book):
//   cricket_lag_flip  On a wicket or boundary that moves the model 4c+ while the market mid hasn't moved
//                     a third of that yet, buy the side the event helped. Sell at the bid once the market has
//                     caught up (moved two thirds of the model's move) or after 90 s, whichever comes first.
//                     This is the friend's claim as a trade: it only needs the direction, not a good model.
//   cricket_lag_hold  The same entries, held to the result.
//   cricket_value     Limited overs, second innings: the model's chance beats the ask by 8c after the fee,
//                     spread 5c or less. One bet a match, held to the result.
// The test plan and the rules for judging it: project doc claude/ten-day-test.md (the cricket book starts
// its own 10 days when it goes live).

import { DurableObject } from 'cloudflare:workers';
import { battingWinProb, cricketState, eventBetween, matchCricket, teamKey, type CricketState } from './cricketmath';
import { dailyStopHit, testStake, takerFee } from './fairvalue';
import { bankroll, closePosition, loadOpen, openPosition, settlePosition, type Position } from './paper';
import { RULES, statusOf, type Status } from './research';

const GATEWAY = 'https://gateway.polymarket.us';
const ESPN = ['site.web.api.espn.com'];   // site.api.espn.com answers 404 for cricket
const UA = { 'User-Agent': 'pilk-bets/1.0' };
const TICK = 3_000;
const SCORE_EVERY = 4_000;
const DISCOVER_EVERY = 15 * 60_000;
const MIN = 60_000;
const MAX_SLEEP = 10 * MIN;
// How long after the start a match can still be live: T20 about 3.5 h, 50 overs about 8 h, first-class 4-5 days.
const LIVE_FOR: Record<string, number> = { t20: 5 * 60 * MIN, odi: 10 * 60 * MIN, multi: 5 * 24 * 60 * MIN };
const FLIP_AFTER = 90_000;

type Side = 'long' | 'short';
interface CricketEnv { DB: D1Database; BOT_ALLOCATION?: string; BOT_MAX_BET?: string; CRICKET?: string }
interface Mkt { slug: string; league: string; long_team: string | null; short_team: string | null; game_start: string; espn_id: string | null; fee_coef: number | null }
interface Quote { bid: number | null; ask: number | null; mid: number | null }

export interface CricketStrategy { id: string; kind: 'lag_flip' | 'lag_hold' | 'value'; bank?: number; lock?: number }
const BASES: CricketStrategy[] = [
  { id: 'cricket_lag_flip', kind: 'lag_flip' },
  { id: 'cricket_lag_hold', kind: 'lag_hold' },
  { id: 'cricket_value', kind: 'value' },
];
export const CRICKET_STRATEGIES: CricketStrategy[] = [...BASES];
for (const b of BASES) {
  for (const c of [{ suffix: '1k', bank: 1000 }, { suffix: 'lock_1k', bank: 1000, lock: 0.5 }, { suffix: '5k', bank: 5000 }, { suffix: '10k', bank: 10000 }]) {
    CRICKET_STRATEGIES.push({ ...b, id: `${b.id}_${c.suffix}`, bank: c.bank, lock: (c as any).lock });
  }
}
export const CRICKET_IDS = CRICKET_STRATEGIES.map((s) => s.id);

const num = (v: any): number | null => { if (v == null) return null; const x = Number(v?.value ?? v); return Number.isFinite(x) ? x : null; };
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const cents = (p: number) => `${Math.round(p * 100)}¢`;
const ceiling = (env: CricketEnv): number | null => { const v = Number(env.BOT_MAX_BET); return v > 0 ? v : null; };
const norm = teamKey;

export class CricketFeed extends DurableObject<CricketEnv> {
  private markets: Mkt[] = [];
  private loadedAt = 0;
  private discoveredAt = 0;
  private scoreAt = 0;
  private events: any[] = [];
  private states = new Map<string, CricketState>();      // espn id -> latest state
  private prevStates = new Map<string, CricketState>();
  private stateAt = new Map<string, number>();           // espn id -> when its state last changed
  private quotes = new Map<string, Quote>();
  private lastMark = new Map<string, string>();
  private mids = new Map<string, Array<[number, number]>>();  // slug -> recent [ts, mid]
  private open: Position[] = [];
  private openAt = 0;
  private lab: { strategies?: Record<string, { status?: Status }> } | null = null;
  private labAt = 0;

  async fetch(_req: Request): Promise<Response> {
    if (this.env.CRICKET === 'off') { await this.ctx.storage.deleteAlarm(); return Response.json({ ok: true, cricket: 'off' }); }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null || alarm > Date.now() + MAX_SLEEP) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return Response.json({ ok: true, alarm, markets: this.markets.length });
  }

  async alarm(): Promise<void> {
    if (this.env.CRICKET === 'off') { await this.ctx.storage.deleteAlarm(); return; }
    const now = Date.now();
    let live = 0;
    try {
      if (now - this.discoveredAt >= DISCOVER_EVERY) { this.discoveredAt = now; await this.discover(now).catch((e) => console.log('cricket discover error', String(e?.message || e))); }
      if (now - this.loadedAt >= 30_000) await this.load(now);
      const games = this.markets.filter((m) => Date.parse(m.game_start) <= now + 5 * MIN);
      live = games.length;
      if (live) {
        if (now - this.scoreAt >= SCORE_EVERY) await this.score(now, games);
        await this.quote(games);
        const stmts: D1PreparedStatement[] = [];
        this.record(games, now, stmts);
        try { await this.paper(games, now); } catch (e) { console.log('cricket paper error', String((e as any)?.message || e)); }
        for (let i = 0; i < stmts.length; i += 100) await this.env.DB.batch(stmts.slice(i, i + 100));
      }
    } catch (e) {
      console.log('cricket feed error', String((e as any)?.message || e));
    } finally {
      if ((await this.ctx.storage.getAlarm()) == null) {
        const next = this.markets.map((m) => Date.parse(m.game_start)).filter((t) => t > now).sort((a, b) => a - b)[0];
        const wake = live ? now + TICK : next ? Math.max(now + MIN, Math.min(next - 5 * MIN, now + MAX_SLEEP)) : now + MAX_SLEEP;
        await this.ctx.storage.setAlarm(Math.max(wake, Date.now() + 1_000));
      }
    }
  }

  // Every cricket match-winner market Polymarket US lists. The list is sorted by start time and capped per page,
  // and basketball fills the first pages, so it pages until the list runs out.
  private async discover(now: number) {
    const upsert = this.env.DB.prepare(`INSERT INTO markets (slug, league, event_slug, title, long_team, short_team, game_start, fee_coef, status, last_bid, last_ask, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET title=excluded.title, long_team=excluded.long_team, short_team=excluded.short_team,
        game_start=excluded.game_start, fee_coef=excluded.fee_coef, status=excluded.status, updated_at=excluded.updated_at`);
    const stmts: D1PreparedStatement[] = [];
    for (let off = 0; off < 6000; off += 500) {
      const res = await fetch(`${GATEWAY}/v1/markets?active=true&closed=false&marketTypes=moneyline&orderBy=gameStartTime&orderDirection=asc&limit=500&offset=${off}`, { headers: UA });
      if (!res.ok) break;
      const ms: any[] = ((await res.json()) as any).markets || [];
      for (const m of ms) {
        if (!String(m.sportsMarketType || '').startsWith('cricket') || !m.slug?.startsWith('aec-') || !m.gameStartTime) continue;
        const sides: any[] = Array.isArray(m.marketSides) ? m.marketSides : [];
        const longSide = sides.find((s) => s.long) || sides[0], shortSide = sides.find((s) => s !== longSide);
        const name = (s: any) => s?.team?.safeName || s?.team?.name || s?.description || null;
        const lt = name(longSide), st = name(shortSide);
        stmts.push(upsert.bind(m.slug, `cricket:${m.slug.split('-')[1]}`, m.slug.replace(/^aec-/, ''), m.title || (lt && st ? `${lt} vs. ${st}` : m.question || null),
          lt, st, m.gameStartTime, num(m.feeCoefficient), m.status || null, num(m.bestBidQuote), num(m.bestAskQuote), new Date(now).toISOString()));
      }
      if (ms.length < 500) break;
    }
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
  }

  private async load(now: number) {
    const { results } = await this.env.DB.prepare(
      "SELECT slug, league, long_team, short_team, game_start, espn_id, fee_coef FROM markets WHERE league LIKE 'cricket:%' AND result IS NULL AND game_start >= ? AND game_start <= ? ORDER BY game_start",
    ).bind(new Date(now - LIVE_FOR.multi).toISOString(), new Date(now + 24 * 60 * MIN).toISOString()).all<Mkt>();
    const known = new Map(this.markets.map((m) => [m.slug, m.espn_id]));
    this.markets = results.map((m) => ({ ...m, espn_id: m.espn_id || known.get(m.slug) || null }));
    this.loadedAt = now;
  }

  private async score(now: number, games: Mkt[]) {
    for (const host of ESPN) {
      try {
        const res = await fetch(`https://${host}/apis/site/v2/sports/cricket/scorepanel?_=${Math.floor(now / 2000)}`, { headers: UA });
        if (!res.ok) continue;
        const body: any = await res.json();
        this.events = (body.scores || []).flatMap((s: any) => (s.events || []).map((e: any) => ({ ...e, _league: s.leagues?.[0]?.name || '' })));
        this.scoreAt = now;
        break;
      } catch {}
    }
    const save: D1PreparedStatement[] = [];
    for (const m of games) {
      if (!m.espn_id) {
        const ev = matchCricket(m, this.events);
        if (ev) { m.espn_id = String(ev.id); save.push(this.env.DB.prepare('UPDATE markets SET espn_id = ? WHERE slug = ?').bind(m.espn_id, m.slug)); }
      }
    }
    if (save.length) await this.env.DB.batch(save);
    for (const ev of this.events) {
      const s = cricketState(ev, ev._league);
      if (!s) continue;
      const before = this.states.get(s.espnId);
      const key = (x?: CricketState) => (x ? `${x.state}|${x.innings}|${x.runs}|${x.wickets}|${x.balls}` : '');
      if (key(before) !== key(s)) { if (before) this.prevStates.set(s.espnId, before); this.stateAt.set(s.espnId, now); }
      this.states.set(s.espnId, s);
    }
  }

  private async quote(games: Mkt[]) {
    for (let i = 0; i < games.length; i += 40) {
      const chunk = games.slice(i, i + 40);
      try {
        const res = await fetch(`${GATEWAY}/v1/markets?${chunk.map((m) => `slug=${encodeURIComponent(m.slug)}`).join('&')}&limit=${chunk.length}&_=${Date.now()}`, { headers: UA });
        if (!res.ok) continue;
        for (const m of (((await res.json()) as any).markets || []) as any[]) {
          const bid = num(m.bestBidQuote), ask = num(m.bestAskQuote);
          this.quotes.set(m.slug, { bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : null });
        }
      } catch {}
    }
  }

  // The long side's team is batting?
  private longBats(m: Mkt, s: CricketState): boolean | null {
    if (!s.battingTeam) return null;
    const b = norm(s.battingTeam), l = norm(m.long_team), sh = norm(m.short_team);
    const like = (x: string) => !!x && (x === b || (x.length >= 4 && (b.includes(x) || x.includes(b))));
    if (like(l) && !like(sh)) return true;
    if (like(sh) && !like(l)) return false;
    return null;
  }

  private longProb(m: Mkt, s: CricketState | undefined): number | null {
    if (!s || s.state !== 'in') return null;
    const p = battingWinProb(s), lb = this.longBats(m, s);
    return p == null || lb == null ? null : lb ? p : 1 - p;
  }

  private record(games: Mkt[], now: number, stmts: D1PreparedStatement[]) {
    const ins = this.env.DB.prepare(`INSERT OR IGNORE INTO cricket_marks (slug, ts, bid, ask, espn_id, state, innings, runs, wickets, balls, target, p_long, score_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const m of games) {
      const q = this.quotes.get(m.slug), s = m.espn_id ? this.states.get(m.espn_id) : undefined;
      if (q?.mid != null) {
        const h = this.mids.get(m.slug) || [];
        h.push([now, q.mid]);
        while (h.length && h[0][0] < now - 10 * MIN) h.shift();
        this.mids.set(m.slug, h);
      }
      const key = `${q?.bid}|${q?.ask}|${s ? `${s.state}|${s.innings}|${s.runs}|${s.wickets}|${s.balls}` : ''}`;
      if (this.lastMark.get(m.slug) === key) continue;
      this.lastMark.set(m.slug, key);
      const p = this.longProb(m, s);
      stmts.push(ins.bind(m.slug, now, q?.bid ?? null, q?.ask ?? null, m.espn_id, s?.state ?? null, s?.innings ?? null, s?.runs ?? null, s?.wickets ?? null,
        s?.balls ?? null, s?.target ?? null, p == null ? null : r4(p), s ? this.stateAt.get(s.espnId) ?? null : null));
    }
  }

  private midAt(slug: string, t: number): number | null {
    const h = this.mids.get(slug);
    if (!h?.length) return null;
    let best: number | null = null;
    for (const [ts, mid] of h) { if (ts <= t) best = mid; else break; }
    return best;
  }

  private async paper(games: Mkt[], now: number) {
    const db = this.env.DB;
    const allocation = Number(this.env.BOT_ALLOCATION || 100) || 100;
    if (now - this.labAt >= 5 * MIN) {
      this.labAt = now;
      const lb = await db.prepare("SELECT v FROM brain WHERE k = 'lab_cricket'").first<{ v: string }>().catch(() => null);
      if (lb) { try { this.lab = JSON.parse(lb.v); } catch {} }
    }
    if (now - this.openAt > 30_000) {
      this.open = [];
      for (const st of CRICKET_STRATEGIES) this.open.push(...(await loadOpen(db, st.id)));
      this.openAt = now;
      for (const p of this.open) {
        const r = await db.prepare('SELECT result FROM markets WHERE slug = ?').bind(p.market_slug).first<{ result: number | null }>();
        if (r?.result === 0 || r?.result === 1) await settlePosition(db, p, { won: (p.side === 'long') === (r.result === 1), now });
      }
      this.open = this.open.filter((x) => x.status === 'open');
    }
    for (const m of games) {
      const q = this.quotes.get(m.slug);
      const s = m.espn_id ? this.states.get(m.espn_id) : undefined;
      const coef = m.fee_coef ?? 0.095;
      const fee = (p: number) => coef * p * (1 - p);
      const held = this.open.filter((p) => p.market_slug === m.slug && p.status === 'open');
      // Finished: settle on ESPN's winner (the market result settles anything left over).
      if (held.length && s?.state === 'post' && s.winner) {
        const longWon = norm(s.winner) === norm(m.long_team) ? true : norm(s.winner) === norm(m.short_team) ? false : null;
        if (longWon != null) for (const p of held) await settlePosition(db, p, { won: (p.side === 'long') === longWon, now });
        continue;
      }
      if (!q || q.bid == null || q.ask == null || q.mid == null || !s || s.state !== 'in') continue;
      const view = (side: Side) => ({ side, ask: side === 'long' ? q.ask! : r4(1 - q.bid!), bid: side === 'long' ? q.bid! : r4(1 - q.ask!), team: (side === 'long' ? m.long_team : m.short_team) || side });

      // Exits for the flip strategy.
      for (const p of held) {
        const st = CRICKET_STRATEGIES.find((x) => x.id === p.strategy);
        if (st?.kind !== 'lag_flip') continue;
        const meta = (() => { try { return JSON.parse((p as any).meta || '{}'); } catch { return {}; } })();
        const v = view(p.side);
        const moved = meta.mid0 != null ? (p.side === 'long' ? q.mid - meta.mid0 : meta.mid0 - q.mid) : 0;
        const caught = meta.dp != null && moved >= (2 / 3) * Math.abs(meta.dp);
        if (caught || now - p.opened_at >= FLIP_AFTER) {
          await closePosition(db, p, { price: v.bid, coef, maker: false, reason: `${caught ? 'market caught up' : '90 s up'}: bid ${cents(v.bid)} (in at ${cents(p.avg_entry ?? v.bid)}), ${s.runs}/${s.wickets} in ${Math.floor(s.balls / 6)}.${s.balls % 6} ov`, now });
          p.status = 'closed';
        }
      }

      // A scoring event this tick: what it did to the model, and whether the market has moved yet.
      const prev = m.espn_id ? this.prevStates.get(m.espn_id) : undefined;
      const changedAt = m.espn_id ? this.stateAt.get(m.espn_id) ?? 0 : 0;
      const ev = now - changedAt <= SCORE_EVERY + TICK ? eventBetween(prev, s) : null;
      const pNow = this.longProb(m, s), pBefore = this.longProb(m, prev);
      const spread = q.ask - q.bid;

      for (const st of CRICKET_STRATEGIES) {
        const status = statusOf(this.lab, st.id);
        if (status === 'retired' || held.some((p) => p.strategy === st.id && p.status === 'open')) continue;
        let pick: ReturnType<typeof view> | null = null, why = '', meta: Record<string, unknown> = {};
        if ((st.kind === 'lag_flip' || st.kind === 'lag_hold') && ev && !ev.inningsChanged && pNow != null && pBefore != null && (ev.wickets > 0 || ev.runs >= 4)) {
          const dp = pNow - pBefore;
          const mid0 = this.midAt(m.slug, changedAt - 1);
          const marketMove = mid0 == null ? null : q.mid - mid0;
          if (Math.abs(dp) >= 0.04 && marketMove != null && Math.abs(marketMove) < Math.abs(dp) / 3 && spread <= 0.06) {
            const v = view(dp > 0 ? 'long' : 'short');
            if (v.ask >= 0.05 && v.ask <= 0.95) {
              pick = v;
              why = `${ev.wickets ? `${ev.wickets} wicket${ev.wickets > 1 ? 's' : ''}` : `${ev.runs} runs`} moved the model ${dp > 0 ? '+' : ''}${Math.round(dp * 100)}¢ for ${m.long_team}; market ${marketMove >= 0 ? '+' : ''}${Math.round(marketMove * 100)}¢ so far`;
              meta = { dp: r4(dp), mid0: r4(q.mid), event: ev };
            }
          }
        } else if (st.kind === 'value' && s.innings === 2 && pNow != null && spread <= 0.05) {
          if (await db.prepare('SELECT 1 FROM bot_positions WHERE strategy = ? AND market_slug = ? LIMIT 1').bind(st.id, m.slug).first()) continue;
          const best = (['long', 'short'] as Side[]).map(view).map((v) => ({ ...v, fair: v.side === 'long' ? pNow : 1 - pNow }))
            .map((v) => ({ ...v, edge: v.fair - v.ask - fee(v.ask) })).filter((v) => v.ask >= 0.08 && v.ask <= 0.92 && v.edge >= 0.08).sort((a, b) => b.edge - a.edge)[0];
          if (best) { pick = best; why = `model ${cents(best.fair)} vs ask ${cents(best.ask)} in the chase`; meta = { fair: r4(best.fair) }; }
        }
        if (!pick) continue;
        const bank = await bankroll(db, st.bank ?? allocation, now, st.id, 'paper', st.lock ?? 0);
        if (dailyStopHit(bank.equity, bank.today, bank.peak)) continue;
        const qty = Math.floor(testStake({ equity: bank.equity, peak: bank.peak, available: bank.available, openNet: bank.openNet, ceiling: ceiling(this.env) }) / pick.ask);
        if (qty < 1) continue;
        const pos = await openPosition(db, {
          strategy: st.id, slug: m.slug, title: `${m.long_team || 'Team A'} vs. ${m.short_team || 'Team B'}`, side: pick.side, sideName: pick.team,
          ask: pick.ask, qty, coef, now, tpBelow: 0,
          reason: `${why}; ${s.battingTeam} ${s.runs}/${s.wickets} in ${Math.floor(s.balls / 6)}.${s.balls % 6} ov${s.target ? `, need ${s.target - s.runs}` : ''}`,
          meta: { rules: RULES, status, p: pNow == null ? null : r4(pNow), ...meta },
        });
        (pos as any).meta = JSON.stringify({ rules: RULES, status, ...meta });
        this.open.push(pos);
        held.push(pos);
      }
    }
    this.open = this.open.filter((p) => p.status === 'open');
    void takerFee;
  }
}
