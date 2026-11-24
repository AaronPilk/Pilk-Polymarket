"""Aaron's second-half scalp (basketball, Polymarket US): going into the third quarter (NBA) or the
second half (college), buy the team that's behind while it's cheap (his example: about 5c, down 10),
and cash out when it climbs to 25-35c, "a three to 4X game". If it never gets there, hold it.

For every resolved NBA and college moneyline since Jan 1, 2026 (the same book-derived minute prices
and cache as swing_flip_replay.py; points with a book wider than 6c dropped):
  - entry window: NBA 65-85 minutes after tip-off (the third quarter starts about 70 minutes in),
    college 55-75 (the second half starts about 60 minutes in). Minute prices carry no game clock,
    so this is the closest proxy.
  - entry: the first point in that window where a side asks <= the cap (5, 8, 10 or 15c), bought at
    that ask; one per game
  - exit: a sell at the target (25c, 35c, or 3x / 4x the entry) the first minute the side's bid
    reaches it, else held to the result
Exact taker fee on the buy and the sell (0.095 x p x (1 - p)). The sell fills at the target, never
better, so a jump past it between minutes isn't counted as extra profit.

The fair yardstick: a price that settles at 0 or 1 touches a higher level q from p with probability
p / q if it's priced right (a 5c side reaches 25c one time in five). Touching more often than that
is the edge his read claims.

Run: python3 scripts/q3_scalp_replay.py [--late]
"""
import json, math
from pathlib import Path

import fav_replay as fr
import swing_flip_replay as sf

import sys
LATE = '--late' in sys.argv
# --late: the bot's late swing instead (hoops_swing_*: 3-12 minutes left, 8-25c, a 2x cash-out):
# NBA 110-130 minutes after tip-off, college 95-115
WINDOW = {'nba': (110, 130), 'cbb': (95, 115)} if LATE else {'nba': (65, 85), 'cbb': (55, 75)}
FLOOR = 0.08 if LATE else 0.0
CAPS = (0.15, 0.25) if LATE else (0.05, 0.08, 0.10, 0.15)
TARGETS = ((('2x', lambda p: 2 * p), ('3x', lambda p: 3 * p)) if LATE else
           (('25c', lambda p: 0.25), ('35c', lambda p: 0.35), ('3x', lambda p: 3 * p), ('4x', lambda p: 4 * p)))
fee = sf.fee

def points(hist, tip):
    pts = []
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        la, sa = h.get('longPrice'), h.get('shortPrice')
        if la is None or sa is None: continue
        la, sa = float(la), float(sa)
        if not (0.01 < la < 0.99 and 0.01 < sa < 0.99) or la + sa > sf.WIDE: continue
        pts.append(((h.get('timestamp') or 0) + 60 - tip, la, sa))
    return pts

def play(pts, lg, long_won, cap):
    lo, hi = WINDOW[lg]
    pre = [p for p in pts if -900 <= p[0] <= 60]
    fav_long = None
    if pre:
        _, la, sa = pre[-1]
        m = (la + 1 - sa) / 2
        if abs(m - 0.5) >= 0.02: fav_long = m > 0.5
    for i, p in enumerate(pts):
        if not (lo * 60 <= p[0] <= hi * 60): continue
        for long_side in (True, False):
            ask = p[1] if long_side else p[2]
            if ask > cap or ask < FLOOR: continue
            won = 1 if (long_won == 1) == long_side else 0
            later = pts[i + 1:]
            out = {'entry': ask, 'won': won, 'mins': p[0] / 60,
                   'tip_fav': None if fav_long is None else fav_long == long_side, 'pnl': {}, 'touch': {}}
            cost = ask + fee(ask)
            out['pnl']['hold'] = won - cost
            for name, tgt in TARGETS:
                q = tgt(ask)
                if q >= 0.99:
                    continue
                hit = next((x for x in later if 1 - (x[2] if long_side else x[1]) >= q), None)
                out['touch'][name] = hit is not None
                out['pnl'][name] = (q - fee(q) - cost) if hit else won - cost
            return out
    return None

