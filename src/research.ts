// The research board. Every strategy is judged on the bets it placed under the current rules, and the
// verdict decides how it bets next:
//   retired    losing beyond luck (even its best case is a loss), still nothing to show after three
//              times the bets it needs to be judged, or an idea the evidence already contradicts.
//              It stops betting.
//   testing    not enough bets to judge, or no clear answer yet. One contract a bet, so a test costs
//              pennies while it gathers data.
//   promising  ahead even in its worst case (mean minus 1.64 standard errors above zero, on the record
//              with one more full loss counted), the mirror of the retire rule. Bets its normal size. The board looks every 5 minutes, and a bar as low
//              as one standard error is one a strategy with no edge clears by luck often enough to bet
//              real money on a streak; at 1.64 that mostly stops.
//   proven     ahead by two standard errors over enough bets (the readiness card's bar). Normal size,
//              and it can size up on its own record.
// The top three are the proven and promising strategies with the best worst case (mean minus one
// standard error, as a return per dollar bet).
import { returnStats, withOneLoss, type ReadyRow } from './ready';
import { TAKER_COEF } from './fairvalue';

// Positions opened under the rules this board judges carry meta.rules >= RULES. Bump it when the
// rules change enough that older bets no longer say anything about the new ones.
export const RULES = 2;
export type Status = 'retired' | 'testing' | 'promising' | 'proven';
export type Book = 'btc' | 'sports';
export const LAB: Record<Book, { judge: number; groups: number; proven: number }> = {
  btc: { judge: 30, groups: 6, proven: 200 },       // groups: hours
  sports: { judge: 30, groups: 8, proven: 100 },    // groups: games
};
const Z = 1.64;   // best case = mean + 1.64 standard errors, worst case = mean - 1.64 (95% one-sided)

// Retired on the evidence of Nov 22, before the board existed.
export const RETIRED: Record<string, string> = {
  crypto_fade_v1: 'Bets against price moves the math doesn’t back, but the market leads the math: 7 of 22 up, −23% a dollar on Nov 22.',
  crypto_late_v1: 'Only bets the last two minutes, where the market beats the math: bets with under 4 minutes left lost $176 on Nov 22.',
  crypto_fav_late: 'Replayed on 30 days of Polymarket prices (2,215 bets): the 95–98¢ favorite with 2 minutes left won 96.9% of the time at 96.8¢, break-even before fees and a small loss after. No edge.',
  crypto_fav_last: 'Replayed on 30 days of Polymarket prices (1,557 bets): with 1 minute left the 95–98¢ favorite won 96.0% at 96.9¢, −1.2¢ a contract after fees. Favorites flip more often than their price says in the last minute.',
  // Nov 23, scripts/pvm_replay.py on 30 days of Polymarket prices (12,089 windows).
  crypto_fair_v1: 'Replayed on 30 days of Polymarket prices (2,454 bets): where the math beat the price by 5¢ or more, those bets won 36% at 37¢, −2.6¢ a contract after fees (t −2.9). The math said 46%; the market said 36%, and the market was right.',
  crypto_hold_v1: 'Same entries as price vs math, held to the result: −2.6¢ a contract over 2,454 replayed bets on 30 days of Polymarket prices (t −2.9). The market priced these windows right; the math was about 9 points too confident.',
  crypto_cheap_v1: 'Replayed on 30 days of Polymarket prices (1,192 bets): the cheap side at 5–20¢ with a sell at 2× lost 5.8¢ a contract, and held to the result it was flat (−0.7¢). No edge after fees.',
};

// The closed bets a strategy is judged on, with fees priced at full size. Polymarket rounds each
// fill's fee to the cent, so a one-contract test pays up to 30% more or less than the formula (and
// nothing at all under about 5 cents). A strategy is promoted to bet real size, so it's judged on the
// exact fee the same bets pay at size, not on a rounding quirk that goes away once it sizes up. Maker
// fills pay nothing either way. Binds: strategy LIKE pattern, RULES.
const EXACT = `${TAKER_COEF} * o.filled_qty * COALESCE(o.avg_fill, o.price) * (1 - COALESCE(o.avg_fill, o.price))`;
const TAKER = `o.order_type IN ('market', 'ioc')`;
export const AT_SIZE_SQL = `SELECT p.strategy, p.closed_at / 3600000 AS hr, p.market_slug AS game,
    p.pnl + p.fees - COALESCE(SUM(CASE WHEN ${TAKER} THEN ${EXACT} END), 0) AS pnl,
    p.cost - COALESCE(SUM(CASE WHEN o.action = 'buy' THEN o.fee END), 0)
      + COALESCE(SUM(CASE WHEN o.action = 'buy' AND ${TAKER} THEN ${EXACT} END), 0) AS cost
  FROM bot_positions p LEFT JOIN bot_orders o ON o.position_id = p.id AND o.filled_qty > 0
  WHERE p.mode = 'paper' AND p.status != 'open' AND p.strategy LIKE ? AND COALESCE(json_extract(p.meta, '$.rules'), 0) >= ?
  GROUP BY p.id`;

export interface Verdict {
  status: Status; reason: string;
  n: number; groups: number; pnl: number; cost: number;
  mean: number | null; se: number | null; t: number | null; low: number | null;
  quick?: Quick;
}

