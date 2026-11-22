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

// End time of a window from its slug: cpc-btc-updown-5m-2026-11-22-1810z -> 18:15Z that day.
export function windowEnd(slug: string): number | null {
  const m = /-updown-(\d+)([mhd])-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})z$/.exec(slug);
  if (!m) return null;
  const n = Number(m[1]);
  const len = (m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440) * 60_000;
  return Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7]) + len;
}
