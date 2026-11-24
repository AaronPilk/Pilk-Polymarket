"""Aaron's actual method, as he described it on Nov 24: he doesn't trade off watching the game (Polymarket is
faster than the broadcast); he trades the Polymarket price itself. So these rules see only the price path,
plus the rough stage of the game (first half / third quarter / fourth quarter), never the score.

Families, one entry per game per rule, NBA and college (4,290 games, Jan-Jun 2026):
  dip      a side's mid fell 8, 12 or 20c over the last 2, 5 or 10 minutes: buy it
  rise     a side's mid rose that much: buy it (chase the run)
  avgdown  the first 8c/5-minute dip, then one more contract each time the ask is 5c under the average
           price (never under 10c), at most two adds; sold at the average + 5c with a resting order, or held
Exits for dip / rise: hold; a resting sell 5c or 10c over the entry; a resting sell back at the level
before the move (dip only); or sell at the bid 10 minutes later.

Fills are honest about speed: the signal is the book at the end of a minute, the buy fills at the NEXT
minute's ask. Taker fee 0.095 x p x (1 - p) on buys and on sells at the bid; resting sells pay none and
fill when a later minute's bid reaches them. Pass bar: up in both halves of the season with t >= 2 in
each, 150+ games; with about 3,000 rules, one or two false passes are expected by luck.

Run: python3 scripts/hoops_price_screen.py   (writes hoops_price_screen_result.json)
"""
import bisect, json, math
from collections import defaultdict
from pathlib import Path

import fav_replay as fr
import hoops_screen as hs

CACHE = fr.CACHE
fee = hs.fee
BANDS = [(0.10, 0.30), (0.30, 0.50), (0.50, 0.70), (0.70, 0.90)]
MOVES = [(d, w) for d in (0.08, 0.12, 0.20) for w in (2, 5, 10)]

