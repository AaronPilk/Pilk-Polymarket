// Is the bot ready for real money? Aaron only wants to switch LIVE_TRADING on once the strategy
// that would trade it has been consistent on paper. Five checks, all from the record (the app
// shows them; the switch stays his). Each one asks "is this real, or could it be luck?":
//   math      Bitcoin: 300+ graded windows, and the math beats the market's own price by enough
//             that luck is an unlikely explanation (t >= 2, with hours as the unit, because
//             windows that start in the same hour move together). Without this, profit is luck.
//             Sports: trades across 40+ different games (several trades in one game are one bet).
//   trades    Bitcoin 200+, Sports 100+ closed paper trades (Bitcoin: on the fixed engine, trades
//             that carry the feed record)
//   profit    up overall after fees, and by enough that luck is unlikely: t >= 2 on the profit
//             per hour (Bitcoin) or per game (Sports), so ten trades on one window count once
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

export function readiness(rows: ReadyRow[], allocation: number, model: ReadyModel | null, opts: { kind?: 'btc' | 'sports'; games?: number } = {}) {
  const kind = opts.kind || 'btc';
  const need = READY[kind];
  const n = rows.length;
  let pnl = 0, staked = 0, eq = allocation, peak = allocation, maxDD = 0;
  const byGroup = new Map<string, number>();
  rows.forEach((r, i) => {
    pnl += r.pnl || 0;
    staked += r.cost || 0;
    eq += r.pnl || 0;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - eq) / peak);
    const g = String(r.group ?? `row${i}`);
    byGroup.set(g, (byGroup.get(g) || 0) + (r.pnl || 0));
  });
  const profitT = groupT([...byGroup.values()]);
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
    groups: byGroup.size, windows, kind, games: opts.games ?? null, ok, ready: Object.values(ok).every(Boolean),
    need,
  };
}
