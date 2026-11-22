// The bot's ledger: open, add, sell, settle. Paper and live positions share bot_positions and
// bot_orders, told apart by mode ('paper' | 'live'). Paper fills are simulated; live entries come
// from the exchange's actual fills (see openLivePosition / liveSell). Fills are kept honest: buys at the
// ask and sells at the bid, both paying the taker fee; a resting take-profit fills with no fee,
// and only once the bid reaches it. Whole contracts only.

import { takerFee } from './fairvalue';

export type Side = 'long' | 'short';

export interface Position {
  id: string; strategy: string; market_slug: string; title: string | null; side: Side; side_name: string | null;
  status: string; opened_at: number; qty: number; avg_entry: number; cost: number; proceeds: number; fees: number;
  adds: number; take_profit: number | null; meta?: string | null; mode?: string; pnl?: number | null;
}

export interface Bankroll { allocation: number; realized: number; openNet: number; equity: number; available: number; today: number; openGames: number; peak: number }

const id = (prefix: string, now: number) => `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

// Midnight in New York for the day containing `now` (epoch ms).
export function startOfDayET(now: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24, m = Number(parts.minute), s = Number(parts.second);
  return now - ((h * 60 + m) * 60 + s) * 1000 - (now % 1000);
}

// Each paper strategy runs its own account of `allocation` dollars, so results compare cleanly. The
// live account (mode 'live') is one account across whatever strategy trades it.
export async function bankroll(db: D1Database, allocation: number, now: number, strategy?: string, mode: 'paper' | 'live' = 'paper'): Promise<Bankroll> {
  const row = await db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status != 'open' THEN pnl END), 0) AS realized,
      COALESCE(SUM(CASE WHEN status = 'open' THEN cost - proceeds END), 0) AS open_net,
      COALESCE(SUM(CASE WHEN status != 'open' AND closed_at >= ?1 THEN pnl END), 0) AS today,
      COUNT(DISTINCT CASE WHEN status = 'open' THEN market_slug END) AS open_games
    FROM bot_positions WHERE mode = ?3 AND (?2 IS NULL OR strategy = ?2)`).bind(startOfDayET(now), strategy ?? null, mode).first<any>();
  // The high-water mark: the best the account has stood at after any closed trade.
  const hw = await db.prepare(`SELECT COALESCE(MAX(run), 0) AS best FROM (
      SELECT SUM(pnl) OVER (ORDER BY closed_at, id) AS run FROM bot_positions
      WHERE mode = ?2 AND (?1 IS NULL OR strategy = ?1) AND status != 'open' AND pnl IS NOT NULL)`).bind(strategy ?? null, mode).first<any>();
  const realized = row?.realized || 0, openNet = row?.open_net || 0;
  const equity = allocation + realized;
  return {
    allocation, realized, openNet, equity, today: row?.today || 0, openGames: row?.open_games || 0,
    available: Math.max(0, allocation + realized - openNet),
    peak: Math.max(equity, allocation + Math.max(0, hw?.best || 0)),
  };
}

// Every open position on a market, paper and live: both settle the same way at the result.
export async function loadOpenBySlug(db: D1Database, slug: string): Promise<Position[]> {
  return (await db.prepare("SELECT * FROM bot_positions WHERE status = 'open' AND market_slug = ?")
    .bind(slug).all<Position>()).results;
}

export async function loadOpen(db: D1Database, strategy: string): Promise<Position[]> {
  return (await db.prepare("SELECT * FROM bot_positions WHERE mode = 'paper' AND status = 'open' AND strategy = ?")
    .bind(strategy).all<Position>()).results;
}

