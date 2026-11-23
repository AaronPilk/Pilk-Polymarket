#!/usr/bin/env python3
"""Replay "price vs math" on Polymarket's own price history.

For every 5m / 15m / 1h Bitcoin window in the last N days it rebuilds what the bot's math said at each
minute with 4+ minutes left: fairUp (src/cryptomath.ts) on Coinbase one-minute prices lined up onto the
official index by the offset at each window start, with volatility blended from the last 15, 60 and 120
minutes like the bot (no hour-of-day profile, scale 1). Then it applies crypto_hold_v1's entry rule
(src/crypto.ts): the side where the math beats the ask by at least 5 cents after the fee, priced 5-90
cents, edge under 30 cents, math no more than 15 cents over the market's mid, and the 50/50 blend clearing
the price plus fee by a cent. It takes the first such moment in each window and holds the bet to the
official result. P&L is per contract with the exact taker fee (0.095 x p x (1 - p)).

Also: the same rule under the early band's fitted blend (no math weight, the market shrunk toward 50/50),
a no-math baseline (the cheaper side at 15-40 cents), and breakdowns by price, time left, series, hour of
day and week. Prices are one point a minute, so entries are coarser than the live bot's.

Run: python3 scripts/pvm_replay.py [days]
"""
import bisect, datetime as dt, json, math, statistics, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fav_replay as fr

GW, COEF, SHIFT = fr.GW, fr.COEF, fr.SHIFT
EARLY = 240                       # bandOf: 4+ minutes left
MIN_EDGE, MAX_EDGE, MAX_GAP, BLEND_EDGE = 0.05, 0.30, 0.15, 0.01
PRICE_MIN, PRICE_MAX = 0.05, 0.90
FIT_C = 0.93                      # the early band's fitted blend on Nov 23 (a 0, b 0, c ~0.93)
ET = dt.timezone(dt.timedelta(hours=-5))

def fee(p): return COEF * p * (1 - p)
def norm_cdf(x):
    t = 1 / (1 + 0.3275911 * abs(x) / math.sqrt(2))
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * math.exp(-(x * x) / 2)
    return (1 + y) / 2 if x >= 0 else (1 - y) / 2
def logit(p):
    q = min(0.99, max(0.01, p)); return math.log(q / (1 - q))
def sigmoid(x): return 1 / (1 + math.exp(-x))
def fair_up(spot, strike, sigma, tau):          # tau >= 60 here, so no end-of-window average term
    if not (spot > 0 and strike > 0 and sigma > 0) or tau <= 0: return None
    var = sigma * sigma * (tau - 40)
    return norm_cdf((math.log(spot) - math.log(strike)) / math.sqrt(var)) if var > 0 else float(spot >= strike)
def blend(b, c, math_p, mkt_p): return sigmoid(b * logit(math_p) + c * logit(mkt_p))
def iso(t): return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def load_markets():
    info = {}
    for f in fr.CACHE.glob('markets-*.json'):
        for m in (json.loads(f.read_text()) or {}).get('markets', []):
            prices = json.loads(m.get('outcomePrices') or '[]')
            li = next((k for k, x in enumerate(m.get('marketSides') or []) if x.get('long')), 0)
            if m.get('status') != 'MARKET_STATUS_RESOLVED' or len(prices) <= li or prices[li] not in ('0', '1'): continue
            apt = m.get('assetPriceTerms') or {}
            try: strike = float((apt.get('priceToBeat') or {}).get('value'))
            except (TypeError, ValueError): strike = None
            info[m['slug']] = {'up': int(prices[li]), 'strike': strike}
    return info

def fetch_missing(wins, info):
    miss = [w for w in wins if fr.slug(w[0], w[1]) not in info]
    for i in range(0, len(miss), 20):
        batch = miss[i:i + 20]
        name = 'markets-' + fr.slug(*batch[0][:2]) + '-' + str(len(batch))
        url = f'{GW}/markets?' + '&'.join('slug=' + fr.slug(s, t) for s, t, _ in batch) + f'&limit={len(batch)}'
        j = fr.get(url) if batch[-1][2] > time.time() - 900 else fr.cached(name, lambda: fr.get(url))
        for m in (j or {}).get('markets', []):
            prices = json.loads(m.get('outcomePrices') or '[]')
            li = next((k for k, x in enumerate(m.get('marketSides') or []) if x.get('long')), 0)
            if m.get('status') == 'MARKET_STATUS_RESOLVED' and len(prices) > li and prices[li] in ('0', '1'):
                apt = m.get('assetPriceTerms') or {}
                try: strike = float((apt.get('priceToBeat') or {}).get('value'))
                except (TypeError, ValueError): strike = None
                info[m['slug']] = {'up': int(prices[li]), 'strike': strike}

