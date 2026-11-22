// Is the bot ready for real money? Aaron only wants to switch LIVE_TRADING on once the strategy
// that would trade it has been consistent on paper. Five checks, all from the record (the app
// shows them; the switch stays his). Each one asks "is this real, or could it be luck?":
//   math      Bitcoin: 300+ graded windows, and the math beats the market's own price by enough
//             that luck is an unlikely explanation (t >= 2, with hours as the unit, because
//             windows that start in the same hour move together). Without this, profit is luck.
//             Sports: trades across 40+ different games (several trades in one game are one bet).
//   trades    Bitcoin 200+, Sports 100+ closed paper trades (Bitcoin: on the fixed engine, trades
//             that carry the feed record)
//   profit    up overall after fees, and by enough that luck is unlikely: t >= 2 on the return
//             per dollar bet, with hours (Bitcoin) or games (Sports) as the unit, so ten trades on
//             one window count once and a stretch of bigger bets doesn't drown out the rest
//   steady    the most recent trades in three blocks (50 for Bitcoin, 30 for Sports): the newest
//             block made money and at least two of the three did, so it isn't fading
//   drawdown  the account never fell more than 20% from its high along the way

export interface ReadyRow { pnl: number | null; cost: number | null; group?: string | number | null }
export interface ReadyModel {
  windows?: number; modelLoss?: number | null; marketLoss?: number | null;
  edge?: { mean: number | null; t: number | null; hours?: number; windows?: number } | null;
}

export const READY = {
  btc: { windows: 300, edgeT: 2, trades: 200, block: 50, profitT: 2, maxDD: 0.2, games: 0 },
  sports: { windows: 0, edgeT: 0, trades: 100, block: 30, profitT: 2, maxDD: 0.2, games: 40 },
} as const;

// Mean over its standard error, across groups. Null with fewer than 3 groups or no spread.
export function groupT(values: number[]): number | null {
  if (values.length < 3) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return v > 0 ? m / Math.sqrt(v / values.length) : null;
}

// The return on each dollar bet across a set of trades, and how sure it is. mean = P&L over
// dollars bet; se treats each group (an hour, a game) as one draw, since trades in a group rise and
// fall together; v is the spread of single-trade returns (what Kelly divides by).
export function returnStats(rows: ReadyRow[]) {
  let pnl = 0, cost = 0, n = 0;
  const g = new Map<string, { pnl: number; cost: number }>();
  const rets: number[] = [];
  rows.forEach((r, i) => {
    const c = r.cost || 0;
    if (!(c > 0)) return;
    const x = r.pnl || 0;
    pnl += x; cost += c; n++; rets.push(x / c);
    const k = String(r.group ?? `row${i}`);
    const a = g.get(k) || { pnl: 0, cost: 0 };
    a.pnl += x; a.cost += c; g.set(k, a);
  });
  const groups = g.size;
  const mean = cost > 0 ? pnl / cost : null;
  let se: number | null = null;
  if (mean != null && groups >= 3) {
    let ss = 0;
    for (const a of g.values()) ss += (a.pnl - mean * a.cost) ** 2;
    se = Math.sqrt((groups / (groups - 1)) * ss) / cost;
  }
  const rm = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const v = rets.length > 1 ? rets.reduce((a, b) => a + (b - rm) ** 2, 0) / (rets.length - 1) : null;
  const t = mean != null && se != null && se > 0 ? mean / se : null;
  return { n, groups, pnl, cost, mean, se, t, v };
}

export function readiness(rows: ReadyRow[], allocation: number, model: ReadyModel | null, opts: { kind?: 'btc' | 'sports'; games?: number } = {}) {
  const kind = opts.kind || 'btc';
  const need = READY[kind];
  const n = rows.length;
  let pnl = 0, staked = 0, eq = allocation, peak = allocation, maxDD = 0;
  for (const r of rows) {
    pnl += r.pnl || 0;
    staked += r.cost || 0;
    eq += r.pnl || 0;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  const rs = returnStats(rows);
  const profitT = rs.t;
  const last = rows.slice(-3 * need.block);
  const blocks = last.length >= 3 * need.block
    ? [0, 1, 2].map((i) => last.slice(i * need.block, (i + 1) * need.block).reduce((a, r) => a + (r.pnl || 0), 0))
    : null;
  const sharper = model?.modelLoss != null && model?.marketLoss != null && model.marketLoss > 0
    ? (model.marketLoss - model.modelLoss) / model.marketLoss : null;
  const edgeT = model?.edge?.t ?? null;
  const windows = model?.windows ?? 0;
  const ok = {
    math: kind === 'sports' ? (opts.games ?? 0) >= need.games : windows >= need.windows && edgeT != null && edgeT >= need.edgeT,
    trades: n >= need.trades,
    profit: n > 0 && pnl > 0 && profitT != null && profitT >= need.profitT,
    steady: !!blocks && blocks[2] > 0 && blocks.filter((b) => b > 0).length >= 2,
    drawdown: n >= need.block && maxDD <= need.maxDD,
  };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    n, pnl: r2(pnl), staked: r2(staked), maxDD: Math.round(maxDD * 1000) / 1000,
    blocks: blocks?.map(r2) ?? null, sharper: sharper == null ? null : Math.round(sharper * 1000) / 1000,
    edgeT: edgeT == null ? null : Math.round(edgeT * 100) / 100, profitT: profitT == null ? null : Math.round(profitT * 100) / 100,
    groups: rs.groups, roi: rs.mean == null ? null : Math.round(rs.mean * 10_000) / 10_000, windows, kind, games: opts.games ?? null, ok, ready: Object.values(ok).every(Boolean),
    need,
  };
}
