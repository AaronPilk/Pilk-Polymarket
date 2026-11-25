// Cricket helpers for the Cricket bot (src/cricket.ts). Pure functions so they can be tested in Node.
//
// Live score: ESPN's public cricket scorepanel (site.web.api.espn.com/apis/site/v2/sports/cricket/scorepanel),
// one call for every live match. Each match carries class.eventType (T20 / ODI / Test), and per team a list of
// innings (linescores) with runs, wickets, overs, isBatting and isCurrent. The chasing side's score string
// says the target and the overs limit, e.g. "119 (17.5/20 ov, target 165)".

const MIN = 60_000;
const norm = (s: any) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
// Team names for matching: Polymarket uses NZ women's brand names ("Auckland Hearts", "Central Hinds") where ESPN
// says "Auckland Women", so brand words and "Women" are dropped on both sides before comparing.
const BRAND = /\b(hearts|brave|magicians|blaze|hinds|sparks|women|womens|w)\b/g;
const teamKey = (s: any) => norm(String(s || '').toLowerCase().replace(BRAND, ' '));

export type Format = 't20' | 'odi' | 'multi';

export interface CricketState {
  espnId: string;
  league: string;
  format: Format;
  maxBalls: number | null;   // per innings, limited-overs only
  state: 'pre' | 'in' | 'post';
  innings: number;           // 1 or 2 for limited overs (the innings now being batted)
  battingTeam: string | null;
  runs: number;
  wickets: number;
  balls: number;             // legal balls bowled this innings
  target: number | null;     // runs the chasing side needs to win, in the second innings
  teams: [string, string];   // display names, in ESPN's order
  summary: string;
  winner: string | null;     // display name of the winner once finished
}

export const ballsOf = (overs: number | null | undefined): number => {
  if (overs == null || !Number.isFinite(overs)) return 0;
  const whole = Math.floor(overs + 1e-9);
  return whole * 6 + Math.round((overs - whole) * 10);
};

export function formatOf(ev: any): Format {
  const t = String(ev?.competitions?.[0]?.class?.eventType || '').toLowerCase();
  if (t.includes('t20') || t.includes('twenty') || t.includes('100')) return 't20';
  if (t.includes('odi') || t.includes('list')) return 'odi';
  return 'multi';
}

// One ESPN scorepanel event -> the match state, or null if it isn't readable.
export function cricketState(ev: any, league = ''): CricketState | null {
  const c = ev?.competitions?.[0];
  const comps: any[] = c?.competitors || [];
  if (comps.length !== 2) return null;
  const format = formatOf(ev);
  const type = ev?.status?.type || c?.status?.type || {};
  const state: 'pre' | 'in' | 'post' = type.state === 'in' ? 'in' : type.state === 'post' ? 'post' : 'pre';
  const teams: [string, string] = [comps[0]?.team?.displayName || '', comps[1]?.team?.displayName || ''];
  let innings = 0, battingTeam: string | null = null, runs = 0, wickets = 0, balls = 0;
  let target: number | null = null, maxBalls: number | null = format === 't20' ? 120 : format === 'odi' ? 300 : null;
  const firstRuns: number[] = [];
  for (const x of comps) {
    const ls: any[] = x.linescores || [];
    for (const l of ls) {
      if (l.isBatting && Number(l.period) === 1) firstRuns.push(Number(l.runs) || 0);
      if (l.isBatting && Number(l.isCurrent) === 1) {
        innings = Number(l.period) || 1;
        battingTeam = x.team?.displayName || null;
        runs = Number(l.runs) || 0;
        wickets = Number(l.wickets) || 0;
        balls = ballsOf(Number(l.overs));
      }
    }
    const s = String(x.score || '');
    const t = s.match(/target (\d+)/);
    if (t) target = Number(t[1]);
    const lim = s.match(/\/(\d+(?:\.\d)?) ov/);
    if (lim && format !== 'multi') maxBalls = ballsOf(Number(lim[1]));
  }
  if (format !== 'multi' && innings === 2 && target == null && firstRuns.length) target = firstRuns[0] + 1;
  const win = comps.find((x) => String(x.winner) === 'true');
  return {
    espnId: String(ev.id), league, format, maxBalls, state, innings, battingTeam, runs, wickets, balls, target, teams,
    summary: String(ev?.status?.summary || c?.status?.summary || ''), winner: win?.team?.displayName || null,
  };
}

// A Polymarket cricket market matches an ESPN event when both team names match (whole name, or one contains
// the other once it's 4+ letters, or the slug's team code is the start of the name) and the start times are
// within 12 hours. Polymarket slug: aec-<league>-<code1>-<code2>-<date>.
export { teamKey };
export function matchCricket(m: { slug: string; long_team: string | null; short_team: string | null; game_start: string }, events: any[]): any | null {
  const tok = m.slug.split('-');
  const want = (name: string | null, code: string | undefined) => ({ name: teamKey(name), code: norm(code) });
  const A = want(m.long_team, tok[2]), B = want(m.short_team, tok[3]);
  const start = Date.parse(m.game_start);
  const fits = (w: { name: string; code: string }, t: any) => {
    const f = [t?.displayName, t?.name, t?.shortDisplayName, t?.location].map(teamKey).filter(Boolean);
    const ab = norm(t?.abbreviation);
    return f.some((x) => x === w.name || (w.name.length >= 4 && (x.includes(w.name) || w.name.includes(x) && x.length >= 4)))
      || (!!w.code && (ab === w.code || f.some((x) => x.startsWith(w.code) && w.code.length >= 3)));
  };
  for (const ev of events) {
    if (Math.abs(Date.parse(ev.date) - start) > 12 * 60 * MIN) continue;
    const teams = (ev.competitions?.[0]?.competitors || []).map((x: any) => x.team);
    if (teams.length !== 2) continue;
    if ((fits(A, teams[0]) && fits(B, teams[1])) || (fits(A, teams[1]) && fits(B, teams[0]))) return ev;
  }
  return null;
}

