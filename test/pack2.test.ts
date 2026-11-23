import test from 'node:test';
import assert from 'node:assert/strict';
import { Book, applyBitstamp, applyCoinbase, applyGemini, replicaPrice } from '../src/replica.ts';
import { recordKelly, stakeFor } from '../src/fairvalue.ts';
import { returnStats } from '../src/ready.ts';
import { gradeSports, type SportsMark } from '../src/sportsgrade.ts';
import { parseFill } from '../src/polymarket.ts';

test('order book depth mid: the average price of the first bitcoin on each side', () => {
  const b = new Book();
  b.load([['100', '0.4'], ['99', '1']], [['101', '0.5'], ['103', '2']]);
  // buy 1: 0.5 @101 + 0.5 @103 = 102; sell 1: 0.4 @100 + 0.6 @99 = 99.4; mid 100.7
  assert.ok(Math.abs(b.depthMid(1)! - 100.7) < 1e-9);
  b.set('ask', 101, 0);           // level gone
  assert.equal(b.depthMid(1), 103 / 2 + 99.4 / 2);
  assert.equal(new Book().depthMid(1), null);
  const thin = new Book(); thin.load([['100', '0.2']], [['101', '0.2']]);
  assert.equal(thin.depthMid(1), null, 'thinner than the depth');
});

test('the three feeds update their books', () => {
  const cb = new Book();
  assert.ok(applyCoinbase(cb, { type: 'snapshot', product_id: 'BTC-USD', bids: [['60000', '2']], asks: [['60002', '2']] }));
  assert.ok(applyCoinbase(cb, { type: 'l2update', product_id: 'BTC-USD', changes: [['buy', '60001', '1'], ['sell', '60002', '0'], ['sell', '60003', '3']] }));
  assert.deepEqual([...cb.bids.keys()].sort(), [60000, 60001]);
  assert.deepEqual([...cb.asks.keys()], [60003]);
  assert.equal(applyCoinbase(cb, { type: 'subscriptions' }), false);

  const gm = new Book();
  gm.set('bid', 1, 1); // stale level from an old connection
  assert.ok(applyGemini(gm, { type: 'update', socket_sequence: 0, events: [{ type: 'change', reason: 'initial', side: 'bid', price: '59999', remaining: '1.5' }, { type: 'change', reason: 'initial', side: 'ask', price: '60004', remaining: '1' }] }));
  assert.equal(gm.bids.has(1), false, 'a fresh connection starts a fresh book');
  assert.ok(applyGemini(gm, { type: 'update', socket_sequence: 5, events: [{ type: 'change', reason: 'cancel', side: 'ask', price: '60004', remaining: '0' }, { type: 'change', reason: 'place', side: 'ask', price: '60005', remaining: '2' }] }));
  assert.deepEqual([...gm.asks.keys()], [60005]);
  assert.equal(applyGemini(gm, { type: 'heartbeat' }), false);

  const bs = new Book();
  assert.ok(applyBitstamp(bs, { event: 'data', channel: 'order_book_btcusd', data: { bids: [['60000', '3']], asks: [['60001', '3']] } }));
  assert.equal(bs.depthMid(1), 60000.5);

  // The copy averages the fresh books and leaves out a quiet one
  cb.at = 1000; gm.at = 1000; bs.at = -10_000;
  gm.set('bid', 59999, 3);
  const r = replicaPrice([cb, gm, bs], 1000)!;
  assert.equal(r.n, 2);
  assert.ok(Math.abs(r.price - ((60001 + 60003) / 2 + (59999 + 60005) / 2) / 2) < 1e-6);
});

test('return per dollar and its standard error treat each hour as one draw', () => {
  const rows = [
    { pnl: 1, cost: 10, group: 1 }, { pnl: 1, cost: 10, group: 1 },
    { pnl: -1, cost: 10, group: 2 }, { pnl: 2, cost: 10, group: 3 }, { pnl: 0, cost: 10, group: 4 },
  ];
  const r = returnStats(rows);
  assert.equal(r.n, 5);
  assert.equal(r.groups, 4);
  assert.ok(Math.abs(r.mean! - 0.06) < 1e-12);
  assert.ok(r.se! > 0 && r.t! > 0);
});

