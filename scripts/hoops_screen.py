"""Wide screen of in-game basketball rules on 4,335 NBA and college games (Jan-Jun 2026), with the real
score and clock from ESPN lined up to Polymarket US minute prices (scripts/hoops_espn.py).

Families, one entry per game per rule (the first minute that qualifies), per league and both together:
  spike    Aaron's play: buy a cheap side (3-8c, 8-15c, 15-25c, 25-40c) in a game situation, then hold
           or cash out with a resting sell at 2x or 3x. Situations: first half / third quarter / fourth
           quarter; favored at tip-off or not; any, on a run (gained 6+ points of lead in the last 5
           minutes), being run on, a close game (within 5), or down 10+
  model    the bot's own basketball math (sportFair, same formula as src/fairvalue.ts) rates the side
           3, 5, 8 or 12c over the ask after the fee; hold, or sell once the bid gets 2c over fair
  espn     ESPN's own win probability rates the side that far over the ask
  late     a 90-95c or 95-98c leader with 1-3 or 3-6 minutes left, held
  leader   a team up 5, 10 or 15 in a quarter, priced 70-97c, held

Data rules: the book at the END of each minute (stamp + 60 s); the game situation as of 20 s before that,
the bot's feed delay; books wider than 6c or crossed dropped; taker fee 0.095 x p x (1 - p) on buys and
sells at the bid, none on a resting sell. A resting sell fills when a later minute's bid reaches it
(minute points miss spikes inside a minute, so cash-outs read a little low).

A rule passes when it's up in BOTH halves of the season (split at the median game date) with t >= 2 in
each, over 150+ games. About one false pass is expected by luck across this many rules, so a pass earns a
live paper test, not trust.

Run: python3 scripts/hoops_screen.py   (writes hoops_screen_result.json)
"""
import bisect, json, math
from collections import defaultdict
from pathlib import Path
from statistics import NormalDist

import fav_replay as fr

CACHE, COEF = fr.CACHE, fr.COEF
ND = NormalDist()
LG = {'nba': (4, 12, 13.5), 'cbb': (2, 20, 11.5)}   # periods, minutes each, sigma (src/fairvalue.ts)
fee = lambda p: COEF * p * (1 - p)
import sys
WIDE = 1.06
DELAY = int(sys.argv[sys.argv.index('--delay') + 1]) if '--delay' in sys.argv else 20   # feed delay, s
STABLE = int(sys.argv[sys.argv.index('--stable') + 1]) if '--stable' in sys.argv else 0  # no score change in the last S s
NEXT = '--next' in sys.argv     # fill at the NEXT minute's price (a slow order)
SPIKE_BANDS = [(0.03, 0.08), (0.08, 0.15), (0.15, 0.25), (0.25, 0.40)]

def fair(lg, lead, r, start):
    _, _, sig = LG[lg]
    mu = sig * ND.inv_cdf(min(0.98, max(0.02, start)))
    if r <= 1e-6: return 1.0 if lead > 0 else 0.0 if lead < 0 else ND.cdf(mu / sig)
    return min(0.97, max(0.03, ND.cdf((lead + mu * r) / (sig * math.sqrt(r)))))

def share_left(lg, period, sec):
    P, M, _ = LG[lg]
    if period is None or sec is None: return None
    if period <= P: return max(0.0, ((P - period) * M * 60 + sec) / (P * M * 60))
    return max(0.0, sec / (P * M * 60))

