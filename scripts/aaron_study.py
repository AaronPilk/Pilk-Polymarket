#!/usr/bin/env python3
"""Aaron's own moneyline bets, studied lot by lot (Nov 24).

Input: a pipe-separated export of his activities (TRADE and POSITION_RESOLUTION rows, aec-* moneylines):
  t|kind|mkt|title|price|qty|cost|fee|pnl|payout   kind = b (bought), s (sold), Rw / Rl (settled won / lost)
Buy cost includes the fee, sell "cost" is the net proceeds after the fee, settlement pays $1 a share with no fee.
The pnl and payout columns are not used: older rows count fees in pnl, newer ones don't.

Every buy is a lot. Sells close the oldest open lots in that market and side first (FIFO), and settlement
closes what is left. For each lot:
  P&L          what it really made, fees in
  if held      what the same shares would have made held to the end (when the result is known)
  peak after   the best bid his side reached after he sold (gateway minute book, each point = end of minute)

Market sides, results and price history come from the public gateway and are cached in .replay-cache/.
The export holds his own trades, so it stays out of git (pass its path).

Run: python3 scripts/aaron_study.py /home/claude/aaron-study/trades.psv [--json out.json]
"""
import collections, datetime as dt, json, re, sys
from pathlib import Path

import fav_replay as fr

GW = fr.GW
SHIFT = 60
BUCKETS = [(0, .03), (.03, .07), (.07, .12), (.12, .20), (.20, .30), (.30, .45), (.45, .60), (.60, 1.01)]
SIZES = [(0, 5), (5, 15), (15, 35), (35, 75), (75, 1e9)]

def num(x): return float(x) if x not in ('', 'None', None) else None
def ts(s): return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())

