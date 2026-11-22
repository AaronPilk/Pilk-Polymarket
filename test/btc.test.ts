import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BLEND, blendProb, eventFor, gradeModel, nextEvent, parseWindow, fairUp, logLoss, learnOffset, selectCheckpoints, windowSlug, type Mark } from '../src/cryptomath.ts';
import { stakeFor, dailyStopHit, kellyStake, riskLimits, drawdownScale } from '../src/fairvalue.ts';

test('parseWindow reads series, start and end', () => {
  const w = parseWindow('cpc-btc-updown-5m-2026-11-22-1940z')!;
  assert.equal(w.series, '5m');
  assert.equal(w.start, Date.UTC(2026, 10, 22, 19, 40));
  assert.equal(w.end - w.start, 5 * 60_000);
  assert.equal(parseWindow('cpc-btc-updown-1h-2026-11-22-1900z')!.end - Date.UTC(2026, 10, 22, 19), 3_600_000);
  assert.equal(parseWindow('nba-lal-bos'), null);
});

test('stakes grow with the account and shrink after losses', () => {
  const at30 = stakeFor({ fair: 0.7, price: 0.5, equity: 30, available: 30 });
  const at150 = stakeFor({ fair: 0.7, price: 0.5, equity: 150, available: 150 });
  assert.ok(Math.abs(at150 / at30 - 5) < 1e-9, 'five times the account, five times the bet');
  // $100 that grows to $1,000 bets ten times bigger; by $10,000 the ladder's 4% a bet binds
  const at100 = stakeFor({ fair: 0.7, price: 0.5, equity: 100, available: 100 });
  const at1k = stakeFor({ fair: 0.7, price: 0.5, equity: 1_000, available: 1_000 });
  assert.ok(Math.abs(at1k / at100 - 10) < 1e-9, 'ten times the account, ten times the bet');
  assert.ok(Math.abs(stakeFor({ fair: 0.7, price: 0.5, equity: 10_000, available: 10_000 }) - 400) < 1e-6, '4% of $10,000');
  assert.equal(stakeFor({ fair: 0.7, price: 0.5, equity: 10_000, available: 10_000, depth: 2_000 }), 250);
  const at20 = stakeFor({ fair: 0.7, price: 0.5, equity: 20, available: 20 });
  assert.ok(at20 < at30);
  // Never more than 10% of a small account on one bet, even with full trust and full Kelly
  const big = stakeFor({ fair: 0.95, price: 0.3, equity: 30, available: 30, fraction: 1, trust: 1 });
  assert.ok(Math.abs(big - 3) < 1e-9, `capped at $3, got ${big}`);
  // Depth: a quarter of what's offered at the best price
  const thin = stakeFor({ fair: 0.9, price: 0.5, equity: 100_000, available: 100_000, depth: 100 });
  assert.equal(thin, 12.5);
  // Aaron's ceiling beats everything
  assert.equal(stakeFor({ fair: 0.9, price: 0.5, equity: 1000, available: 1000, ceiling: 7 }), 7);
  // Never more than what's free
  assert.equal(stakeFor({ fair: 0.9, price: 0.5, equity: 30, available: 1.5 }), 1.5);
  // No edge, no bet
  assert.equal(stakeFor({ fair: 0.5, price: 0.5, equity: 30, available: 30 }), 0);
  assert.ok(Math.abs(kellyStake(0.6, 0.5, 30) - 0.75) < 1e-9);
});

test('the risk ladder tightens as the account grows', () => {
  assert.deepEqual(riskLimits(100), { bet: 0.10, open: 0.30, dd: 0.50, day: 0.25 });
  assert.deepEqual(riskLimits(40), riskLimits(100));                  // small accounts: the first rung
  assert.deepEqual(riskLimits(5e6), { bet: 0.015, open: 0.08, dd: 0.20, day: 0.10 });
  const mid = riskLimits(Math.sqrt(100 * 1000));                       // halfway on a log scale
  assert.ok(Math.abs(mid.bet - 0.09) < 1e-9 && Math.abs(mid.dd - 0.45) < 1e-9);
  const sizes = [100, 1_000, 5_000, 10_000, 100_000].map((x) => riskLimits(x).bet);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] < sizes[i - 1], 'smaller share every rung');
});

