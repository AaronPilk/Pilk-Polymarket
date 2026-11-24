import test from 'node:test';
import assert from 'node:assert/strict';
import { Book, applyBitstamp, applyCoinbase, applyGemini, replicaPrice } from '../src/replica.ts';
import { edgeFloor, otherSideCheap, recordKelly, stakeFor, thinLine } from '../src/fairvalue.ts';
import { returnStats } from '../src/ready.ts';
import { takeProfitFor } from '../src/paper.ts';
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

test("order book top mid: best bid and best ask, the ticker's number", () => {
  const b = new Book();
  b.load([['60000', '0.01'], ['59999', '5']], [['60003', '0.02'], ['60010', '4']]);
  assert.equal(b.topMid(), 60001.5);
  b.set('bid', 60000, 0);          // best bid gone
  assert.equal(b.topMid(), (59999 + 60003) / 2);
  assert.equal(new Book().topMid(), null, 'empty book');
  const oneSide = new Book(); oneSide.load([['60000', '1']], []);
  assert.equal(oneSide.topMid(), null, 'one side missing');
  const crossed = new Book(); crossed.load([['60005', '1']], [['60001', '1']]);
  assert.equal(crossed.topMid(), null, 'crossed book is out of sync');
  // Coinbase's feed keeps it current
  const cb = new Book();
  applyCoinbase(cb, { type: 'snapshot', product_id: 'BTC-USD', bids: [['60000', '2']], asks: [['60002', '2']] });
  applyCoinbase(cb, { type: 'l2update', product_id: 'BTC-USD', changes: [['buy', '60001', '1'], ['sell', '60002', '0'], ['sell', '60004', '3']] });
  assert.equal(cb.topMid(), 60002.5);
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

test('edgeFloor: a negative veto lets slightly rich prices through; positive vetoes and the leader bar are unchanged', () => {
  const raw = { veto: () => -0.08 };
  assert.equal(edgeFloor(raw, 0.9, -5), -0.08);              // was clamped to 0 before the fix
  assert.ok(-0.03 >= edgeFloor(raw, 0.9, -5));               // a price the math rates 3c rich still qualifies
  assert.equal(edgeFloor({ veto: () => 0.03 }, 0.9, -5), 0.03);
  const value = { veto: (p: number) => (p > 0.5 ? 0.06 : 0.04), leaderEdge: 0.08 };
  assert.equal(edgeFloor(value, 0.3, -2), 0.04);
  assert.equal(edgeFloor(value, 0.6, -2), 0.06);
  assert.equal(edgeFloor(value, 0.3, 4), 0.08);              // a leader needs the bigger edge
  const trailer = { veto: (p: number) => (p < 0.5 ? 0.02 : 0.03) };
  for (const [p, lead] of [[0.2, -3], [0.7, -8], [0.4, 2]] as const) assert.equal(edgeFloor(trailer, p, lead), p < 0.5 ? 0.02 : 0.03);
});

test('takeProfitFor: the late swing rests its 2x sell at any entry; other strategies only under 15c', () => {
  assert.equal(takeProfitFor(0.12), 0.24);
  assert.equal(takeProfitFor(0.2), null);
  assert.equal(takeProfitFor(0.2, 1), 0.4);
  assert.equal(takeProfitFor(0.6, 1), 0.99);
});

test('otherSideCheap: the leader at the half only buys while the other side is down to 10¢ on a tight book', () => {
  assert.equal(otherSideCheap(0.94, 0.92, 0.1), true);     // the other side asks 8¢, book 2¢ wide
  assert.equal(otherSideCheap(0.91, 0.9, 0.1), true);      // exactly 10¢
  assert.equal(otherSideCheap(0.9, 0.88, 0.1), false);     // the other side asks 12¢
  assert.equal(otherSideCheap(0.97, 0.9, 0.1), false);     // 7¢ wide: the replay dropped these
  assert.equal(otherSideCheap(0.96, 0.9, 0.1), true);      // 6¢ wide is allowed
});

test('a test bet is 3% of the account, inside the ladder', async () => {
  const { testStake, TEST_SHARE } = await import('../src/fairvalue.ts');
  assert.equal(TEST_SHARE, 0.03);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(testStake({ equity: 100, peak: 100, available: 100, openNet: 0 }), 3);
  // half way down to the floor (the $100 rung gives back 50%), half size
  near(testStake({ equity: 75, peak: 100, available: 75, openNet: 0 }), 1.125);
  // the 30% all-open limit leaves $1 of room
  near(testStake({ equity: 100, peak: 100, available: 71, openNet: 29 }), 1);
  // never more than the book offers, or Aaron's cap
  near(testStake({ equity: 100, peak: 100, available: 100, openNet: 0, depth: 2, price: 0.5 }), 1);
  near(testStake({ equity: 100, peak: 100, available: 100, openNet: 0, ceiling: 2 }), 2);
  // at the floor, nothing
  near(testStake({ equity: 50, peak: 100, available: 50, openNet: 0 }), 0);
});

test("Aaron's price tiers: most around 10¢, less at 5¢ and 20¢+, never past the ladder", async () => {
  const { tierShare, tierStake, tierQty, TIERED } = await import('../src/fairvalue.ts');
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const acct = { equity: 100, peak: 100, available: 100, openNet: 0 };
  near(tierShare(0.05), 0.05);
  near(tierShare(0.10), 0.10);
  near(tierShare(0.15), 0.075);
  near(tierShare(0.25), 0.05);
  near(tierShare(0.02), 0);      // under 3¢: no bet (his held lottery tickets: 1 of 37)
  near(tierShare(0.30), 0);      // over 25¢: not this model
  near(tierStake({ ...acct, price: 0.10 }), 10);   // $10 at 10¢ on a $100 account, the ladder's per-bet limit
  near(tierStake({ ...acct, price: 0.05 }), 5);
  near(tierStake({ ...acct, price: 0.22 }), 5);
  // the 30% open limit leaves $4 of room
  near(tierStake({ ...acct, available: 74, openNet: 26, price: 0.10 }), 4);
  // half way down to the floor, half size; at the floor, nothing; Aaron's cap wins
  near(tierStake({ equity: 75, peak: 100, available: 75, openNet: 0, price: 0.10 }), 3.75);
  near(tierStake({ equity: 50, peak: 100, available: 50, openNet: 0, price: 0.10 }), 0);
  near(tierStake({ ...acct, ceiling: 2, price: 0.10 }), 2);
  // the fee comes out of the stake: $10 at 10¢ is 92 contracts, $9.20 + $0.79 fee
  assert.equal(tierQty(10, 0.10), 92);
  assert.ok(92 * 0.10 + 92 * 0.095 * 0.10 * 0.90 <= 10);
  assert.equal(tierQty(0, 0.10), 0);
  assert.ok(TIERED.has('hoops_tier_2x') && TIERED.has('hoops_tier_3x') && TIERED.has('hoops_tier_reload'));
  // the 3x account gets no resting 2x sell (tpBelow 0), the 2x accounts get one on every entry (tpBelow 1)
  assert.equal(takeProfitFor(0.04, 0), null);
  assert.equal(takeProfitFor(0.12, 1), 0.24);
  assert.equal(takeProfitFor(0.12), 0.24);   // the old default: every entry under 15¢
});

test('per-strategy chart lines are thinned without losing their shape', () => {
  const short: [number, number][] = [[1, 1], [2, -1]];
  assert.deepEqual(thinLine(short, 60), short);
  const long: [number, number][] = Array.from({ length: 500 }, (_, i) => [i, i === 250 ? -40 : i === 400 ? 55 : Math.sin(i / 10)]);
  const out = thinLine(long, 60);
  assert.ok(out.length <= 121);
  assert.deepEqual(out.at(-1), long.at(-1));
  assert.ok(out.some((p) => p[1] === -40));
  assert.ok(out.some((p) => p[1] === 55));
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0]);
});
