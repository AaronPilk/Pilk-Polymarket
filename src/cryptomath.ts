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

// One step of an exchange's learned offset to the official index. The first few official prices
// are plain-averaged (so one odd reading doesn't set it), after that each new one moves it `alpha`
// of the way: recent enough to follow a drifting exchange, smooth enough to ignore one noisy minute.
export function learnOffset(prev: number, n: number, gap: number, alpha = 0.3): number {
  const a = n < 3 ? 1 / (n + 1) : alpha;
  return prev + a * (gap - prev);
}

// ---------- scheduled releases

// Scheduled US releases, as UTC times: jobs and CPI at 8:30 AM ET (BLS calendar), Fed decisions at
// 2:00 PM ET with the press conference at 2:30 (Fed calendar). The price can jump the moment one
// lands and the math's volatility knows nothing about it, so no new entries go into a window that
// spans 2 minutes before to `after` minutes after one. Refresh this list each quarter.
export const EVENTS: Array<{ at: number; name: string; after: number }> = [
  { at: Date.UTC(2026, 11, 4, 13, 30), name: 'jobs report', after: 15 },
  { at: Date.UTC(2026, 11, 9, 19, 0), name: 'Fed decision', after: 45 },
  { at: Date.UTC(2026, 11, 10, 13, 30), name: 'CPI', after: 15 },
  { at: Date.UTC(2027, 0, 8, 13, 30), name: 'jobs report', after: 15 },
  { at: Date.UTC(2027, 0, 13, 13, 30), name: 'CPI', after: 15 },
  { at: Date.UTC(2027, 0, 27, 19, 0), name: 'Fed decision', after: 45 },
  { at: Date.UTC(2027, 1, 5, 13, 30), name: 'jobs report', after: 15 },
  { at: Date.UTC(2027, 1, 11, 13, 30), name: 'CPI', after: 15 },
  { at: Date.UTC(2027, 2, 5, 13, 30), name: 'jobs report', after: 15 },
  { at: Date.UTC(2027, 2, 10, 13, 30), name: 'CPI', after: 15 },
  { at: Date.UTC(2027, 2, 17, 18, 0), name: 'Fed decision', after: 45 },
  { at: Date.UTC(2027, 3, 2, 12, 30), name: 'jobs report', after: 15 },
  { at: Date.UTC(2027, 3, 13, 12, 30), name: 'CPI', after: 15 },
  { at: Date.UTC(2027, 3, 28, 18, 0), name: 'Fed decision', after: 45 },
];
const EVENT_BEFORE = 2 * 60_000;

// The release a window [start, end) runs into, if any.
export function eventFor(start: number, end: number): string | null {
  for (const e of EVENTS) if (start < e.at + e.after * 60_000 && end > e.at - EVENT_BEFORE) return e.name;
  return null;
}

// The next pause on the calendar (or the one under way), for the app.
export function nextEvent(now: number): { name: string; at: number; from: number; until: number } | null {
  const e = EVENTS.find((x) => x.at + x.after * 60_000 > now);
  return e ? { name: e.name, at: e.at, from: e.at - EVENT_BEFORE, until: e.at + e.after * 60_000 } : null;
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
  target?: number;   // the checkpoint (seconds left) selectCheckpoints picked this mark for
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

// ---------- scoring each window honestly

// The moments each window is scored at (seconds left). A few fixed points per window, so a window
// with a busy stream doesn't count more than a quiet one, and early, middle and late calls are all
// in. `tol`: how far from the target a checkpoint may sit.
export const SCORE_POINTS: Record<string, { at: number[]; tol: number }> = {
  '5m': { at: [240, 150, 60], tol: 20 },
  '15m': { at: [720, 450, 180, 60], tol: 45 },
  '1h': { at: [2700, 1800, 900, 300, 60], tol: 90 },
};

export function selectCheckpoints(marks: Mark[]): Mark[] {
  const by = new Map<string, Mark[]>();
  for (const m of marks) { const a = by.get(m.slug) || []; a.push(m); by.set(m.slug, a); }
  const out: Mark[] = [];
  for (const [slug, ms] of by) {
    const sp = SCORE_POINTS[parseWindow(slug)?.series || ''];
    if (!sp) continue;
    for (const target of sp.at) {
      let best: Mark | null = null;
      for (const m of ms) if (Math.abs(m.tau - target) <= sp.tol && (!best || Math.abs(m.tau - target) < Math.abs(best.tau - target))) best = m;
      if (best) out.push({ ...best, target });
    }
  }
  return out;
}

const clipP = (p: number) => Math.min(0.99, Math.max(0.01, p));
export const logit = (p: number) => { const q = clipP(p); return Math.log(q / (1 - q)); };
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// How the bot weighs its math against the market, on the log-odds scale (the research: a straight-
// line mix of two calibrated forecasts is itself miscalibrated):
//   P(Up) = σ(a + b·logit(math) + c·logit(market))
// b is the weight on the math, c on the market, a a lean toward Up or Down. The starting point is a
// 50/50 split; the grading fits the real weights once enough windows are in.
export interface Blend { a: number; b: number; c: number }
export const DEFAULT_BLEND: Blend = { a: 0, b: 0.5, c: 0.5 };
export function blendProb(bl: Blend, math: number, market: number): number {
  return sigmoid(bl.a + bl.b * logit(math) + bl.c * logit(market));
}

function solve3(A: number[][], g: number[]): number[] {
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return [0, 0, 0];
  return [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? g[i] : v)))) / D);
}

