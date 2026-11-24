import { aggregateOrder, isApiFill, normalize, parseFill, pm, type Fill, type PmEnv, type Row } from './polymarket';
import { recordMarkets, settleMarkets } from './recorder';
import { bankroll } from './paper';
import { RISK_LADDER, drawdownScale, riskLimits, thinLine } from './fairvalue';
import { readiness, type ReadyRow } from './ready';
import { RULES, board, AT_SIZE_SQL, QUICK_SQL, quickScore, type Quick } from './research';
import { nextEvent } from './cryptomath';
import { gradeSports, type SportsMark } from './sportsgrade';
export { LiveFeed } from './live';
export { CryptoFeed } from './crypto';
import { HOOPS_IDS } from './live';
import { CRYPTO_IDS } from './crypto';

interface Env extends PmEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  LIVE: DurableObjectNamespace;
  CRYPTO: DurableObjectNamespace;
  BOT_ALLOCATION?: string;  // the bot's bankroll in dollars, set by Aaron only (default 100)
  BOT_MAX_BET?: string;     // Aaron's cap per bet in dollars (none by default; bets grow with the account)
  BTC_STREAM?: string;      // "off" turns the live bitcoin streams off
  LIVE_STRATEGY?: string;   // which bitcoin strategy trades real money (default crypto_fair_v1)
  SPORTS?: string;          // "off" puts the Sports bot to sleep (game feed, recorder, basketball paper traders); on by default
  SPORTS_STRATEGY?: string; // which sports strategy its readiness card follows (default hoops_trailer_v1, Aaron's style)
  LIVE_TRADING?: string;    // "on" lets the bot place real orders with its live account (Aaron sets it; default off)
  DASH_PASSWORD?: string;   // wrangler secret put DASH_PASSWORD
  SESSION_SECRET?: string;  // wrangler secret put SESSION_SECRET (any long random string)
}

const COLS = ['id', 'type', 't', 'action', 'title', 'sub', 'ev', 'ev_slug', 'mkt', 'cat', 'smt', 'sub2', 'game_start',
  'price', 'entry', 'qty', 'cost', 'basis', 'fee', 'settle', 'payout', 'pnl', 'order_id', 'color', 'done', 'amount', 'status', 'method'] as const;
const KEYMAP: Record<string, string> = { ev_slug: 'evSlug', game_start: 'gameStart', order_id: 'order' };
const camel = (c: string) => KEYMAP[c] || c;

const PUBLIC_PATHS = new Set(['/login', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/favicon.svg']);
const ONE_YEAR = 60 * 60 * 24 * 365;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/login') return login(req, env);
    if (url.pathname === '/logout') return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': cookie('', 0) } });
    if (!PUBLIC_PATHS.has(url.pathname) && !(await authed(req, env))) {
      if (url.pathname.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
      return Response.redirect(new URL('/login', url).toString(), 303);
    }

    try {
      if (url.pathname === '/api/activities' && req.method === 'GET') return json(await listActivities(env));
      if (url.pathname === '/api/state' && req.method === 'GET') return json(await state(env));
      if (url.pathname === '/api/sync' && req.method === 'POST') return json(await sync(env));
      if (url.pathname === '/api/bot' && req.method === 'GET') return json(await bot(env, url.searchParams.get('book') === 'sports' ? 'sports' : 'btc'));
      if (url.pathname === '/api/bot/curve' && req.method === 'GET') return json(await botCurve(env, url.searchParams.get('range') || '1d', url.searchParams.get('mode') === 'live' ? 'live' : 'paper'));
      if (url.pathname === '/api/paper') {
        if (req.method === 'GET') return json(await listPaper(env));
        if (req.method === 'POST') return json(await addPaper(env, await req.json()));
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500);
    }

    const res = await env.ASSETS.fetch(req);
    // The app shell should always revalidate so new deploys show up on the home-screen app.
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
      const r = new Response(res.body, res);
      r.headers.set('Cache-Control', 'no-cache');
      return r;
    }
    return res;
  },

  // Cron runs every minute: keep both bots' loops alive. Account sync every 15 minutes. The Sports
  // bot (game feed, minute price recorder, game settlement) sleeps with SPORTS=off.
  async scheduled(evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = new Date(evt.scheduledTime);
    const fullTick = now.getUTCMinutes() % 15 === 0;
    const sports = env.SPORTS !== 'off';
    ctx.waitUntil(env.CRYPTO.get(env.CRYPTO.idFromName('btc')).fetch('https://crypto/kick').catch(() => undefined));
    // The live feed is told on every tick: with sports off it clears its own alarm and stays asleep.
    ctx.waitUntil(env.LIVE.get(env.LIVE.idFromName('live')).fetch('https://live/kick').catch(() => undefined));
    ctx.waitUntil((async () => {
      if (sports) {
        try { await recordMarkets(env, now, fullTick); }
        catch (e: any) { if (fullTick) await logSync(env, false, 0, `recorder: ${e?.message || e}`); }
      }
      // Every 5 minutes: the research board for each bot (retire losers, rank what works).
      if (now.getUTCMinutes() % 5 === 0) await researchBoards(env).catch((e) => console.log('research board error', String(e?.message || e)));
      if (!fullTick) return;
      if (sports) {
        try { await settleMarkets(env, now); }
        catch (e: any) { await logSync(env, false, 0, `settle: ${e?.message || e}`); }
        // Twice an hour, right after settling: grade the Sports bot's math on finished games.
        if (now.getUTCMinutes() % 30 === 0) await gradeSportsBook(env).catch((e) => console.log('sports grading error', String(e?.message || e)));
      }
      await sync(env).catch((e) => logSync(env, false, 0, String(e?.message || e)));
    })());
  },
};

