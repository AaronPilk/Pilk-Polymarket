"""Cash out the underdog's run, then put the profit on the favorite (basketball, Polymarket US).

Aaron's play (Nov 23, night; e.g. Washington v BYU): back the underdog while the odds are long, sell
when they make a run, then put the profit on the team that should win, now cheaper because of that
run. The question that decides it is the second leg: right after the underdog's run, is the favorite
priced too low?

For every resolved NBA and college basketball moneyline since Jan 1, 2026 (book-derived minute
prices, points with a book wider than 6c dropped):
  - favorite / underdog: the side over / under 50c (mid) just before tip-off
  - leg 1: buy the underdog at its ask in the first minutes after tip-off, if it asks 45c or less
  - the run: the underdog's bid reaches entry + D (D = 10, 15, 20 points) before the last stretch
    (NBA 100 minutes after tip, college 90)
  - leg 2: sell the underdog there, buy the favorite at its ask

Results per game, exact taker fee on every buy and sell (0.095 x p x (1 - p)), none at settlement:
  hold_dog      the underdog held to the end
  scalp         sell at the run, done
  flip_profit   sell at the run, all the profit onto the favorite (the stake is safe; the profit rides)
  flip_half     half the profit onto the favorite
  fav_after_run 1 contract of the favorite bought at the run, held (leg 2 alone: is it cheap?)
  fav_at_tip    control: 1 contract of the favorite at tip-off, held

Run: python3 scripts/swing_flip_replay.py [--since 2026-01-01]
"""
import concurrent.futures as cf, datetime as dt, json, math, sys
from pathlib import Path

import fav_replay as fr

GW, COEF = fr.GW, fr.COEF
LEAGUES = {'nba': 100, 'cbb': 90}   # minutes after tip-off the run has to come by
DELTAS = (0.10, 0.15, 0.20)
WIDE = 1.06

def fee(p): return COEF * p * (1 - p)
def ts(s): return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())

def closed_moneylines(max_off=14400):
    """Closed moneyline markets, paged oldest first (the gateway sorts ascending). The list is long
    (tennis, esports...: 160,000+ by Nov 2026), so it stops at max_off: offset 14,400 reaches June 2026,
    which covers the 2025-26 basketball season from January."""
    out, off = [], 0
    while off <= max_off:
        url = f'{GW}/markets?closed=true&marketTypes=moneyline&orderBy=gameStartTime&orderDirection=desc&limit=300&offset={off}'
        j = None
        for _ in range(4):   # a failed fetch is not the end of the list
            j = fr.cached(f'ml-page-{off}', lambda: fr.get(url)) if off < 14700 else fr.get(url)
            if j is not None: break
        if j is None: raise SystemExit(f'listing failed at offset {off}')
        ms = j.get('markets') or []
        out += ms
        if not ms: return out   # pages can come back a market short (hidden ones), so only an empty page ends it
        off += 300
    return out

def result_long(m):
    prices = json.loads(m.get('outcomePrices') or '[]')
    li = next((k for k, x in enumerate(m.get('marketSides') or []) if x.get('long')), 0)
    if m.get('status') != 'MARKET_STATUS_RESOLVED' or len(prices) <= li or prices[li] not in ('0', '1'): return None
    return int(prices[li])

def history(slug, tip):
    j = fr.cached('hist-' + slug, lambda: fr.get(f'{GW}/price-history?symbol={slug}&timestamp.startTimestamp={tip - 1800}&timestamp.endTimestamp={tip + 4 * 3600}&fidelity=1'))
    return (j or {}).get('history') or []

def play(hist, tip, cutoff_min, long_won):
    pts = []
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        la, sa = h.get('longPrice'), h.get('shortPrice')
        if la is None or sa is None: continue
        la, sa = float(la), float(sa)
        if not (0.01 < la < 0.99 and 0.01 < sa < 0.99) or la + sa > WIDE: continue
        pts.append(((h.get('timestamp') or 0) + 60 - tip, la, sa))   # each point: the book at the end of its minute
    pre = [p for p in pts if -900 <= p[0] <= 60]
    if not pre: return None
    _, la, sa = pre[-1]
    mid_long = (la + 1 - sa) / 2
    if abs(mid_long - 0.5) < 0.02: return None                      # a coin flip has no favorite
    fav_long = mid_long > 0.5
    ask = lambda p, long_side: p[1] if long_side else p[2]
    bid = lambda p, long_side: 1 - (p[2] if long_side else p[1])
    fav_won = 1 if (long_won == 1) == fav_long else 0
    after = [p for p in pts if 60 <= p[0] <= 300]
    if not after: return None
    p0 = after[0]
    dog_ask0, fav_ask0 = ask(p0, not fav_long), ask(p0, fav_long)
    out = {'fav_won': fav_won, 'fav_ask0': fav_ask0, 'dog_ask0': dog_ask0, 'pnl': {}}
    out['pnl']['fav_at_tip'] = fav_won - fav_ask0 - fee(fav_ask0)
    if dog_ask0 > 0.45: return out
    cost = dog_ask0 + fee(dog_ask0)
    out['pnl']['hold_dog'] = (1 - fav_won) - cost
    for d in DELTAS:
        trig = next((p for p in pts if p0[0] < p[0] <= cutoff_min * 60 and bid(p, not fav_long) >= dog_ask0 + d), None)
        k = f'{int(d * 100)}'
        if not trig:
            for name in ('scalp', 'flip_profit', 'flip_half'): out['pnl'][f'{name}_{k}'] = (1 - fav_won) - cost
            continue
        b = bid(trig, not fav_long); a = ask(trig, fav_long)
        profit = b - fee(b) - cost
        unit = a + fee(a)
        out['pnl'][f'scalp_{k}'] = profit
        out['pnl'][f'flip_profit_{k}'] = (profit / unit) * fav_won if profit > 0 else profit
        out['pnl'][f'flip_half_{k}'] = (profit / 2 + (profit / 2 / unit) * fav_won) if profit > 0 else profit
        out['pnl'][f'fav_after_run_{k}'] = fav_won - unit
        out.setdefault('runs', {})[k] = {'fav_ask': a, 'mins': trig[0] / 60}
    return out

