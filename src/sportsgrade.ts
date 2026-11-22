// Grading the Sports bot's math against the market, the same honest way as bitcoin's.
//
// The live feed writes one checkpoint per game at fixed points of the game (share of regulation
// left: 75%, 50%, 25%, 10%, roughly after the first quarter, at halftime, after the third and with
// about five minutes to go in the NBA): what the math said, and the market's bid and ask. Once the
// game is final, both are scored by log loss on the same moments. Each game weighs 1 in all, and
// games are the unit for the "is it luck?" test. Pure code, tested in Node.

import { fitBlend, logLoss, logit } from './cryptomath';

export const SPORTS_POINTS = [0.75, 0.5, 0.25, 0.1];
export const SPORTS_POINT_TOL = 0.03;   // a checkpoint is taken the first time the game is within this past a point

export interface SportsMark { slug: string; target: number; fair: number; bid: number | null; ask: number | null; result: number; league?: string | null }

interface Bucket { lo: number; n: number; p: number; hit: number }
const buckets = (): Bucket[] => Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, n: 0, p: 0, hit: 0 }));
const addTo = (b: Bucket[], p: number, y: number, w: number) => { const k = b[Math.min(9, Math.floor(p * 10))]; k.n += w; k.p += w * p; k.hit += w * y; };
const finish = (b: Bucket[]) => b.filter((k) => k.n > 0).map((k) => ({ lo: k.lo, n: Math.round(k.n * 10) / 10, p: Math.round((k.p / k.n) * 1000) / 1000, hit: Math.round((k.hit / k.n) * 1000) / 1000 }));

export function gradeSports(marks: SportsMark[]) {
  const per = new Map<string, number>();
  const ok = marks.filter((m) => m.fair != null && (m.result === 0 || m.result === 1));
  for (const m of ok) per.set(m.slug, (per.get(m.slug) || 0) + 1);
  const byGame = new Map<string, number>();
  const leagues = new Map<string, { w: number; model: number; market: number }>();
  const mb = buckets(), kb = buckets();
  const fit: Array<{ x: number; z: number; y: number; w: number }> = [];
  let wPair = 0, model = 0, market = 0;
  for (const m of ok) {
    const w = 1 / (per.get(m.slug) || 1);
    const y = m.result;
    addTo(mb, m.fair, y, w);
    if (m.bid == null || m.ask == null || !(m.ask > m.bid)) continue;
    const mid = (m.bid + m.ask) / 2;
    const lm = logLoss(m.fair, y), lk = logLoss(mid, y);
    wPair += w; model += w * lm; market += w * lk;
    byGame.set(m.slug, (byGame.get(m.slug) || 0) + w * (lk - lm));
    addTo(kb, mid, y, w);
    fit.push({ x: logit(m.fair), z: logit(mid), y, w });
    const lg = m.league || 'other';
    const row = leagues.get(lg) || { w: 0, model: 0, market: 0 };
    row.w += w; row.model += w * lm; row.market += w * lk;
    leagues.set(lg, row);
  }
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const d = [...byGame.values()];
  const mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  let t: number | null = null;
  if (d.length >= 3 && mean != null) {
    const v = d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1);
    t = v > 0 ? mean / Math.sqrt(v / d.length) : null;
  }
  const blend = fit.length >= 30 ? fitBlend(fit) : null;
  return {
    games: per.size, marks: ok.length,
    modelLoss: wPair ? r4(model / wPair) : null, marketLoss: wPair ? r4(market / wPair) : null,
    edge: { mean: mean == null ? null : r4(mean), t: t == null ? null : Math.round(t * 100) / 100, games: d.length },
    blend: blend && { a: r4(blend.a), b: r4(blend.b), c: r4(blend.c) },
    byLeague: Object.fromEntries([...leagues].map(([k, v]) => [k, { games: Math.round(v.w), model: r4(v.model / v.w), market: r4(v.market / v.w) }])),
    buckets: finish(mb), marketBuckets: finish(kb),
  };
}