test('a strategy sizes on its own record only after it has shown an edge beyond luck', () => {
  // 120 trades over 30 hours, +8% a dollar with modest spread: a clear edge
  const good = Array.from({ length: 120 }, (_, i) => ({ pnl: i % 3 === 0 ? -0.6 : 0.9, cost: 5, group: Math.floor(i / 4) }));
  const g = recordKelly(good);
  assert.ok(g.f > 0 && g.f <= 1, JSON.stringify(g));
  // Too few trades: nothing yet
  assert.equal(recordKelly(good.slice(0, 40)).f, 0);
  // Up a little, but well inside the noise: nothing
  const noisy = Array.from({ length: 120 }, (_, i) => ({ pnl: (i * 7919) % 11 < 5 ? -4 : 3.6, cost: 5, group: Math.floor(i / 4) }));
  const n = recordKelly(noisy);
  assert.equal(n.f, 0, JSON.stringify(n));
  // The record lifts the stake when the blended chance shows no edge, and the ladder still caps it
  const base = { fair: 0.5, price: 0.55, equity: 100, available: 100, peak: 100, openNet: 0, trust: 1, fraction: 0.25 };
  assert.equal(stakeFor(base), 0);
  const lifted = stakeFor({ ...base, recordKelly: g.f });
  assert.ok(lifted > 0 && lifted <= 10, `stake ${lifted}`);
  assert.equal(stakeFor({ ...base, recordKelly: 1 }), 10, 'one bet never over 10% at $100');
});

// One result per game makes the weights slow to pin down: the direction is clear at 600 games, not at 150.
test('sports grading: one score per game, games as the unit', () => {
  const marks: SportsMark[] = [];
  let s = 3;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  for (let g = 0; g < 600; g++) {
    const p = 0.15 + 0.7 * r();
    const y = r() < p ? 1 : 0;
    for (const pt of [0.75, 0.5, 0.25, 0.1]) {
      const noisy = Math.min(0.97, Math.max(0.03, p + (r() - 0.5) * 0.5));
      marks.push({ slug: `game${g}`, target: pt, fair: p, bid: noisy - 0.01, ask: noisy + 0.01, result: y, league: g % 2 ? 'nba' : 'cbb' });
    }
  }
  const out = gradeSports(marks);
  assert.equal(out.games, 600);
  assert.equal(out.marks, 2400);
  assert.ok(out.modelLoss! < out.marketLoss!, 'the math knows, the market is noise');
  assert.ok(out.edge.t! > 2, `t ${out.edge.t}`);
  assert.ok(out.blend && out.blend.b > out.blend.c);
  assert.equal(out.byLeague.nba.games + out.byLeague.cbb.games, 600);
  // Unsettled games are left out
  assert.equal(gradeSports([{ slug: 'x', target: 0.5, fair: 0.5, bid: 0.4, ask: 0.6, result: null as any }]).games, 0);
});

test('pruning keeps the top of the book', () => {
  const b = new Book();
  b.load([['60000', '1'], ['50000', '5']], [['60010', '1'], ['90000', '5']]);
  b.prune(60005);
  assert.deepEqual([...b.bids.keys()], [60000]);
  assert.deepEqual([...b.asks.keys()], [60010]);
});

test('a short buy is shown as the team actually bought', () => {
  const f = parseFill({ type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'T1', aggressorExecution: { lastPx: '0.87', lastShares: '106.61', order: {
    id: 'O1', marketSlug: 'aec-nba-det-atl-2026-11-22', intent: 'ORDER_INTENT_BUY_SHORT',
    marketMetadata: { title: 'DET Pistons vs. ATL Hawks', outcome: 'Hawks', team: { safeName: 'Hawks', name: 'Atlanta Hawks' } } } } } })!;
  assert.equal(f.title, 'Hawks');
  assert.equal(f.action, 'bought');
  assert.ok(Math.abs(f.price - 0.13) < 1e-9);
  const g = parseFill({ type: 'ACTIVITY_TYPE_TRADE', trade: { id: 'T2', aggressorExecution: { lastPx: '0.535', lastShares: '44.74', order: {
    id: 'O2', marketSlug: 'aec-nfl-bal-car-2026-11-22', intent: 'ORDER_INTENT_BUY_LONG',
    marketMetadata: { title: 'BAL Ravens vs. CAR Panthers', outcome: 'Ravens', team: { safeName: 'BAL Ravens' } } } } } })!;
  assert.equal(g.title, 'BAL Ravens');
});
