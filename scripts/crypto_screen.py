"""Wide screen of price-only rules on Polymarket US Up/Down windows: Bitcoin, XRP and gold, every
series in the replay cache (about 30 days), so a rule needs no outside price feed to trade.

Rule families, each one entry per window at most (the first minute point that qualifies):
  band     at a given time left, buy whichever side asks inside a price band; hold to the result
  move     after the Up price moved X or more over the last k minutes, buy the side that moved
           (momentum) or the other one (reversal); hold to the result
  cheap2x  buy a side asking X or less with half the window or more left; sell at 2x or 3x the
           entry the first minute its bid gets there, else hold

Data rules (same as the earlier replays): one book point a minute, each showing the book at the END
of its minute (so time left = end - stamp - 60 s); crossed books (Up ask + Down ask under $1) dropped;
exact taker fee 0.095 x p x (1 - p) on every buy and sell, none at settlement; uncertainty clustered
by the hour the window ends in.

A rule passes only if it wins in BOTH halves of the month with t >= 2 in each, on 200+ bets. With
several hundred rules, about one false pass is expected by luck at that bar, so a pass earns a live
1-contract test, nothing more.

Run: python3 scripts/crypto_screen.py   (writes crypto_screen_result.json)
"""
import datetime as dt, json, math, re, statistics
from collections import defaultdict
from pathlib import Path

import fav_replay as fr
import pvm_replay as pv

CACHE, COEF, SHIFT = fr.CACHE, fr.COEF, fr.SHIFT
LEN = {'5m': 300, '15m': 900, '1h': 3600}
ASSET = {'cpc-btc-updown': 'btc', 'cpcxrp-xrp-updown': 'xrp', 'cpausp-gold-updown': 'gold'}
BANDS = [(0.02, 0.10), (0.10, 0.20), (0.20, 0.35), (0.35, 0.50), (0.50, 0.65), (0.65, 0.80),
         (0.80, 0.90), (0.90, 0.95), (0.95, 0.98), (0.98, 0.995)]
TAU = {
    '5m': [('4m', 240, 240), ('3m', 180, 180), ('2m', 120, 120), ('1m', 60, 60)],
    '15m': [('14-10m', 600, 840), ('9-5m', 300, 540), ('4-3m', 180, 240), ('2m', 120, 120), ('1m', 60, 60)],
    '1h': [('59-45m', 2700, 3540), ('44-30m', 1800, 2640), ('29-15m', 900, 1740), ('14-5m', 300, 840),
           ('4-3m', 180, 240), ('2m', 120, 120), ('1m', 60, 60)],
}
MOVES = [(k, x) for k in (1, 2, 3) for x in (0.10, 0.20, 0.30)]
fee = lambda p: COEF * p * (1 - p)
RX = re.compile(r'^hist-(cpc-btc-updown|cpcxrp-xrp-updown|cpausp-gold-updown)-(5m|15m|1h)-(\d{4}-\d{2}-\d{2}-\d{4})z\.json$')

def load():
    info = pv.load_markets()
    wins = []
    for f in CACHE.iterdir():
        m = RX.match(f.name)
        if not m: continue
        pre, series, stamp = m.groups()
        sl = f.name[5:-5]
        if sl not in info: continue
        start = int(dt.datetime.strptime(stamp, '%Y-%m-%d-%H%M').replace(tzinfo=dt.timezone.utc).timestamp())
        end = start + LEN[series]
        try: hist = (json.loads(f.read_text()) or {}).get('history') or []
        except Exception: continue
        pts = []
        for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
            la, sa = h.get('longPrice'), h.get('shortPrice')
            if la is None or sa is None: continue
            la, sa = float(la), float(sa)
            tau = end - (h.get('timestamp') or 0) - SHIFT
            if tau <= 0 or tau > LEN[series]: continue
            if not (0 < la < 1 and 0 < sa < 1) or la + sa < 1 - 1e-9: continue   # crossed: can't exist
            pts.append((tau, la, sa))
        if pts: wins.append({'asset': ASSET[pre], 'series': series, 'end': end, 'up': info[sl]['up'], 'pts': pts})
    return wins

