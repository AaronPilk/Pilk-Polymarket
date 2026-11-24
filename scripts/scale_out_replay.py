"""Sell half at a double, against holding and selling everything, on past Polymarket US Up/Down windows.

Aaron's idea (Nov 23, evening): buy around 20c, and when it doubles sell half to lock in the profit,
then ride the rest. This replays it on every window in the last N days (bitcoin 5m / 15m / 1h, gold
15m / 1h): the first minute a side asks 15-25c with at least 40% of the window left, buy 2 contracts
at the ask, then compare four ways out:

  hold       both held to the result
  sell_all   both sold at the bid the first minute it reaches 2x the entry, otherwise held
  sell_half  one sold at the double, the other held to the result
  half_3x    one sold at 2x, the other at 3x if it gets there, otherwise held

P&L is per contract with the exact taker fee on every buy and sell (none at settlement). It also asks
the question that decides it: of the entries that doubled, how often did the side go on to win,
against the price it was at when it doubled? If those prices were fair, holding and selling are worth
the same and selling half only trades some upside for a smoother ride (and an extra fee).

Minute points (each is the book at the end of its minute, crossed books dropped), so a touch inside a
minute can be missed. Responses are cached in .replay-cache/ like the other replays.

Run: python3 scripts/scale_out_replay.py [days] [--asset btc|gold]
"""
import concurrent.futures as cf, datetime as dt, json, math, sys
from pathlib import Path

import fav_replay as fr

COEF, SHIFT = fr.COEF, fr.SHIFT
ASSETS = {
    'btc': ('cpc-btc-updown', (('5m', 300), ('15m', 900), ('1h', 3600))),
    'gold': ('cpausp-gold-updown', (('15m', 900), ('1h', 3600))),
}
ENTRY_LO, ENTRY_HI, MIN_LEFT = 0.15, 0.25, 0.40
EXITS = ('hold', 'sell_all', 'sell_half', 'half_3x')

def fee(p): return COEF * p * (1 - p)

def points(hist, e):
    """(time left, up ask, down ask) per minute, oldest first, crossed books dropped."""
    out = []
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        up, dn = h.get('longPrice'), h.get('shortPrice')
        if up is None or dn is None: continue
        up, dn = float(up), float(dn)
        if up + dn < 0.995: continue
        tau = e - (h.get('timestamp') or 0) - SHIFT
        if tau > 0: out.append((tau, up, dn))
    return out

def play(pts, length, won_up):
    """One window: the first 15-25c entry with 40%+ left, and what each exit made on 2 contracts."""
    for k, (tau, up, dn) in enumerate(pts):
        if tau < MIN_LEFT * length: break
        for side, ask in ((1, up), (0, dn)):
            if not ENTRY_LO <= ask <= ENTRY_HI: continue
            won = 1 if (won_up == 1) == (side == 1) else 0
            bid = lambda pt: 1 - (pt[2] if side else pt[1])
            b2 = b3 = None
            for pt in pts[k + 1:]:
                b = bid(pt)
                if b2 is None:
                    if b >= 2 * ask: b2 = b
                elif b >= min(3 * ask, 0.99):
                    b3 = b; break
            cost = 2 * (ask + fee(ask))
            sell = lambda p: p - fee(p)
            pnl = {
                'hold': 2 * won - cost,
                'sell_all': (2 * sell(b2) if b2 else 2 * won) - cost,
                'sell_half': (sell(b2) + won if b2 else 2 * won) - cost,
                'half_3x': ((sell(b2) + (sell(b3) if b3 else won)) if b2 else 2 * won) - cost,
            }
            return {'side': side, 'price': ask, 'tau': tau, 'won': won, 'b2': b2, 'b3': b3, 'pnl': pnl}
    return None

