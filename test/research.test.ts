import test from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED, board, judge, statusOf } from '../src/research.ts';

// rows: one bet per row, $1 each, spread over `groups` hours (or games)
const rows = (n: number, groups: number, pnl: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ pnl: pnl(i), cost: 1, group: i % groups }));

test('research board: too few bets is testing, with how many it still needs', () => {
  const v = judge('crypto_fair_v1', rows(12, 6, () => 0.3), 'btc');
  assert.equal(v.status, 'testing');
  assert.match(v.reason, /12 of 30 bets/);
  const g = judge('hoops_value_v1', rows(40, 5, () => 0.3), 'sports');
  assert.equal(g.status, 'testing');
  assert.match(g.reason, /5 of 8 games/);
});

test('research board: losing beyond luck retires; a clear winner is promising, then proven with enough bets', () => {
  const lose = judge('crypto_fair_v1', rows(40, 8, (i) => (i % 2 ? -0.6 : -0.2)), 'btc');
  assert.equal(lose.status, 'retired');
  assert.match(lose.reason, /Losing beyond luck/);
  // ahead, but noisy: t between 1 and 2 → promising
  const noisy = judge('crypto_fair_v1', rows(40, 8, (i) => [0.5, -0.2, 0.4, -0.1, 0.45, -0.25, 0.35, -0.15][i % 8]), 'btc');
  assert.ok(noisy.t! >= 1 && noisy.t! < 2, `t ${noisy.t}`);
  assert.equal(noisy.status, 'promising');
  // ahead clearly, but under 200 bets: still promising, not proven
  const clear = judge('crypto_fair_v1', rows(60, 10, (i) => 0.2 + ((i % 10) - 4.5) * 0.02), 'btc');
  assert.ok(clear.t! >= 2);
  assert.equal(clear.status, 'promising');
  const proven = judge('crypto_fair_v1', rows(220, 20, (i) => 0.2 + ((i % 20) - 9.5) * 0.02), 'btc');
  assert.equal(proven.status, 'proven');
  // even money, no clear answer: stays testing (one contract a bet)
  const flat = judge('crypto_fair_v1', rows(40, 8, (i) => (i % 2 ? 0.5 : -0.5)), 'btc');
  assert.equal(flat.status, 'testing');
  assert.match(flat.reason, /No clear answer/);
  // ...but still nothing after three times the bets it needs: retired, fees for no edge
  const stale = judge('crypto_fair_v1', rows(95, 12, (i) => (i % 2 ? 0.5 : -0.5)), 'btc');
  assert.equal(stale.status, 'retired');
  assert.match(stale.reason, /Nothing to show after 95 bets/);
});

test('research board: ideas the evidence contradicts stay retired; top 3 ranks proven, then promising by worst case', () => {
  assert.ok(RETIRED.crypto_fade_v1 && RETIRED.crypto_late_v1);
  assert.equal(judge('crypto_fade_v1', rows(60, 10, () => 0.5), 'btc').status, 'retired');
  const by = new Map([
    ['a', rows(220, 20, (i) => 0.05 + ((i % 20) - 9.5) * 0.004)],   // proven, small edge
    ['b', rows(60, 10, (i) => 0.4 + ((i % 10) - 4.5) * 0.02)],     // promising, big edge
    ['c', rows(60, 10, (i) => 0.2 + ((i % 10) - 4.5) * 0.02)],     // promising, smaller edge
    ['d', rows(40, 8, (i) => (i % 2 ? -0.6 : -0.2))],               // retired
  ]);
  const b = board(by, ['a', 'b', 'c', 'd', 'e'], 'btc', 1);
  assert.equal(b.strategies.a.status, 'proven');
  assert.equal(b.strategies.e.status, 'testing');   // no bets yet
  assert.deepEqual(b.top, ['a', 'b', 'c']);
  assert.equal(statusOf(b, 'd'), 'retired');
  assert.equal(statusOf(null, 'crypto_fair_v1'), 'testing');
  assert.equal(statusOf(null, 'crypto_late_v1'), 'retired');
});
