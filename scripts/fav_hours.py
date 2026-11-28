#!/usr/bin/env python3
"""The 98-99c favorite with ~3 minutes left (crypto_fav_98's cut), split by time of day.

Uses fav_replay.py's cache and helpers. Question (Nov 27, Aaron): do the losses cluster before the 4 PM ET
US close, or was that this week's luck? Prints loss rates by ET hour, weekday/weekend, the 2-4 PM weekday
window vs the rest, and the same split before/after Nov 23 (the live bot's data starts Nov 23, so anything
before is out of sample for the pattern).

Run: python3 scripts/fav_hours.py [days]
"""
import concurrent.futures as cf, datetime as dt, json, sys
from zoneinfo import ZoneInfo
sys.path.insert(0, __file__.rsplit('/', 1)[0])
import fav_replay as fr

ET = ZoneInfo('America/New_York')
LO, HI, PMIN, PMAX = 180, 180, 0.98, 0.995
LIVE_FROM = dt.datetime(2026, 11, 23, tzinfo=ET).timestamp()

def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 34
    fr.CACHE.mkdir(exist_ok=True)
    wins = fr.windows(days)
    res = fr.results(wins)
    todo = [w for w in wins if fr.slug(w[0], w[1]) in res]
    with cf.ThreadPoolExecutor(8) as ex:
        hists = dict(zip([fr.slug(w[0], w[1]) for w in todo], ex.map(lambda w: fr.history(*w), todo)))
    bets = []
    for series, s, e in todo:
        h = hists[fr.slug(series, s)]
        if not h: continue
        f = fr.first_fav(h, e, LO, HI, PMIN, PMAX)
        if not f: continue
        t = dt.datetime.fromtimestamp(e - f[2], ET)
        bets.append(dict(series=series, ts=e - f[2], hour=t.hour, half=t.hour * 100 + (30 if t.minute >= 30 else 0), wd=t.weekday(),
                         date=t.strftime('%Y-%m-%d'), p=f[1], won=f[0] == res[fr.slug(series, s)]))
    def row(name, bs):
        n = len(bs); l = sum(1 for b in bs if not b['won'])
        if not n: return f'  {name:38s} no bets'
        avg = sum(b['p'] for b in bs) / n
        pnl = sum(((1 - b['p']) if b['won'] else -b['p']) - fr.COEF * b['p'] * (1 - b['p']) for b in bs) / sum(b['p'] for b in bs)
        return f'  {name:38s} n {n:5d}  lost {l:3d}  {100 * l / n:5.2f}%  avg {avg:.3f}  {100 * pnl:+.2f}% a dollar'
    pre = lambda b: b['wd'] < 5 and 14 <= b['hour'] < 16
    out = [f'{days} days, {len(bets)} bets at {int(PMIN*100)}-{PMAX*100:g}c with ~3 min left', '']
    for label, sub in (('ALL DATA', bets), ('BEFORE Nov 23 (out of sample)', [b for b in bets if b['ts'] < LIVE_FROM]), ('Nov 23 on (live period)', [b for b in bets if b['ts'] >= LIVE_FROM])):
        out += [label, row('all', sub), row('weekday 2-4 PM ET', [b for b in sub if pre(b)]), row('everything else', [b for b in sub if not pre(b)]),
                row('weekday 2:30-4 PM ET', [b for b in sub if b['wd'] < 5 and 1430 <= b['half'] < 1600]),
                row('weekend, all hours', [b for b in sub if b['wd'] >= 5]), row('weekend 2-4 PM ET', [b for b in sub if b['wd'] >= 5 and 14 <= b['hour'] < 16]), '']
    out.append('BY ET HOUR, weekdays, all data')
    for h in range(24): out.append(row(f'{h:02d}:00', [b for b in bets if b['wd'] < 5 and b['hour'] == h]))
    out += ['', 'BY ET HOUR, weekends, all data']
    for h in range(24): out.append(row(f'{h:02d}:00', [b for b in bets if b['wd'] >= 5 and b['hour'] == h]))
    out += ['', 'BY SESSION (ET), all days']
    for name, a, b in (('Asia 7 PM-3 AM', 19, 3), ('London 3-8 AM', 3, 8), ('US 8 AM-2 PM', 8, 14), ('US 2-4 PM', 14, 16), ('US evening 4-7 PM', 16, 19)):
        out.append(row(name, [x for x in bets if ((a <= x['hour'] < b) if a < b else (x['hour'] >= a or x['hour'] < b))]))
    out += ['', 'BY WEEKDAY (0 = Mon)']
    for d in range(7): out.append(row(str(d), [b for b in bets if b['wd'] == d]))
    out += ['', 'BY SERIES']
    for s in ('5m', '15m', '1h'): out.append(row(s, [b for b in bets if b['series'] == s]))
    out += ['', 'BY PRICE']
    out += [row('98c', [b for b in bets if b['p'] < 0.985]), row('99c+', [b for b in bets if b['p'] >= 0.985])]
    out += ['', 'WEEKDAY 2-4 PM LOSSES BY DATE']
    dates = sorted({b['date'] for b in bets if pre(b)})
    for d in dates:
        ds = [b for b in bets if pre(b) and b['date'] == d]
        if any(not b['won'] for b in ds): out.append(row(d, ds))
    print('\n'.join(out))
    (fr.CACHE.parent / 'fav_hours_result.txt').write_text('\n'.join(out))

if __name__ == '__main__':
    main()
