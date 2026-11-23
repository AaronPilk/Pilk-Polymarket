#!/usr/bin/env python3
"""Replay the Bitcoin bot's strategies with their exits, and resting maker buys, on Polymarket's own
price history (the last N days of 5m / 15m / 1h Up/Down windows).

Same data and math as pvm_replay.py: one book point a minute (each shows the book at the end of its
minute, so its real time left is the stamp minus 60 s), Coinbase one-minute closes lined up onto the
official index, fairUp with blended volatility. Test bets are judged like the live bot judges them
(judgingBlend): the 50/50 blend with 4+ minutes left, the fitted late blend (close to the market's
own price) under 4 minutes, which in practice keeps test entries to the early band.

Taker strategies (src/crypto.ts), entry at the ask with the taker fee, then each minute:
  a resting 2x sell under tpBelow fills once the bid reaches it (no fee); otherwise sell at the bid
  once it clears the blend + fee + exitAbove (taker fee), or for makerExit a resting sell at
  blend + exitAbove (no fee); otherwise hold to the official result. A loss closes the window for
  that strategy; after a winning sell it may buy back in at a later point.
    fair_strict  10c+ edge, the live test
    fair_v1      5c+ edge (retired Nov 23 on the hold-to-the-end replay; rerun with its exits)
    fair_maker   fair_v1's entries, exit by a resting sell at blend + 3c
    hold         fair_v1's entries held to the result
    cheap_v1     3c+ edge at 5-20c, 2x resting sell under 20c, sell at blend + fee + 3c
    lag_minute   the math moved 6+ points over the last minute while the market's price moved under
                 half as much: buy the move (4c+ edge), sell at blend + fee + 2c. The live rule
                 (crypto_lag_v1) reacts to 30-second moves; with one point a minute this is a
                 proxy for it, not the live rule.

Maker buys (not in the bot yet): a resting buy at the side's bid, no fee, held to the result.
    m_fair       on the side where the 50/50 blend is 3c+ over the bid (5-90c, same data checks),
                 re-priced each minute while that holds, cancelled when it doesn't or at 4 minutes left
    m_fair_up1   the same, 1c over the bid when the spread is 2c+
    m_both       bids on both sides at every early point, each side filled at most once
  Fill rules, from strict to loose: 'through' (the side's ask at the next point is at or under the
  order: the price traded down to it), 'touch' (or the side's bid fell under the order), 'instant'
  (filled the moment it is placed: no adverse selection, an upper bound).

P&L is per contract, clustered by hour for the t-stat. Verdict rules (fixed before running):
retire a live test only on t <= -2 over 300+ bets with both halves of the period losing; add a
maker test only on t >= 2 over 300+ fills under the strict 'through' rule with both halves winning.

Run: python3 scripts/strategy_replay.py [days]
"""
import datetime as dt, json, math, statistics, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fav_replay as fr
import pvm_replay as pv

COEF = fr.COEF
EARLY = 240
MAX_EDGE, MAX_GAP, BLEND_EDGE = 0.30, 0.15, 0.01
LATE_B, LATE_C = 0.05, 1.04          # the late band's fitted blend on Nov 23 (b 0.03-0.08, c ~1.04)
ET = dt.timezone(dt.timedelta(hours=-5))

def fee(p): return COEF * p * (1 - p)

STRATS = {
    'fair_strict': dict(minEdge=0.10, pmin=0.05, pmax=0.90, tpBelow=0.15, exitAbove=0.03, tauMin=75),
    'fair_v1':     dict(minEdge=0.05, pmin=0.05, pmax=0.90, tpBelow=0.15, exitAbove=0.03, tauMin=75),
    'fair_maker':  dict(minEdge=0.05, pmin=0.05, pmax=0.90, tpBelow=0.15, exitAbove=0.03, tauMin=75, makerExit=True),
    'hold':        dict(minEdge=0.05, pmin=0.05, pmax=0.90, tpBelow=0.0, exitAbove=None, tauMin=75),
    'cheap_v1':    dict(minEdge=0.03, pmin=0.05, pmax=0.20, tpBelow=0.20, exitAbove=0.03, tauMin=75),
    'lag_minute':  dict(minEdge=0.04, pmin=0.05, pmax=0.90, tpBelow=0.0, exitAbove=0.02, tauMin=45, lag=True),
}