def bets_for(w):
    """Every rule's entry in this window: rule key -> (price, won, pnl)."""
    out, pts, up, series = {}, w['pts'], w['up'], w['series']
    a, s = w['asset'], series
    # band: first point in each time-left bucket
    for name, lo, hi in TAU[series]:
        p = next((x for x in pts if lo <= x[0] <= hi), None)
        if not p: continue
        for side_up, ask in ((True, p[1]), (False, p[2])):
            for b in BANDS:
                if b[0] <= ask < b[1]:
                    won = 1 if (up == 1) == side_up else 0
                    out[('band', a, s, name, f'{b[0]:.2f}-{b[1]:.3f}'.rstrip('0'))] = (ask, won, won - ask - fee(ask))
    # move: Up mid change over k minutes, before the last minute
    L = LEN[series]
    for i, p in enumerate(pts):
        if p[0] <= 60: continue
        phase = 'early' if p[0] >= L / 2 else 'late'
        mid = (p[1] + 1 - p[2]) / 2
        for k, x in MOVES:
            back = next((q for q in reversed(pts[:i]) if abs(q[0] - (p[0] + 60 * k)) <= 1), None)
            if not back: continue
            d = mid - (back[1] + 1 - back[2]) / 2
            if abs(d) < x: continue
            for how in ('momentum', 'reversal'):
                key = ('move', a, s, phase, f'{k}m', f'{x:.2f}', how)
                if key in out: continue
                side_up = (d > 0) == (how == 'momentum')
                ask = p[1] if side_up else p[2]
                if not (0.02 <= ask <= 0.98): continue
                won = 1 if (up == 1) == side_up else 0
                out[key] = (ask, won, won - ask - fee(ask))
    # cheap2x: cheap side with half the window or more left, sell at 2x / 3x
    for i, p in enumerate(pts):
        if p[0] < L / 2: break
        for side_up, ask in ((True, p[1]), (False, p[2])):
            for cap in (0.10, 0.20, 0.30):
                if not (0.02 <= ask <= cap): continue
                won = 1 if (up == 1) == side_up else 0
                for mult in (2, 3):
                    key = ('cheap2x', a, s, f'<={cap:.2f}', f'{mult}x')
                    if key in out: continue
                    q = mult * ask
                    hit = q < 0.99 and any((1 - (x[2] if side_up else x[1])) >= q for x in pts[i + 1:])
                    pnl = (q - fee(q) - ask - fee(ask)) if hit else (won - ask - fee(ask))
                    out[key] = (ask, won, pnl)
    return out

def stats(rows):
    """rows: (hour, pnl). Mean per contract and t with hour-clustered SE."""
    n = len(rows)
    if n < 2: return None
    mean = sum(r[1] for r in rows) / n
    by = defaultdict(float)
    for h, x in rows: by[h] += x - mean
    g = len(by)
    var = sum(v * v for v in by.values()) / (n * n) * (g / (g - 1) if g > 1 else 1)
    se = math.sqrt(var) if var > 0 else float('nan')
    return {'n': n, 'mean': mean, 'se': se, 't': mean / se if se and se == se else None}

def main():
    wins = load()
    days = sorted({w['end'] // 86400 for w in wins})
    split = days[len(days) // 2]
    print(f'{len(wins)} windows over {len(days)} days; second half from {dt.datetime.fromtimestamp(split * 86400, dt.timezone.utc):%b %d}')
    rules = defaultdict(list)
    for w in wins:
        for key, (ask, won, pnl) in bets_for(w).items():
            rules[key].append((w['end'] // 3600, w['end'] // 86400 >= split, ask, won, pnl))
    res = []
    for key, rs in rules.items():
        if len(rs) < 60: continue
        allst = stats([(h, x) for h, _, _, _, x in rs])
        a = stats([(h, x) for h, s2, _, _, x in rs if not s2]); b = stats([(h, x) for h, s2, _, _, x in rs if s2])
        if not allst or not a or not b: continue
        res.append({'rule': ' | '.join(key), 'family': key[0], 'asset': key[1], 'series': key[2], 'n': allst['n'],
                    'won': sum(r[3] for r in rs) / len(rs), 'price': sum(r[2] for r in rs) / len(rs),
                    'cents': 100 * allst['mean'], 't': allst['t'], 'h1': (a['n'], 100 * a['mean'], a['t']), 'h2': (b['n'], 100 * b['mean'], b['t'])})
    ok = lambda r: r['n'] >= 200 and min(r['h1'][0], r['h2'][0]) >= 80 and r['h1'][1] > 0 and r['h2'][1] > 0 and (r['h1'][2] or 0) >= 2 and (r['h2'][2] or 0) >= 2
    passed = sorted([r for r in res if ok(r)], key=lambda r: -r['t'])
    near = sorted([r for r in res if not ok(r) and r['n'] >= 200 and r['h1'][1] > 0 and r['h2'][1] > 0 and (r['t'] or 0) >= 2.5], key=lambda r: -r['t'])
    print(f'{len(res)} rules scored; {len(passed)} pass both halves at t >= 2; {len(near)} near misses (both halves up, t >= 2.5)')
    for r in passed + near[:15]:
        tag = 'PASS' if r in passed else 'near'
        print(f"{tag:4} {r['rule']:<55} n {r['n']:5}  won {r['won']:.3f} @ {r['price']:.3f}  {r['cents']:+.2f}c  t {r['t']:+.2f}  "
              f"h1 {r['h1'][1]:+.2f}c (t {r['h1'][2]:+.1f})  h2 {r['h2'][1]:+.2f}c (t {r['h2'][2]:+.1f})")
    Path(CACHE.parent / 'crypto_screen_result.json').write_text(json.dumps(
        {'windows': len(wins), 'days': len(days), 'rules': len(res), 'passed': passed, 'near': near,
         'all': sorted(res, key=lambda r: -(r['t'] or -99))}, indent=1, default=str))

if __name__ == '__main__':
    main()