def summary(rows, key):
    xs = [r['pnl'][key] for r in rows if key in r['pnl']]
    if len(xs) < 2: return None
    n = len(xs); m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))
    stake = sum(r['entry'] + fee(r['entry']) for r in rows if key in r['pnl'])
    out = {'n': n, 'cents': round(m * 100, 2), 't': round(m / (sd / math.sqrt(n)), 2) if sd else None,
           'per_dollar': round(sum(xs) / stake * 100, 1)}
    if key != 'hold':
        tr = [r for r in rows if key in r['touch']]
        hits = sum(r['touch'][key] for r in tr)
        tgt = dict(TARGETS)[key]
        fair = sum(r['entry'] / min(tgt(r['entry']), 0.99) for r in tr)
        out.update({'touched': hits, 'fair_touches': round(fair, 1), 'vs_fair': round(hits / fair, 2) if fair else None})
    else:
        out.update({'won': sum(r['won'] for r in rows), 'fair_wins': round(sum(r['entry'] for r in rows), 1)})
    return out

def main():
    games, seen = [], set()
    for m in sf.closed_moneylines():
        if m['slug'] in seen: continue
        seen.add(m['slug'])
        lg = m['slug'].split('-')[1] if m['slug'].startswith('aec-') else None
        if lg not in WINDOW or not m.get('gameStartTime') or m['gameStartTime'] < '2026-01-01': continue
        r = sf.result_long(m)
        if r is not None: games.append((m['slug'], lg, sf.ts(m['gameStartTime']), r))
    pts = {g[0]: points(sf.history(g[0], g[2]), g[2]) for g in games}
    out = {'games': len(games), 'results': {}}
    for cap in CAPS:
        rows = []
        for slug, lg, tip, r in games:
            x = play(pts[slug], lg, r, cap)
            if x: rows.append({**x, 'league': lg, 'tip': tip})
        mid = sorted(r['tip'] for r in rows)[len(rows) // 2] if rows else 0
        res = {}
        for label, sel in (('all', lambda r: True), ('nba', lambda r: r['league'] == 'nba'), ('cbb', lambda r: r['league'] == 'cbb'),
                           ('was_tipoff_favorite', lambda r: r['tip_fav'] is True), ('was_tipoff_underdog', lambda r: r['tip_fav'] is False),
                           ('first_half_of_season', lambda r: r['tip'] < mid), ('second_half_of_season', lambda r: r['tip'] >= mid)):
            rs = [r for r in rows if sel(r)]
            res[label] = {k: summary(rs, k) for k in ['hold'] + [t[0] for t in TARGETS]}
            res[label]['avg_entry'] = round(sum(r['entry'] for r in rs) / len(rs), 3) if rs else None
        out['results'][f'ask<={int(cap * 100)}c'] = res
    Path(fr.CACHE.parent / ('late_swing_result.json' if LATE else 'q3_scalp_result.json')).write_text(json.dumps(out, indent=1))
    for cap, res in out['results'].items():
        a = res['all']
        print(f"\n{cap}: {a['hold']['n'] if a['hold'] else 0} games, avg entry {a['avg_entry']}")
        for k in ['hold'] + [t[0] for t in TARGETS]:
            for label in ('all', 'nba', 'cbb', 'was_tipoff_favorite', 'was_tipoff_underdog', 'first_half_of_season', 'second_half_of_season'):
                s = res[label][k]
                if s: print(f"  {k:5s} {label:22s} n {s['n']:4d}  {s['cents']:+6.2f}c  t {s['t']}  {s['per_dollar']:+6.1f}%/$  " +
                            (f"touched {s['touched']} vs fair {s['fair_touches']} ({s['vs_fair']}x)" if k != 'hold' else f"won {s['won']} vs fair {s['fair_wins']}"))

if __name__ == '__main__':
    main()