class Pt:
    __slots__ = ('real', 'tau', 'up', 'dn', 'mid', 'f')

def points(hist, e, strike, px, offs):
    out = []
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        up, dn = h.get('longPrice'), h.get('shortPrice')
        if up is None or dn is None: continue
        p = Pt(); p.real = (h.get('timestamp') or 0) + fr.SHIFT; p.tau = e - p.real
        if p.tau <= 0: continue
        p.up, p.dn = float(up), float(dn)
        p.mid = (p.up + 1 - p.dn) / 2
        spot, sig = px.at(p.real), px.sigma(p.real)
        p.f = pv.fair_up(spot + pv.offset_at(offs, p.real), strike, sig, p.tau) if (spot and sig and p.tau >= 60) else None
        out.append(p)
    return out

def p_up(pt):
    """What a test bet believes Up is worth at this point (judgingBlend)."""
    return pv.blend(0.5, 0.5, pt.f, pt.mid) if pt.tau >= EARLY else pv.blend(LATE_B, LATE_C, pt.f, pt.mid)

def ask_of(pt, side): return pt.up if side else pt.dn
def bid_of(pt, side): return 1 - pt.dn if side else 1 - pt.up

def taker_entry(pt, st, length, want=None):
    if pt.f is None or pt.tau < st['tauMin'] or pt.tau > length - 30: return None
    best = None
    for side, fs in ((1, pt.f), (0, 1 - pt.f)):
        if want is not None and side != want: continue
        a = ask_of(pt, side); ed = fs - a - fee(a)
        if st['pmin'] <= a <= st['pmax'] and st['minEdge'] <= ed <= MAX_EDGE and (best is None or ed > best[3]): best = (side, fs, a, ed)
    if not best: return None
    side, fs, a, _ = best
    mid_side = pt.mid if side else 1 - pt.mid
    if fs - mid_side > MAX_GAP: return None
    pu = p_up(pt); ps = pu if side else 1 - pu
    if ps - a - fee(a) < BLEND_EDGE: return None
    return side, a

def lag_dir(prev, pt):
    if prev is None or pt.f is None or prev.f is None: return None
    dF, dM = pt.f - prev.f, pt.mid - prev.mid
    if dF >= 0.06 and dM <= dF / 2: return 1
    if dF <= -0.06 and dM >= dF / 2: return 0
    return None

def run_taker(pts, st, length, won_up):
    """All bets one strategy makes in one window: list of (entry point, price, pnl, how it ended)."""
    bets, i, n = [], 0, len(pts)
    while i < n:
        pt = pts[i]
        want = None
        if st.get('lag'):
            want = lag_dir(pts[i - 1] if i else None, pt)
            if want is None: i += 1; continue
        e = taker_entry(pt, st, length, want)
        if not e: i += 1; continue
        side, a = e
        cost = a + fee(a)
        tp = min(0.99, round(a * 2, 4)) if a < st['tpBelow'] else None
        exit_px, exit_fee, how, j = None, 0.0, 'held', i + 1
        while j < n:
            q = pts[j]; bs = bid_of(q, side)
            if tp is not None and bs >= tp: exit_px, how = tp, '2x'; break
            if st['exitAbove'] is not None and q.f is not None and q.tau >= 20:
                pu = p_up(q); fsd = pu if side else 1 - pu
                if st.get('makerExit'):
                    target = min(0.99, fsd + st['exitAbove'])
                    if bs >= target: exit_px, how = target, 'resting sell'; break
                elif bs >= fsd + fee(bs) + st['exitAbove']:
                    exit_px, exit_fee, how = bs, fee(bs), 'sold early'; break
            j += 1
        if exit_px is None:
            pnl = (1.0 if won_up == side else 0.0) - cost
            bets.append((pt, a, pnl, how, won_up == side)); break
        pnl = exit_px - exit_fee - cost
        bets.append((pt, a, pnl, how, pnl > 0))
        if pnl < 0: break                       # lostIn: a loss closes the window for this strategy
        i = j + 1                               # after a winning sell, it may buy back in later
    return bets

