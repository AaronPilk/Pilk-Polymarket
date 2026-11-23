#!/usr/bin/env python3
"""Replay the late-favorite rule on past Polymarket US Bitcoin Up/Down windows.

For every 5m / 15m / 1h window in the last N days it pulls the official result (gateway markets) and
the book-derived price history (gateway price-history, no auth, one market per request), then asks:
in a given stretch of time left, the first time one side was priced in a given range, what happened if
you bought that side and held it to the result? P&L is per contract with the exact taker fee
(0.095 x p x (1 - p)). Responses are cached in .replay-cache/, so a rerun picks up where it left off.

Run: python3 scripts/fav_replay.py [days] [--sample N]
"""
import concurrent.futures as cf, datetime as dt, json, math, os, sys, threading, time, urllib.request
from pathlib import Path

GW = 'https://gateway.polymarket.us/v1'
UA = {'User-Agent': 'pilk-bets-replay/1.0'}
CACHE = Path(__file__).resolve().parent.parent / '.replay-cache'
COEF = 0.095
# Each price-history point shows the book at the END of its one-minute bucket, not at its timestamp:
# checked Nov 23 against the bot's own 30-second marks (the point stamped 2:00 left matched the bot's
# 1:00-left quote, and the 1:00-left point was already the closing 99/1). So a point's real time left
# is its stamped time left minus 60 s, and points at or after the close are dropped.
SHIFT = 60
SERIES = (('5m', 300), ('15m', 900), ('1h', 3600))
# The live tests (crypto_fav_late, crypto_fav_last) and the grid around them.
ARMS = {'fav_late 90-120s 95-98c': (90, 120, 0.95, 0.98), 'fav_last 30-90s 95-98c': (30, 90, 0.95, 0.98)}
TAU_BANDS = [(180, 180), (120, 120), (60, 60)]   # with one-minute points, the moments that exist
PRICE_BANDS = [(0.80, 0.90), (0.90, 0.95), (0.95, 0.98), (0.98, 0.995)]

_lock, _last = threading.Lock(), [0.0]
def get(url, tries=5):
    for i in range(tries):
        with _lock:   # at most ~14 requests a second (the public limit is 20)
            wait = _last[0] + 0.07 - time.time()
            if wait > 0: time.sleep(wait)
            _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            time.sleep(2 * (i + 1) if e.code == 429 else 1 + i)
        except Exception:
            time.sleep(1 + i)
    return None

def slug(series, t):
    return f"cpc-btc-updown-{series}-{dt.datetime.fromtimestamp(t, dt.timezone.utc):%Y-%m-%d-%H%M}z"

def cached(name, fetch):
    p = CACHE / f'{name}.json'
    if p.exists(): return json.loads(p.read_text())
    v = fetch()
    if v is not None: p.write_text(json.dumps(v))
    return v

