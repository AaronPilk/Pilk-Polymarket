import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeModel, parseWindow, fairUp, logLoss, learnOffset, type Mark } from '../src/cryptomath.ts';
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

test('grading learns how much to trust the math over the market', () => {
  const r = rng(11);
  const mk = (truth: (p: number) => { fair: number; mid: number }) => {
    const marks: Mark[] = [];
    for (let w = 0; w < 200; w++) {
      const p = 0.1 + 0.8 * r();
      const y = r() < p ? 1 : 0;
      const { fair, mid } = truth(p);
      for (let k = 0; k < 4; k++) marks.push({ slug: `cpc-btc-updown-5m-2026-11-22-${String(w).padStart(4, '0')}z`, tau: 200 - k * 40, fair, bid: mid - 0.01, ask: mid + 0.01, spot: 60000, strike: 60000, sigma: 5e-5, avgObs: null, result: y });
    }
    return marks;
  };
  const clip = (x: number) => Math.min(0.97, Math.max(0.03, x));
  // The market knows the truth, the math is noisy: trust the market
  const lowT = gradeModel(mk((p) => ({ fair: clip(p + (r() - 0.5) * 0.6), mid: p })), 1, 0.5);
  assert.ok(lowT.trustBest <= 0.3, `trust ${lowT.trustBest}`);
  // The math knows the truth, the market is noisy: trust the math
  const highT = gradeModel(mk((p) => ({ fair: p, mid: clip(p + (r() - 0.5) * 0.6) })), 1, 0.5);
  assert.ok(highT.trustBest >= 0.7, `trust ${highT.trustBest}`);
  assert.equal(highT.trustNext, highT.trustBest);
});

// Simulated windows: a random walk; the true model is fairUp with the true sigma. A model told the
// wrong sigma should be pulled toward the true one, and a sharp model should beat a noisy market.
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function gauss(r: () => number) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

test('grading finds the volatility scale that fits and scores math vs market', () => {
  const r = rng(7);
  const trueSigma = 8e-5, told = trueSigma / 1.25; // the bot underestimates volatility by 25%
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
      marks.push({ slug: `cpc-btc-updown-5m-2026-11-22-${String(w).padStart(4, '0')}z`, tau, fair, bid: mid - 0.005, ask: mid + 0.005, spot, strike, sigma: told, avgObs: null, result });
    }
  }
  const g = gradeModel(marks, 1);
  assert.equal(g.windows, 300);
  assert.ok(g.best >= 1.1 && g.best <= 1.4, `best scale near 1.25, got ${g.best}`);
  assert.equal(g.next, g.best);
  assert.ok(g.modelLoss! < g.marketLoss!, 'a sharp model beats a noisy market');
  assert.ok(g.buckets.length >= 5);
  assert.ok(g.bySeries['5m'].windows === 300);
  // Hysteresis: already on the best scale, stay there
  assert.equal(gradeModel(marks, g.best).next, g.best);
});

test('log loss is clipped', () => {
  assert.ok(Math.abs(logLoss(0.5, 1) - Math.log(2)) < 1e-12);
  assert.equal(logLoss(0, 1), logLoss(0.01, 1));
});

test('ready for real money only when all five checks pass', async () => {
  const { readiness } = await import('../src/ready.ts');
  const good = { ready: true, windows: 60, modelLoss: 0.60, marketLoss: 0.62 };
  // 120 trades, steady small wins with a few losses spread out
  const rows = Array.from({ length: 120 }, (_, i) => ({ pnl: i % 4 === 0 ? -1 : 0.6, cost: 3 }));
  const r = readiness(rows, 100, good);
  assert.equal(r.ready, true, JSON.stringify(r.ok));
  // Too few trades
  assert.equal(readiness(rows.slice(0, 60), 100, good).ok.trades, false);
  // The market is as sharp as the math: not ready, however good the P&L looks
  assert.equal(readiness(rows, 100, { ...good, modelLoss: 0.62 }).ok.math, false);
  assert.equal(readiness(rows, 100, { ...good, ready: false }).ok.math, false);
  // Two losing blocks out of three: not consistent
  const streaky = [...rows.slice(0, 30), ...Array.from({ length: 60 }, (_, i) => ({ pnl: i < 30 ? -0.5 : 0.2, cost: 3 })), ...Array.from({ length: 30 }, () => ({ pnl: -0.3, cost: 3 }))];
  assert.equal(readiness(streaky, 100, good).ok.steady, false);
  // A 25% drop along the way fails the drawdown check
  const deep = [...Array.from({ length: 20 }, () => ({ pnl: 1, cost: 3 })), ...Array.from({ length: 30 }, () => ({ pnl: -1, cost: 3 })), ...Array.from({ length: 70 }, () => ({ pnl: 1, cost: 3 }))];
  const d = readiness(deep, 100, good);
  assert.ok(d.maxDD > 0.2 && !d.ok.drawdown, `dd ${d.maxDD}`);
});