test('bets shrink toward the floor under the peak', () => {
  assert.equal(drawdownScale(100, 100, 0.5), 1);
  assert.equal(drawdownScale(120, 100, 0.5), 1);
  assert.ok(Math.abs(drawdownScale(75, 100, 0.5) - 0.5) < 1e-9);       // half way to the $50 floor
  assert.equal(drawdownScale(50, 100, 0.5), 0);
  assert.equal(drawdownScale(40, 100, 0.5), 0);
  const fresh = stakeFor({ fair: 0.7, price: 0.5, equity: 75, available: 75 });
  const hurt = stakeFor({ fair: 0.7, price: 0.5, equity: 75, available: 75, peak: 100 });
  assert.ok(Math.abs(hurt - fresh / 2) < 1e-9, 'same account, half the bet when it is half way to its floor');
  // At $100,000 the floor is $80,000: $90,000 is half way, so half size
  assert.ok(Math.abs(drawdownScale(90_000, 100_000, riskLimits(100_000).dd) - 0.5) < 1e-9);
  // All open bets together stay under 30% of a $100 account
  assert.equal(stakeFor({ fair: 0.9, price: 0.5, equity: 100, available: 100, openNet: 28 }), 2);
  assert.equal(stakeFor({ fair: 0.9, price: 0.5, equity: 100, available: 100, openNet: 31 }), 0);
});

test('daily stop comes from the ladder', () => {
  assert.equal(dailyStopHit(70, -30), true);    // started at 100, 25% stop is $25
  assert.equal(dailyStopHit(80, -20), false);
  assert.equal(dailyStopHit(91_000, -9_000), false); // started at 100K: the stop is $10,000
  assert.equal(dailyStopHit(89_000, -11_000), true);
});

test('feed offsets: plain average at first, then smoothed', () => {
  let b = 0;
  b = learnOffset(b, 0, -2.5); assert.equal(b, -2.5);
  b = learnOffset(b, 1, -1.5); assert.equal(b, -2);
  b = learnOffset(b, 2, -2); assert.equal(b, -2);
  b = learnOffset(b, 3, -6, 0.3); assert.ok(Math.abs(b - -3.2) < 1e-9);
});

// Simulated windows, five minutes apart (so they spread over many hours, the unit the grading
// clusters on).
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function gauss(r: () => number) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const BASE = Date.UTC(2026, 10, 20, 0, 0);
const slugAt = (w: number) => windowSlug('btc', '5m', BASE + w * 5 * 60_000);

test('each window is scored at a few fixed moments', () => {
  const slug = windowSlug('btc', '15m', Date.UTC(2026, 10, 22, 18, 0));
  const ms: Mark[] = [700, 730, 455, 300, 190, 61, 30].map((tau) => ({ slug, tau, fair: 0.5, bid: 0.49, ask: 0.51, spot: 1, strike: 1, sigma: 1e-4, avgObs: null, result: 1 }));
  assert.deepEqual(selectCheckpoints(ms).map((m) => m.tau), [730, 455, 190, 61]);
  // A busy window doesn't count more: a hundred marks still give its three scoring points
  const busy: Mark[] = Array.from({ length: 100 }, (_, i) => ({ slug: slugAt(0), tau: 300 - i * 2.5, fair: 0.5, bid: 0.49, ask: 0.51, spot: 1, strike: 1, sigma: 1e-4, avgObs: null, result: 1 }));
  assert.equal(selectCheckpoints(busy).length, 3);
});

