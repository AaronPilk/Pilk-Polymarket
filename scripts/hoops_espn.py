"""Score and clock for every replayed basketball game: matches each resolved NBA and college
moneyline in the replay cache (Jan-Jun 2026, Polymarket US minute prices) to its ESPN event and
keeps a compact play-by-play: one row per score change or period change, with ESPN's wall-clock
time, so the price at any minute can be lined up with the game situation at that moment.

Writes .replay-cache/hoops_games.json:
  [{slug, league, tip, long_won, long_home, pts: [[t, long_ask, short_ask], ...],
    plays: [[t, period, sec_left_in_period, long_score, short_score, long_wp], ...],
    espn_id, spread_long (sportsbook line for the long team, points; negative = favored)}]

ESPN's public site API (no key): scoreboard by local date, summary by event id. Responses are
cached under .replay-cache/espn-*, so a rerun only fetches what's missing.

Run: python3 scripts/hoops_espn.py
"""
import concurrent.futures as cf, datetime as dt, json, re, threading, time, urllib.request
from pathlib import Path

import fav_replay as fr
import swing_flip_replay as sf

CACHE = fr.CACHE
ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball'
PATH = {'nba': 'nba', 'cbb': 'mens-college-basketball'}
UA = {'User-Agent': 'Mozilla/5.0 (pilk-bets research)'}
_lock, _last = threading.Lock(), [0.0]

def get(url, tries=4):
    for k in range(tries):
        with _lock:   # about 8 requests a second, polite
            wait = _last[0] + 0.12 - time.time()
            if wait > 0: time.sleep(wait)
            _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(1 + 2 * k)
    return None

def cached(name, fetch):
    p = CACHE / f'{name}.json'
    if p.exists():
        try: return json.loads(p.read_text())
        except Exception: pass
    j = fetch()
    if j is not None: p.write_text(json.dumps(j, separators=(',', ':')))
    return j