// The quick score: how far the side's price moved, mid to mid, in about the minute after each bet (the
// first of the bot's 30-second marks 60-120 s after entry). A bet's result takes the whole window; this
// says within the hour whether a strategy's entries come before the price moves its way. It's shown next
// to each verdict; the verdicts themselves still go by money.
export const QUICK_SQL = `SELECT p.strategy, p.opened_at / 3600000 AS hr,
    (CASE WHEN p.side = 'long' THEN (m.bid + m.ask) / 2 ELSE 1 - (m.bid + m.ask) / 2 END) - json_extract(p.meta, '$.mid') AS move
  FROM bot_positions p
  JOIN crypto_marks m ON m.slug = p.market_slug AND m.ts = (SELECT MIN(x.ts) FROM crypto_marks x
    WHERE x.slug = p.market_slug AND x.ts BETWEEN p.opened_at + 60000 AND p.opened_at + 120000 AND x.bid IS NOT NULL AND x.ask IS NOT NULL)
  WHERE p.mode = 'paper' AND p.strategy LIKE ? AND COALESCE(json_extract(p.meta, '$.rules'), 0) >= ?
    AND json_extract(p.meta, '$.mid') IS NOT NULL AND p.market_slug LIKE '%-updown-%'`;

export interface Quick { n: number; cents: number | null; t: number | null }
// Average move in cents, with hours as the unit for the standard error (bets in the same hour move together).
export function quickScore(rows: Array<{ move: number | null; hr: number }>): Quick {
  const xs = rows.filter((r): r is { move: number; hr: number } => r.move != null && Number.isFinite(r.move));
  const n = xs.length;
  if (!n) return { n: 0, cents: null, t: null };
  const mean = xs.reduce((a, r) => a + r.move, 0) / n;
  const g = new Map<number, number>();
  for (const r of xs) g.set(r.hr, (g.get(r.hr) || 0) + r.move - mean);
  let ss = 0;
  for (const v of g.values()) ss += v * v;
  const se = g.size >= 3 ? Math.sqrt((g.size / (g.size - 1)) * ss) / n : null;
  return { n, cents: Math.round(mean * 1000) / 10, t: se ? Math.round((mean / se) * 100) / 100 : null };
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10_000) / 10_000);

export function judge(id: string, rows: ReadyRow[], book: Book): Verdict {
  const s = returnStats(rows);
  // Moving up (and the ranking) go on the record with one more full loss counted (ready.ts withOneLoss),
  // so a strategy that hasn't lost yet can't size up on a streak; retiring goes on the real record.
  const g = returnStats(withOneLoss(rows));
  const base = {
    n: s.n, groups: s.groups, pnl: Math.round(s.pnl * 100) / 100, cost: Math.round(s.cost * 100) / 100,
    mean: r4(s.mean), se: r4(s.se), t: s.t == null ? null : Math.round(s.t * 100) / 100,
    low: g.mean != null && g.se != null ? r4(g.mean - g.se) : null,
  };
  if (RETIRED[id]) return { ...base, status: 'retired', reason: RETIRED[id] };
  const lab = LAB[book], unit = book === 'btc' ? 'hours' : 'games';
  if (s.n < lab.judge || s.groups < lab.groups || s.mean == null || s.se == null || !(s.se > 0)) {
    const more = s.n < lab.judge ? `${s.n} of ${lab.judge} bets on the new rules` : s.groups < lab.groups ? `${s.groups} of ${lab.groups} ${unit} so far` : 'no spread in its results yet';
    return { ...base, status: 'testing', reason: `Testing with one contract a bet: ${more}.` };
  }
  const t = s.mean / s.se, line = `${pct(s.mean)} a dollar over ${s.n} bets`;
  if (s.mean + Z * s.se < 0) {
    return { ...base, status: 'retired', reason: `Losing beyond luck: ${line}, best case ${pct(s.mean + Z * s.se)}.` };
  }
  if (s.n >= lab.judge * 3 && t < 0.5) {
    return { ...base, status: 'retired', reason: `Nothing to show after ${s.n} bets: ${pct(s.mean)} a dollar (t ${t.toFixed(1)}). Fees for no edge.` };
  }
  const gt = g.mean != null && g.se != null && g.se > 0 ? g.mean / g.se : null;
  if (s.n >= lab.proven && gt != null && gt >= 2 && s.pnl > 0) return { ...base, status: 'proven', reason: `Ahead beyond luck: ${line} (t ${gt.toFixed(1)} with one more full loss counted).` };
  if (g.mean != null && g.se != null && g.mean - Z * g.se > 0 && s.pnl > 0) return { ...base, status: 'promising', reason: `Ahead even in its worst case: ${line}, worst case ${pct(g.mean - Z * g.se)} even after one more full loss. Bets its normal size.` };
  return { ...base, status: 'testing', reason: `No clear answer yet: ${line} (t ${t.toFixed(1)}). Still one contract a bet.` };
}

export function board(rowsBy: Map<string, ReadyRow[]>, ids: string[], book: Book, now = Date.now(), quickBy?: Map<string, Quick>) {
  const strategies: Record<string, Verdict> = {};
  for (const id of new Set([...ids, ...rowsBy.keys()])) {
    strategies[id] = judge(id, rowsBy.get(id) || [], book);
    const q = quickBy?.get(id);
    if (q) strategies[id].quick = q;
  }
  const rank = (v: Verdict) => (v.status === 'proven' ? 1 : 0) * 10 + (v.low ?? -1);
  const top = Object.entries(strategies)
    .filter(([, v]) => v.status === 'proven' || v.status === 'promising')
    .sort((a, b) => rank(b[1]) - rank(a[1]))
    .slice(0, 3).map(([id]) => id);
  return { at: now, rules: RULES, book, strategies, top };
}

// What a strategy may do with its verdict (missing = testing; a retired idea stays retired).
export function statusOf(lab: { strategies?: Record<string, { status?: Status }> } | null | undefined, id: string): Status {
  if (RETIRED[id]) return 'retired';
  return lab?.strategies?.[id]?.status ?? 'testing';
}
