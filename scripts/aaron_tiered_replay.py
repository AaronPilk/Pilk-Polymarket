#!/usr/bin/env python3
"""Aaron's price-tiered idea (Nov 24), replayed on 4,290 NBA and college games (Jan-Jun 2026).

His words: buy the trailing team when it's cheap and sell the bounce; size by the price, because a 10-point
move pays 3x from 5c but only 1.4x from 25c. So: around 10c bet the most, at 5c a bit less, at 20c+ less.

The rule here, one entry per game: the first minute in the second half (and 2+ minutes left) that a side
asks inside the band, buy it at the NEXT minute's ask (the book is the end of each minute, so a decision
fills a minute later). Exits:
  2x / 3x     a resting sell at 2x / 3x the entry (no fee; fills when a later minute's bid reaches it), else held
  2x+half     the 2x resting sell, plus a stop: once the bid is at half the entry, sell at the next minute's bid
  hold        held to the end
Taker fee 0.095 x p x (1 - p) on the buy and on stop sells; none at settlement or on resting sells.

Each bucket is run on its own (first time a side's ask enters that bucket), so the buckets overlap in games.
Then the tiered sizing is applied to the single wide rule (2-25c, first qualifying minute): flat stake vs
Aaron's tiers on the same trades. A bigger stake can't turn a losing rule into a winning one; it can only
put more of the money where the rule does best (or worst).

Run: python3 scripts/aaron_tiered_replay.py
"""
import json, math, statistics as st
from pathlib import Path

import fav_replay as fr
import hoops_screen as hs

fee = hs.fee
BUCKETS = [(0.02, 0.05), (0.05, 0.08), (0.08, 0.12), (0.12, 0.18), (0.18, 0.25)]
TIERS = [((0.02, 0.05), 0.05), ((0.05, 0.08), 0.075), ((0.08, 0.12), 0.10), ((0.12, 0.18), 0.075), ((0.18, 0.25), 0.05)]
EXITS = ('2x', '3x', '2x+half', 'hold')

def trade(rows, side, won, i, exit_):
    """Buy at row i+1's ask; returns (entry, pnl per share) or None."""
    if i + 1 >= len(rows) or rows[i + 1]['t'] - rows[i]['t'] > 90: return None
    ask = lambda x: x['la'] if side == 'long' else x['sa']
    bid = lambda x: (1 - x['sa']) if side == 'long' else (1 - x['la'])
    p = ask(rows[i + 1])
    if not (0.01 <= p <= 0.30): return None
    cost = p + fee(p)
    k = {'2x': 2.0, '3x': 3.0, '2x+half': 2.0}.get(exit_)
    for j in range(i + 2, len(rows)):
        b = bid(rows[j])
        if k and b >= k * p and k * p < 0.99:
            return p, k * p - cost                          # resting sell filled at the target
        if exit_ == '2x+half' and b <= p / 2:
            if j + 1 < len(rows):
                sb = bid(rows[j + 1]); return p, sb - fee(sb) - cost
            return p, b - fee(b) - cost
    return p, (1.0 if won else 0.0) - cost                 # held to the end

def first_in(rows, lo, hi):
    for i, x in enumerate(rows):
        if x['r'] > 0.5 or x['mins'] < 2: continue
        for side in ('long', 'short'):
            a = x['la'] if side == 'long' else x['sa']
            if lo <= a < hi: return i, side
    return None

def summary(rs):
    if not rs: return 'n 0'
    m = st.mean(rs); sd = st.pstdev(rs) if len(rs) > 1 else 0
    t = m / (sd / math.sqrt(len(rs))) if sd else 0
    return f'n {len(rs):>4}  per $ {m:+6.1%}  t {t:+5.2f}'

