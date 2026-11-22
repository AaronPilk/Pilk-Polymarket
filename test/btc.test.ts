import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeModel, parseWindow, fairUp, logLoss, type Mark } from '../src/cryptomath.ts';
import { stakeFor, dailyStopHit, kellyStake } from '../src/fairvalue.ts';

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
  // $100 that grows to $10,000 bets a hundred times bigger (until the book or Aaron's cap binds)
  const at100 = stakeFor({ fair: 0.7, price: 0.5, equity: 100, available: 100 });
  const at10k = stakeFor({ fair: 0.7, price: 0.5, equity: 10_000, available: 10_000 });
  assert.ok(Math.abs(at10k / at100 - 100) < 1e-9, 'a hundred times the account, a hundred times the bet');
  assert.equal(stakeFor({ fair: 0.7, price: 0.5, equity: 10_000, available: 10_000, depth: 2_000 }), 250);
  const at20 = stakeFor({ fair: 0.7, price: 0.5, equity: 20, available: 20 });
  assert.ok(at20 < at30);
  // Never more than a sixth of the account on one window
  const big = stakeFor({ fair: 0.95, price: 0.3, equity: 30, available: 30, fraction: 1, trust: 1 });
  assert.ok(Math.abs(big - 5) < 1e-9, `capped at $5, got ${big}`);
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

test('daily stop is a third of the day’s starting account', () => {
  assert.equal(dailyStopHit(20, -10), true);   // started at 30, down 10
  assert.equal(dailyStopHit(21, -9), false);
  assert.equal(dailyStopHit(100, -49), false); // started at 149, needs -49.67
  assert.equal(dailyStopHit(99, -50), true);
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
