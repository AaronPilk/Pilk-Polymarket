// The bot's paper ledger: open, add, sell, settle. It writes bot_positions and bot_orders, the
// same tables live trading will use, with mode = 'paper'. Fills are kept honest: buys at the
// ask and sells at the bid, both paying the taker fee; a resting take-profit fills with no fee,
// and only once the bid reaches it. Whole contracts only.

import { takerFee } from './fairvalue';

export type Side = 'long' | 'short';

export interface Position {
  id: string; strategy: string; market_slug: string; title: string | null; side: Side; side_name: string | null;
  status: string; opened_at: number; qty: number; avg_entry: number; cost: number; proceeds: number; fees: number;
  adds: number; take_profit: number | null;
}

export interface Bankroll { allocation: number; realized: number; openNet: number; equity: number; available: number; today: number; openGames: number }

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

export async function bankroll(db: D1Database, allocation: number, now: number): Promise<Bankroll> {
  const row = await db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status != 'open' THEN pnl END), 0) AS realized,
      COALESCE(SUM(CASE WHEN status = 'open' THEN cost - proceeds END), 0) AS open_net,
      COALESCE(SUM(CASE WHEN status != 'open' AND closed_at >= ? THEN pnl END), 0) AS today,
      COUNT(DISTINCT CASE WHEN status = 'open' THEN market_slug END) AS open_games
    FROM bot_positions WHERE mode = 'paper'`).bind(startOfDayET(now)).first<any>();
  const realized = row?.realized || 0, openNet = row?.open_net || 0;
  return {
    allocation, realized, openNet, equity: allocation + realized, today: row?.today || 0, openGames: row?.open_games || 0,
    available: Math.max(0, allocation + realized - openNet),
  };
}

export async function loadOpen(db: D1Database, strategy: string): Promise<Position[]> {
  return (await db.prepare("SELECT * FROM bot_positions WHERE mode = 'paper' AND status = 'open' AND strategy = ?")
    .bind(strategy).all<Position>()).results;
}

function order(db: D1Database, o: { pos: string; now: number; slug: string; side: Side; action: string; type: string; price: number; qty: number; fee: number; status: string; reason: string }) {
  return db.prepare(`INSERT INTO bot_orders (id, position_id, ts, mode, market_slug, side, action, order_type, price, qty, filled_qty, avg_fill, fee, status, reason, updated_at)
    VALUES (?,?,?,'paper',?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id('po', o.now), o.pos, o.now, o.slug, o.side, o.action, o.type, r4(o.price), o.qty,
    o.status === 'filled' ? o.qty : 0, o.status === 'filled' ? r4(o.price) : null, o.fee, o.status, o.reason, o.now);
}

const cancelResting = (db: D1Database, pos: string, now: number) =>
  db.prepare("UPDATE bot_orders SET status = 'cancelled', updated_at = ? WHERE position_id = ? AND status = 'resting'").bind(now, pos);

// Take-profit for cheap entries: a resting sell at 2x, placed at the fill (from his history:
// cheap buys spike and give it back within minutes). Above 15c, winners tend to keep running.
export const takeProfitFor = (avgEntry: number): number | null => (avgEntry < 0.15 ? Math.min(0.99, r4(avgEntry * 2)) : null);

export async function openPosition(db: D1Database, o: {
  strategy: string; slug: string; title: string; side: Side; sideName: string; ask: number; qty: number; coef: number; reason: string; now: number;
}): Promise<Position> {
  const fee = takerFee(o.qty, o.ask, o.coef);
  const cost = r2(o.qty * o.ask + fee);
  const tp = takeProfitFor(o.ask);
  const pos: Position = {
    id: id('pp', o.now), strategy: o.strategy, market_slug: o.slug, title: o.title, side: o.side, side_name: o.sideName,
    status: 'open', opened_at: o.now, qty: o.qty, avg_entry: r4(o.ask), cost, proceeds: 0, fees: fee, adds: 0, take_profit: tp,
  };
  const stmts = [
    db.prepare(`INSERT INTO bot_positions (id, mode, strategy, market_slug, title, side, side_name, status, opened_at, qty, avg_entry, cost, proceeds, fees, adds, take_profit, reason)
      VALUES (?, 'paper', ?,?,?,?,?, 'open', ?,?,?,?,0,?,0,?,?)`).bind(pos.id, o.strategy, o.slug, o.title, o.side, o.sideName, o.now, o.qty, pos.avg_entry, cost, fee, tp, o.reason),
    order(db, { pos: pos.id, now: o.now, slug: o.slug, side: o.side, action: 'buy', type: 'market', price: o.ask, qty: o.qty, fee, status: 'filled', reason: `starter: ${o.reason}` }),
  ];
  if (tp != null) stmts.push(order(db, { pos: pos.id, now: o.now, slug: o.slug, side: o.side, action: 'sell', type: 'limit', price: tp, qty: o.qty, fee: 0, status: 'resting', reason: 'take_profit' }));
  await db.batch(stmts);
  return pos;
}

export async function addToPosition(db: D1Database, pos: Position, o: { ask: number; qty: number; coef: number; reason: string; now: number }) {
  const fee = takerFee(o.qty, o.ask, o.coef);
  const qty = pos.qty + o.qty;
  pos.avg_entry = r4((pos.avg_entry * pos.qty + o.ask * o.qty) / qty);
  pos.qty = qty;
  pos.cost = r2(pos.cost + o.qty * o.ask + fee);
  pos.fees = r2(pos.fees + fee);
  pos.adds += 1;
  pos.take_profit = takeProfitFor(pos.avg_entry);
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
}

// Held to the end: each contract pays $1 if its side won, $0 if not.
export async function settlePosition(db: D1Database, pos: Position, o: { won: boolean; now: number }) {
  const payout = o.won ? 1 : 0;
  const proceeds = r2(pos.proceeds + pos.qty * payout);
  const pnl = r2(proceeds - pos.cost);
  await db.batch([
    db.prepare("UPDATE bot_positions SET status = 'settled', closed_at = ?, qty = 0, proceeds = ?, pnl = ?, result = ? WHERE id = ?").bind(o.now, proceeds, pnl, payout, pos.id),
    cancelResting(db, pos.id, o.now),
    order(db, { pos: pos.id, now: o.now, slug: pos.market_slug, side: pos.side, action: 'settle', type: 'settlement', price: payout, qty: pos.qty, fee: 0, status: 'filled', reason: o.won ? 'won' : 'lost' }),
  ]);
  pos.status = 'settled';
}
