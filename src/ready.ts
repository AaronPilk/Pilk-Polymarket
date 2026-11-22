// Is the bot ready for real money? Aaron only wants to switch LIVE_TRADING on once the strategy
// that would trade it has been consistent on paper. Five checks, all from the record (the app
// shows them; the switch stays his):
//   math      the grading has 40+ finished windows and the math scores at least 1% better than
//             the market's own price (log loss). Without this, any profit is luck.
//   trades    100+ closed paper trades on the fixed engine (trades that carry the feed record)
//   profit    those trades are up overall, after fees
//   steady    the last 90 split into three blocks of 30: at least two of the three made money
//   drawdown  the account never fell more than 20% from its high along the way

export interface ReadyRow { pnl: number | null; cost: number | null }
export interface ReadyModel { ready?: boolean; windows?: number; modelLoss?: number | null; marketLoss?: number | null }

export const READY_TRADES = 100;
export const READY_BLOCK = 30;
export const READY_MAX_DD = 0.2;
export const READY_EDGE = 0.01;

export function readiness(rows: ReadyRow[], allocation: number, model: ReadyModel | null) {
  const n = rows.length;
  let pnl = 0, staked = 0, eq = allocation, peak = allocation, maxDD = 0;
  for (const r of rows) {
    pnl += r.pnl || 0;
    staked += r.cost || 0;
    eq += r.pnl || 0;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  const last = rows.slice(-3 * READY_BLOCK);
  const blocks = last.length >= 3 * READY_BLOCK
    ? [0, 1, 2].map((i) => last.slice(i * READY_BLOCK, (i + 1) * READY_BLOCK).reduce((a, r) => a + (r.pnl || 0), 0))
    : null;
  const sharper = model?.modelLoss != null && model?.marketLoss != null && model.marketLoss > 0
    ? (model.marketLoss - model.modelLoss) / model.marketLoss : null;
  const ok = {
    math: !!model?.ready && sharper != null && sharper >= READY_EDGE,
    trades: n >= READY_TRADES,
    profit: n > 0 && pnl > 0,
    steady: !!blocks && blocks.filter((b) => b > 0).length >= 2,
    drawdown: n >= READY_BLOCK && maxDD <= READY_MAX_DD,
  };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    n, pnl: r2(pnl), staked: r2(staked), maxDD: Math.round(maxDD * 1000) / 1000,
    blocks: blocks?.map(r2) ?? null, sharper: sharper == null ? null : Math.round(sharper * 1000) / 1000,
    windows: model?.windows ?? 0, ok, ready: Object.values(ok).every(Boolean),
    need: { trades: READY_TRADES, block: READY_BLOCK, maxDD: READY_MAX_DD, edge: READY_EDGE },
  };
}