// Fit the blend by weighted log loss (each window weighs 1 in all), pulled toward "the market is
// right" (a 0, b 0, c 1). The pull is worth `prior` windows of evidence: its strength is set from
// the data's own curvature, so it fades as windows pile up, and it stays strongest where the math
// and the market move together and the data can't tell them apart. Weights can't go negative.
export function fitBlend(pts: Array<{ x: number; z: number; y: number; w: number }>, prior = 30): Blend {
  const p0 = [0, 0, 1];
  const W = pts.reduce((a, p) => a + p.w, 0);
  if (!(W > 0)) return { ...DEFAULT_BLEND };
  const curv = [0, 0, 0];
  for (const p of pts) {
    const pr = sigmoid(p0[0] + p0[1] * p.x + p0[2] * p.z);
    const s2 = pr * (1 - pr) * p.w;
    curv[0] += s2; curv[1] += s2 * p.x * p.x; curv[2] += s2 * p.z * p.z;
  }
  // No intercept: Up and Down (or the two teams) are symmetric, so a few hours that happen to run one
  // way must not teach the bot to lean that way on every window. At 73 windows on Nov 22 the free fit
  // put it at +0.28, enough to make every Up bet look 7 points cheap at 50¢. A very strong prior pins
  // it at 0; only the weights on the math and the market are learned.
  const lam = curv.map((c, i) => (i === 0 ? 1e6 : Math.max(1e-3, (prior / W) * c)));
  let th = [...p0];
  for (let it = 0; it < 30; it++) {
    const g = th.map((t, i) => lam[i] * (t - p0[i]));
    const H = [[lam[0], 0, 0], [0, lam[1], 0], [0, 0, lam[2]]];
    for (const p of pts) {
      const v = [1, p.x, p.z];
      const pr = sigmoid(th[0] + th[1] * p.x + th[2] * p.z);
      const r = (pr - p.y) * p.w, s2 = pr * (1 - pr) * p.w;
      for (let i = 0; i < 3; i++) { g[i] += r * v[i]; for (let j = 0; j < 3; j++) H[i][j] += s2 * v[i] * v[j]; }
    }
    const step = solve3(H, g);
    th = th.map((t, i) => t - step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return { a: th[0], b: Math.max(0, th[1]), c: Math.max(0, th[2]) };
}

// A t-stat across groups: the mean of per-group values over its standard error.
function tStat(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return v > 0 ? m / Math.sqrt(v / xs.length) : null;
}

// Grade the settled windows at their fixed scoring points. Windows that start in the same hour move
// together (the 5-minute, 15-minute and hourly windows overlap), so every "is it real?" question is
// answered with hours as the unit: per-window values averaged within each hour, then a t-stat across
// hours.
//   modelLoss/marketLoss  log loss of the math and of the market's mid on the same moments
//   edge                  market loss minus math loss per window (positive: math sharper), its
//                         t-stat across hours, and how many hours and windows that rests on
//   grid / best / next    log loss for each volatility scale; `next` moves one step from `current`
//                         toward the best only with 100+ windows and t >= 2 (slow, and never on noise)
//   blend / blendNext     the fitted log-odds weights; blendNext is set once 100+ windows are in
//   buckets               calibration: when the math said 60-70%, how often did Up happen
// Late bets (under 4 minutes left) and early ones get their own blend: on Nov 22 the market beat the
// math late (bets placed with under 4 minutes left lost $176; the price moved against them within
// 10 s 60% of the time) while early the math held its own (the price moved its way, +2¢ on average).
export const BAND_SPLIT = 240;
export type Band = 'early' | 'late';
export const bandOf = (tau: number): Band => (tau >= BAND_SPLIT ? 'early' : 'late');

// The blend a bet is judged on. Each band adopts its own fit at 100 windows. A strategy still testing
// (1-contract paper bets) keeps the 50/50 start with 4+ minutes left, so the early fit can't end a test
// before the research board reaches a verdict: on Nov 23 that fit's market weight went 0.92 → 0.78 →
// 0.90 in four hours, and at adoption it shut off every early bet of the strategies leading the board.
// The board still retires a test that loses. Promoted strategies, sizing and real money use the fit.
export function judgingBlend(fitted: Record<Band, Blend>, band: Band, testing: boolean): Blend {
  return testing && band === 'early' ? DEFAULT_BLEND : fitted[band];
}

export function gradeModel(marks: Mark[], current = 1) {
  const pts = selectCheckpoints(marks);
  const perWindow = new Map<string, number>();
  for (const m of pts) perWindow.set(m.slug, (perWindow.get(m.slug) || 0) + 1);
  // Each band weighs every window once among its own checkpoints. A checkpoint is filed by the moment
  // it stands for, not the exact second of its mark: the 5m window's 4-minute check lands anywhere in
  // 3:40-4:20 (the bot marks every 30 s), and filed by the second most of them fell into the last-4-minutes
  // band (Nov 23: only ~30 of ~130 five-minute windows counted as early).
  const bandFor = (m: Mark) => bandOf(m.target ?? m.tau);
  const perBand = new Map<string, number>();
  for (const m of pts) { const k = `${bandFor(m)}|${m.slug}`; perBand.set(k, (perBand.get(k) || 0) + 1); }
  const bandAcc: Record<Band, { fit: Array<{ x: number; z: number; y: number; w: number }>; w: number; model: number; market: number; windows: Set<string> }> = {
    early: { fit: [], w: 0, model: 0, market: 0, windows: new Set() },
    late: { fit: [], w: 0, model: 0, market: 0, windows: new Set() },
  };
  const hourOf = (slug: string) => Math.floor((parseWindow(slug)?.start ?? 0) / 3_600_000);
  const series = new Map<string, { w: number; model: number; market: number }>();
  const buckets = emptyBuckets(), marketBuckets = emptyBuckets();
  const gridLoss = SIGMA_GRID.map(() => 0);
  const gridByHour = new Map<number, number[]>();
  const edgeByWindow = new Map<string, number>();
  const fitPts: Array<{ x: number; z: number; y: number; w: number }> = [];
  let wAll = 0, wPair = 0, model = 0, market = 0;
  for (const m of pts) {
    const w = 1 / (perWindow.get(m.slug) || 1);
    const y = m.result ? 1 : 0;
    wAll += w;
    const h = hourOf(m.slug);
    const gh = gridByHour.get(h) || SIGMA_GRID.map(() => 0);
    SIGMA_GRID.forEach((mult, i) => {
      const p = fairUp({ spot: m.spot, strike: m.strike, sigma: m.sigma * mult, tau: m.tau, avgObs: m.avgObs });
      const l = w * logLoss(p ?? 0.5, y);
      gridLoss[i] += l; gh[i] += l;
    });
    gridByHour.set(h, gh);
    if (m.fair != null) addBucket(buckets, m.fair, y, w);
    if (m.fair != null && m.bid != null && m.ask != null && m.ask > m.bid) {
      const mid = (m.bid + m.ask) / 2;
      const lm = logLoss(m.fair, y), lk = logLoss(mid, y);
      wPair += w; model += w * lm; market += w * lk;
      edgeByWindow.set(m.slug, (edgeByWindow.get(m.slug) || 0) + w * (lk - lm));
      fitPts.push({ x: logit(m.fair), z: logit(mid), y, w });
      const band = bandFor(m), B = bandAcc[band], wb = 1 / (perBand.get(`${band}|${m.slug}`) || 1);
      B.fit.push({ x: logit(m.fair), z: logit(mid), y, w: wb });
      B.w += wb; B.model += wb * lm; B.market += wb * lk; B.windows.add(m.slug);
      addBucket(marketBuckets, mid, y, w);
      const s = parseWindow(m.slug)?.series || 'other';
      const row = series.get(s) || { w: 0, model: 0, market: 0 };
      row.w += w; row.model += w * lm; row.market += w * lk;
      series.set(s, row);
    }
  }
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const windows = perWindow.size;

  // Is the math sharper than the market, beyond luck?
  const edgeHours = new Map<number, number[]>();
  for (const [slug, d] of edgeByWindow) { const h = hourOf(slug); const a = edgeHours.get(h) || []; a.push(d); edgeHours.set(h, a); }
  const hourMeans = [...edgeHours.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  const edgeMean = edgeByWindow.size ? [...edgeByWindow.values()].reduce((a, b) => a + b, 0) / edgeByWindow.size : null;
  const edgeT = tStat(hourMeans);

  // Volatility scale: best on the grid, adopted one step at a time and only when it's real.
  const scored = SIGMA_GRID.map((mult, i) => ({ mult, loss: wAll ? r4(gridLoss[i] / wAll) : null }));
  const bestI = gridLoss.reduce((bi, l, i) => (l < gridLoss[bi] ? i : bi), 0);
  const curI = Math.max(0, SIGMA_GRID.findIndex((x) => x === current) >= 0 ? SIGMA_GRID.findIndex((x) => x === current) : SIGMA_GRID.indexOf(1));
  const gridT = tStat([...gridByHour.values()].map((gh) => gh[curI] - gh[bestI]));
  const step = bestI > curI ? 1 : bestI < curI ? -1 : 0;
  const next = windows >= 100 && step !== 0 && gridT != null && gridT >= 2 ? SIGMA_GRID[curI + step] : SIGMA_GRID[curI];

  // The log-odds weights.
  const blend = fitPts.length >= 30 ? fitBlend(fitPts) : null;
  const blendNext = blend && windows >= 100 ? blend : null;
  // ...and per band, each adopted once that band alone has 100 windows.
  const bands = Object.fromEntries((['early', 'late'] as Band[]).map((k) => {
    const B = bandAcc[k], n = B.windows.size;
    const bl = B.fit.length >= 30 ? fitBlend(B.fit) : null;
    return [k, {
      windows: n, modelLoss: B.w ? r4(B.model / B.w) : null, marketLoss: B.w ? r4(B.market / B.w) : null,
      blend: bl && { a: r4(bl.a), b: r4(bl.b), c: r4(bl.c) }, next: bl && n >= 100 ? bl : null,
    }];
  })) as Record<Band, { windows: number; modelLoss: number | null; marketLoss: number | null; blend: Blend | null; next: Blend | null }>;

  return {
    windows, marks: pts.length,
    modelLoss: wPair ? r4(model / wPair) : null, marketLoss: wPair ? r4(market / wPair) : null, paired: Math.round(wPair),
    edge: { mean: edgeMean == null ? null : r4(edgeMean), t: edgeT == null ? null : Math.round(edgeT * 100) / 100, hours: hourMeans.length, windows: edgeByWindow.size },
    grid: scored, best: SIGMA_GRID[bestI], next, gridT: gridT == null ? null : Math.round(gridT * 100) / 100,
    blend: blend && { a: r4(blend.a), b: r4(blend.b), c: r4(blend.c) }, blendNext, bands,
    bySeries: Object.fromEntries([...series].map(([k, v]) => [k, { windows: Math.round(v.w), model: r4(v.model / v.w), market: r4(v.market / v.w) }])),
    buckets: finishBuckets(buckets), marketBuckets: finishBuckets(marketBuckets),
  };
}