def game_rows(g):
    lg = g['league']
    plays = sorted(g['plays'], key=lambda p: p[0])
    if len(plays) < 20: return None
    pt = [p[0] for p in plays]
    pts = [p for p in g['pts'] if 0 < p[1] < 1 and 0 < p[2] < 1 and 1 - 1e-9 <= p[1] + p[2] <= WIDE]
    pre = [p for p in pts if p[0] <= g['tip'] + 60]
    if not pre: return None
    start = (pre[-1][1] + 1 - pre[-1][2]) / 2
    def state(x):
        i = bisect.bisect_right(pt, x) - 1
        return plays[i] if i >= 0 else None
    rows = []
    for t, la, sa in pts:
        if t < plays[0][0] + 60 or t > plays[-1][0]: continue
        s = state(t - DELAY)
        if not s: continue
        _, per, sec, ls, ss, wp = s
        r = share_left(lg, per, sec)
        if r is None: continue
        back = state(t - DELAY - 300)
        run = (ls - ss) - ((back[3] - back[4]) if back else 0)
        last_play = plays[bisect.bisect_right(pt, t) - 1][0]   # the latest score change the market could know
        rows.append({'t': t, 'la': la, 'sa': sa, 'lead': ls - ss, 'r': r, 'mins': r * LG[lg][0] * LG[lg][1], 'run': run, 'wp': wp,
                     'calm': t - last_play >= STABLE})
    return start, rows

def phase(r, mins):
    if r > 0.5: return 'H1'
    if r > 0.25: return 'Q3'
    return 'Q4' if mins > 3 else None