def norm(s):
    s = (s or '').lower().replace('&', ' and ')
    s = re.sub(r"[.'’()\-]", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def keys(team):
    """Names a team can go by: full name, short name, school/city, abbreviation."""
    ks = set()
    for k in ('name', 'alias', 'displayName', 'shortDisplayName', 'location', 'safeName', 'abbreviation', 'displayAbbreviation'):
        v = norm(team.get(k))
        if v: ks.add(v)
    return ks

def scoreboard(lg, day):
    url = f'{ESPN}/{PATH[lg]}/scoreboard?dates={day}&limit=400' + ('&groups=50' if lg == 'cbb' else '')
    def fetch():
        j = get(url)
        if j is None: return None
        out = []
        for e in j.get('events') or []:
            c = (e.get('competitions') or [{}])[0]
            teams = {}
            for t in c.get('competitors') or []:
                tm = t.get('team') or {}
                teams[t.get('homeAway')] = {k: tm.get(k) for k in ('displayName', 'shortDisplayName', 'location', 'abbreviation', 'name')}
            out.append({'id': e.get('id'), 'date': e.get('date'), 'teams': teams})
        return out
    return cached(f'espn-sb-{lg}-{day}', fetch) or []

def clock_sec(v):
    v = str(v or '')
    try:
        if ':' in v:
            m, s = v.split(':'); return int(m) * 60 + float(s)
        return float(v)
    except ValueError:
        return None

def summary(lg, eid):
    def fetch():
        j = get(f'{ESPN}/{PATH[lg]}/summary?event={eid}')
        if j is None: return None
        wp = {w.get('playId'): w.get('homeWinPercentage') for w in j.get('winprobability') or []}
        # Every play, not just score changes: the clock stays fresh through scoreless stretches, and each
        # row's ESPN win probability is the one ESPN showed at that moment (keeping only score changes and
        # carrying the latest probability forward leaked later plays into earlier rows).
        plays = []
        for p in j.get('plays') or []:
            wc = p.get('wallclock')
            if not wc: continue
            per = (p.get('period') or {}).get('number')
            row = [int(dt.datetime.fromisoformat(wc.replace('Z', '+00:00')).timestamp()), per,
                   clock_sec((p.get('clock') or {}).get('displayValue')), p.get('homeScore'), p.get('awayScore'), wp.get(p.get('id'))]
            if plays and plays[-1][1:] == row[1:]: continue
            plays.append(row)
        spread = None
        for pc in j.get('pickcenter') or []:
            if pc.get('spread') is not None: spread = pc.get('spread'); break   # home team's line
        return {'plays': plays, 'spread_home': spread}
    return cached(f'espn2-{lg}-{eid}', fetch)

def main():
    ms = sf.closed_moneylines()
    games = []
    for m in ms:
        slug = m.get('slug') or ''
        lg = slug.split('-')[1] if slug.startswith('aec-') else ''
        if lg not in PATH or not m.get('gameStartTime'): continue
        tip = sf.ts(m['gameStartTime'])
        if not (dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp() <= tip < dt.datetime(2026, 7, 1, tzinfo=dt.timezone.utc).timestamp()): continue
        won = sf.result_long(m)
        if won is None or not (CACHE / f'hist-{slug}.json').exists(): continue
        sides = m.get('marketSides') or []
        lo = next((s for s in sides if s.get('long')), None); sh = next((s for s in sides if not s.get('long')), None)
        if not lo or not sh: continue
        games.append({'slug': slug, 'league': lg, 'tip': tip, 'long_won': won, 'long': lo.get('team') or {}, 'short': sh.get('team') or {}})
    print(f'{len(games)} resolved games with prices')
    days = {(g['league'], (dt.datetime.fromtimestamp(g['tip'] - h * 3600, dt.timezone.utc)).strftime('%Y%m%d')) for g in games for h in (4, 5)}
    print(f'{len(days)} ESPN scoreboards')
    with cf.ThreadPoolExecutor(8) as ex: boards = dict(zip(days, ex.map(lambda d: scoreboard(*d), days)))
    matched = []
    for g in games:
        lk, sk = keys(g['long']), keys(g['short'])
        cands = []
        for h in (4, 5):
            day = dt.datetime.fromtimestamp(g['tip'] - h * 3600, dt.timezone.utc).strftime('%Y%m%d')
            cands += boards.get((g['league'], day)) or []
        best = None
        for e in cands:
            home, away = (e['teams'].get('home') or {}), (e['teams'].get('away') or {})
            hk, ak = keys(home), keys(away)
            if not e.get('date'): continue
            if abs(sf.ts(e['date'].replace('Z', ':00Z') if len(e['date']) == 17 else e['date']) - g['tip']) > 3 * 3600: continue
            if lk & hk and sk & ak: best = (e['id'], True); break
            if lk & ak and sk & hk: best = (e['id'], False); break
        if best: matched.append({**g, 'espn_id': best[0], 'long_home': best[1]})
    print(f'{len(matched)} matched to ESPN events ({len(games) - len(matched)} unmatched)')
    with cf.ThreadPoolExecutor(8) as ex: sums = list(ex.map(lambda g: summary(g['league'], g['espn_id']), matched))
    out = []
    for g, s in zip(matched, sums):
        if not s or len(s.get('plays') or []) < 20: continue
        hist = json.loads((CACHE / f"hist-{g['slug']}.json").read_text()).get('history') or []
        pts = []
        for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
            la, sa = h.get('longPrice'), h.get('shortPrice')
            if la is None or sa is None: continue
            pts.append([(h.get('timestamp') or 0) + 60, float(la), float(sa)])   # the book at the END of the minute
        lh = g['long_home']
        plays = [[t, per, sec, (hs if lh else as_), (as_ if lh else hs), (None if wp is None else (wp if lh else 1 - wp))]
                 for t, per, sec, hs, as_, wp in s['plays'] if hs is not None and as_ is not None]
        sp = s.get('spread_home')
        out.append({'slug': g['slug'], 'league': g['league'], 'tip': g['tip'], 'long_won': g['long_won'], 'long_home': lh,
                    'espn_id': g['espn_id'], 'spread_long': None if sp is None else (sp if lh else -sp), 'pts': pts, 'plays': plays})
    (CACHE / 'hoops_games.json').write_text(json.dumps(out, separators=(',', ':')))
    print(f'{len(out)} games written with play-by-play')

if __name__ == '__main__':
    main()