test('the blend learns how much weight the math and the market each deserve', () => {
  const r = rng(11);
  const mk = (truth: (p: number) => { fair: number; mid: number }, n = 200) => {
    const marks: Mark[] = [];
    for (let w = 0; w < n; w++) {
      const p = 0.1 + 0.8 * r();
      const y = r() < p ? 1 : 0;
      for (const tau of [240, 150, 60]) {
        const { fair, mid } = truth(p);
        marks.push({ slug: slugAt(w), tau, fair, bid: mid - 0.01, ask: mid + 0.01, spot: 60000, strike: 60000, sigma: 5e-5, avgObs: null, result: y });
      }
    }
    return marks;
  };
  const noisy = (p: number) => Math.min(0.97, Math.max(0.03, p + (r() - 0.5) * 0.6));
  // The market knows, the math is noise: the market carries the weight and the math shows no edge
  const mkt = gradeModel(mk((p) => ({ fair: noisy(p), mid: p })));
  assert.ok(mkt.blend!.c > mkt.blend!.b, JSON.stringify(mkt.blend));
  assert.ok(mkt.edge.mean! < 0);
  // The math knows, the market is noise: the math carries the weight, and the edge is real
  const math = gradeModel(mk((p) => ({ fair: p, mid: noisy(p) })));
  assert.ok(math.blend!.b > math.blend!.c, JSON.stringify(math.blend));
  assert.ok(math.edge.t! > 2, `t ${math.edge.t}`);
  assert.ok(math.edge.hours >= 10);
  assert.ok(math.blendNext);
  // Under 100 windows nothing is adopted yet
  assert.equal(gradeModel(mk((p) => ({ fair: p, mid: noisy(p) }), 60)).blendNext, null);
  // The starting 50/50 split lands between the math and the market, on the log-odds scale
  const p = blendProb(DEFAULT_BLEND, 0.7, 0.5);
  assert.ok(p > 0.5 && p < 0.7);
  assert.ok(Math.abs(blendProb({ a: 0, b: 0, c: 1 }, 0.9, 0.42) - 0.42) < 1e-9);
});

// A random walk; the true model is fairUp with the true sigma. A model told the wrong sigma should
// be pulled toward the true one, one step at a time, and a sharp model should beat a noisy market.
test('grading finds the volatility scale, moves toward it one step at a time, and scores math vs market', () => {
  const r = rng(7);
  // The bot underestimates volatility by a third. (Smaller misses take many hundreds of windows to
  // show through the noise, which is why the scale only moves on strong evidence.)
  const trueSigma = 8e-5, told = trueSigma / 1.5;
  const marks: Mark[] = [];
  for (let w = 0; w < 300; w++) {
    const strike = 60000;
    let x = Math.log(strike) + gauss(r) * trueSigma * Math.sqrt(30);
    const path: Array<[number, number]> = [];
    for (let tau = 300; tau > 0; tau -= 1) { x += gauss(r) * trueSigma; path.push([tau, x]); }
    const last60 = path.slice(-60).map(([, v]) => Math.exp(v));
    const settle = last60.reduce((a, b) => a + b, 0) / last60.length;
    const result = settle >= strike ? 1 : 0;
    for (const [tau, v] of path) {
      if (tau % 30 !== 0 || tau < 60) continue;
      const spot = Math.exp(v);
      const fair = fairUp({ spot, strike, sigma: told, tau })!;
      const truth = fairUp({ spot, strike, sigma: trueSigma, tau })!;
      const mid = Math.min(0.99, Math.max(0.01, truth + gauss(r) * 0.08)); // a noisy market
      marks.push({ slug: slugAt(w), tau, fair, bid: mid - 0.005, ask: mid + 0.005, spot, strike, sigma: told, avgObs: null, result });
    }
  }
  const g = gradeModel(marks, 1);
  assert.equal(g.windows, 300);
  assert.equal(g.marks, 900, 'three scoring points per 5-minute window');
  assert.ok(g.best >= 1.25 && g.best <= 1.6, `best scale near 1.5, got ${g.best}`);
  assert.ok(g.gridT! >= 2, `gridT ${g.gridT}`);
  assert.equal(g.next, 1.1, 'one step toward the best, not a jump');
  assert.ok(g.buckets.length >= 5);
  assert.equal(g.bySeries['5m'].windows, 300);
  // Already on the best scale: stay there
  assert.equal(gradeModel(marks, g.best).next, g.best);
  // Under 100 windows: don't move at all
  const early = marks.filter((m) => m.slug <= slugAt(59));
  assert.equal(gradeModel(early, 1).next, 1);
});

test('log loss is clipped', () => {
  assert.ok(Math.abs(logLoss(0.5, 1) - Math.log(2)) < 1e-12);
  assert.equal(logLoss(0, 1), logLoss(0.01, 1));
});

