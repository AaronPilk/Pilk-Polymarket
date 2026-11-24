"""Do Polymarket's Bitcoin windows that settle at the same moment agree with each other?

At every quarter hour a 5-minute, a 15-minute and (on the hour) an hourly window all end together and
settle on the same CF Benchmarks price, each against its own start price (strike). For two windows A and
B ending together with strike_A >= strike_B, "Up on B" pays whenever "Up on A" does, so:

  buy Up on B (the lower strike) + buy Down on A (the higher strike)
  pays $1 always, $2 if the final price lands between the two strikes.

If that pair asks under $1 after fees it's a locked-in profit. Even above $1 it's a bet on the gap
between the strikes, worth 1 + P(final lands between them). This replays every such pair at every
minute point in the cache (same data rules as the other replays: the book at the end of each minute,
crossed books dropped, taker fee 0.095 x p x (1 - p) per leg) and counts:
  - minutes where the pair asked under $1 before fees, and under $1 after fees (true locks)
  - the pair bet's average result per $1 of payout, first point per window pair, by time left

Run: python3 scripts/cross_window.py [asset]   (btc default; xrp, gold)
"""
import datetime as dt, json, math, re, sys
from collections import defaultdict

import fav_replay as fr
import pvm_replay as pv

CACHE, COEF, SHIFT = fr.CACHE, fr.COEF, fr.SHIFT
LEN = {'5m': 300, '15m': 900, '1h': 3600}
PRE = {'btc': 'cpc-btc-updown', 'xrp': 'cpcxrp-xrp-updown', 'gold': 'cpausp-gold-updown'}
fee = lambda p: COEF * p * (1 - p)

def main():
    asset = sys.argv[1] if len(sys.argv) > 1 else 'btc'
    rx = re.compile(rf'^hist-{PRE[asset]}-(5m|15m|1h)-(\d{{4}}-\d{{2}}-\d{{2}}-\d{{4}})z\.json$')
    info = pv.load_markets()
    by_end = defaultdict(list)
    for f in CACHE.iterdir():
        m = rx.match(f.name)
        if not m: continue
        series, stamp = m.groups()
        sl = f.name[5:-5]
        meta = info.get(sl)
        if not meta or meta.get('strike') is None: continue
        start = int(dt.datetime.strptime(stamp, '%Y-%m-%d-%H%M').replace(tzinfo=dt.timezone.utc).timestamp())
        end = start + LEN[series]
        pts = {}
        for h in (json.loads(f.read_text()) or {}).get('history') or []:
            la, sa = h.get('longPrice'), h.get('shortPrice')
            if la is None or sa is None: continue
            la, sa = float(la), float(sa)
            if not (0 < la < 1 and 0 < sa < 1) or la + sa < 1 - 1e-9: continue
            t = (h.get('timestamp') or 0) + SHIFT        # the moment this book was true
            if t >= end: continue
            pts[t] = (la, sa)
        if pts: by_end[end].append({'series': series, 'strike': meta['strike'], 'up': meta['up'], 'pts': pts})
    groups = [g for g in by_end.values() if len(g) >= 2]
    print(f'{asset}: {sum(len(g) for g in by_end.values())} windows with a strike, {len(groups)} settlement moments shared by 2+ windows')
    minutes = under1 = locked = 0
    first = defaultdict(list)   # time-left bucket -> results per $1 payout of the first pair bet per window pair
    samples = []
    for g in groups:
        for a in g:
            for b in g:
                if a is b or a['strike'] < b['strike']: continue
                if a['strike'] == b['strike'] and LEN[a['series']] > LEN[b['series']]: continue   # count equal strikes once
                done = False
                common = sorted(set(a['pts']) & set(b['pts']))
                end = None
                for t in common:
                    la_a, sa_a = a['pts'][t]; la_b, sa_b = b['pts'][t]
                    up_b, down_a = la_b, sa_a                      # asks
                    cost = up_b + down_a
                    costf = cost + fee(up_b) + fee(down_a)
                    minutes += 1
                    if cost < 1: under1 += 1
                    if costf < 1: locked += 1; samples.append((t, a['series'], b['series'], a['strike'], b['strike'], up_b, down_a, round(costf, 4)))
                    if not done:
                        done = True
                        # payoff: Up on B wins if final > strike_B (b['up']), Down on A wins if final <= strike_A (not a['up'])
                        pay = b['up'] + (1 - a['up'])
                        left = None
                        for s in (a, b):
                            pass
                        first[(a['series'], b['series'])].append(pay - costf)
    print(f'pair-minutes checked: {minutes:,}; asked under $1: {under1:,}; under $1 after fees (locked profit): {locked:,}')
    for k, xs in sorted(first.items()):
        n = len(xs); mean = sum(xs) / n
        sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1)) if n > 1 else float('nan')
        print(f'  first pair bet, {k[0]} (higher strike, Down) + {k[1]} (Up): n {n:5}  {100 * mean:+.2f}c per pair  t {mean / (sd / math.sqrt(n)):+.2f}')
    for s in samples[:12]:
        print('  lock:', dt.datetime.fromtimestamp(s[0], dt.timezone.utc).strftime('%m-%d %H:%M'), s[1:])
    json.dump({'asset': asset, 'minutes': minutes, 'under1': under1, 'locked': locked, 'samples': samples[:500]},
              open(CACHE.parent / f'cross_window_{asset}_result.json', 'w'), indent=1)

if __name__ == '__main__':
    main()
