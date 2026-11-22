// ESPN public scoreboard helpers (no key). Pure functions so they can be tested in Node.

// League -> [sport path, extra query]. groups=80 is FBS football, groups=50 is Division I men's hoops.
export const ESPN_PATHS: Record<string, [string, string]> = {
  nfl: ['football/nfl', ''],
  cfb: ['football/college-football', 'groups=80&limit=300'],
  nba: ['basketball/nba', ''],
  cbb: ['basketball/mens-college-basketball', 'groups=50&limit=400'],
};

export function scoreboardUrl(league: string, host = 'site.api.espn.com', now = Date.now()): string {
  const [path, query] = ESPN_PATHS[league];
  const bust = `_=${Math.floor(now / 10_000)}`;
  return `https://${host}/apis/site/v2/sports/${path}/scoreboard?${query ? `${query}&` : ''}${bust}`;
}
const MIN = 60_000;
const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : null;
};
const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function fetchScoreboard(league: string): Promise<any[] | null> {
  if (!ESPN_PATHS[league]) return null;
  for (const host of ['site.api.espn.com', 'site.web.api.espn.com']) {
    try {
      const res = await fetch(scoreboardUrl(league, host), { headers: { 'User-Agent': 'pilk-bets/1.0' } });
      if (res.ok) return (((await res.json()) as any).events || []) as any[];
    } catch {}
  }
  return null;
}

// A Polymarket game matches an ESPN event when both teams match on name or abbreviation
// and the start times are within 12 hours.
export function matchEvent(m: { slug: string; long_team: string | null; short_team: string | null; game_start: string }, events: any[]): any | null {
  const tokens = m.slug.split('-');
  const wantA = [m.long_team, tokens[2]].map(norm).filter(Boolean);
  const wantB = [m.short_team, tokens[3]].map(norm).filter(Boolean);
  const start = Date.parse(m.game_start);
  const fits = (want: string[], t: any) => {
    const fields = [t?.abbreviation, t?.location, t?.name, t?.shortDisplayName, t?.displayName].map(norm).filter(Boolean);
    return want.some((w) => fields.some((f) => f === w || (w.length >= 5 && f.includes(w))));
  };
  for (const ev of events) {
    if (Math.abs(Date.parse(ev.date) - start) > 12 * 60 * MIN) continue;
    const teams = (ev.competitions?.[0]?.competitors || []).map((c: any) => c.team);
    if (teams.length !== 2) continue;
    const ok = (fits(wantA, teams[0]) && fits(wantB, teams[1])) || (fits(wantA, teams[1]) && fits(wantB, teams[0]));
    if (ok) return ev;
  }
  return null;
}

export function gameState(ev: any) {
  const c = ev?.competitions?.[0];
  if (!c) return null;
  const home = c.competitors.find((x: any) => x.homeAway === 'home');
  const away = c.competitors.find((x: any) => x.homeAway === 'away');
  const st = c.status || ev.status || {};
  const sit = c.situation || {};
  const possId = sit.possession != null ? String(sit.possession) : null;
  return {
    home: home?.team?.abbreviation || null, away: away?.team?.abbreviation || null,
    homeScore: num(home?.score), awayScore: num(away?.score),
    period: num(st.period), clock: st.displayClock ?? null, state: st.type?.state ?? null,
    possession: possId ? (possId === String(home?.team?.id) ? 'home' : possId === String(away?.team?.id) ? 'away' : null) : null,
    down: num(sit.down), distance: num(sit.distance), yardLine: num(sit.yardLine),
    lastPlay: sit.lastPlay?.text ? String(sit.lastPlay.text).slice(0, 200) : null,
  };
}

// American odds as an integer (-1840, +990 -> 990). "EVEN" is +100.
const ml = (v: any): number | null => {
  if (v == null || v === '') return null;
  const t = String(v).trim();
  if (/^even$/i.test(t)) return 100;
  const x = parseInt(t.replace(/[^0-9+-]/g, ''), 10);
  return Number.isFinite(x) && x !== 0 ? x : null;
};

// Sportsbook line ESPN shows before a game (DraftKings as of Nov 2026). Gone once it's live.
export function gameLine(ev: any) {
  const c = ev?.competitions?.[0];
  const o = Array.isArray(c?.odds) ? c.odds[0] : null;
  if (!o) return null;
  const home = c.competitors?.find((x: any) => x.homeAway === 'home');
  const away = c.competitors?.find((x: any) => x.homeAway === 'away');
  const line = {
    provider: o.provider?.name ?? null,
    home: home?.team?.abbreviation ?? null,
    away: away?.team?.abbreviation ?? null,
    homeMl: ml(o.moneyline?.home?.close?.odds ?? o.homeTeamOdds?.moneyLine),
    awayMl: ml(o.moneyline?.away?.close?.odds ?? o.awayTeamOdds?.moneyLine),
    homeMlOpen: ml(o.moneyline?.home?.open?.odds),
    awayMlOpen: ml(o.moneyline?.away?.open?.odds),
    spread: num(o.pointSpread?.home?.close?.line ?? o.spread), // home team's line, negative = home favored
    total: num(o.overUnder),
  };
  return line.homeMl == null && line.awayMl == null && line.spread == null ? null : line;
}