def main():
    G = json.load(open(CACHE / 'hoops_games.json'))
    tips = sorted(g['tip'] for g in G)
    split = tips[len(tips) // 2]
    rules = defaultdict(list)
    used = 0
    for g in G:
        out = hs.game_rows(g)
        if not out or len(out[1]) < 30: continue
        used += 1
        _, rows = out
        lg, h2 = g['league'], g['tip'] >= split
        n = len(rows)
        ts = [x['t'] for x in rows]
        first = {}
        S = {}
        for side in ('long', 'short'):
            ask = [x['la'] if side == 'long' else x['sa'] for x in rows]
            bid = [(1 - x['sa']) if side == 'long' else (1 - x['la']) for x in rows]
            mid = [(a + b) / 2 for a, b in zip(ask, bid)]
            suf = [0.0] * (n + 1)
            for i in range(n - 1, -1, -1): suf[i] = max(bid[i], suf[i + 1])
            S[side] = (ask, bid, mid, suf, g['long_won'] if side == 'long' else 1 - g['long_won'])
        # dip / rise, in time order across both sides: the first minute either side qualifies
        for i in range(1, n - 1):
            if ts[i + 1] - ts[i] > 90: continue
            ph = hs.phase(rows[i]['r'], rows[i]['mins'])
            if not ph: continue
            for side in ('long', 'short'):
                ask, bid, mid, suf, won = S[side]
                f, a = i + 1, ask[i + 1]
                band = next((b for b in BANDS if b[0] <= a < b[1]), None)
                if not band: continue
                for d, w in MOVES:
                    k = bisect.bisect_left(ts, ts[i] - 60 * w)
                    if k >= i or abs(ts[k] - (ts[i] - 60 * w)) > 40: continue
                    move = mid[i] - mid[k]
                    kind = 'dip' if move <= -d else 'rise' if move >= d else None
                    if not kind: continue
                    for L in (lg, 'all'):
                        key = (kind, ph, f'{int(d * 100)}c/{w}m', f'{band[0]:.2f}-{band[1]:.2f}', L)
                        if key not in first: first[key] = (side, f, a, won, mid[k], bid, suf)
        # avgdown: the first 8c/5-minute dip in the first half or third quarter, either side
        trig = None
        for i in range(1, n - 1):
            if ts[i + 1] - ts[i] > 90: continue
            ph = hs.phase(rows[i]['r'], rows[i]['mins'])
            if ph not in ('H1', 'Q3'): continue
            k = bisect.bisect_left(ts, ts[i] - 300)
            if k >= i or abs(ts[k] - (ts[i] - 300)) > 40: continue
            for side in ('long', 'short'):
                ask, bid, mid, suf, won = S[side]
                if mid[i] - mid[k] <= -0.08 and 0.10 <= ask[i + 1] <= 0.90: trig = (i, ph, side); break
            if trig: break
        if trig:
            i, ph, side = trig
            ask, bid, mid, suf, won = S[side]
            buys = [ask[i + 1]]; done_at = None
            for j in range(i + 2, n):
                avg = sum(buys) / len(buys)
                if bid[j] >= round(avg + 0.05, 2): done_at = round(avg + 0.05, 2); break
                if len(buys) < 3 and 0.10 <= ask[j] <= avg - 0.05: buys.append(ask[j])
            cost = sum(b + fee(b) for b in buys)
            pnl = (done_at * len(buys) - cost) if done_at else (won * len(buys) - cost)
            for L in (lg, 'all'):
                rules[('avgdown', ph, '8c/5m', 'any', L, 'avg+5')].append((h2, pnl / len(buys), buys[0]))
                rules[('avgdown', ph, '8c/5m', 'any', L, 'hold')].append((h2, (won * len(buys) - cost) / len(buys), buys[0]))
        tsl = ts
        for key, (side, f, a, won, pre, bid, suf) in first.items():
            cost = a + fee(a)
            res = {'hold': won - cost}
            for x, name in ((0.05, 'b5'), (0.10, 'b10')):
                q = round(a + x, 2)
                res[name] = (q - cost) if (q < 0.99 and suf[f + 1] >= q) else won - cost
            if key[0] == 'dip' and pre > a + 0.02:
                q = round(pre, 2)
                res['revert'] = (q - cost) if (q < 0.99 and suf[f + 1] >= q) else won - cost
            j = bisect.bisect_left(tsl, tsl[f] + 600)
            res['t10'] = (bid[j] - fee(bid[j]) - cost) if j < len(tsl) else won - cost
            for ex, pnl in res.items():
                rules[key + (ex,)].append((h2, pnl, a))
    def st(xs):
        n = len(xs)
        if n < 2: return None
        m = sum(xs) / n
        sd = math.sqrt(sum((v - m) ** 2 for v in xs) / (n - 1))
        return n, m, (m / (sd / math.sqrt(n)) if sd > 0 else float('inf'))
    res = []
    for k, rs in rules.items():
        a = st([p for h, p, _ in rs if not h]); b = st([p for h, p, _ in rs if h]); c = st([p for _, p, _ in rs])
        if not a or not b or not c: continue
        res.append({'rule': ' | '.join(k), 'family': k[0], 'n': c[0], 'cents': 100 * c[1], 't': c[2], 'price': sum(e for _, _, e in rs) / len(rs),
                    'h1': (a[0], 100 * a[1], a[2]), 'h2': (b[0], 100 * b[1], b[2])})
    ok = lambda r: r['n'] >= 150 and min(r['h1'][0], r['h2'][0]) >= 60 and r['h1'][1] > 0 and r['h2'][1] > 0 and r['h1'][2] >= 2 and r['h2'][2] >= 2
    passed = sorted([r for r in res if ok(r)], key=lambda r: -r['t'])
    print(f'{used} games; {len(res)} rules scored; {len(passed)} pass both halves at t >= 2')
    for r in passed[:30]:
        print(f"PASS {r['rule']:<48} n {r['n']:5} @ {r['price']:.3f}  {r['cents']:+.2f}c  t {r['t']:+.2f}  h1 {r['h1'][1]:+.2f}c (t {r['h1'][2]:+.1f})  h2 {r['h2'][1]:+.2f}c (t {r['h2'][2]:+.1f})")
    fam = defaultdict(list)
    for r in res:
        if r['rule'].split(' | ')[-2] == 'all': fam[(r['family'], r['rule'].split(' | ')[-1])].append(r['cents'] * r['n'])
    print('average result per contract by family and exit (all leagues, weighted by games):')
    for (f, ex), xs in sorted(fam.items()):
        nn = sum(r['n'] for r in res if r['family'] == f and r['rule'].split(' | ')[-1] == ex and r['rule'].split(' | ')[-2] == 'all')
        print(f"  {f:8} {ex:7} {sum(xs) / nn:+.2f}c over {nn} entries")
    Path(CACHE.parent / 'hoops_price_screen_result.json').write_text(json.dumps({'games': used, 'rules': len(res), 'passed': passed,
        'all': sorted(res, key=lambda r: -r['t'])}, indent=1, default=str))

if __name__ == '__main__':
    main()
