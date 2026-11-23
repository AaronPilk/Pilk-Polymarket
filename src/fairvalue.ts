// Fair price for a team in a live game. Pure functions, no Cloudflare imports, so they can be
// tested in Node.
//
// Model: the final margin is the current lead plus a random walk over the time left, with a
// drift equal to the pregame expected margin (Stern 1991/1994 for the NFL and NBA). Team
// strength comes from the market's own price at tip-off, so the model agrees with the market
// before the game and only disagrees about what the score and clock have done since.
//
//   P(win) = Phi( (lead + mu * r) / (sigma * sqrt(r)) ),  r = share of regulation left
//
// Limits of v1, on purpose: no fouls, timeouts or injuries; in football only who has the ball
// (worth about a point and a half), not down, distance or field position.

import { returnStats, withOneLoss, type ReadyRow } from './ready';

// Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). Same as cryptomath.ts.
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface LeagueSpec { periods: number; periodMin: number; otMin: number; sigma: number; football: boolean }

// sigma = spread of the final margin around the pregame line, in points. Set a little wide on
// purpose: the smooth random walk is overconfident about big leads (trailing teams speed up
// and shoot more threes), so basketball gets fatter tails than the textbook numbers.
export const LEAGUE: Record<string, LeagueSpec> = {
  nba: { periods: 4, periodMin: 12, otMin: 5, sigma: 13.5, football: false },
  cbb: { periods: 2, periodMin: 20, otMin: 5, sigma: 11.5, football: false },
  nfl: { periods: 4, periodMin: 15, otMin: 10, sigma: 13.5, football: true },
  cfb: { periods: 4, periodMin: 15, otMin: 0, sigma: 15.5, football: true },
};

// Inverse standard normal (Acklam's rational approximation, |error| < 1.2e-9 after refinement).
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  let q: number, r: number, x: number;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= hi) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  // One Newton step against our CDF so normCdf(normInv(p)) round-trips.
  const e = normCdf(x) - p;
  return x - e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
}

// Pregame expected margin implied by a win probability.
export function muFromPrice(league: string, p: number): number {
  const s = LEAGUE[league];
  const pp = Math.min(0.98, Math.max(0.02, p));
  return s.sigma * normInv(pp);
}

// "4:35" -> 4.583 minutes, "45.3" -> 0.755
export function clockMinutes(clock: string | null): number | null {
  if (!clock) return null;
  const parts = clock.split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  return parts.length === 2 ? parts[0] + parts[1] / 60 : parts[0] / 60;
}

// Share of regulation left (0..1). Overtime returns the OT minutes as a share of regulation.
// null when it can't be worked out (or college football overtime, which has no clock).
export function shareLeft(league: string, period: number | null, clock: string | null): number | null {
  const s = LEAGUE[league];
  const m = clockMinutes(clock);
  if (!s || period == null || m == null || period < 1) return null;
  const total = s.periods * s.periodMin;
  if (period <= s.periods) return Math.max(0, ((s.periods - period) * s.periodMin + m) / total);
  if (!s.otMin) return null;
  return Math.max(0, m / total);
}

export function progress(league: string, period: number | null, clock: string | null): number | null {
  const left = shareLeft(league, period, clock);
  return left == null ? null : Math.min(1, 1 - left);
}

// Chance this team wins. lead = its points minus the opponent's; startPrice = its price at
// tip-off; hasBall = football possession (true/false/null).
export function sportFair(o: { league: string; lead: number; left: number; startPrice: number; hasBall?: boolean | null }): number {
  const s = LEAGUE[o.league];
  const mu = muFromPrice(o.league, o.startPrice);
  const ball = s.football && o.hasBall != null ? (o.hasBall ? 1.5 : -1.5) : 0;
  const lead = o.lead + ball;
  if (o.left <= 1e-6) return lead > 0 ? 1 : lead < 0 ? 0 : normCdf(mu / s.sigma);
  // Never more than 97% sure either way: the model doesn't know about injuries, fouls or
  // garbage time, and a near-certain number would size bets on noise.
  return Math.min(0.97, Math.max(0.03, normCdf((lead + mu * o.left) / (s.sigma * Math.sqrt(o.left)))));
}