function order(db: D1Database, o: {
  pos: string; now: number; slug: string; side: Side; action: string; type: string; price: number; qty: number; fee: number; status: string; reason: string;
  mode?: 'paper' | 'live'; exchangeId?: string | null; filled?: number; avg?: number | null;
}) {
  const filled = o.filled ?? (o.status === 'filled' ? o.qty : 0);
  return db.prepare(`INSERT INTO bot_orders (id, position_id, ts, mode, market_slug, side, action, order_type, price, qty, filled_qty, avg_fill, fee, status, reason, exchange_order_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id(o.mode === 'live' ? 'lo' : 'po', o.now), o.pos, o.now, o.mode || 'paper', o.slug, o.side, o.action, o.type, r4(o.price), o.qty,
    filled, o.avg ?? (filled ? r4(o.price) : null), o.fee, o.status, o.reason, o.exchangeId ?? null, o.now);
}

const cancelResting = (db: D1Database, pos: string, now: number) =>
  db.prepare("UPDATE bot_orders SET status = 'cancelled', updated_at = ? WHERE position_id = ? AND status = 'resting'").bind(now, pos);

// Take-profit for cheap entries: a resting sell at 2x, placed at the fill (from his history:
// cheap buys spike and give it back within minutes). Above 15c, winners tend to keep running.
export const takeProfitFor = (avgEntry: number, below = 0.15): number | null => (avgEntry < below ? Math.min(0.99, r4(avgEntry * 2)) : null);

export async function openPosition(db: D1Database, o: {
  strategy: string; slug: string; title: string; side: Side; sideName: string; ask: number; qty: number; coef: number; reason: string; now: number; tpBelow?: number;
  meta?: Record<string, unknown>;
}): Promise<Position> {
  const fee = takerFee(o.qty, o.ask, o.coef);
  const cost = r2(o.qty * o.ask + fee);
  const tp = takeProfitFor(o.ask, o.tpBelow);
  const pos: Position = {
    id: id('pp', o.now), strategy: o.strategy, market_slug: o.slug, title: o.title, side: o.side, side_name: o.sideName,
    status: 'open', opened_at: o.now, qty: o.qty, avg_entry: r4(o.ask), cost, proceeds: 0, fees: fee, adds: 0, take_profit: tp,
    meta: o.meta ? JSON.stringify(o.meta) : null,
  };
  const stmts = [
    db.prepare(`INSERT INTO bot_positions (id, mode, strategy, market_slug, title, side, side_name, status, opened_at, qty, avg_entry, cost, proceeds, fees, adds, take_profit, reason, meta)
      VALUES (?, 'paper', ?,?,?,?,?, 'open', ?,?,?,?,0,?,0,?,?,?)`).bind(pos.id, o.strategy, o.slug, o.title, o.side, o.sideName, o.now, o.qty, pos.avg_entry, cost, fee, tp, o.reason, pos.meta ?? null),
    order(db, { pos: pos.id, now: o.now, slug: o.slug, side: o.side, action: 'buy', type: 'market', price: o.ask, qty: o.qty, fee, status: 'filled', reason: `starter: ${o.reason}` }),
  ];
  if (tp != null) stmts.push(order(db, { pos: pos.id, now: o.now, slug: o.slug, side: o.side, action: 'sell', type: 'limit', price: tp, qty: o.qty, fee: 0, status: 'resting', reason: 'take_profit' }));
  await db.batch(stmts);
  return pos;
}

export async function addToPosition(db: D1Database, pos: Position, o: { ask: number; qty: number; coef: number; reason: string; now: number; tpBelow?: number }) {
  const fee = takerFee(o.qty, o.ask, o.coef);
  const qty = pos.qty + o.qty;
  pos.avg_entry = r4((pos.avg_entry * pos.qty + o.ask * o.qty) / qty);
  pos.qty = qty;
  pos.cost = r2(pos.cost + o.qty * o.ask + fee);
  pos.fees = r2(pos.fees + fee);
  pos.adds += 1;
  pos.take_profit = takeProfitFor(pos.avg_entry, o.tpBelow);
  const stmts = [
    db.prepare('UPDATE bot_positions SET qty = ?, avg_entry = ?, cost = ?, fees = ?, adds = ?, take_profit = ? WHERE id = ?')
      .bind(pos.qty, pos.avg_entry, pos.cost, pos.fees, pos.adds, pos.take_profit, pos.id),
    order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'buy', type: 'market', price: o.ask, qty: o.qty, fee, status: 'filled', reason: `add: ${o.reason}` }),
    cancelResting(db, pos.id, o.now),
  ];
  if (pos.take_profit != null) stmts.push(order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'sell', type: 'limit', price: pos.take_profit, qty: pos.qty, fee: 0, status: 'resting', reason: 'take_profit' }));
  await db.batch(stmts);
}

// Sell everything. Market sells pay the taker fee; a filled take-profit (maker) pays none.
export async function closePosition(db: D1Database, pos: Position, o: { price: number; coef: number; maker: boolean; reason: string; now: number }) {
  const fee = o.maker ? 0 : takerFee(pos.qty, o.price, o.coef);
  const proceeds = r2(pos.proceeds + pos.qty * o.price - fee);
  const fees = r2(pos.fees + fee);
  const pnl = r2(proceeds - pos.cost);
  await db.batch([
    db.prepare("UPDATE bot_positions SET status = 'closed', closed_at = ?, qty = 0, proceeds = ?, fees = ?, pnl = ? WHERE id = ?").bind(o.now, proceeds, fees, pnl, pos.id),
    cancelResting(db, pos.id, o.now),
    order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'sell', type: o.maker ? 'limit' : 'market', price: o.price, qty: pos.qty, fee, status: 'filled', reason: o.reason }),
  ]);
  pos.status = 'closed';
  pos.proceeds = proceeds; pos.fees = fees; pos.pnl = pnl; pos.qty = 0;
}

// Held to the end: each contract pays $1 if its side won, $0 if not.
export async function settlePosition(db: D1Database, pos: Position, o: { won: boolean; now: number }) {
  const payout = o.won ? 1 : 0;
  const proceeds = r2(pos.proceeds + pos.qty * payout);
  const pnl = r2(proceeds - pos.cost);
  await db.batch([
    db.prepare("UPDATE bot_positions SET status = 'settled', closed_at = ?, qty = 0, proceeds = ?, pnl = ?, result = ? WHERE id = ?").bind(o.now, proceeds, pnl, payout, pos.id),
    cancelResting(db, pos.id, o.now),
    order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'settle', type: 'settlement', price: payout, qty: pos.qty, fee: 0, status: 'filled', reason: o.won ? 'won' : 'lost', mode: pos.mode === 'live' ? 'live' : 'paper' }),
  ]);
  pos.status = 'settled';
  pos.proceeds = proceeds; pos.pnl = pnl; pos.qty = 0;
}

// ---------- live: the ledger records what the exchange actually filled

// A live entry from an IOC buy's real fills. If a take-profit order was placed, it's recorded as
// resting with its exchange id so the bot can watch it and cancel it.
export async function openLivePosition(db: D1Database, o: {
  strategy: string; slug: string; title: string; side: Side; sideName: string; qty: number; avgPx: number; fee: number;
  limitPx: number; exchangeId: string | null; reason: string; now: number; meta?: Record<string, unknown>;
}): Promise<Position> {
  const cost = r2(o.qty * o.avgPx + o.fee);
  const pos: Position = {
    id: id('lp', o.now), strategy: o.strategy, market_slug: o.slug, title: o.title, side: o.side, side_name: o.sideName,
    status: 'open', opened_at: o.now, qty: o.qty, avg_entry: r4(o.avgPx), cost, proceeds: 0, fees: r2(o.fee), adds: 0, take_profit: null,
    meta: o.meta ? JSON.stringify(o.meta) : null, mode: 'live',
  };
  await db.batch([
    db.prepare(`INSERT INTO bot_positions (id, mode, strategy, market_slug, title, side, side_name, status, opened_at, qty, avg_entry, cost, proceeds, fees, adds, take_profit, reason, meta)
      VALUES (?, 'live', ?,?,?,?,?, 'open', ?,?,?,?,0,?,0,NULL,?,?)`).bind(pos.id, o.strategy, o.slug, o.title, o.side, o.sideName, o.now, o.qty, pos.avg_entry, cost, pos.fees, o.reason, pos.meta ?? null),
    order(db, { pos: pos.id, now: o.now, slug: o.slug, side: o.side, action: 'buy', type: 'ioc', price: o.limitPx, qty: o.qty, fee: o.fee, status: 'filled', reason: `entry: ${o.reason}`, mode: 'live', exchangeId: o.exchangeId, filled: o.qty, avg: r4(o.avgPx) }),
  ]);
  return pos;
}

export async function recordLiveTakeProfit(db: D1Database, pos: Position, o: { price: number; qty: number; exchangeId: string; now: number }) {
  pos.take_profit = r4(o.price);
  await db.batch([
    db.prepare('UPDATE bot_positions SET take_profit = ? WHERE id = ?').bind(pos.take_profit, pos.id),
    order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'sell', type: 'limit', price: o.price, qty: o.qty, fee: 0, status: 'resting', reason: 'take_profit', mode: 'live', exchangeId: o.exchangeId, filled: 0, avg: null }),
  ]);
}

// Close out a resting live order's row (the take-profit) once it's filled or cancelled.
export async function markLiveOrder(db: D1Database, exchangeId: string, status: string, now: number) {
  await db.prepare("UPDATE bot_orders SET status = ?, updated_at = ? WHERE exchange_order_id = ? AND status = 'resting'").bind(status, now, exchangeId).run();
}

// A live sale (IOC sell or the take-profit filling), possibly partial. The position closes once
// nothing is left.
export async function liveSell(db: D1Database, pos: Position, o: {
  qty: number; avgPx: number; fee: number; limitPx: number; exchangeId: string | null; maker: boolean; reason: string; now: number;
}) {
  const qty = Math.min(o.qty, pos.qty);
  pos.proceeds = r2(pos.proceeds + qty * o.avgPx - o.fee);
  pos.fees = r2(pos.fees + o.fee);
  pos.qty = Math.round((pos.qty - qty) * 10_000) / 10_000;
  const done = pos.qty <= 1e-9;
  const stmts = [
    order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'sell', type: o.maker ? 'limit' : 'ioc', price: o.limitPx, qty, fee: o.fee, status: 'filled', reason: o.reason, mode: 'live', exchangeId: o.exchangeId, filled: qty, avg: r4(o.avgPx) }),
  ];
  if (done) {
    pos.status = 'closed';
    pos.pnl = r2(pos.proceeds - pos.cost);
    stmts.push(db.prepare("UPDATE bot_positions SET status = 'closed', closed_at = ?, qty = 0, proceeds = ?, fees = ?, pnl = ? WHERE id = ?").bind(o.now, pos.proceeds, pos.fees, pos.pnl, pos.id));
  } else {
    stmts.push(db.prepare('UPDATE bot_positions SET qty = ?, proceeds = ?, fees = ? WHERE id = ?').bind(pos.qty, pos.proceeds, pos.fees, pos.id));
  }
  await db.batch(stmts);
}