def score(xs):
    if not xs: return None
    n = len(xs); m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1)) if n > 1 else None
    return {'n': n, 'mean': m, 't': m / (sd / math.sqrt(n)) if sd else None}

def main():
    since = sys.argv[sys.argv.index('--since') + 1] if '--since' in sys.argv else '2026-01-01'
    fr.CACHE.mkdir(exist_ok=True)
    games, seen = [], set()
    for m in closed_moneylines():
        if m['slug'] in seen: continue
        seen.add(m['slug'])
        lg = m['slug'].split('-')[1] if m['slug'].startswith('aec-') else None
        if lg not in LEAGUES or not m.get('gameStartTime') or m['gameStartTime'] < since: continue
        r = result_long(m)
        if r is not None: games.append((m['slug'], lg, ts(m['gameStartTime']), r))
    with cf.ThreadPoolExecutor(8) as ex:
        hists = dict(zip([g[0] for g in games], ex.map(lambda g: history(g[0], g[2]), games)))
    rows = []
    for slug, lg, tip, r in games:
        x = play(hists.get(slug) or [], tip, LEAGUES[lg], r)
        if x: rows.append({**x, 'slug': slug, 'league': lg, 'tip': tip})
    mid = sorted(r['tip'] for r in rows)[len(rows) // 2] if rows else 0
    keys = ['fav_at_tip', 'hold_dog'] + [f'{n}_{int(d * 100)}' for d in DELTAS for n in ('scalp', 'flip_profit', 'flip_half', 'fav_after_run')]
    out = {'since': since, 'games': len(games), 'played': len(rows), 'results': {}}
    for lg in ('all',) + tuple(LEAGUES):
        rs = [r for r in rows if lg == 'all' or r['league'] == lg]
        res = {}
        for k in keys:
            xs = [r['pnl'][k] for r in rs if k in r['pnl']]
            sc = score(xs)
            if sc:
                sc['first_half'] = (lambda v: sum(v) / len(v) if v else None)([r['pnl'][k] for r in rs if k in r['pnl'] and r['tip'] < mid])
                sc['second_half'] = (lambda v: sum(v) / len(v) if v else None)([r['pnl'][k] for r in rs if k in r['pnl'] and r['tip'] >= mid])
            res[k] = sc
        for d in DELTAS:
            k = f'{int(d * 100)}'
            runs = [r for r in rs if k in r.get('runs', {})]
            if runs:
                res[f'run_{k}'] = {'games_with_dog': sum(1 for r in rs if 'hold_dog' in r['pnl']), 'runs': len(runs),
                                   'fav_ask_at_run': sum(r['runs'][k]['fav_ask'] for r in runs) / len(runs),
                                   'fav_won_after_run': sum(r['fav_won'] for r in runs) / len(runs),
                                   'median_minute': sorted(r['runs'][k]['mins'] for r in runs)[len(runs) // 2]}
        out['results'][lg] = res
    Path('swing_flip_result.json').write_text(json.dumps(out, indent=1, default=str))
    f = lambda v, d=3: '   —  ' if v is None else f'{v:+.{d}f}'
    print(f"{len(games)} resolved basketball moneylines since {since}, {len(rows)} with clean prices")
    for lg, res in out['results'].items():
        print(f'== {lg}')
        for k in keys:
            v = res.get(k)
            if v: print(f"  {k:18s} n {v['n']:5d}  {f(v['mean'])} per game  t {f(v['t'], 2)}  halves {f(v['first_half'])} {f(v['second_half'])}")
        for d in DELTAS:
            v = res.get(f'run_{int(d * 100)}')
            if v: print(f"  run +{int(d * 100)}: {v['runs']} of {v['games_with_dog']} underdog buys; favorite then asked {v['fav_ask_at_run']:.3f} and won {v['fav_won_after_run']:.3f} (median minute {v['median_minute']:.0f})")

if __name__ == '__main__':
    main()
