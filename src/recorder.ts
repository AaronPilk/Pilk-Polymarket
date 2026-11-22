// Market recorder: builds the price history the bot learns from.
// Public Polymarket US data only (no key). Every minute while a game is live,
// every 15 minutes before it starts, and only when the price actually moved.

const GATEWAY = 'https://gateway.polymarket.us';
const LEAGUES = new Set(['nfl', 'cfb', 'nba', 'cbb']);
const HOUR = 3600_000;

interface RecEnv { DB: D1Database }

const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : null;
};

export interface MarketRow {
  slug: string; league: string; event_slug: string; title: string | null;
  long_team: string | null; short_team: string | null; game_start: string;
  fee_coef: number | null; status: string | null;
}

export function toMarketRow(m: any): MarketRow | null {
  const slug: string = m?.slug || '';
  const league = slug.split('-')[1];
  if (!slug.startsWith('aec-') || !LEAGUES.has(league) || !m.gameStartTime) return null;
  const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
  const longSide = sides.find((s: any) => s.long) || sides[0];
  const shortSide = sides.find((s: any) => s !== longSide);
  const name = (s: any) => s?.team?.safeName || s?.team?.name || s?.description || null;
  const longTeam = name(longSide), shortTeam = name(shortSide);
  return {
    slug, league, event_slug: slug.replace(/^aec-/, ''),
    title: m.title || (longTeam && shortTeam ? `${longTeam} vs. ${shortTeam}` : m.question || null),
    long_team: longTeam, short_team: shortTeam, game_start: m.gameStartTime,
    fee_coef: num(m.feeCoefficient), status: m.status || null,
  };
}

// Returns how many price points were written.
export async function recordMarkets(env: RecEnv, now = new Date(), fullTick = false): Promise<{ watched: number; written: number }> {
  const url = `${GATEWAY}/v1/markets?active=true&closed=false&marketTypes=moneyline&orderBy=gameStartTime&orderDirection=asc&limit=300`;
  const res = await fetch(url, { headers: { 'User-Agent': 'pilk-bets/1.0' } });
  if (!res.ok) throw new Error(`gateway markets ${res.status}`);
  const body: any = await res.json();
  const nowMs = now.getTime();
  const minute = new Date(Math.floor(nowMs / 60000) * 60000).toISOString();

  const watched: Array<{ row: MarketRow; bid: number | null; ask: number | null; live: boolean }> = [];
  for (const m of body.markets || []) {
    const row = toMarketRow(m);
    if (!row) continue;
    const start = Date.parse(row.game_start);
    if (!(start > nowMs - 5 * HOUR && start < nowMs + 24 * HOUR)) continue;
    const live = start <= nowMs;
    if (!live && !fullTick && start - nowMs > 2 * HOUR) continue;
    watched.push({ row, bid: num(m.bestBidQuote), ask: num(m.bestAskQuote), live });
  }
  if (!watched.length) return { watched: 0, written: 0 };

  // Last stored quote per market, so we only write when something moved.
  const last = new Map<string, { bid: number | null; ask: number | null }>();
  for (let i = 0; i < watched.length; i += 80) {
    const slugs = watched.slice(i, i + 80).map((w) => w.row.slug);
    const { results } = await env.DB.prepare(`SELECT slug, last_bid AS bid, last_ask AS ask FROM markets WHERE slug IN (${slugs.map(() => '?').join(',')})`)
      .bind(...slugs).all<{ slug: string; bid: number | null; ask: number | null }>();
    for (const r of results) last.set(r.slug, { bid: r.bid, ask: r.ask });
  }

  const stmts: D1PreparedStatement[] = [];
  const upsertMarket = env.DB.prepare(`INSERT INTO markets (slug, league, event_slug, title, long_team, short_team, game_start, fee_coef, status, last_bid, last_ask, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET title=excluded.title, long_team=excluded.long_team, short_team=excluded.short_team,
      game_start=excluded.game_start, fee_coef=excluded.fee_coef, status=excluded.status,
      last_bid=excluded.last_bid, last_ask=excluded.last_ask, updated_at=excluded.updated_at`);
  const insertPrice = env.DB.prepare('INSERT OR IGNORE INTO prices (slug, t, bid, ask, live) VALUES (?,?,?,?,?)');
  let written = 0;
  for (const w of watched) {
    const prev = last.get(w.row.slug);
    const moved = !prev || prev.bid !== w.bid || prev.ask !== w.ask;
    if (moved) {
      stmts.push(insertPrice.bind(w.row.slug, minute, w.bid, w.ask, w.live ? 1 : 0));
      written++;
    }
    if (moved || fullTick || !prev) {
      const r = w.row;
      stmts.push(upsertMarket.bind(r.slug, r.league, r.event_slug, r.title, r.long_team, r.short_team, r.game_start, r.fee_coef, r.status, w.bid, w.ask, now.toISOString()));
    }
  }
  if (written) {
    // Running counter so the dashboard never has to count the prices table.
    stmts.push(env.DB.prepare('INSERT INTO stats (k, n, last) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n, last = excluded.last')
      .bind('prices', written, now.getTime()));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { watched: watched.length, written };
}

// Mark finished games with their result (1 = long side won, 0 = short side won).
export async function settleMarkets(env: RecEnv, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 2.5 * HOUR).toISOString();
  const { results } = await env.DB.prepare('SELECT slug FROM markets WHERE result IS NULL AND game_start < ? ORDER BY game_start LIMIT 40')
    .bind(cutoff).all<{ slug: string }>();
  if (!results.length) return 0;
  const qs = results.map((r) => `slug=${encodeURIComponent(r.slug)}`).join('&');
  const res = await fetch(`${GATEWAY}/v1/markets?${qs}&limit=40`, { headers: { 'User-Agent': 'pilk-bets/1.0' } });
  if (!res.ok) throw new Error(`gateway settle ${res.status}`);
  const body: any = await res.json();
  const stmt = env.DB.prepare('UPDATE markets SET status = ?, result = ?, settled_at = ? WHERE slug = ?');
  const stmts: D1PreparedStatement[] = [];
  for (const m of body.markets || []) {
    if (m.status !== 'MARKET_STATUS_RESOLVED') continue;
    let prices: string[] = [];
    try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}
    const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
    const longIdx = Math.max(0, sides.findIndex((s: any) => s.long));
    const longPx = num(prices[longIdx]);
    const result = longPx === 1 ? 1 : longPx === 0 ? 0 : null;
    stmts.push(stmt.bind(m.status, result, now.toISOString(), m.slug));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}
