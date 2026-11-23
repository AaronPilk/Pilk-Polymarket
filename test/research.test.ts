import test from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED, board, judge, statusOf, AT_SIZE_SQL } from '../src/research.ts';
import { readFileSync } from 'node:fs';

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
  // ahead by one standard error is a streak a no-edge strategy hits by luck: keeps testing at one contract
  const noisy = judge('crypto_fair_v1', rows(40, 8, (i) => [0.5, -0.2, 0.4, -0.1, 0.45, -0.25, 0.35, -0.15][i % 8]), 'btc');
  assert.ok(noisy.t! >= 1 && noisy.t! < 1.64, `t ${noisy.t}`);
  assert.equal(noisy.status, 'testing');
  assert.match(noisy.reason, /No clear answer/);
  // ahead even in its worst case (mean - 1.64 SE above zero): promising, normal size
  const ahead = judge('crypto_fair_v1', rows(40, 8, (i) => [0.59, -0.11, 0.49, -0.01, 0.54, -0.16, 0.44, -0.06][i % 8]), 'btc');
  assert.ok(ahead.t! >= 1.64 && ahead.t! < 2, `t ${ahead.t}`);
  assert.equal(ahead.status, 'promising');
  assert.match(ahead.reason, /worst case \+/);
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

test('research board: bets are judged on fees at full size, not the cent-rounded fee', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  // the real tables from schema.sql
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const t of ['bot_positions', 'bot_orders']) {
    const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\);`));
    assert.ok(m, t);
    db.exec(m[0]);
  }
  const pos = db.prepare(`INSERT INTO bot_positions (id, mode, strategy, market_slug, side, status, opened_at, closed_at, qty, cost, proceeds, fees, pnl, meta)
    VALUES (?, 'paper', ?, 'w1', 'short', ?, 0, 18000001, 0, ?, ?, ?, ?, ?)`);
  const ord = db.prepare(`INSERT INTO bot_orders (id, position_id, ts, mode, market_slug, side, action, order_type, price, qty, filled_qty, avg_fill, fee, status)
    VALUES (?, ?, 0, 'paper', 'w1', 'short', ?, ?, ?, 1, ?, ?, ?, 'filled')`);
  const rules = JSON.stringify({ rules: 2 });
  // 1 contract in at 22¢ (fee 2¢, exact 1.63¢), out at 9¢ (fee 1¢, exact 0.78¢); the resting take-profit never filled
  pos.run('a', 'crypto_fair_v1', 'closed', 0.24, 0.08, 0.03, -0.16, rules);
  ord.run('a1', 'a', 'buy', 'market', 0.22, 1, 0.22, 0.02);
  ord.run('a2', 'a', 'sell', 'limit', 0.44, 0, null, 0);
  ord.run('a3', 'a', 'sell', 'market', 0.09, 1, 0.09, 0.01);
  // same entry, out on a maker sell at 7.92¢: no exit fee either way
  pos.run('b', 'crypto_fair_maker', 'closed', 0.24, 0.0792, 0.02, -0.1608, rules);
  ord.run('b1', 'b', 'buy', 'market', 0.22, 1, 0.22, 0.02);
  ord.run('b2', 'b', 'sell', 'limit', 0.0792, 1, 0.0792, 0);
  // a 4¢ longshot that won: rounds to a zero fee at 1 contract, pays 0.36¢ a contract at size
  pos.run('c', 'crypto_cheap_v1', 'won', 0.04, 1, 0, 0.96, rules);
  ord.run('c1', 'c', 'buy', 'market', 0.04, 1, 0.04, 0);
  // not judged: old rules, still open, the other bot
  pos.run('d', 'crypto_fair_v1', 'closed', 0.24, 0.08, 0.03, -0.16, null);
  pos.run('e', 'crypto_fair_v1', 'open', 0.24, 0, 0.02, null, rules);
  pos.run('f', 'hoops_value_v1', 'closed', 0.24, 0.08, 0.03, -0.16, rules);
  const out = db.prepare(AT_SIZE_SQL).all('crypto_%', 2) as Array<{ strategy: string; pnl: number; cost: number; hr: number }>;
  const by = Object.fromEntries(out.map((r) => [r.strategy, r]));
  assert.equal(out.length, 3);
  const fee = (p: number) => 0.095 * p * (1 - p);
  const close = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
  close(by.crypto_fair_v1.pnl, -0.16 + 0.03 - fee(0.22) - fee(0.09));
  close(by.crypto_fair_v1.cost, 0.24 - 0.02 + fee(0.22));
  close(by.crypto_fair_maker.pnl, -0.1608 + 0.02 - fee(0.22));
  close(by.crypto_cheap_v1.pnl, 0.96 - fee(0.04));
  close(by.crypto_cheap_v1.cost, 0.04 + fee(0.04));
  assert.equal(by.crypto_fair_v1.hr, 5);
});