def coinbase(t0, t1):
    """time of minute start -> close (the price at the end of that minute)."""
    out, step, t = {}, 299 * 60, t0 - t0 % 60
    while t < t1:
        a, b = t, min(t + step, t1)
        url = f'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start={iso(a)}&end={iso(b)}'
        j = fr.get(url) if b > time.time() - 600 else fr.cached(f'cb-{a}-{b}', lambda: fr.get(url))
        for row in j or []:
            if isinstance(row, list) and len(row) >= 5: out[int(row[0])] = float(row[4])
        t = b
    return out

class Prices:
    def __init__(self, closes):
        self.t = sorted(closes); self.p = [closes[k] for k in self.t]
        self.idx = {k: i for i, k in enumerate(self.t)}
        self.r2 = [0.0] + [math.log(self.p[i] / self.p[i - 1]) ** 2 if self.t[i] - self.t[i - 1] == 60 else 0.0 for i in range(1, len(self.p))]
        self.cum = [0.0]
        for x in self.r2: self.cum.append(self.cum[-1] + x)
    def at(self, real):                          # price at real time `real` (close of the minute before)
        i = self.idx.get(real - 60)
        return self.p[i] if i is not None else None
    def sigma(self, real):                       # per sqrt(second): 0.5 x 15m + 0.3 x 60m + 0.2 x 120m variance
        i = self.idx.get(real - 60)
        if i is None: return None
        def s(mins):
            j = max(1, i - mins + 1)
            n = i - j + 1
            return (self.cum[i + 1] - self.cum[j]) / (n * 60) if n >= mins * 0.8 else None
        v15, v60, v120 = s(15), s(60), s(120)
        if v15 is None: return None
        sm, wt = 0.5 * v15, 0.5
        if v60 is not None: sm += 0.3 * v60; wt += 0.3
        if v120 is not None: sm += 0.2 * v120; wt += 0.2
        return math.sqrt(sm / wt)

def offsets(info, px):
    """The index minus Coinbase at each 5m window start (the official start price is the index averaged
    over the minute before), as a sorted list for a rolling one-hour median."""
    pts = []
    for sl, v in info.items():
        if '-5m-' not in sl or not v['strike']: continue
        start = int(dt.datetime.strptime(sl[-16:-1], '%Y-%m-%d-%H%M').replace(tzinfo=dt.timezone.utc).timestamp())
        a, b = px.at(start - 60), px.at(start)
        if a and b: pts.append((start, v['strike'] - (a + b) / 2))
    pts.sort()
    return pts

def offset_at(pts, real):
    i = bisect.bisect_right(pts, (real, float('inf')))
    win = [o for s, o in pts[max(0, i - 12):i] if real - s <= 3600]
    return statistics.median(win) if win else 0.0

def entry(hist, e, length, strike, px, offs, rule):
    for h in sorted(hist, key=lambda x: x.get('timestamp') or 0):
        real = (h.get('timestamp') or 0) + SHIFT
        tau = e - real
        if tau < EARLY or tau > length - 30: continue
        up, dn = h.get('longPrice'), h.get('shortPrice')
        if up is None or dn is None: continue
        up, dn = float(up), float(dn)
        mid_up = (up + (1 - dn)) / 2
        if rule == 'cheap':                      # no math: the cheaper side at 15-40 cents
            side, a = (1, up) if up <= dn else (0, dn)
            if 0.15 <= a <= 0.40: return side, a, tau, real, None, None
            continue
        spot, sig = px.at(real), px.sigma(real)
        if spot is None or sig is None: continue
        f = fair_up(spot + offset_at(offs, real), strike, sig, tau)
        if f is None: continue
        best = None
        for side, fs, a in ((1, f, up), (0, 1 - f, dn)):
            ed = fs - a - fee(a)
            if PRICE_MIN <= a <= PRICE_MAX and MIN_EDGE <= ed <= MAX_EDGE and (best is None or ed > best[3]): best = (side, fs, a, ed)
        if not best: continue
        side, fs, a, _ = best
        mid_side = mid_up if side else 1 - mid_up
        if fs - mid_side > MAX_GAP: continue
        p_up = blend(0.5, 0.5, f, mid_up) if rule == 'start' else blend(0.0, FIT_C, f, mid_up)
        ps = p_up if side else 1 - p_up
        if ps - a - fee(a) < BLEND_EDGE: continue
        return side, a, tau, real, fs, mid_side
    return None