def windows(days):
    end = int(time.time()) // 300 * 300 - 600
    start = end - days * 86400
    out = []
    for series, length in SERIES:
        t = (start // length + 1) * length
        while t + length <= end:
            out.append((series, t, t + length)); t += length
    return out

def results(wins):
    """slug -> 1 if Up won, 0 if Down, for resolved windows."""
    info = {}
    for i in range(0, len(wins), 20):
        batch = wins[i:i + 20]
        key = 'markets-' + slug(*batch[0][:2]) + '-' + str(len(batch))
        j = cached(key, lambda: get(f'{GW}/markets?' + '&'.join('slug=' + slug(s, t) for s, t, _ in batch) + f'&limit={len(batch)}'))
        for m in (j or {}).get('markets', []):
            prices = json.loads(m.get('outcomePrices') or '[]')
            li = next((k for k, x in enumerate(m.get('marketSides') or []) if x.get('long')), 0)
            if m.get('status') == 'MARKET_STATUS_RESOLVED' and len(prices) > li and prices[li] in ('0', '1'):
                info[m['slug']] = int(prices[li])
    return info

def history(series, s, e):
    sl = slug(series, s)
    j = cached('hist-' + sl, lambda: get(f'{GW}/price-history?symbol={sl}&timestamp.startTimestamp={s - 60}&timestamp.endTimestamp={e}&fidelity=1'))
    return (j or {}).get('history') or []

def first_fav(hist, e, lo, hi, pmin, pmax):
    """The first observation with lo <= time left <= hi where a side is priced in [pmin, pmax]."""
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        tau = e - (h.get('timestamp') or 0) - SHIFT
        if tau <= 0 or tau > hi or tau < lo: continue
        for side, key in ((1, 'longPrice'), (0, 'shortPrice')):
            p = h.get(key)
            if p is not None and pmin <= float(p) <= pmax:
                return side, float(p), tau
    return None

def score(bets):
    """bets: list of (hour, price, won). Per-contract P&L with the exact fee, cluster SE by hour."""
    if not bets: return None
    rows = [(hr, p, (1 - p if w else -p) - COEF * p * (1 - p)) for hr, p, w in bets]
    n, wins = len(rows), sum(1 for b in bets if b[2])
    cost = sum(p for _, p, _ in rows); pnl = sum(x for _, _, x in rows)
    def se_of(rs):
        c = sum(p for _, p, _ in rs); m = sum(x for _, _, x in rs) / c
        g = {}
        for hr, p, x in rs:
            a = g.setdefault(hr, [0.0, 0.0]); a[0] += x; a[1] += p
        G = len(g)
        if G < 3: return m, None
        ss = sum((a[0] - m * a[1]) ** 2 for a in g.values())
        return m, math.sqrt(G / (G - 1) * ss) / c
    mean, se = se_of(rows)
    avg_p = cost / n
    gm, gse = se_of(rows + [('one-more-loss', avg_p, -avg_p - COEF * avg_p * (1 - avg_p))])
    return {'n': n, 'wins': wins, 'losses': n - wins, 'win_rate': wins / n, 'avg_price': avg_p,
            'pnl_per_contract': pnl / n, 'per_dollar': mean, 'se': se, 't': mean / se if se else None,
            'worst_case_with_one_more_loss': gm - 1.64 * gse if gse else None, 'hours': len({r[0] for r in rows})}

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    days = int(args[0]) if args else 7
    sample = int(sys.argv[sys.argv.index('--sample') + 1]) if '--sample' in sys.argv else None
    CACHE.mkdir(exist_ok=True)
    wins = windows(days)
    if sample: wins = wins[-sample:]
    res = results(wins)
    todo = [w for w in wins if slug(w[0], w[1]) in res]
    with cf.ThreadPoolExecutor(8) as ex:
        hists = dict(zip([slug(w[0], w[1]) for w in todo], ex.map(lambda w: history(*w), todo)))
    have = [w for w in todo if hists[slug(w[0], w[1])]]
    print(f'{days} days: {len(wins)} windows, {len(res)} resolved, {len(have)} with price history')
    obs = sorted(len(hists[slug(w[0], w[1])]) for w in have)
    if obs: print(f'observations per window: median {obs[len(obs) // 2]}, min {obs[0]}, max {obs[-1]}')

    out = {'days': days, 'windows': len(wins), 'resolved': len(res), 'with_history': len(have), 'arms': {}, 'grid': {}}
    for name, (lo, hi, pmin, pmax) in ARMS.items():
        for series_filter in (None, '5m', '15m', '1h'):
            bets = []
            for series, s, e in have:
                if series_filter and series != series_filter: continue
                f = first_fav(hists[slug(series, s)], e, lo, hi, pmin, pmax)
                if f: bets.append((s // 3600, f[1], f[0] == res[slug(series, s)]))
            out['arms'][f'{name} {series_filter or "all"}'] = score(bets)
            if series_filter is None and bets:
                days_pnl = {}
                for hr, p, w in bets:
                    days_pnl[hr // 24] = days_pnl.get(hr // 24, 0) + (1 - p if w else -p) - COEF * p * (1 - p)
                out.setdefault('by_day', {})[name] = {'up_days': sum(1 for v in days_pnl.values() if v > 0), 'down_days': sum(1 for v in days_pnl.values() if v < 0), 'worst_day': min(days_pnl.values()), 'best_day': max(days_pnl.values())}
    for lo, hi in TAU_BANDS:
        for pmin, pmax in PRICE_BANDS:
            bets = []
            for series, s, e in have:
                f = first_fav(hists[slug(series, s)], e, lo, hi, pmin, pmax)
                if f: bets.append((s // 3600, f[1], f[0] == res[slug(series, s)]))
            out['grid'][f'{lo}-{hi}s {int(pmin * 100)}-{int(pmax * 100)}c'] = score(bets)
    Path(CACHE.parent / 'fav_replay_result.json').write_text(json.dumps(out, indent=1))
    fmt = lambda v: '-' if v is None else f'{v:+.4f}'
    for k, v in out.get('by_day', {}).items():
        print(f"  {k}: {v['up_days']} up days, {v['down_days']} down days, worst day {v['worst_day']:+.2f}, best {v['best_day']:+.2f} per contract-a-bet")
    for section in ('arms', 'grid'):
        print(f'\n{section}:')
        for k, v in out[section].items():
            if not v: print(f'  {k:34s} no bets'); continue
            print(f"  {k:34s} n {v['n']:5d}  lost {v['losses']:3d}  win {v['win_rate']:.3f} at {v['avg_price']:.3f}  "
                  f"{fmt(v['pnl_per_contract'])}/contract  {fmt(v['per_dollar'])}/$  t {fmt(v['t'])}  worst+1loss {fmt(v['worst_case_with_one_more_loss'])}")

if __name__ == '__main__':
    main()
