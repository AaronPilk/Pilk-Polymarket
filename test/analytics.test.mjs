import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, buildPositions } from '../public/analytics.js';

const A = [
  { id: 'd1', type: 'ACCOUNT_DEPOSIT', t: '2026-11-01T00:00:00Z', amount: 100, status: 'COMPLETED' },
  { id: 'd2', type: 'ACCOUNT_DEPOSIT', t: '2026-11-01T00:00:01Z', amount: 50, status: 'REJECTED' },
  { id: 'b1', type: 'TRADE', t: '2026-11-02T00:00:00Z', action: 'bought', title: 'Team A', mkt: 'm1', evSlug: 'nba-a-b', cost: 40, qty: 100, price: 0.4, fee: 1 },
  { id: 'r1', type: 'POSITION_RESOLUTION', t: '2026-11-02T03:00:00Z', action: 'won', title: 'Team A', mkt: 'm1', evSlug: 'nba-a-b', payout: 100, pnl: 60 },
  { id: 'b2', type: 'TRADE', t: '2026-11-03T00:00:00Z', action: 'bought', title: 'Team C', mkt: 'm2', evSlug: 'cfb-c-d', cost: 20, qty: 100, price: 0.2, fee: 1 },
  { id: 's2', type: 'TRADE', t: '2026-11-03T01:00:00Z', action: 'sold', title: 'Team C', mkt: 'm2', evSlug: 'cfb-c-d', cost: 15, qty: 100, price: 0.15, pnl: -5, fee: 1 },
  { id: 'x1', type: 'REFERRAL_BONUS', t: '2026-11-04T00:00:00Z', amount: 10, status: 'COMPLETED' },
];

test('positions group by market and side, with results', () => {
  const p = buildPositions(A);
  assert.equal(p.length, 2);
  const a = p.find((x) => x.title === 'Team A');
  assert.equal(a.result, 'won'); assert.equal(a.pnl, 60); assert.equal(a.league, 'NBA');
  const c = p.find((x) => x.title === 'Team C');
  assert.equal(c.result, 'sold'); assert.equal(c.outcome, 'loss');
});

test('summary totals: realized + credited promos, rejected deposits ignored', () => {
  const S = summarize(A, { reserved: 0 });
  assert.equal(S.realized, 55);
  assert.equal(S.total, 65);
  assert.equal(S.flows.deposits, 100);
  assert.deepEqual(S.record, { wins: 1, losses: 1, pushes: 0 });
  assert.equal(S.fees, 3);
});
