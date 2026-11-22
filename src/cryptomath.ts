// Pure math for the crypto windows feed, kept free of Cloudflare imports so it can be tested in Node.

const pad = (n: number) => String(n).padStart(2, '0');

export function windowSlug(asset: string, series: string, startMs: number): string {
  const d = new Date(startMs);
  return `cpc-${asset}-updown-${series}-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}z`;
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7).
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Chance the window settles Up. Log price is treated as a driftless random walk with
// volatility `sigma` per sqrt(second). The settlement value is the average over the final
// 60 seconds, so with tau >= 60 s left its variance is sigma^2 (tau - 40); inside the last
// minute part of that average is already known (avgObs over the elapsed part) and the rest
// has variance sigma^2 tau^3 / 10800.
export function fairUp(o: { spot: number; strike: number; sigma: number; tau: number; avgObs?: number | null }): number | null {
  const { spot, strike, sigma, tau } = o;
  if (!(spot > 0 && strike > 0 && sigma > 0) || tau <= 0) return null;
  const x = Math.log(spot), k = Math.log(strike);
  let mean = x, variance: number;
  if (tau >= 60) variance = sigma * sigma * (tau - 40);
  else {
    const obs = o.avgObs != null && o.avgObs > 0 ? Math.log(o.avgObs) : x;
    mean = ((60 - tau) / 60) * obs + (tau / 60) * x;
    variance = (sigma * sigma * tau ** 3) / 10_800;
  }
  if (variance <= 0) return mean >= k ? 1 : 0;
  return normCdf((mean - k) / Math.sqrt(variance));
}

// A window from its slug: cpc-btc-updown-5m-2026-11-22-1810z -> 5m, 18:10Z to 18:15Z that day.
export function parseWindow(slug: string): { series: string; start: number; end: number } | null {
  const m = /-updown-(\d+)([mhd])-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})z$/.exec(slug);
  if (!m) return null;
  const n = Number(m[1]);
  const len = (m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440) * 60_000;
  const start = Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7]);
  return { series: `${m[1]}${m[2]}`, start, end: start + len };
}

export function windowEnd(slug: string): number | null {
  return parseWindow(slug)?.end ?? null;
}

// ---------- grading the math against what happened

// Log loss of a probability call against a 0/1 result, clipped at 1%/99% so one confident miss
// can't swamp everything else. Lower is better; a coin flip scores 0.693.
export function logLoss(p: number, y: number): number {
  const q = Math.min(0.99, Math.max(0.01, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

// One checkpoint: what the math and the market said about a window at some moment, plus how the
// window ended (1 = Up). sigma is the raw realized volatility, before any tuning.
export interface Mark {
  slug: string; tau: number; fair: number | null; bid: number | null; ask: number | null;
  spot: number; strike: number; sigma: number; avgObs: number | null; result: number;
}

// Volatility scales to try. Wide on the upside: on a quiet day the market prices bitcoin moves at
// up to twice what the last 15 minutes showed, and the grading decides who's right.
export const SIGMA_GRID = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.3, 2.6];

interface Bucket { lo: number; n: number; p: number; hit: number }
const emptyBuckets = (): Bucket[] => Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, n: 0, p: 0, hit: 0 }));
const addBucket = (b: Bucket[], p: number, y: number, w: number) => {
  const k = b[Math.min(9, Math.max(0, Math.floor(p * 10)))];
  k.n += w; k.p += w * p; k.hit += w * y;
};
const finishBuckets = (b: Bucket[]) => b.filter((k) => k.n > 0)
  .map((k) => ({ lo: k.lo, n: Math.round(k.n * 10) / 10, p: Math.round((k.p / k.n) * 1000) / 1000, hit: Math.round((k.hit / k.n) * 1000) / 1000 }));

// Grade the checkpoints of settled windows. Every window counts once: its checkpoints split one
// unit of weight, so a 1-hour window (120 checkpoints) doesn't outvote twelve 5-minute ones.
//   model vs market  log loss of what the bot believed (fair) and of the market's mid, on the
//                    checkpoints that had a market, so the two are scored on the same moments
//   grid             log loss if volatility had been scaled by each multiplier
//   next             the scale to use: the best one, but only moving off `current` when it
//                    scores at least 0.2% better, so the setting doesn't twitch on noise
//   buckets          calibration: when the math said 60-70%, how often did Up happen
export function gradeModel(marks: Mark[], current = 1) {
  const perWindow = new Map<string, number>();
  for (const m of marks) perWindow.set(m.slug, (perWindow.get(m.slug) || 0) + 1);
  const grid = SIGMA_GRID.map((mult) => ({ mult, loss: 0 }));
  const series = new Map<string, { w: number; model: number; market: number }>();
  const buckets = emptyBuckets(), marketBuckets = emptyBuckets();
  let wAll = 0, wPair = 0, model = 0, market = 0;
  for (const m of marks) {
    const w = 1 / (perWindow.get(m.slug) || 1);
    const y = m.result ? 1 : 0;
    wAll += w;
    for (const g of grid) {
      const p = fairUp({ spot: m.spot, strike: m.strike, sigma: m.sigma * g.mult, tau: m.tau, avgObs: m.avgObs });
      g.loss += w * logLoss(p ?? 0.5, y);
    }
    if (m.fair != null) addBucket(buckets, m.fair, y, w);
    if (m.fair != null && m.bid != null && m.ask != null && m.ask > m.bid) {
      const mid = (m.bid + m.ask) / 2;
      wPair += w;
      model += w * logLoss(m.fair, y);
      market += w * logLoss(mid, y);
      addBucket(marketBuckets, mid, y, w);
      const s = parseWindow(m.slug)?.series || 'other';
      const row = series.get(s) || { w: 0, model: 0, market: 0 };
      row.w += w; row.model += w * logLoss(m.fair, y); row.market += w * logLoss(mid, y);
      series.set(s, row);
    }
  }
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const scored = grid.map((g) => ({ mult: g.mult, loss: wAll ? r4(g.loss / wAll) : null }));
  const best = scored.reduce((a, b) => (b.loss != null && (a.loss == null || b.loss < a.loss) ? b : a), scored[0]);
  const cur = scored.find((g) => g.mult === current) || scored.find((g) => g.mult === 1)!;
  const next = best.loss != null && cur.loss != null && best.loss < cur.loss * 0.998 ? best.mult : current;
  return {
    windows: perWindow.size, marks: marks.length,
    modelLoss: wPair ? r4(model / wPair) : null, marketLoss: wPair ? r4(market / wPair) : null, paired: Math.round(wPair),
    grid: scored, best: best.mult, next,
    bySeries: Object.fromEntries([...series].map(([k, v]) => [k, { windows: Math.round(v.w), model: r4(v.model / v.w), market: r4(v.market / v.w) }])),
    buckets: finishBuckets(buckets), marketBuckets: finishBuckets(marketBuckets),
  };
}