def load(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        if not line.strip(): continue
        t, kind, mkt, title, price, qty, cost, fee, _pnl, _payout = line.split('|')
        rows.append(dict(t=int(t), kind=kind, mkt=mkt, title=title, price=num(price), qty=num(qty), cost=num(cost), fee=num(fee)))
    return rows

def markets(slugs):
    out = {}
    slugs = sorted(set(slugs))
    for i in range(0, len(slugs), 20):
        batch = slugs[i:i + 20]
        j = fr.cached('aaron-mkts-' + batch[0] + '-' + str(len(batch)),
                      lambda: fr.get(f'{GW}/markets?' + '&'.join('slug=' + s for s in batch) + f'&limit={len(batch)}'))
        for m in (j or {}).get('markets', []):
            out[m['slug']] = m
    return out

def words(s): return set(w for w in re.split(r'[^a-z0-9]+', (s or '').lower()) if w and w not in ('the', 'st', 'state'))

def side_of(title, m):
    """'long' / 'short' for a trade title, matched against the market's team names."""
    best, pick = 0, None
    for sd in m.get('marketSides') or []:
        t = sd.get('team') or {}
        names = ' '.join([sd.get('description') or '', t.get('name') or '', t.get('alias') or '', t.get('safeName') or '', t.get('abbreviation') or ''])
        score = len(words(title) & words(names))
        if title and (title.lower() in names.lower()): score += 2
        if score > best: best, pick = score, ('long' if sd.get('long') else 'short')
    return pick

def result_long(m):
    prices = json.loads(m.get('outcomePrices') or '[]')
    li = next((k for k, x in enumerate(m.get('marketSides') or []) if x.get('long')), 0)
    if m.get('status') != 'MARKET_STATUS_RESOLVED' or len(prices) <= li or prices[li] not in ('0', '1'): return None
    return int(prices[li])

def history(slug, start, end):
    j = fr.cached(f'aaron-hist-{slug}', lambda: fr.get(f'{GW}/price-history?symbol={slug}&timestamp.startTimestamp={start}&timestamp.endTimestamp={end}&fidelity=1'))
    pts = []
    for h in (j or {}).get('history') or []:
        la, sa = h.get('longPrice'), h.get('shortPrice')
        if la is None or sa is None: continue
        la, sa = float(la), float(sa)
        if 0 < la < 1 and 0 < sa < 1 and la + sa < 1.15:
            pts.append(((h.get('timestamp') or 0) + SHIFT, la, sa))
    return sorted(pts)

def bucket(x, edges):
    for lo, hi in edges:
        if lo <= x < hi: return (lo, hi)
    return edges[-1]

def build_lots(rows, info):
    lots, open_ = [], collections.defaultdict(list)   # (mkt, side) -> open lots
    for r in sorted(rows, key=lambda r: r['t']):
        m = info.get(r['mkt']) or {}
        if r['kind'] == 'b':
            side = side_of(r['title'], m) or r['title']
            lot = dict(mkt=r['mkt'], league=r['mkt'].split('-')[1], title=r['title'], side=side, t=r['t'], price=r['price'],
                       shares=r['qty'] or 0.0, left=r['qty'] or 0.0, cost=r['cost'] or 0.0, proceeds=0.0, sold=0.0, settled=0.0,
                       exits=[], won=None)
            lots.append(lot); open_[(r['mkt'], side)].append(lot)
        elif r['kind'] == 's':
            side = side_of(r['title'], m) or r['title']
            q, net = r['qty'] or 0.0, r['cost'] or 0.0
            for lot in open_[(r['mkt'], side)]:
                if q <= 1e-9: break
                if lot['left'] <= 1e-9: continue
                take = min(lot['left'], q)
                lot['left'] -= take; q -= take
                lot['proceeds'] += net * take / (r['qty'] or 1); lot['sold'] += take
                lot['exits'].append(('sold', r['t'], r['price'], take))
        else:   # settlement: closes whatever is still open in this market
            won = r['kind'] == 'Rw'
            for (mk, side), ls in open_.items():
                if mk != r['mkt']: continue
                for lot in ls:
                    if lot['left'] <= 1e-9: continue
                    lot['proceeds'] += lot['left'] * (1.0 if won else 0.0); lot['settled'] += lot['left']
                    lot['exits'].append(('won' if won else 'lost', r['t'], 1.0 if won else 0.0, lot['left']))
                    lot['won'] = won; lot['left'] = 0.0
    return lots

def main():
    path = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
    if not path: raise SystemExit(__doc__)
    out_json = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
    rows = load(path)
    info = markets(r['mkt'] for r in rows)
    lots = build_lots(rows, info)

    # Which side won each market: the gateway result, else his own settlements.
    res = {}
    for slug, m in info.items():
        rl = result_long(m)
        if rl is not None: res[slug] = rl
    for lot in lots:
        if lot['won'] is not None and lot['mkt'] not in res and lot['side'] in ('long', 'short'):
            res[lot['mkt']] = int(lot['won']) if lot['side'] == 'long' else 1 - int(lot['won'])

    hists = {}
    for slug in set(l['mkt'] for l in lots):
        m = info.get(slug) or {}
        t0 = min(l['t'] for l in lots if l['mkt'] == slug)
        gs = ts(m['gameStartTime']) if m.get('gameStartTime') else t0
        hists[slug] = history(slug, min(gs, t0) - 1800, max(gs, t0) + 5 * 3600)

    closed = []
    for lot in lots:
        if lot['left'] > 1e-6 and lot['settled'] == 0 and lot['sold'] < lot['shares'] - 1e-6:
            lot['status'] = 'open'
            continue
        lot['pnl'] = lot['proceeds'] - lot['cost']
        lot['kind'] = 'held' if lot['sold'] <= 1e-9 else ('sold' if lot['settled'] <= 1e-9 else 'mixed')
        m = info.get(lot['mkt']) or {}
        r = res.get(lot['mkt'])
        lot['side_won'] = None if r is None or lot['side'] not in ('long', 'short') else (r if lot['side'] == 'long' else 1 - r)
        lot['held_pnl'] = None if lot['side_won'] is None else lot['shares'] * lot['side_won'] - lot['cost']
        gs = ts(m['gameStartTime']) if m.get('gameStartTime') else None
        lot['min_in'] = None if gs is None else round((lot['t'] - gs) / 60)
        # best bid his side reached after his last sell, and the lowest
        lot['peak_after'] = lot['low_after'] = None
        sells = [e for e in lot['exits'] if e[0] == 'sold']
        if sells and lot['side'] in ('long', 'short'):
            t_sell = max(e[1] for e in sells)
            bids = [(1 - sa) if lot['side'] == 'long' else (1 - la) for (t, la, sa) in hists.get(lot['mkt'], []) if t > t_sell]
            if bids:
                lot['peak_after'], lot['low_after'] = max(bids), min(bids)
            lot['sell_price'] = sum(e[2] * e[3] for e in sells) / max(1e-9, sum(e[3] for e in sells))
        # house money: bought after a profitable sell earlier in the same game
        lot['reentry'] = any(o is not lot and o['mkt'] == lot['mkt'] and o['t'] < lot['t'] and o.get('pnl', 0) > 0 and o['sold'] > 0
                             and max(e[1] for e in o['exits'] if e[0] == 'sold') < lot['t'] for o in closed)
        lot['status'] = 'closed'
        closed.append(lot)

    def table(title, key, order=None):
        g = collections.OrderedDict()
        for k in (order or []): g[k] = []
        for l in closed: g.setdefault(key(l), []).append(l)
        print(f'\n{title}')
        print(f"  {'group':<18}{'lots':>5}{'staked':>9}{'P&L':>9}{'per $':>8}{'won':>6}{'sold':>6}{'held':>6}  {'if held':>9}{'held n':>7}")
        for k, ls in g.items():
            if not ls: continue
            st, pn = sum(l['cost'] for l in ls), sum(l['pnl'] for l in ls)
            hk = [l for l in ls if l['held_pnl'] is not None]
            hp = sum(l['held_pnl'] for l in hk)
            print(f"  {str(k):<18}{len(ls):>5}{st:>9.2f}{pn:>9.2f}{(pn / st if st else 0):>8.1%}{sum(l['pnl'] > 0 for l in ls):>6}"
                  f"{sum(l['kind'] != 'held' for l in ls):>6}{sum(l['kind'] == 'held' for l in ls):>6}  {hp:>9.2f}{len(hk):>7}")

    print(f'{len(rows)} rows, {len(lots)} lots ({len(closed)} closed, {sum(l["status"] == "open" for l in lots)} open), '
          f'{len(info)} markets found on the gateway, {len(res)} with a known result')
    unmatched = sorted(set((l['mkt'], l['title']) for l in lots if l['side'] not in ('long', 'short')))
    if unmatched: print('side not matched:', unmatched)
    tot_c, tot_p = sum(l['cost'] for l in closed), sum(l['pnl'] for l in closed)
    print(f'closed lots: staked ${tot_c:.2f}, P&L ${tot_p:+.2f} ({tot_p / tot_c:+.1%} a dollar)')

    fmt = lambda b: f'{b[0] * 100:.0f}-{b[1] * 100:.0f}c' if b[1] <= 1 else f'{b[0] * 100:.0f}c+'
    table('By entry price', lambda l: fmt(bucket(l['price'] or 0, BUCKETS)), [fmt(b) for b in BUCKETS])
    table('By how it ended', lambda l: l['kind'], ['sold', 'held', 'mixed'])
    table('By league', lambda l: l['league'])
    table('By bet size', lambda l: (lambda b: f'${b[0]:.0f}-{b[1]:.0f}' if b[1] < 1e8 else f'${b[0]:.0f}+')(bucket(l['cost'], SIZES)),
          [(lambda b: f'${b[0]:.0f}-{b[1]:.0f}' if b[1] < 1e8 else f'${b[0]:.0f}+')(b) for b in SIZES])
    table('Basketball only, by entry price', lambda l: fmt(bucket(l['price'] or 0, BUCKETS)) if l['league'] in ('nba', 'cbb') else None,
          [fmt(b) for b in BUCKETS])
    table('Re-entry after a winning sell in the same game', lambda l: 'reentry' if l['reentry'] else 'first entries', ['first entries', 'reentry'])

    print('\nSold lots: what selling did against holding to the end (result known)')
    sold = [l for l in closed if l['kind'] == 'sold' and l['held_pnl'] is not None]
    better = [l for l in sold if l['pnl'] > l['held_pnl'] + 1e-9]
    print(f"  {len(sold)} sold lots, selling beat holding on {len(better)}; P&L sold ${sum(l['pnl'] for l in sold):+.2f} vs held ${sum(l['held_pnl'] for l in sold):+.2f}")
    for lo, hi in [(0, .12), (.12, .30), (.30, 1.01)]:
        s = [l for l in sold if lo <= (l['price'] or 0) < hi]
        if s: print(f"    entry {lo * 100:.0f}-{min(hi, 1) * 100:.0f}c: {len(s)} lots, sold ${sum(l['pnl'] for l in s):+.2f} vs held ${sum(l['held_pnl'] for l in s):+.2f}, held-to-end winners {sum(l['side_won'] == 1 for l in s)}")
    pk = [l for l in closed if l.get('peak_after') is not None and l.get('sell_price')]
    if pk:
        mult = sorted(l['peak_after'] / l['sell_price'] for l in pk)
        print(f"  after his sells ({len(pk)} with prices): the price went higher later on {sum(l['peak_after'] > l['sell_price'] + .02 for l in pk)}, "
              f"median best-later / sold = {mult[len(mult) // 2]:.2f}x; it went to 0-5c on {sum(l['low_after'] <= .05 for l in pk)}")

    print('\nEvery basketball lot (newest last):')
    for l in closed:
        if l['league'] not in ('nba', 'cbb'): continue
        when = dt.datetime.fromtimestamp(l['t'], dt.timezone(dt.timedelta(hours=-5))).strftime('%m-%d %H:%M')
        held = '' if l['held_pnl'] is None else f" held {l['held_pnl']:+7.2f}"
        after = '' if l.get('peak_after') is None else f" later {l['low_after']:.2f}-{l['peak_after']:.2f}"
        mins = '' if l['min_in'] is None else f" min {l['min_in']}"
        print(f"  {when} {l['mkt'][4:]:<26} {l['title'][:16]:<16} {l['price']:.3f} ${l['cost']:>6.2f} {l['kind']:<5} P&L {l['pnl']:+7.2f}{held}{after}{mins}")
    if out_json:
        Path(out_json).write_text(json.dumps([{k: v for k, v in l.items() if k != 'exits'} | {'exits': l['exits']} for l in lots], default=str))

if __name__ == '__main__':
    main()