def main():
    G = json.load(open(fr.CACHE / 'hoops_games.json'))
    tips = sorted(g['tip'] for g in G); split = tips[len(tips) // 2]
    games = []
    for g in G:
        out = hs.game_rows(g)
        if out and len(out[1]) >= 30: games.append((g, out[1]))
    print(f'{len(games)} games with prices and play-by-play')
    res = {}
    print('\nEach entry bucket alone (return per dollar staked, fees in; halves = Jan-Mar / Apr-Jun)')
    for lo, hi in BUCKETS:
        for ex in EXITS:
            rs, h1, h2, hits = [], [], [], 0
            for g, rows in games:
                f = first_in(rows, lo, hi)
                if not f: continue
                i, side = f
                won = g['long_won'] if side == 'long' else 1 - g['long_won']
                tr = trade(rows, side, won, i, ex)
                if not tr: continue
                p, pnl = tr
                r = pnl / (p + fee(p))
                rs.append(r); (h1 if g['tip'] < split else h2).append(r)
                hits += r > 0
            res[f'{lo:.2f}-{hi:.2f} {ex}'] = {'n': len(rs), 'mean': st.mean(rs) if rs else None, 'win': hits / len(rs) if rs else None,
                                              'h1': st.mean(h1) if h1 else None, 'h2': st.mean(h2) if h2 else None}
            print(f"  {lo * 100:>2.0f}-{hi * 100:<2.0f}c {ex:<8} {summary(rs)}  won {hits / max(1, len(rs)):>4.0%}  "
                  f"halves {st.mean(h1) if h1 else 0:+6.1%} / {st.mean(h2) if h2 else 0:+6.1%}")
    print('\nOne wide rule (2-25c), flat stake vs Aaron\'s tiers (5% / 7.5% / 10% / 7.5% / 5% of the account)')
    for ex in EXITS:
        flat, tier_pnl, tier_stake = [], 0.0, 0.0
        for g, rows in games:
            f = first_in(rows, 0.02, 0.25)
            if not f: continue
            i, side = f
            won = g['long_won'] if side == 'long' else 1 - g['long_won']
            tr = trade(rows, side, won, i, ex)
            if not tr: continue
            p, pnl = tr
            r = pnl / (p + fee(p))
            flat.append(r)
            w = next((w for (lo, hi), w in TIERS if lo <= p < hi), 0.05)
            tier_pnl += w * r; tier_stake += w
        print(f"  {ex:<8} flat {summary(flat)}   tiered per $ {tier_pnl / tier_stake if tier_stake else 0:+6.1%}")
        res[f'wide {ex}'] = {'n': len(flat), 'flat': st.mean(flat) if flat else None, 'tiered': tier_pnl / tier_stake if tier_stake else None}
    print('\nThe live swing tests\' own filter: trailing by 3-9 with 3-12 minutes left, asking 8-25c (first such minute)')
    for ex in ('2x', '2x+half', 'hold'):
        rs, h1, h2, hits = [], [], [], 0
        for g, rows in games:
            f = None
            for i, x in enumerate(rows):
                if not (3 <= x['mins'] <= 12): continue
                for side in ('long', 'short'):
                    lead = x['lead'] if side == 'long' else -x['lead']
                    a = x['la'] if side == 'long' else x['sa']
                    if -9 <= lead <= -3 and 0.08 <= a <= 0.25: f = (i, side); break
                if f: break
            if not f: continue
            i, side = f
            won = g['long_won'] if side == 'long' else 1 - g['long_won']
            tr = trade(rows, side, won, i, ex)
            if not tr: continue
            p, pnl = tr
            r = pnl / (p + fee(p)); rs.append(r); (h1 if g['tip'] < split else h2).append(r); hits += r > 0
        print(f"  {ex:<8} {summary(rs)}  won {hits / max(1, len(rs)):>4.0%}  halves {st.mean(h1) if h1 else 0:+6.1%} / {st.mean(h2) if h2 else 0:+6.1%}")
        res[f'swing {ex}'] = {'n': len(rs), 'mean': st.mean(rs) if rs else None, 'win': hits / len(rs) if rs else None}
    print('\nFair-market check: a 2x resting sell should fill about half the time if prices were fair (p / 2p).')
    Path(fr.CACHE.parent / 'aaron_tiered_result.json').write_text(json.dumps(res, indent=1))

if __name__ == '__main__':
    main()