// Blowout line from his history: basketball down 15+ in the 2nd half, or 10+ with 6 minutes
// or less left (NBA) / 5 (college); football down 17+ in the 2nd half, or 9+ with 8 or less.
export function isBlowout(league: string, lead: number, period: number | null, clock: string | null): boolean {
  const s = LEAGUE[league];
  const left = shareLeft(league, period, clock);
  if (!s || left == null || lead >= 0) return false;
  const deficit = -lead;
  const minsLeft = left * s.periods * s.periodMin;
  if (s.football) return (left <= 0.5 && deficit >= 17) || (minsLeft <= 8 && deficit >= 9);
  const lateMins = league === 'nba' ? 6 : 5;
  return (left <= 0.5 && deficit >= 15) || (minsLeft <= lateMins && deficit >= 10);
}

// Taker fee: coefficient x contracts x p x (1 - p), rounded to the cent per fill (Polymarket US
// rounds every fee to the nearest cent). TAKER_COEF is the app's Tier 1 rate.
export const TAKER_COEF = 0.095;
export function takerFee(qty: number, price: number, coef = TAKER_COEF): number {
  return Math.round(coef * qty * price * (1 - price) * 100) / 100;
}

// Quarter-Kelly stake for buying at `price` when our estimate is `fair`. The estimate is first
// pulled halfway back to the market price (`trust`), because the market knows things the model
// doesn't; the entry decision uses the full edge, the bet size only half of it.
export function kellyStake(fair: number, price: number, bankroll: number, fraction = 0.25, trust = 0.5): number {
  if (!(fair > price) || price <= 0 || price >= 1 || bankroll <= 0) return 0;
  const p = price + trust * (fair - price);
  return bankroll * fraction * ((p - price) / (1 - price));
}

// The risk ladder: the most the bot may put at risk, by the size of the account's peak. A small
// account swings bigger to grow; a big one protects what it built. Between the listed sizes it
// slides smoothly (on a log scale), so nothing jumps at $1,000.
//   peak       one bet   all open bets   gives back from its peak   day stop
//   $100       10%       30%             50%                        25%
//   $1,000      8%       25%             40%                        20%
//   $10,000     4%       15%             30%                        15%
//   $100,000    1.5%      8%             20%                        10%
// "Gives back" is a floor under the peak: as the account falls toward it, every bet shrinks in
// step (half way down, half size), so a bad run can't dig a hole it takes weeks to climb out of,
// and at the peak nothing holds the bot back.
export const RISK_LADDER = [
  { at: 100, bet: 0.10, open: 0.30, dd: 0.50, day: 0.25 },
  { at: 1_000, bet: 0.08, open: 0.25, dd: 0.40, day: 0.20 },
  { at: 10_000, bet: 0.04, open: 0.15, dd: 0.30, day: 0.15 },
  { at: 100_000, bet: 0.015, open: 0.08, dd: 0.20, day: 0.10 },
];
export interface RiskLimits { bet: number; open: number; dd: number; day: number }

export function riskLimits(peak: number): RiskLimits {
  const L = RISK_LADDER, pick = ({ bet, open, dd, day }: RiskLimits) => ({ bet, open, dd, day });
  if (!(peak > L[0].at)) return pick(L[0]);
  if (peak >= L[L.length - 1].at) return pick(L[L.length - 1]);
  let i = 0;
  while (peak >= L[i + 1].at) i++;
  const a = L[i], b = L[i + 1];
  const t = (Math.log10(peak) - Math.log10(a.at)) / (Math.log10(b.at) - Math.log10(a.at));
  const mix = (x: number, y: number) => x + t * (y - x);
  return { bet: mix(a.bet, b.bet), open: mix(a.open, b.open), dd: mix(a.dd, b.dd), day: mix(a.day, b.day) };
}

// 1 at the peak, falling in a straight line to 0 at the floor (peak minus its allowed giveback).
export function drawdownScale(equity: number, peak: number, dd: number): number {
  if (!(peak > 0) || equity >= peak) return 1;
  const floor = peak * (1 - dd);
  return Math.max(0, Math.min(1, (equity - floor) / (peak - floor)));
}

