// The research board. Every strategy is judged on the bets it placed under the current rules, and the
// verdict decides how it bets next:
//   retired    losing beyond luck (even its best case is a loss), still nothing to show after three
//              times the bets it needs to be judged, or an idea the evidence already contradicts.
//              It stops betting.
//   testing    not enough bets to judge, or no clear answer yet. One contract a bet, so a test costs
//              pennies while it gathers data.
//   promising  ahead by more than one standard error. Bets its normal size.
//   proven     ahead by two standard errors over enough bets (the readiness card's bar). Normal size,
//              and it can size up on its own record.
// The top three are the proven and promising strategies with the best worst case (mean minus one
// standard error, as a return per dollar bet).
import { returnStats, type ReadyRow } from './ready';

// Positions opened under the rules this board judges carry meta.rules >= RULES. Bump it when the
// rules change enough that older bets no longer say anything about the new ones.
export const RULES = 2;
export type Status = 'retired' | 'testing' | 'promising' | 'proven';
export type Book = 'btc' | 'sports';
export const LAB: Record<Book, { judge: number; groups: number; proven: number }> = {
  btc: { judge: 30, groups: 6, proven: 200 },       // groups: hours
  sports: { judge: 30, groups: 8, proven: 100 },    // groups: games
};
const RETIRE_Z = 1.64;   // best case = mean + 1.64 standard errors (95% one-sided)

// Retired on the evidence of Nov 22, before the board existed.
export const RETIRED: Record<string, string> = {
  crypto_fade_v1: 'Bets against price moves the math doesn’t back, but the market leads the math: 7 of 22 up, −23% a dollar on Nov 22.',
  crypto_late_v1: 'Only bets the last two minutes, where the market beats the math: bets with under 4 minutes left lost $176 on Nov 22.',
};

export interface Verdict {
  status: Status; reason: string;
  n: number; groups: number; pnl: number; cost: number;
  mean: number | null; se: number | null; t: number | null; low: number | null;
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10_000) / 10_000);

export function judge(id: string, rows: ReadyRow[], book: Book): Verdict {
  const s = returnStats(rows);
  const base = {
    n: s.n, groups: s.groups, pnl: Math.round(s.pnl * 100) / 100, cost: Math.round(s.cost * 100) / 100,
    mean: r4(s.mean), se: r4(s.se), t: s.t == null ? null : Math.round(s.t * 100) / 100,
    low: s.mean != null && s.se != null ? r4(s.mean - s.se) : null,
  };
  if (RETIRED[id]) return { ...base, status: 'retired', reason: RETIRED[id] };
  const lab = LAB[book], unit = book === 'btc' ? 'hours' : 'games';
  if (s.n < lab.judge || s.groups < lab.groups || s.mean == null || s.se == null || !(s.se > 0)) {
    const more = s.n < lab.judge ? `${s.n} of ${lab.judge} bets on the new rules` : `${s.groups} of ${lab.groups} ${unit} so far`;
    return { ...base, status: 'testing', reason: `Testing with one contract a bet: ${more}.` };
  }
  const t = s.mean / s.se, line = `${pct(s.mean)} a dollar over ${s.n} bets`;
  if (s.mean + RETIRE_Z * s.se < 0) {
    return { ...base, status: 'retired', reason: `Losing beyond luck: ${line}, best case ${pct(s.mean + RETIRE_Z * s.se)}.` };
  }
  if (s.n >= lab.judge * 3 && t < 0.5) {
    return { ...base, status: 'retired', reason: `Nothing to show after ${s.n} bets: ${pct(s.mean)} a dollar (t ${t.toFixed(1)}). Fees for no edge.` };
  }
  if (s.n >= lab.proven && t >= 2 && s.pnl > 0) return { ...base, status: 'proven', reason: `Ahead beyond luck: ${line} (t ${t.toFixed(1)}).` };
  if (t >= 1 && s.pnl > 0) return { ...base, status: 'promising', reason: `Ahead by more than its noise: ${line} (t ${t.toFixed(1)}). Bets its normal size.` };
  return { ...base, status: 'testing', reason: `No clear answer yet: ${line} (t ${t.toFixed(1)}). Still one contract a bet.` };
}

export function board(rowsBy: Map<string, ReadyRow[]>, ids: string[], book: Book, now = Date.now()) {
  const strategies: Record<string, Verdict> = {};
  for (const id of new Set([...ids, ...rowsBy.keys()])) strategies[id] = judge(id, rowsBy.get(id) || [], book);
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