def score(rows):
    """rows: dicts with hr, price, won. fav_replay's scoring: per contract, per dollar, t by hour."""
    return fr.score([(r['hr'], r['price'], r['won']) for r in rows])

def bucket(rows, key):
    out = {}
    for r in rows: out.setdefault(key(r), []).append(r)
    return {k: score(v) for k, v in sorted(out.items())}

def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fr.CACHE.mkdir(exist_ok=True)
    wins = fr.windows(days)
    info = load_markets()
    fetch_missing(wins, info)
    todo = [w for w in wins if fr.slug(w[0], w[1]) in info and info[fr.slug(w[0], w[1])]['strike']]
    hists = {fr.slug(*w[:2]): fr.history(*w) for w in todo}
    px = Prices(coinbase(wins[0][1] - 3 * 3600, wins[-1][2] + 60))
    offs = offsets(info, px)
    print(f'{days} days: {len(wins)} windows, {len(todo)} resolved with a start price, '
          f'{sum(1 for w in todo if hists[fr.slug(*w[:2])])} with price history; {len(px.t)} Coinbase minutes; '
          f'index minus Coinbase median {statistics.median([o for _, o in offs]):.2f}')
    out = {'days': days, 'windows': len(wins), 'rules': {}}
    for rule in ('start', 'fit', 'cheap'):
        rows = []
        for series, s, e in todo:
            sl = fr.slug(series, s)
            r = entry(hists[sl], e, e - s, info[sl]['strike'], px, offs, rule)
            if not r: continue
            side, a, tau, real, fs, mid_side = r
            won = info[sl]['up'] == side
            rows.append({'slug': sl, 'series': series, 'side': side, 'price': a, 'tau': tau, 'real': real, 'hr': real // 3600,
                         'won': won, 'math': fs, 'mid': mid_side, 'pnl': (1 - a if won else -a) - fee(a)})
        et = lambda r: dt.datetime.fromtimestamp(r['real'], ET)
        def hour_band(r):
            h = et(r).hour + et(r).minute / 60
            return '1 night 0-6' if h < 6 else '2 early 6-9:30' if h < 9.5 else '3 US open 9:30-12' if h < 12 else '4 midday 12-16' if h < 16 else '5 evening 16-24'
        res = {
            'all': score(rows),
            'series': bucket(rows, lambda r: r['series']),
            'price': bucket(rows, lambda r: '05-20c' if r['price'] < 0.2 else '20-30c' if r['price'] < 0.3 else '30-40c' if r['price'] < 0.4 else '40-50c' if r['price'] < 0.5 else '50-90c'),
            'time_left': bucket(rows, lambda r: '4-6 min' if r['tau'] < 360 else '6-10 min' if r['tau'] < 600 else '10+ min'),
            'hour_et': bucket(rows, hour_band),
            'week': bucket(rows, lambda r: et(r).strftime('%m-%d') if False else f"wk {et(r).isocalendar()[1]}"),
            'since_live_run': score([r for r in rows if r['real'] >= 1795404000]),
        }
        if rule != 'cheap' and rows:
            res['calibration'] = {'won': sum(r['won'] for r in rows) / len(rows), 'math_said': sum(r['math'] for r in rows) / len(rows),
                                  'market_mid': sum(r['mid'] for r in rows) / len(rows), 'avg_price': sum(r['price'] for r in rows) / len(rows)}
        out['rules'][rule] = res
        out[f'{rule}_bets'] = [{k: r[k] for k in ('slug', 'side', 'price', 'tau', 'won')} for r in rows]
    Path('pvm_replay_result.json').write_text(json.dumps(out, indent=1, default=str))
    fmt = lambda v, d=3: '—' if v is None else f'{v:+.{d}f}'
    for rule, res in out['rules'].items():
        print(f"\n== {rule}")
        for name, block in res.items():
            if name == 'calibration': print('  calibration', {k: round(v, 3) for k, v in block.items()}); continue
            items = [('', block)] if (block is None or 'n' in block) else list(block.items())
            for k, v in items:
                if not v: continue
                print(f"  {name:14s} {k:18s} n {v['n']:5d} won {v['win_rate']:.3f} at {v['avg_price']:.3f}  "
                      f"{fmt(v['pnl_per_contract'])}/contract {fmt(v['per_dollar'])}/$ t {fmt(v['t'], 2)} hrs {v['hours']}")

if __name__ == '__main__':
    main()
