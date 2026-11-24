"""Classic chart rules, scored against the price Polymarket was charging (bitcoin and gold Up/Down).

Aaron (Nov 23, night): traders lean on charting, breakouts through a level, trend, overbought and
oversold, so test it on every time frame. This replays the last N days of windows (bitcoin 5m / 15m
/ 1h, gold 15m / 1h). At the start of each window a rule reads the chart and picks a side; the bot
buys that side at the first ask 1-3 minutes into the window and holds it to the result, with the
exact taker fee. A rule only counts if it wins more often than the price it paid says, which is a
higher bar than beating a coin flip: when the chart is obvious, the market has usually priced it.

The chart is the official start prices (the settlement index at each window start: bitcoin every 5
minutes, gold every 15), so no exchange offset and no lookahead.

Rules (each window, at its start):
  brk_L       start price above the high of the last L minutes -> Up, below the low -> Down
  fade_L      the opposite side of brk_L
  trend_L     above the average of the last L minutes -> Up, below -> Down
  rsi_fade    14-step RSI over 70 -> Down, under 30 -> Up (overbought / oversold snaps back)
  rsi_mom     the opposite (strength keeps going)
  streakK     the last K windows of the same length all went one way -> that way
  streakK_rev the opposite way
  always_up   control: Up every time (what the spread and fee cost)

Run: python3 scripts/chart_replay.py [days] [--asset btc|gold]
"""
import bisect, concurrent.futures as cf, datetime as dt, json, math, sys
from pathlib import Path

import fav_replay as fr
import pvm_replay as pv

COEF, SHIFT = fr.COEF, fr.SHIFT
ASSETS = {
    'btc': ('cpc-btc-updown', (('5m', 300), ('15m', 900), ('1h', 3600)), 300, (30, 60, 240)),
    'gold': ('cpausp-gold-updown', (('15m', 900), ('1h', 3600)), 900, (60, 240)),
}

def fee(p): return COEF * p * (1 - p)

def entry_ask(hist, s, e):
    """Up and Down asks at the first book 1-3 minutes into the window (crossed books dropped)."""
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        at = (h.get('timestamp') or 0) + SHIFT
        if at < s + 60: continue
        if at > s + 180: return None
        up, dn = h.get('longPrice'), h.get('shortPrice')
        if up is None or dn is None: continue
        up, dn = float(up), float(dn)
        if up + dn >= 0.995 and 0.01 < up < 0.99 and 0.01 < dn < 0.99: return up, dn
    return None