def maker_pick(pt, length, up1):
    if pt.f is None or pt.tau < EARLY or pt.tau > length - 30: return None
    pu = p_up(pt); spread = pt.up + pt.dn - 1
    best = None
    for side, fs in ((1, pt.f), (0, 1 - pt.f)):
        price = bid_of(pt, side)
        if up1 and spread >= 0.02 - 1e-9: price = round(price + 0.01, 4)
        ps = pu if side else 1 - pu
        mid_side = pt.mid if side else 1 - pt.mid
        if not (0.05 <= price <= 0.90) or fs - price > MAX_EDGE or fs - mid_side > MAX_GAP: continue
        if ps - price >= 0.03 and (best is None or ps - price > best[2]): best = (side, price, ps - price)
    return best

def filled(q, side, price, rule):
    if rule == 'through': return ask_of(q, side) <= price + 1e-9
    return ask_of(q, side) <= price + 1e-9 or bid_of(q, side) < price - 1e-9      # 'touch'

def run_maker(pts, length, won_up, rule, up1=False):
    """m_fair / m_fair_up1: at most one fill per window, held to the result."""
    order = None
    for k, pt in enumerate(pts):
        if order:
            side, price, at = order
            if rule == 'instant' or filled(pt, side, price, rule):
                return [(at, price, (1.0 if won_up == side else 0.0) - price, 'filled', won_up == side)]
        pick = maker_pick(pt, length, up1)
        order = (pick[0], pick[1], pt) if pick else None
        if order and rule == 'instant':
            side, price, at = order
            return [(at, price, (1.0 if won_up == side else 0.0) - price, 'filled', won_up == side)]
    return []

def run_both(pts, length, won_up, rule):
    """m_both: a bid on each side at every early point until that side fills; held to the result."""
    out, orders, done = [], {}, set()
    for pt in pts:
        for side, (price, at) in list(orders.items()):
            if side not in done and (rule == 'instant' or filled(pt, side, price, rule)):
                out.append((at, price, (1.0 if won_up == side else 0.0) - price, 'filled', won_up == side)); done.add(side)
        orders = {}
        if pt.tau >= EARLY and pt.tau <= length - 30:
            for side in (1, 0):
                price = bid_of(pt, side)
                if side not in done and 0.05 <= price <= 0.95: orders[side] = (price, pt)
        if rule == 'instant':
            for side, (price, at) in orders.items():
                out.append((at, price, (1.0 if won_up == side else 0.0) - price, 'filled', won_up == side)); done.add(side)
            orders = {}
    return out

def score(rows, split=None):
    """rows: dicts with hr, real, price, pnl, won. Per contract, t clustered by hour, both halves."""
    if not rows: return None
    n = len(rows); tot = sum(r['pnl'] for r in rows); m = tot / n
    g = {}
    for r in rows:
        a = g.setdefault(r['hr'], [0.0, 0]); a[0] += r['pnl']; a[1] += 1
    G = len(g)
    se = math.sqrt(G / (G - 1) * sum((a[0] - m * a[1]) ** 2 for a in g.values())) / n if G >= 3 else None
    out = {'n': n, 'pnl_per_contract': m, 't': (m / se) if se else None, 'win_rate': sum(1 for r in rows if r['won']) / n,
           'avg_price': sum(r['price'] for r in rows) / n, 'total': tot, 'per_dollar': tot / sum(r['price'] for r in rows), 'hours': G}
    if split is not None:
        h1 = [r['pnl'] for r in rows if r['real'] < split]; h2 = [r['pnl'] for r in rows if r['real'] >= split]
        out['first_half'] = sum(h1) / len(h1) if h1 else None
        out['second_half'] = sum(h2) / len(h2) if h2 else None
        out['n_halves'] = [len(h1), len(h2)]
    return out