// Bet size that grows with the account. Kelly on the current account (starting money plus
// everything won or lost so far) is the risk-to-reward math: it bets more when the payout is
// good for the chance of losing, nothing when it isn't, and `trust` (learned by the grading)
// decides how much of the math's edge to believe. Then:
//   drawdown  below its peak, the bet shrinks toward zero at the floor (see the ladder)
//   one bet   at most the ladder's share of the account
//   open      all open bets together stay under the ladder's share
//   depth     a quarter of the contracts offered at the best price, when known, so a big account
//             never tries to buy more than the market can fill
//   available what isn't already tied up in open positions
//   ceiling   Aaron's BOT_MAX_BET when he sets one, over everything
export function stakeFor(o: {
  fair: number; price: number; equity: number; available: number;
  fraction?: number; trust?: number; maxShare?: number; depth?: number | null; ceiling?: number | null;
  peak?: number; openNet?: number;
  recordKelly?: number;   // the strategy's own record as a Kelly share of the account (recordKelly())
}): number {
  const peak = Math.max(o.peak ?? o.equity, o.equity);
  const lim = riskLimits(peak);
  // What it wants: Kelly on the chance it believes, or on what its own record has shown, whichever
  // is bigger. A strategy that earns its money selling early can prove an edge its calls on the
  // result don't show.
  const fraction = o.fraction ?? 0.25;
  const fromChance = kellyStake(o.fair, o.price, o.equity, fraction, o.trust ?? 0.5);
  const fromRecord = o.equity * fraction * Math.max(0, o.recordKelly ?? 0);
  const k = Math.max(fromChance, fromRecord) * drawdownScale(o.equity, peak, lim.dd);
  let cap = Math.min(o.equity * (o.maxShare ?? lim.bet), o.available);
  if (o.openNet != null) cap = Math.min(cap, Math.max(0, o.equity * lim.open - o.openNet));
  if (o.depth != null && o.depth > 0) cap = Math.min(cap, o.depth * o.price * 0.25);
  if (o.ceiling != null && o.ceiling > 0) cap = Math.min(cap, o.ceiling);
  return Math.max(0, Math.min(k, cap));
}

// The least edge (fair - ask - fee) a strategy takes on a side: its veto, raised to the leader bar for a
// team that is ahead. A negative veto lets through prices the math rates slightly rich (Aaron's raw plays).
export function edgeFloor(st: { veto: (progress: number) => number; leaderEdge?: number }, progress: number, lead: number): number {
  const v = st.veto(progress);
  return lead > 0 && st.leaderEdge ? Math.max(v, st.leaderEdge) : v;
}

// A strategy's own record as a bet size. Kelly for a bet that returns R per dollar is about
// E[R] / E[R²]; the record bets on its return minus one standard error (hours or games as the unit,
// see returnStats), so only on edge it has shown beyond luck, and nothing until it has 50+ closed
// trades over 10+ hours. Never more than a full Kelly share of the account (the ladder caps it far
// lower anyway).
export const RECORD_MIN = { trades: 50, groups: 10 };
export function recordKelly(rows: ReadyRow[]) {
  const a = returnStats(rows);
  // Sized on the record with one more full loss counted (ready.ts withOneLoss); the minimums and the
  // numbers it reports come from the real record.
  const r = returnStats(withOneLoss(rows));
  let f = 0;
  if (a.n >= RECORD_MIN.trades && a.groups >= RECORD_MIN.groups && r.mean != null && r.se != null && r.v != null) {
    const edge = r.mean - r.se;
    const m2 = r.v + r.mean * r.mean;
    f = edge > 0 && m2 > 0 ? Math.min(1, edge / m2) : 0;
  }
  const r4 = (x: number | null) => (x == null ? null : Math.round(x * 10_000) / 10_000);
  return { f: r4(f) as number, mean: r4(a.mean), se: r4(a.se), t: a.t == null ? null : Math.round(a.t * 100) / 100, n: a.n, hours: a.groups };
}

// Stop for the day after losing the ladder's day share of what the account started the day with
// ($25 on $100, $10,000 on $100,000), so the stop scales with the account too.
export function dailyStopHit(equity: number, today: number, peak = equity): boolean {
  const startOfDay = equity - today;
  return today <= -Math.max(1, startOfDay * riskLimits(Math.max(peak, startOfDay)).day);
}