def score(rows, split):
    if not rows: return None
    n = len(rows)
    pnl = [r['pnl'] for r in rows]
    m = sum(pnl) / n
    g = {}
    for r in rows:
        a = g.setdefault(r['hr'], [0.0, 0]); a[0] += r['pnl']; a[1] += 1
    G = len(g)
    se = math.sqrt(G / (G - 1) * sum((a[0] - m * a[1]) ** 2 for a in g.values())) / n if G > 2 else None
    half = lambda rs: sum(r['pnl'] for r in rs) / len(rs) if rs else None
    return {'n': n, 'win_rate': sum(r['won'] for r in rows) / n, 'avg_price': sum(r['price'] for r in rows) / n,
            'per_contract': m, 't': m / se if se else None,
            'first_half': half([r for r in rows if r['s'] < split]), 'second_half': half([r for r in rows if r['s'] >= split])}

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    days = int(args[0]) if args else 30
    asset = sys.argv[sys.argv.index('--asset') + 1] if '--asset' in sys.argv else 'btc'
    prefix, series, step, looks = ASSETS[asset]
    fr.slug = lambda sn, t: f"{prefix}-{sn}-{dt.datetime.fromtimestamp(t, dt.timezone.utc):%Y-%m-%d-%H%M}z"
    fr.SERIES = series
    fr.CACHE.mkdir(exist_ok=True)
    wins = fr.windows(days)
    info = {k: v for k, v in pv.load_markets().items() if k.startswith(prefix)}
    pv.fetch_missing(wins, info)
    todo = [w for w in wins if fr.slug(w[0], w[1]) in info]
    with cf.ThreadPoolExecutor(8) as ex:
        hists = dict(zip([fr.slug(*w[:2]) for w in todo], ex.map(lambda w: fr.history(*w), todo)))

    # The chart: official start prices on the asset's grid.
    grid = {}
    for sn, s, e in todo:
        k = info[fr.slug(sn, s)]['strike']
        if k and s % step == 0: grid.setdefault(s, k)
    gt = sorted(grid); gp = [grid[t] for t in gt]
    def window_pts(s, mins):   # grid prices with s - mins*60 < t < s (strictly before the start)
        i, j = bisect.bisect_right(gt, s - mins * 60), bisect.bisect_left(gt, s)
        return gp[i:j]
    def full(pts, mins): return len(pts) >= 0.8 * (mins * 60 / step - 1)   # points strictly inside the lookback
    def rsi(s):
        i = bisect.bisect_left(gt, s)
        if i < 15 or gt[i] != s or gt[i] - gt[i - 14] > 14 * step * 1.5: return None
        d = [gp[k] - gp[k - 1] for k in range(i - 13, i + 1)]
        up, dn = sum(x for x in d if x > 0), -sum(x for x in d if x < 0)
        return 100.0 if dn == 0 else 100 - 100 / (1 + up / dn)

    # Each series' results in order, for streaks.
    res_by = {}
    for sn, s, e in todo: res_by.setdefault(sn, {})[s] = info[fr.slug(sn, s)]['up']
    length_of = dict(series)

    rules = {f'brk_{L}': [] for L in looks} | {f'fade_{L}': [] for L in looks} | {f'trend_{L}': [] for L in (60, 240)}
    rules |= {'rsi_fade': [], 'rsi_mom': [], 'streak2': [], 'streak2_rev': [], 'streak3': [], 'streak3_rev': [], 'always_up': []}
    split = (wins[0][1] + wins[-1][2]) // 2
    for sn, s, e in todo:
        sl = fr.slug(sn, s)
        p0 = grid.get(s) or info[sl]['strike']
        asks = entry_ask(hists.get(sl) or [], s, e)
        if not p0 or not asks: continue
        won_up = info[sl]['up']
        def bet(rule, side):   # side 1 = Up, 0 = Down
            ask = asks[0] if side else asks[1]
            won = 1 if (won_up == 1) == (side == 1) else 0
            rules[rule].append({'series': sn, 's': s, 'hr': s // 3600, 'price': ask, 'won': won,
                                'pnl': (1 - ask if won else -ask) - fee(ask)})
        bet('always_up', 1)
        for L in looks:
            pts = window_pts(s, L)
            if not full(pts, L): continue
            hi, lo = max(pts), min(pts)
            if p0 > hi: bet(f'brk_{L}', 1); bet(f'fade_{L}', 0)
            elif p0 < lo: bet(f'brk_{L}', 0); bet(f'fade_{L}', 1)
        for L in (60, 240):
            pts = window_pts(s, L)
            if not full(pts, L): continue
            avg = sum(pts) / len(pts)
            if p0 != avg: bet(f'trend_{L}', 1 if p0 > avg else 0)
        r = rsi(s)
        if r is not None and (r > 70 or r < 30):
            bet('rsi_fade', 0 if r > 70 else 1); bet('rsi_mom', 1 if r > 70 else 0)
        length = length_of[sn]
        for K in (2, 3):
            prev = [res_by[sn].get(s - k * length) for k in range(1, K + 1)]
            if None in prev or len(set(prev)) != 1: continue
            bet(f'streak{K}', prev[0]); bet(f'streak{K}_rev', 1 - prev[0])

    out = {'asset': asset, 'days': days, 'windows': len(wins), 'resolved': len(todo), 'grid_points': len(gt),
           'rules': {k: {'all': score(v, split), 'series': {sn: score([r for r in v if r['series'] == sn], split) for sn, _ in series}}
                     for k, v in rules.items()}}
    Path(f'chart_replay_{asset}_result.json').write_text(json.dumps(out, indent=1, default=str))
    f = lambda v, d=3: '   —  ' if v is None else f'{v:+.{d}f}'
    print(f"{asset} {days} days: {len(wins)} windows, {len(todo)} resolved, chart of {len(gt)} official start prices")
    for k, v in out['rules'].items():
        a = v['all']
        if not a: print(f'{k:12s} no bets'); continue
        print(f"{k:12s} n {a['n']:5d} won {a['win_rate']:.3f} at {a['avg_price']:.3f}  {f(a['per_contract'])}/contract  t {f(a['t'], 2)}  halves {f(a['first_half'])} {f(a['second_half'])}   "
              + '  '.join(f"{sn} {f(x['per_contract'])}(t{f(x['t'], 1)})" for sn, x in v['series'].items() if x))

if __name__ == '__main__':
    main()