def score(rows, key, split):
    """Per-contract P&L, its t with hours as the unit, how often a pair lost money, and the two halves."""
    if not rows: return None
    xs = [(r['hr'], r['pnl'][key] / 2) for r in rows]
    n = len(xs); m = sum(x for _, x in xs) / n
    g = {}
    for hr, x in xs: g[hr] = g.get(hr, 0.0) + x
    G = len(g)
    se = math.sqrt(G / (G - 1) * sum((v - m * sum(1 for h, _ in xs if h == hr)) ** 2 for hr, v in g.items())) / n if G > 2 else None
    half = lambda rs: (sum(r['pnl'][key] for r in rs) / 2 / len(rs)) if rs else None
    return {'n': n, 'per_contract': m, 't': m / se if se else None,
            'pairs_losing': sum(1 for r in rows if r['pnl'][key] < -1e-9) / n,
            'first_half': half([r for r in rows if r['real'] < split]),
            'second_half': half([r for r in rows if r['real'] >= split])}

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    days = int(args[0]) if args else 30
    asset = sys.argv[sys.argv.index('--asset') + 1] if '--asset' in sys.argv else 'btc'
    prefix, series = ASSETS[asset]
    fr.slug = lambda s, t: f"{prefix}-{s}-{dt.datetime.fromtimestamp(t, dt.timezone.utc):%Y-%m-%d-%H%M}z"
    fr.SERIES = series
    fr.CACHE.mkdir(exist_ok=True)
    wins = fr.windows(days)
    res = fr.results(wins)
    todo = [w for w in wins if fr.slug(w[0], w[1]) in res]
    with cf.ThreadPoolExecutor(8) as ex:
        hists = dict(zip([fr.slug(*w[:2]) for w in todo], ex.map(lambda w: fr.history(*w), todo)))
    split = (wins[0][1] + wins[-1][2]) // 2
    rows = []
    for s_name, s, e in todo:
        sl = fr.slug(s_name, s)
        pts = points(hists.get(sl) or [], e)
        if not pts: continue
        r = play(pts, e - s, res[sl])
        if r: rows.append({**r, 'series': s_name, 'hr': (e - r['tau']) // 3600, 'real': e - r['tau']})
    dbl = [r for r in rows if r['b2']]
    out = {
        'asset': asset, 'days': days, 'windows': len(wins), 'resolved': len(todo), 'entries': len(rows),
        'entry_avg_price': sum(r['price'] for r in rows) / len(rows) if rows else None,
        'entry_win_rate': sum(r['won'] for r in rows) / len(rows) if rows else None,
        'doubled': len(dbl), 'doubled_rate': len(dbl) / len(rows) if rows else None,
        'after_double_avg_bid': sum(r['b2'] for r in dbl) / len(dbl) if dbl else None,
        'after_double_win_rate': sum(r['won'] for r in dbl) / len(dbl) if dbl else None,
        'tripled_after_double': sum(1 for r in dbl if r['b3']) / len(dbl) if dbl else None,
        'exits': {k: score(rows, k, split) for k in EXITS},
        'series': {sn: {'entries': len(rs), 'doubled': sum(1 for r in rs if r['b2']), **{k: score(rs, k, split) for k in EXITS}}
                   for sn in [x[0] for x in series] for rs in [[r for r in rows if r['series'] == sn]]},
    }
    Path(f'scale_out_{asset}_result.json').write_text(json.dumps(out, indent=1, default=str))
    f = lambda v, d=3: '   —  ' if v is None else f'{v:+.{d}f}'
    print(f"{asset} {days} days: {len(wins)} windows, {len(todo)} resolved, {len(rows)} entries at 15-25c "
          f"(avg {out['entry_avg_price'] or 0:.3f}, won {out['entry_win_rate'] or 0:.3f})")
    if rows:
        print(f"doubled: {len(dbl)} ({out['doubled_rate']:.1%}); at the double the bid averaged {out['after_double_avg_bid'] or 0:.3f} "
              f"and the side went on to win {out['after_double_win_rate'] or 0:.3f}; tripled after doubling {out['tripled_after_double'] or 0:.1%}")
    for k, v in out['exits'].items():
        if v: print(f"{k:10s} {f(v['per_contract'])}/contract  t {f(v['t'], 2)}  pairs losing {v['pairs_losing']:.1%}  halves {f(v['first_half'])} {f(v['second_half'])}")
    for sn, v in out['series'].items():
        if v['entries']:
            print(f"  {sn:4s} entries {v['entries']:4d} doubled {v['doubled']:4d}  " + '  '.join(f"{k} {f(v[k]['per_contract'])}" for k in EXITS if v[k]))

if __name__ == '__main__':
    main()