// ---------- data

async function listActivities(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${COLS.join(',')} FROM activities WHERE type != 'TRADE_FILL' ORDER BY t DESC`).all();
  return results.map((r: any) => {
    const o: Record<string, unknown> = {};
    for (const c of COLS) if (r[c] !== null && r[c] !== undefined && r[c] !== '') o[camel(c)] = r[c];
    return o;
  });
}

async function state(env: Env) {
  const snap = await env.DB.prepare('SELECT * FROM snapshots ORDER BY t DESC LIMIT 1').first<any>();
  const last = await env.DB.prepare('SELECT * FROM sync_log ORDER BY t DESC LIMIT 1').first<any>();
  // Counts come from the small stats table (kept by the recorder and the live feed), so a
  // dashboard refresh never scans the big price tables.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const games = await env.DB.prepare('SELECT COUNT(*) AS n FROM markets WHERE game_start > ?').bind(since).first<{ n: number }>().catch(() => null);
  const rows = await env.DB.prepare('SELECT k, n, last FROM stats').all<{ k: string; n: number; last: number | null }>().catch(() => null);
  const S: Record<string, { n: number; last: number | null }> = {};
  for (const r of rows?.results || []) S[r.k] = r;
  const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
  const fresh = (r?: { n: number; last: number | null }) => !!r?.last && Date.now() - r.last < 3 * 60_000;
  const liveFresh = fresh(S.live_now);
  const lastSignal = await env.DB.prepare('SELECT s.kind, s.ts, s.side, s.price, s.detail, m.title FROM signals s LEFT JOIN markets m ON m.slug = s.slug ORDER BY s.ts DESC LIMIT 1')
    .first<{ kind: string; ts: number; side: string | null; price: number | null; detail: string | null; title: string | null }>().catch(() => null);
  return {
    recorder: { games: games?.n ?? 0, totalPoints: S.prices?.n ?? 0, last: iso(S.prices?.last) },
    live: {
      now: liveFresh ? S.live_now.n : 0, focus: liveFresh ? S.focus_now?.n ?? 0 : 0,
      ticks: S.ticks?.n ?? 0, states: S.game_states?.n ?? 0, lines: S.lines?.n ?? 0, last: iso(S.ticks?.last),
      signals: (S.signals?.n ?? 0) + (S.crypto_signals?.n ?? 0),
      lastSignal: lastSignal ? { ...lastSignal, ts: iso(lastSignal.ts) } : null,
    },
    crypto: {
      btc: S.btc_cents ? S.btc_cents.n / 100 : null, at: iso(S.btc_cents?.last),
      ticks: S.crypto_ticks?.n ?? 0, signals: S.crypto_signals?.n ?? 0,
      // Live streams: updates per second over the last minute (0 = down), fresh within 3 minutes.
      stream: fresh(S.pm_stream) ? S.pm_stream.n / 10 : 0,
      ticker: fresh(S.cb_stream) ? S.cb_stream.n / 10 : 0,
      gemini: fresh(S.gm_stream) ? S.gm_stream.n / 10 : 0,
      volScale: S.btc_mult ? S.btc_mult.n / 100 : 1,
      mathWeight: S.btc_trust ? S.btc_trust.n / 100 : 0.5,   // the blend's weight on the math (stored in hundredths)
      skipped: S.gap_skips?.n ?? 0, feeSkips: S.fee_skips?.n ?? 0,
      paused: { feeds: S.feed_skips?.n ?? 0, jumps: S.jump_skips?.n ?? 0, news: S.event_skips?.n ?? 0 },
      replicaBooks: fresh(S.replica_books) ? S.replica_books.n : 0,   // order books behind the index copy, of 3
    },
    money: {
      on: env.LIVE_TRADING === 'on', strategy: env.LIVE_STRATEGY || 'crypto_fair_v1', sports: env.SPORTS !== 'off',
      last: await env.DB.prepare('SELECT ts, kind, detail FROM live_events ORDER BY ts DESC LIMIT 1').first<{ ts: number; kind: string; detail: string }>().catch(() => null),
    },
    snapshot: snap ? { t: snap.t, cash: snap.cash, positions: snap.positions, portfolio: snap.portfolio, reserved: snap.reserved } : null,
    lastSync: last ? { t: last.t, ok: !!last.ok, added: last.added, msg: last.msg } : null,
    apiConfigured: !!(env.POLYMARKET_KEY_ID && env.POLYMARKET_SECRET_KEY),
  };
}

// The Sports bot's math vs the market on finished games (sportsgrade.ts), saved for the app.
// The research board (research.ts): every strategy judged on its bets under the current rules, as a
// return per dollar with hours (bitcoin) or games (sports) as the unit. The bots read the verdicts:
// retired strategies stop betting, testing ones bet 3% of their account, promising and proven bet normally.
async function researchBoards(env: Env) {
  for (const book of ['btc', 'sports'] as const) {
    const { results } = await env.DB.prepare(AT_SIZE_SQL)
      .bind(BOOKS[book], RULES).all<{ strategy: string; pnl: number | null; cost: number | null; hr: number; game: string }>();
    const by = new Map<string, ReadyRow[]>();
    for (const r of results) {
      const a = by.get(r.strategy) || [];
      a.push({ pnl: r.pnl, cost: r.cost, group: book === 'btc' ? r.hr : r.game });
      by.set(r.strategy, a);
    }
    // The quick score (research.ts): bitcoin only, from the bot's 30-second marks. A failure here
    // never holds up the verdicts.
    let quick: Map<string, Quick> | undefined;
    if (book === 'btc') {
      try {
        const q = await env.DB.prepare(QUICK_SQL).bind(BOOKS.btc, RULES).all<{ strategy: string; hr: number; move: number | null }>();
        const qs = new Map<string, Array<{ move: number | null; hr: number }>>();
        for (const r of q.results) { const a = qs.get(r.strategy) || []; a.push({ move: r.move, hr: r.hr }); qs.set(r.strategy, a); }
        quick = new Map([...qs].map(([id, a]) => [id, quickScore(a)]));
      } catch (e) { console.log('quick score error', String((e as any)?.message || e)); }
    }
    const b = board(by, book === 'btc' ? CRYPTO_IDS : HOOPS_IDS, book, Date.now(), quick);
    await env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .bind(`lab_${book}`, JSON.stringify(b), Date.now()).run();
  }
}

async function gradeSportsBook(env: Env) {
  const { results } = await env.DB.prepare(`SELECT h.slug, h.point AS target, h.fair, h.bid, h.ask, m.result, m.league
    FROM hoops_marks h JOIN markets m ON m.slug = h.slug WHERE m.result IS NOT NULL`).all<SportsMark>();
  const g = gradeSports(results);
  await env.DB.prepare('INSERT INTO brain (k, v, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
    .bind('hoops_model', JSON.stringify(g), Date.now()).run();
}

// ---------- the bot's own ledger (never mixed with Aaron's trades)

// Two bots, one database, separate books. Every trade row carries its strategy, and the prefix
// says whose it is: crypto_ = the Bitcoin bot, hoops_ = the Sports bot. Each bot has its own paper
// lineup, its own learning, risk ladder and readiness card (and the Bitcoin bot its live account),
// and nothing here ever adds the two together, except the head-to-head, which compares them.
const BOOKS = { btc: 'crypto_%', sports: 'hoops_%' } as const;
type Book = keyof typeof BOOKS;

async function bot(env: Env, book: Book) {
  const allocation = Number(env.BOT_ALLOCATION || 100) || 100;
  const liveOn = env.LIVE_TRADING === 'on';
  const sports = env.SPORTS !== 'off';
  const q = async <T>(sql: string, ...args: unknown[]): Promise<T[]> =>
    (await env.DB.prepare(sql).bind(...args).all<T>().catch(() => ({ results: [] as T[] }))).results;
  const scope = ` AND strategy LIKE '${BOOKS[book]}'`;

  // One account's view: open positions marked at what they'd sell for, history, totals.
  const block = async (mode: 'paper' | 'live') => {
    const open = await q<any>(`SELECT * FROM bot_positions WHERE mode = ? AND status = 'open'${scope} ORDER BY opened_at DESC LIMIT 50`, mode);
    const history = await q<any>(`SELECT * FROM bot_positions WHERE mode = ? AND status != 'open'${scope} ORDER BY closed_at DESC LIMIT 100`, mode);
    const totals = (await q<{ realized: number | null; n: number; wins: number; fees: number | null; staked: number | null }>(
      `SELECT SUM(pnl) AS realized, COUNT(*) AS n, SUM(pnl > 0) AS wins, SUM(fees) AS fees, SUM(cost) AS staked FROM bot_positions WHERE mode = ? AND status != 'open'${scope}`, mode))[0];
    let unrealized = 0, atRisk = 0;
    const positions = [];
    for (const p of open) {
      const t = (await q<{ bid: number | null; ask: number | null; ts: number }>(
        'SELECT bid, ask, ts FROM ticks WHERE slug = ? ORDER BY ts DESC LIMIT 1', p.market_slug))[0];
      const exit = t ? (p.side === 'long' ? t.bid : t.ask != null ? 1 - t.ask : null) : null;
      const value = exit != null ? exit * (p.qty || 0) : null;
      const netIn = (p.cost || 0) - (p.proceeds || 0);
      const upnl = value != null ? value - netIn : null;
      if (upnl != null) unrealized += upnl;
      atRisk += Math.max(0, netIn);
      const orders = await q<any>('SELECT ts, action, price, qty, filled_qty, avg_fill, fee, status, reason, exchange_order_id FROM bot_orders WHERE position_id = ? ORDER BY ts', p.id);
      positions.push({ ...p, price: exit, priceAt: t?.ts ?? null, value, upnl, orders });
    }
    const realized = totals?.realized || 0;
    return {
      realized, unrealized, atRisk,
      equity: allocation + realized + unrealized,
      available: Math.max(0, allocation + realized - atRisk),
      record: { closed: totals?.n || 0, wins: totals?.wins || 0 },
      // Fees paid on closed trades and the money they were paid on (paper charges the full 0.095).
      fees: totals?.fees || 0, staked: totals?.staked || 0,
      positions, history,
    };
  };

  const paper = await block('paper');
  const byStrategy = await q<any>(`SELECT strategy,
      SUM(status != 'open') AS closed, SUM(status != 'open' AND pnl > 0) AS wins, SUM(status = 'open') AS open,
      COALESCE(SUM(CASE WHEN status != 'open' THEN pnl END), 0) AS pnl,
      COALESCE(SUM(CASE WHEN status != 'open' THEN cost END), 0) AS staked
    FROM bot_positions WHERE mode = 'paper'${scope} GROUP BY strategy ORDER BY strategy`);
  const isBtcSlug = "(s.slug LIKE 'cpc-btc-%' OR s.slug LIKE 'btc-above-%')";
  const signals = await q<any>(`SELECT s.slug, s.ts, s.kind, s.side, s.price, s.ref, s.detail, m.title, m.league
    FROM signals s LEFT JOIN markets m ON m.slug = s.slug WHERE ${book === 'btc' ? isBtcSlug : `NOT ${isBtcSlug}`} ORDER BY s.ts DESC LIMIT 30`);

  let live = null, model = null, ready = null, exits = null, records = null, riskFor: { strategy?: string; mode: 'paper' | 'live' };
  if (book === 'btc') {
    // The Bitcoin bot's real-money account (only bitcoin has a live engine so far).
    const anyLive = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM bot_positions WHERE mode = 'live'${scope}`))[0]?.n || 0;
    const events = await q<any>('SELECT ts, kind, slug, detail FROM live_events ORDER BY ts DESC LIMIT 40');
    live = liveOn || anyLive || events.length
      ? { on: liveOn, strategy: env.LIVE_STRATEGY || 'crypto_fair_v1', ...(await block('live')), events }
      : null;
    // What the bitcoin model has learned: its latest self-grading (every half hour), each
    // exchange's offset to the official index (every window start), trades the data check refused.
    const brainRows = await q<{ k: string; v: string; at: number }>("SELECT k, v, at FROM brain WHERE k IN ('btc_model', 'btc_basis', 'btc_tod', 'btc_replica', 'btc_records')");
    const fromBrain = (k: string) => {
      const r = brainRows.find((x) => x.k === k);
      try { return r ? { ...JSON.parse(r.v), at: r.at } : null; } catch { return null; }
    };
    const graded = fromBrain('btc_model'), basis = fromBrain('btc_basis'), tod = fromBrain('btc_tod'), replica = fromBrain('btc_replica');
    records = fromBrain('btc_records');
    if (tod) delete tod.bins;
    const st = Object.fromEntries((await q<{ k: string; n: number }>(
      "SELECT k, n FROM stats WHERE k IN ('gap_skips', 'feed_skips', 'jump_skips', 'event_skips', 'fee_skips')")).map((r) => [r.k, r.n]));
    model = {
      ...(graded || {}), basis, tod, replica, skips: st.gap_skips || 0, feeSkips: st.fee_skips || 0,
      // Times it held off: the exchanges disagreed, bitcoin had just jumped, a release was due
      paused: { feeds: st.feed_skips || 0, jumps: st.jump_skips || 0, news: st.event_skips || 0 },
      nextEvent: nextEvent(Date.now()),
    };
    // Ready for real money? The strategy that would trade it, on the fixed engine (trades carrying
    // the feed record, Nov 22 on), plus the grading's verdict on the math.
    const liveId = env.LIVE_STRATEGY || 'crypto_fair_v1';
    // Trades are grouped by the hour they closed in for the "is it luck?" test: trades on the same
    // window, or windows in the same hour, rise and fall together.
    const rows = await q<{ pnl: number; cost: number; group: number }>(`SELECT pnl, cost, closed_at / 3600000 AS "group" FROM bot_positions
      WHERE mode = 'paper' AND strategy = ? AND status != 'open' AND json_extract(meta, '$.feeds') IS NOT NULL ORDER BY closed_at`, liveId);
    ready = { strategy: liveId, ...readiness(rows, allocation, graded) };
    riskFor = live?.record?.closed ? { mode: 'live' } : { strategy: liveId, mode: 'paper' };
    // Selling early vs holding to the result, per strategy, since the Nov 22 fix (trades carrying the
    // feed record, the same scope as the readiness card): what each early sale got, against what
    // its contracts paid when the window settled ($1 if its side won, nothing if not). Positive:
    // selling beat holding. Split into losers sold early (what selling saved) and winners sold
    // early (what holding would have added).
    const ex = await q<any>(`SELECT p.strategy, COUNT(*) AS n, SUM(p.status = 'closed') AS early,
        SUM(p.status = 'closed' AND won = 1) AS winners,
        ROUND(SUM(p.proceeds - shares * won), 2) AS vsHold,
        ROUND(SUM(CASE WHEN p.status = 'closed' AND won = 0 THEN p.proceeds ELSE 0 END), 2) AS saved,
        ROUND(SUM(CASE WHEN p.status = 'closed' AND won = 1 THEN shares - p.proceeds ELSE 0 END), 2) AS gaveUp
      FROM (SELECT p.*, (p.side = 'long') = (w.result = 1) AS won,
              (SELECT COALESCE(SUM(o.filled_qty), 0) FROM bot_orders o WHERE o.position_id = p.id AND o.action = 'buy') AS shares
            FROM bot_positions p JOIN windows w ON w.slug = p.market_slug AND w.result IS NOT NULL
            WHERE p.mode = 'paper' AND p.status != 'open'${scope.replace('strategy', 'p.strategy')} AND json_extract(p.meta, '$.feeds') IS NOT NULL) p
      GROUP BY p.strategy`);
    exits = Object.fromEntries(ex.map((r) => [r.strategy, { n: r.n, early: r.early || 0, winners: r.winners || 0, vsHold: r.vsHold || 0, saved: r.saved || 0, gaveUp: r.gaveUp || 0 }]));
  } else {
    // The Sports bot: paper only. Its card follows one strategy (Aaron's style by default) and
    // counts different games, since several trades in one game are one bet on that game.
    const id = env.SPORTS_STRATEGY || 'hoops_trailer_v1';
    const rows = await q<{ pnl: number; cost: number; group: string }>(`SELECT pnl, cost, market_slug AS "group" FROM bot_positions
      WHERE mode = 'paper' AND strategy = ? AND status != 'open' ORDER BY closed_at`, id);
    const games = (await q<{ n: number }>(`SELECT COUNT(DISTINCT market_slug) AS n FROM bot_positions WHERE mode = 'paper' AND strategy = ? AND status != 'open'`, id))[0]?.n || 0;
    ready = { strategy: id, ...readiness(rows, allocation, null, { kind: 'sports', games }) };
    const hm = (await q<{ v: string; at: number }>("SELECT v, at FROM brain WHERE k = 'hoops_model'"))[0];
    const pending = (await q<{ n: number }>('SELECT COUNT(DISTINCT h.slug) AS n FROM hoops_marks h JOIN markets m ON m.slug = h.slug WHERE m.result IS NULL'))[0]?.n || 0;
    try { model = { ...(hm ? JSON.parse(hm.v) : { games: 0 }), at: hm?.at ?? null, pending }; } catch { model = { games: 0, pending }; }
    riskFor = { strategy: id, mode: 'paper' };
  }

  // Where that account sits on the risk ladder right now.
  const acct = await bankroll(env.DB, allocation, Date.now(), riskFor.strategy, riskFor.mode);
  const lim = riskLimits(acct.peak);
  const risk = {
    account: riskFor.mode, strategy: riskFor.strategy ?? null, equity: acct.equity, peak: acct.peak, openNet: acct.openNet,
    floor: acct.peak * (1 - lim.dd), scale: drawdownScale(acct.equity, acct.peak, lim.dd), ...lim,
    ladder: RISK_LADDER,
  };

  // Head to head: both bots on equal terms (paper, since both started on Nov 22).
  const compare: Record<string, unknown> = {};
  for (const k of Object.keys(BOOKS) as Book[]) {
    const r = (await q<any>(`SELECT COUNT(*) AS n, SUM(pnl > 0) AS wins, COALESCE(SUM(pnl), 0) AS pnl, COALESCE(SUM(cost), 0) AS staked,
        COUNT(DISTINCT strategy) AS strategies, COUNT(DISTINCT market_slug) AS markets, MIN(opened_at) AS since
      FROM bot_positions WHERE mode = 'paper' AND status != 'open' AND strategy LIKE ?`, BOOKS[k]))[0] || {};
    const best = (await q<any>(`SELECT strategy, SUM(pnl) AS pnl, SUM(cost) AS staked FROM bot_positions
      WHERE mode = 'paper' AND status != 'open' AND strategy LIKE ? GROUP BY strategy ORDER BY SUM(pnl) DESC LIMIT 1`, BOOKS[k]))[0] || null;
    const open = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM bot_positions WHERE mode = 'paper' AND status = 'open' AND strategy LIKE ?`, BOOKS[k]))[0]?.n || 0;
    compare[k] = {
      closed: r.n || 0, wins: r.wins || 0, pnl: r.pnl || 0, staked: r.staked || 0, roi: r.staked ? r.pnl / r.staked : null,
      strategies: r.strategies || 0, markets: r.markets || 0, open, since: r.since || null, best,
    };
  }

  // The research board for this bot (written every 5 minutes) and its total under the current rules.
  const labRow = await env.DB.prepare('SELECT v, at FROM brain WHERE k = ?').bind(`lab_${book}`).first<{ v: string; at: number }>().catch(() => null);
  let lab = null;
  try { lab = labRow ? { ...JSON.parse(labRow.v), at: labRow.at } : null; } catch { lab = null; }
  const run = (await q<{ n: number; pnl: number | null; staked: number | null; fees: number | null }>(`SELECT COUNT(*) AS n, SUM(pnl) AS pnl, SUM(cost) AS staked, SUM(fees) AS fees
    FROM bot_positions WHERE mode = 'paper' AND status != 'open'${scope} AND COALESCE(json_extract(meta, '$.rules'), 0) >= ?`, RULES))[0] || null;
  return {
    book, books: Object.keys(BOOKS), mode: liveOn ? 'live' : 'paper', allocation, sports, rules: RULES, lab, run,
    model, live, ready, risk, compare, exits, records,
    // This bot's paper accounts
    ...paper, signals, byStrategy,
  };
}

// The bot's P&L over time for the chart: realized P&L summed into time buckets, as running
// totals for everything, bitcoin and basketball, plus a small running total per strategy for the
// sparklines. Open positions are added on the phone from /api/bot, so the line ends at "now".
const SPANS: Record<string, number> = { '1h': 3_600_000, '1d': 86_400_000, '1w': 7 * 86_400_000 };
const groupOf = (strategy: string | null) => (strategy?.startsWith('crypto_') ? 'btc' : strategy?.startsWith('hoops_') ? 'hoops' : 'other');

async function botCurve(env: Env, range: string, mode: 'paper' | 'live') {
  const now = Date.now();
  let from = SPANS[range] ? now - SPANS[range] : 0;
  // "run": only bets placed under the current rules (the research board's run), from its first bet.
  const onRules = range === 'run' ? ` AND COALESCE(json_extract(meta, '$.rules'), 0) >= ${RULES}` : '';
  const rows = (await env.DB.prepare(`SELECT closed_at AS t, pnl, cost, strategy FROM bot_positions WHERE mode = ? AND status != 'open' AND closed_at >= ?${onRules} ORDER BY closed_at`)
    .bind(mode, from).all<{ t: number; pnl: number | null; cost: number | null; strategy: string | null }>()).results;
  if (!SPANS[range]) {
    const first = await env.DB.prepare(`SELECT MIN(opened_at) AS t FROM bot_positions WHERE mode = ?${onRules}`).bind(mode).first<{ t: number | null }>();
    from = Math.min(first?.t ?? now - 3_600_000, now - 3_600_000);
  }
  const N = 120, S = 24;
  const step = (now - from) / N;
  const groups = ['all', 'btc', 'hoops'] as const;
  const sum: Record<string, number[]> = {}, n: Record<string, number[]> = {};
  const wins: Record<string, number> = {}, losses: Record<string, number> = {};
  for (const g of groups) { sum[g] = new Array(N).fill(0); n[g] = new Array(N).fill(0); wins[g] = 0; losses[g] = 0; }
  const strat: Record<string, number[]> = {};
  // Each strategy's own line, bet by bet: [seconds after "from", running P&L], for the per-strategy
  // charts. Long runs are thinned to the low and high of each stretch so the shape survives.
  const per: Record<string, { n: number; w: number; pnl: number; staked: number; pts: [number, number][] }> = {};
  for (const r of rows) {
    const k = r.strategy || 'other';
    const x = (per[k] ||= { n: 0, w: 0, pnl: 0, staked: 0, pts: [] });
    x.n++; if ((r.pnl || 0) > 0) x.w++;
    x.pnl = Math.round((x.pnl + (r.pnl || 0)) * 100) / 100;
    x.staked += r.cost || 0;
    x.pts.push([Math.round((r.t - from) / 1000), x.pnl]);
  }
  for (const x of Object.values(per)) {
    x.staked = Math.round(x.staked * 100) / 100;
    x.pts = thinLine(x.pts, 60);
  }
  for (const r of rows) {
    const i = Math.min(N - 1, Math.max(0, Math.floor((r.t - from) / step)));
    const pnl = r.pnl || 0;
    for (const g of ['all', groupOf(r.strategy)]) {
      if (!sum[g]) continue;
      sum[g][i] += pnl; n[g][i]++;
      if (pnl > 0) wins[g]++; else losses[g]++;
    }
    const k = r.strategy || 'other';
    strat[k] ||= new Array(S).fill(0);
    strat[k][Math.min(S - 1, Math.max(0, Math.floor(((r.t - from) / (now - from)) * S)))] += pnl;
  }
  const running = (xs: number[]) => { let c = 0; return xs.map((x) => (c = Math.round((c + x) * 100) / 100)); };
  return {
    range, from, to: now,
    t: Array.from({ length: N }, (_, i) => Math.round(from + (i + 1) * step)),
    all: running(sum.all), btc: running(sum.btc), hoops: running(sum.hoops),
    n, wins, losses,
    strat: Object.fromEntries(Object.entries(strat).map(([k, v]) => [k, running(v)])),
    per,
  };
}

async function upsert(env: Env, rows: Array<Row & { raw?: string }>) {
  if (!rows.length) return;
  const cols = [...COLS, 'raw'];
  const placeholders = cols.map(() => '?').join(',');
  // Trades and settlements never change once recorded, so the row already stored wins and
  // a thinner feed can only fill gaps. Deposits/withdrawals do change (PENDING -> COMPLETED).
  const fresh = new Set(['status', 'done', 'raw']);
  const updates = cols.filter((c) => c !== 'id')
    .map((c) => (fresh.has(c) ? `${c}=COALESCE(excluded.${c}, activities.${c})` : `${c}=COALESCE(activities.${c}, excluded.${c})`)).join(',');
  const stmt = env.DB.prepare(`INSERT INTO activities (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`);
  const batch = rows.map((r: any) => stmt.bind(...cols.map((c) => (c === 'raw' ? r.raw ?? null : r[camel(c)] ?? null))));
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
}

// Pull newest-first until a page brings nothing new. Pending deposits/withdrawals
// get re-upserted so their status flips to COMPLETED on their own.
// Trades arrive one row per fill; fills go to their own table and are rolled up
// into one activity row per order (id ord_<orderId>).
async function sync(env: Env) {
  if (!env.POLYMARKET_KEY_ID || !env.POLYMARKET_SECRET_KEY) throw new Error('Polymarket API key not configured');
  const known = new Set(
    (await env.DB.prepare('SELECT id FROM activities').all<{ id: string }>()).results.map((r) => r.id),
  );
  const knownFills = new Set(
    (await env.DB.prepare('SELECT id FROM fills').all<{ id: string }>()).results.map((r) => r.id),
  );
  const touchedOrders = new Set<string>();
  let cursor: string | undefined, added = 0, pages = 0, skipped = 0;
  while (pages++ < 60) {
    const q = new URLSearchParams({ limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const page = await pm<any>(env, 'GET', '/v1/portfolio/activities', q);
    const acts: any[] = page.activities || [];

    const fillActs = acts.filter(isApiFill);
    const fills = fillActs.map((a) => ({ f: parseFill(a), raw: JSON.stringify(a) })).filter((x): x is { f: Fill; raw: string } => !!x.f);
    skipped += fillActs.length - fills.length;
    const freshFills = fills.filter((x) => !knownFills.has(x.f.id));
    if (freshFills.length) {
      const stmt = env.DB.prepare('INSERT OR IGNORE INTO fills (id, order_id, t, mkt, raw) VALUES (?,?,?,?,?)');
      for (let i = 0; i < freshFills.length; i += 50) {
        await env.DB.batch(freshFills.slice(i, i + 50).map((x) => stmt.bind(x.f.id, x.f.orderId, x.f.t, x.f.mkt, x.raw)));
      }
      for (const x of freshFills) { touchedOrders.add(x.f.orderId); knownFills.add(x.f.id); }
    }

    const others = acts.filter((a) => !isApiFill(a)).map((a) => ({ ...normalize(a), raw: JSON.stringify(a) }));
    const rows = others.filter((r: Row) => r.id && r.t);
    skipped += others.length - rows.length;
    const fresh = rows.filter((r: Row) => !known.has(r.id));
    added += fresh.length;
    await upsert(env, rows);

    if ((known.size && !fresh.length && !freshFills.length) || page.eof || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  added += await rollUpOrders(env, touchedOrders);

  try {
    const b = await pm<any>(env, 'GET', '/v1/account/balances');
    const usd = (b.balances || []).find((x: any) => (x.currency || 'USD') === 'USD') || b.balances?.[0];
    if (usd) {
      // buyingPower is the cash figure the app shows. currentBalance still includes
      // pending withdrawals. bonusReservation is a promo credit not yet released.
      const cash = Number(usd.buyingPower ?? usd.currentBalance ?? 0), pos = Number(usd.assetNotional ?? 0);
      await env.DB.prepare('INSERT OR REPLACE INTO snapshots (t, cash, positions, portfolio, reserved, raw) VALUES (?,?,?,?,?,?)')
        .bind(new Date().toISOString(), cash, pos, cash + pos, Number(usd.bonusReservation ?? 0), JSON.stringify(b)).run();
    }
  } catch (e: any) {
    await logSync(env, false, added, `balances: ${e?.message || e}`);
    return { ok: true, added, warning: 'balances failed' };
  }
  await logSync(env, true, added, skipped ? `${skipped} activities had no timestamp and were skipped` : null);
  return { ok: true, added, skipped };
}

async function rollUpOrders(env: Env, orderIds: Set<string>) {
  let added = 0;
  for (const orderId of orderIds) {
    const { results } = await env.DB.prepare('SELECT raw FROM fills WHERE order_id = ?').bind(orderId).all<{ raw: string }>();
    const fills = results.map((r) => parseFill(JSON.parse(r.raw))).filter((f): f is Fill => !!f);
    const row = aggregateOrder(fills);
    if (!row) continue;
    // Orders from before the API sync existed are already stored (from the website history)
    // under their own id. Same market, same timestamp, same direction = same order.
    const dup = await env.DB.prepare("SELECT 1 FROM activities WHERE type IN ('TRADE','TRADE_FILL') AND id NOT LIKE 'ord_%' AND mkt = ? AND t = ? AND action = ? LIMIT 1")
      .bind(row.mkt ?? null, row.t, row.action ?? null).first();
    if (dup) continue;
    const exists = await env.DB.prepare('SELECT 1 FROM activities WHERE id = ?').bind(row.id).first();
    const placeholders = COLS.map(() => '?').join(',');
    const updates = COLS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',');
    await env.DB.prepare(`INSERT INTO activities (${COLS.join(',')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`)
      .bind(...COLS.map((c) => (row as any)[camel(c)] ?? null)).run();
    if (!exists) added++;
  }
  return added;
}

async function logSync(env: Env, ok: boolean, added: number, msg: string | null) {
  await env.DB.prepare('INSERT OR REPLACE INTO sync_log (t, ok, added, msg) VALUES (?,?,?,?)')
    .bind(new Date().toISOString(), ok ? 1 : 0, added, msg).run();
}

// Paper trades: the bot (or you) logs a call here instead of placing it.
// Graded later against how the market settled. Nothing here touches real money.
async function listPaper(env: Env) {
  return (await env.DB.prepare('SELECT * FROM paper_trades ORDER BY created_at DESC LIMIT 500').all()).results;
}

async function addPaper(env: Env, b: any) {
  const required = ['market_slug', 'side', 'price', 'stake'];
  for (const k of required) if (b?.[k] === undefined) throw new Error(`missing ${k}`);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO paper_trades (id, created_at, strategy, market_slug, title, side, price, stake, rationale, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, new Date().toISOString(), b.strategy || 'manual', b.market_slug, b.title || null, b.side, Number(b.price), Number(b.stake), b.rationale || null, 'open').run();
  return { id };
}

// ---------- auth: one password, then a signed cookie good for a year.
// (Home-screen web apps on iOS handle HTTP basic auth badly, so no basic auth.)

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function secretOf(env: Env) {
  return env.SESSION_SECRET || `pm:${env.DASH_PASSWORD}`;
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authed(req: Request, env: Env) {
  if (!env.DASH_PASSWORD) return true; // local dev without a password
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)pm_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(secretOf(env), exp));
}

function cookie(value: string, maxAge: number) {
  return `pm_session=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function login(req: Request, env: Env) {
  let error = '';
  if (req.method === 'POST') {
    const form = await req.formData();
    const pw = String(form.get('password') || '');
    if (env.DASH_PASSWORD && safeEqual(pw, env.DASH_PASSWORD)) {
      const exp = String(Math.floor(Date.now() / 1000) + ONE_YEAR);
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': cookie(`${exp}.${await hmac(secretOf(env), exp)}`, ONE_YEAR) } });
    }
    error = 'That password didn’t match.';
  }
  return new Response(loginPage(error), { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function loginPage(error: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Pilk Bets">
<meta name="theme-color" content="#000000"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="manifest" href="/manifest.webmanifest">
<title>Pilk Bets</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#000;color:#f5f5f7;font:17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom))}
form{width:100%;max-width:340px;display:grid;gap:14px}
img{width:72px;height:72px;border-radius:17px;margin:0 auto 6px}
h1{font:600 28px/1.1 -apple-system,"SF Pro Display",system-ui;letter-spacing:-.02em;text-align:center;margin:0}
p{margin:0 0 10px;text-align:center;color:#8e8e93;font-size:15px}
input{font:inherit;font-size:17px;color:inherit;background:#1c1c1e;border:1px solid #2c2c2e;border-radius:14px;padding:15px 16px;outline:none;transition:border-color 160ms ease}
input:focus{border-color:#0a84ff}
button{font:600 17px/1 -apple-system,system-ui;color:#000;background:#f5f5f7;border:0;border-radius:14px;padding:16px;transition:transform 120ms cubic-bezier(.23,1,.32,1)}
button:active{transform:scale(.97)}.err{color:#ff453a;text-align:center;font-size:15px;min-height:1.2em}
</style></head><body><form method="post" action="/login">
<img src="/icon-180.png" alt=""><h1>Pilk Bets</h1><p>Your Polymarket record, on your home screen.</p>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Unlock</button><div class="err">${error}</div></form></body></html>`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