// Win probability for the side batting now, limited overs. A DLS-style resource model: the share of an
// innings' scoring power left with u balls and w wickets in hand is
//   R(u, w) = (1 - exp(-b * u / F(w))) * F(w)   normalised so R(full, 0 down) = 1,
// where F(w) shrinks as wickets fall (DLS Standard Edition shape). Expected runs still to come =
// par * R. Chasing: P(win) = Phi((expected - needed) / sd), sd growing with what's left.
// First innings: compared with an average total for the format. Coefficients: research_notes/cricket_research.md.
const PAR: Record<'t20' | 'odi', number> = { t20: 165, odi: 270 };
// DLS Standard Edition shape: share of a full 50-over innings' resources left at 50 overs to go, by wickets down.
const F = [1, 0.934, 0.851, 0.749, 0.627, 0.49, 0.349, 0.22, 0.119, 0.047];
const B = 0.035 / 6;   // DLS decay per ball (about 0.035 an over): the last overs score fastest
function resource(ballsLeft: number, wicketsDown: number, maxBalls: number): number {
  if (wicketsDown >= 10 || ballsLeft <= 0) return 0;
  const f = F[Math.max(0, Math.min(9, wicketsDown))];
  return (f * (1 - Math.exp((-B * ballsLeft) / f))) / (1 - Math.exp(-B * maxBalls));
}
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// The chase: a logistic model fitted on Cricsheet ball-by-ball data (3,305 men's T20Is, 2,207 ODIs, completed
// results only; research_notes/cricket_model). Held-out log loss 0.361 (T20) and 0.392 (ODI). Inputs: runs needed n,
// balls left b, wickets in hand w, required runs a ball r = n/b, share of the innings left f = b / total balls.
const CHASE: Record<'t20' | 'odi', { int: number; c: [number, number, number, number, number, number] }> = {
  t20: { int: 2.6211, c: [-0.1205, 0.7247, -2.9343, -0.0849, -4.7019, 3.7284] },
  odi: { int: 2.5908, c: [-0.6184, 1.1752, -4.6914, -0.3992, -2.3864, 1.3338] },
};
export function chaseWinProb(format: 't20' | 'odi', need: number, ballsLeft: number, wicketsInHand: number, maxBalls: number): number {
  if (need <= 0) return 1;
  if (wicketsInHand <= 0 || ballsLeft <= 0) return 0;
  const { int, c } = CHASE[format];
  const r = need / ballsLeft, w = wicketsInHand, f = ballsLeft / maxBalls;
  const z = int + c[0] * r + c[1] * w + c[2] * f + c[3] * r * w + c[4] * Math.log(need) + c[5] * Math.log(ballsLeft);
  return Math.min(0.995, Math.max(0.005, 1 / (1 + Math.exp(-z))));
}

// The model doesn't know which team is stronger. The pre-match price does: blend them on the log-odds scale,
// trusting the price more early on (logit P = logit P_model + k x share of balls left x logit p0). k = 1 to
// start; the recorded marks will fit it.
const logit = (p: number) => Math.log(p / (1 - p));
export function withPrior(p: number, p0: number | null, shareLeft: number, k = 1): number {
  if (p0 == null || !(p0 > 0.01 && p0 < 0.99) || p <= 0.005 || p >= 0.995) return p;
  const z = logit(p) + k * Math.max(0, Math.min(1, shareLeft)) * logit(p0);
  return Math.min(0.995, Math.max(0.005, 1 / (1 + Math.exp(-z))));
}

// p0: the batting side's pre-match price, when known.
export function battingWinProb(s: Pick<CricketState, 'format' | 'maxBalls' | 'innings' | 'runs' | 'wickets' | 'balls' | 'target'>, p0: number | null = null): number | null {
  if (s.format === 'multi' || !s.maxBalls) return null;
  const par = PAR[s.format] * (s.maxBalls / (s.format === 't20' ? 120 : 300));
  const left = Math.max(0, s.maxBalls - s.balls);
  if (s.innings === 2 && s.target != null) {
    const need = s.target - s.runs;
    if (need <= 0) return 1;
    if (s.wickets >= 10 || left === 0) return 0;
    return withPrior(chaseWinProb(s.format, need, left, 10 - s.wickets, s.maxBalls), p0, left / s.maxBalls);
  }
  if (s.innings === 1) {
    const projected = s.runs + par * resource(left, s.wickets, s.maxBalls);
    // The chase adds its own spread, so a first-innings lead counts for less than the same lead mid-chase.
    const sd = 0.18 * par * Math.SQRT2;
    return withPrior(Math.min(0.97, Math.max(0.03, phi((projected - par) / sd))), p0, (s.maxBalls + left) / (2 * s.maxBalls));
  }
  return null;
}

// What changed between two polls of the same match: runs and wickets added, balls bowled.
export interface CricketEvent { runs: number; wickets: number; balls: number; inningsChanged: boolean }
export function eventBetween(a: CricketState | undefined, b: CricketState): CricketEvent | null {
  if (!a || a.state !== 'in' || b.state !== 'in') return null;
  if (a.innings !== b.innings) return { runs: 0, wickets: 0, balls: 0, inningsChanged: true };
  const e = { runs: b.runs - a.runs, wickets: b.wickets - a.wickets, balls: b.balls - a.balls, inningsChanged: false };
  return e.runs || e.wickets || e.balls ? e : null;
}