def main():
    G = json.load(open(CACHE / 'hoops_games.json'))
    tips = sorted(g['tip'] for g in G)
    split = tips[len(tips) // 2]
    rules = defaultdict(list)    # key -> [(second_half, pnl, entry)]
    touch = defaultdict(lambda: [0, 0.0, 0])   # spike key -> [entries, fair touches (p/q), touches] for 2x
    used = 0
    for g in G:
        out = game_rows(g)
        if not out or len(out[1]) < 30: continue
        used += 1
        start_long, rows = out
        lg, h2 = g['league'], g['tip'] >= split
        n = len(rows)
        # per side: bid path and its running max from the end (for resting-sell touches)
        sides = {}
        for side in ('long', 'short'):
            bids = [(1 - x['sa']) if side == 'long' else (1 - x['la']) for x in rows]
            suf = [0.0] * (n + 1)
            for i in range(n - 1, -1, -1): suf[i] = max(bids[i], suf[i + 1])
            sides[side] = (bids, suf)
        first = {}
        for i, x in enumerate(rows):
            if not x['calm']: continue
            if NEXT and (i + 1 >= n or rows[i + 1]['t'] - x['t'] > 90): continue
            ph = phase(x['r'], x['mins'])
            for side in ('long', 'short'):
                sgn = 1 if side == 'long' else -1
                ask = x['la'] if side == 'long' else x['sa']
                fill = (rows[i + 1]['la'] if side == 'long' else rows[i + 1]['sa']) if NEXT else ask
                lead, run = sgn * x['lead'], sgn * x['run']
                start = start_long if side == 'long' else 1 - start_long
                won = g['long_won'] if side == 'long' else 1 - g['long_won']
                keys = []
                if ph:
                    favd = 'fav' if start >= 0.5 else 'dog'
                    for lo, hi in SPIKE_BANDS:
                        if lo <= ask < hi:
                            ctx = ['any']
                            if run >= 6: ctx.append('run+')
                            if run <= -6: ctx.append('run-')
                            if abs(lead) <= 5: ctx.append('close')
                            if lead <= -10: ctx.append('deep')
                            for c in ctx: keys.append(('spike', ph, f'{lo:.2f}-{hi:.2f}', favd, c))
                    if 0.10 <= ask <= 0.90 and x['mins'] > 3:
                        f = fair(lg, lead, x['r'], start)
                        e = f - ask - fee(ask)
                        for th in (0.03, 0.05, 0.08, 0.12):
                            if e >= th: keys.append(('model', ph, f'{th:.2f}'))
                        if x['wp'] is not None:
                            w = x['wp'] if side == 'long' else 1 - x['wp']
                            ew = w - ask - fee(ask)
                            for th in (0.03, 0.05, 0.08, 0.12):
                                if ew >= th: keys.append(('espn', ph, f'{th:.2f}'))
                    if 0.70 <= ask <= 0.97:
                        for L in (5, 10, 15):
                            if lead >= L: keys.append(('leader', ph, f'up{L}'))
                if lead > 0 and 1 <= x['mins'] <= 6:
                    win = '1-3m' if x['mins'] <= 3 else '3-6m'
                    for lo, hi in ((0.90, 0.95), (0.95, 0.98)):
                        if lo <= ask < hi: keys.append(('late', win, f'{lo:.2f}-{hi:.2f}'))
                for k in keys:
                    for kk in (k + (lg,), k + ('all',)):
                        if kk not in first: first[kk] = (i + 1 if NEXT else i, side, fill, won, start)
        for k, (i, side, ask, won, start) in first.items():
            cost = ask + fee(ask)
            bids, suf = sides[side]
            fam = k[0]
            res = {'hold': won - cost}
            if fam == 'spike':
                for m in (2, 3):
                    q = round(m * ask, 2)
                    res[f'{m}x'] = (q - cost) if (q < 0.99 and suf[i + 1] >= q) else won - cost
                tk = k
                touch[tk][0] += 1; touch[tk][1] += min(1.0, ask / min(0.99, 2 * ask)); touch[tk][2] += int(2 * ask < 0.99 and suf[i + 1] >= 2 * ask)
            if fam in ('model', 'espn'):
                pnl = won - cost
                for j in range(i + 1, n):
                    y = rows[j]
                    if y['mins'] <= 3: break
                    sgn = 1 if side == 'long' else -1
                    if fam == 'model': fv = fair(lg, sgn * y['lead'], y['r'], start)
                    else:
                        if y['wp'] is None: continue
                        fv = y['wp'] if side == 'long' else 1 - y['wp']
                    b = bids[j]
                    if b >= fv + fee(b) + 0.02:
                        pnl = b - fee(b) - cost; break
                res['exit'] = pnl
            for ex, pnl in res.items():
                rules[k + (ex,)].append((h2, pnl, ask))
    print(f'{used} games used; second half from {__import__("datetime").datetime.utcfromtimestamp(split):%b %d}')
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
    print(f'{len(res)} rules scored; {len(passed)} pass both halves at t >= 2')
    tag = f"delay {DELAY}s, stable {STABLE}s{', next-minute fills' if NEXT else ''}"
    print(tag)
    idx = {x['rule']: x for x in res}
    for base in ('model | H1 | 0.05 | all', 'model | Q3 | 0.08 | all', 'model | Q4 | 0.08 | all', 'model | H1 | 0.08 | nba', 'model | H1 | 0.08 | cbb',
                 'espn | H1 | 0.05 | all', 'espn | Q3 | 0.05 | all', 'espn | Q4 | 0.08 | all'):
        for ex in ('hold', 'exit'):
            x = idx.get(f'{base} | {ex}')
            if x: print(f"  {x['rule']:<34} n {x['n']:5} @ {x['price']:.3f} {x['cents']:+.2f}c t {x['t']:+.2f}  h1 {x['h1'][1]:+.2f} (t {x['h1'][2]:+.1f}) h2 {x['h2'][1]:+.2f} (t {x['h2'][2]:+.1f})")
    for r in passed[:0]:
        print(f"PASS {r['rule']:<52} n {r['n']:5} @ {r['price']:.3f}  {r['cents']:+.2f}c  t {r['t']:+.2f}  h1 {r['h1'][1]:+.2f}c (t {r['h1'][2]:+.1f})  h2 {r['h2'][1]:+.2f}c (t {r['h2'][2]:+.1f})")
    # The touch test for the spike play: cash-out touches vs what a fair price gives (p / q)
    Path(CACHE.parent / 'hoops_screen_result.json').write_text(json.dumps({'games': used, 'rules': len(res), 'passed': passed, 'args': sys.argv[1:],
        'all': sorted(res, key=lambda r: -r['t'])}, indent=1, default=str))
    if '--touch' not in sys.argv: return
    print('spike touch test (2x target), all leagues, situation "any":')
    for k, (n, fair_t, hit) in sorted(touch.items()):
        if k[-1] != 'all' or k[4] != 'any' or n < 100: continue
        print(f"  {k[1]} {k[2]} {k[3]}: {n} entries, reached 2x {hit} times, a fair price would {fair_t:.0f}  ({hit / fair_t:.2f}x)")

if __name__ == '__main__':
    main()