test('no new entries into a window that runs into a scheduled release', () => {
  const cpi = Date.UTC(2026, 11, 10, 13, 30);
  const w = (startMin: number, len: number) => [cpi + startMin * 60_000, cpi + (startMin + len) * 60_000] as const;
  assert.equal(eventFor(...w(-15, 15)), 'CPI');      // 13:15-13:30 ends right on it
  assert.equal(eventFor(...w(0, 15)), 'CPI');        // 13:30-13:45
  assert.equal(eventFor(...w(15, 15)), null);        // 13:45-14:00 is clear
  assert.equal(eventFor(...w(-30, 60)), 'CPI');      // the 1-hour window 13:00-14:00
  assert.equal(eventFor(...w(-90, 60)), null);       // 12:00-13:00
  assert.equal(eventFor(...w(-5, 5)), 'CPI');        // 13:25-13:30: inside the 2 minutes before
  assert.equal(eventFor(...w(-10, 5)), null);        // 13:20-13:25
  const fed = Date.UTC(2026, 11, 9, 19, 0);
  assert.equal(eventFor(fed + 30 * 60_000, fed + 35 * 60_000), 'Fed decision'); // press conference
  const nx = nextEvent(Date.UTC(2026, 10, 22, 12, 0))!;
  assert.equal(nx.name, 'jobs report');
  assert.equal(nx.at, Date.UTC(2026, 11, 4, 13, 30));
});

test('ready for real money only when all five checks pass, and none of them on luck', async () => {
  const { readiness } = await import('../src/ready.ts');
  const good = { windows: 320, modelLoss: 0.60, marketLoss: 0.62, edge: { mean: 0.02, t: 2.6, hours: 30, windows: 320 } };
  // 240 trades over 60 hours, steady small wins with a loss in every hour
  const rows = Array.from({ length: 240 }, (_, i) => ({ pnl: i % 4 === Math.floor(i / 4) % 4 ? -1 : 0.6 + 0.1 * ((i * 7) % 3), cost: 3, group: Math.floor(i / 4) }));
  const r = readiness(rows, 100, good);
  assert.equal(r.ready, true, JSON.stringify(r.ok));
  // Too few trades
  assert.equal(readiness(rows.slice(0, 150), 100, good).ok.trades, false);
  // The math isn't clearly better than the market: not ready, however good the P&L looks
  assert.equal(readiness(rows, 100, { ...good, edge: { ...good.edge, t: 1.4 } }).ok.math, false);
  assert.equal(readiness(rows, 100, { ...good, windows: 150 }).ok.math, false);
  // Up, but not by more than luck: a good hour, a bad hour, a good hour...
  const lucky = rows.map((x, i) => ({ ...x, pnl: Math.floor(i / 4) % 2 === 0 ? 0.6 : [-1, -1, 0.3, -0.6][i % 4] }));
  const lk = readiness(lucky, 100, good);
  assert.ok(lk.pnl > 0 && !lk.ok.profit, `pnl ${lk.pnl} t ${lk.profitT}`);
  // The newest block lost money: fading, not consistent
  const fading = [...rows.slice(0, 190), ...Array.from({ length: 50 }, (_, i) => ({ pnl: -0.3, cost: 3, group: 100 + i }))];
  assert.equal(readiness(fading, 100, good).ok.steady, false);
  // A 25% drop along the way fails the drawdown check
  const deep = [...Array.from({ length: 20 }, (_, i) => ({ pnl: 1, cost: 3, group: i })), ...Array.from({ length: 30 }, (_, i) => ({ pnl: -1, cost: 3, group: 20 + i })), ...Array.from({ length: 200 }, (_, i) => ({ pnl: 1, cost: 3, group: 50 + i }))];
  const d = readiness(deep, 100, good);
  assert.ok(d.maxDD > 0.2 && !d.ok.drawdown, `dd ${d.maxDD}`);
});

test('the Sports bot counts different games instead of grading math', async () => {
  const { readiness } = await import('../src/ready.ts');
  // 120 trades over 40 games, three per game
  const rows = Array.from({ length: 120 }, (_, i) => ({ pnl: i % 4 === 0 ? -1 : 0.6, cost: 3, group: `game${Math.floor(i / 3)}` }));
  const few = readiness(rows, 100, null, { kind: 'sports', games: 12 });
  assert.equal(few.kind, 'sports');
  assert.equal(few.ok.math, false);
  assert.equal(few.ready, false);
  const many = readiness(rows, 100, null, { kind: 'sports', games: 40 });
  assert.equal(many.ok.math, true);
  assert.equal(many.ready, true, JSON.stringify(many.ok));
});