def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fr.CACHE.mkdir(exist_ok=True)
    wins = fr.windows(days)
    info = pv.load_markets()
    pv.fetch_missing(wins, info)
    todo = [w for w in wins if fr.slug(w[0], w[1]) in info and info[fr.slug(w[0], w[1])]['strike']]
    hists = {fr.slug(*w[:2]): fr.history(*w) for w in todo}
    px = pv.Prices(pv.coinbase(wins[0][1] - 3 * 3600, wins[-1][2] + 60))
    offs = pv.offsets(info, px)
    split = (wins[0][1] + wins[-1][2]) // 2
    print(f'{days} days: {len(wins)} windows, {len(todo)} resolved with a start price, '
          f'{sum(1 for w in todo if hists[fr.slug(*w[:2])])} with price history, {len(px.t)} Coinbase minutes')
    rows = {k: [] for k in list(STRATS) + [f'{m}:{r}' for m in ('m_fair', 'm_fair_up1', 'm_both') for r in ('through', 'touch', 'instant')]}
    exits = {k: {} for k in STRATS}
    lag_triggers = 0
    for series, s, e in todo:
        sl = fr.slug(series, s)
        hist = hists[sl]
        if not hist: continue
        pts = points(hist, e, info[sl]['strike'], px, offs)
        if not pts: continue
        won_up, length = info[sl]['up'], e - s
        for k in range(1, len(pts)):
            if pts[k].tau >= EARLY and lag_dir(pts[k - 1], pts[k]) is not None: lag_triggers += 1
        def add(key, bets):
            for at, price, pnl, how, won in bets:
                rows[key].append({'series': series, 'hr': at.real // 3600, 'real': at.real, 'tau': at.tau, 'price': price, 'pnl': pnl, 'won': won, 'how': how})
        for name, st in STRATS.items():
            b = run_taker(pts, st, length, won_up)
            add(name, b)
            for x in b: exits[name][x[3]] = exits[name].get(x[3], 0) + 1
        for rule in ('through', 'touch', 'instant'):
            add(f'm_fair:{rule}', run_maker(pts, length, won_up, rule))
            add(f'm_fair_up1:{rule}', run_maker(pts, length, won_up, rule, up1=True))
            add(f'm_both:{rule}', run_both(pts, length, won_up, rule))
    out = {'days': days, 'windows': len(wins), 'resolved': len(todo), 'split': split, 'lag_minute_triggers_early': lag_triggers, 'results': {}}
    for key, rs in rows.items():
        res = {'all': score(rs, split), 'series': {sr: score([r for r in rs if r['series'] == sr], split) for sr in ('5m', '15m', '1h')}}
        if key in exits: res['exits'] = exits[key]
        out['results'][key] = res
    Path('strategy_replay_result.json').write_text(json.dumps(out, indent=1, default=str))
    fmt = lambda v, d=3: '   —  ' if v is None else f'{v:+.{d}f}'
    print(f'lag proxy triggers with 4+ min left: {lag_triggers}')
    for key, res in out['results'].items():
        a = res['all']
        if not a: print(f'{key:22s} no bets'); continue
        print(f"{key:22s} n {a['n']:5d} won {a['win_rate']:.3f} at {a['avg_price']:.3f}  {fmt(a['pnl_per_contract'])}/contract  t {fmt(a['t'], 2)}  "
              f"halves {fmt(a['first_half'])} {fmt(a['second_half'])}  {res.get('exits', '')}")
        for sr, v in res['series'].items():
            if v: print(f"    {sr:4s} n {v['n']:5d} won {v['win_rate']:.3f} at {v['avg_price']:.3f}  {fmt(v['pnl_per_contract'])}/contract  t {fmt(v['t'], 2)}")

if __name__ == '__main__':
    main()
