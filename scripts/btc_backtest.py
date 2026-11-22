#!/usr/bin/env python3
"""Grade the bot's bitcoin math on past Polymarket US Up/Down windows.

Pulls every 5m / 15m / 1h window from the last N days (Polymarket's official starting price and
result) and Coinbase 1-minute prices, then scores fairUp() at each minute of each window against
what happened, for a range of volatility scales. Run: python3 scripts/btc_backtest.py [days]

Nov 22, 2026 run (7 days, 2,853 windows, 27,305 checkpoints): the realized-volatility model is
well calibrated (said 75% -> happened 76%, 85% -> 87%), log loss 0.412 vs 0.693 for a coin flip,
and scale x1.0 fits best (x2 scores 0.453), so the market's higher implied volatility is the
overpriced side.
"""
import datetime as dt, json, math, sys, time, urllib.request

UA = {'User-Agent': 'pilk-bets-backtest/1.0'}
GRID = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.3, 2.6]

def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None

def slug(series, t):
    return f"cpc-btc-updown-{series}-{dt.datetime.fromtimestamp(t, dt.timezone.utc):%Y-%m-%d-%H%M}z"

def ncdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))

def fair(spot, k, sig, tau):  # same as fairUp() for tau >= 60 s
    var = sig * sig * (tau - 40)
    return ncdf((math.log(spot) - math.log(k)) / math.sqrt(var)) if var > 0 else float(spot >= k)

def ll(p, y):
    q = min(0.99, max(0.01, p)); return -(y * math.log(q) + (1 - y) * math.log(1 - q))

def main(days=7):
    end = int(time.time()) // 300 * 300 - 600
    start = end - days * 86400
    wins = []
    for series, length in (('5m', 300), ('15m', 900), ('1h', 3600)):
        t = (start // length + 1) * length
        while t + length <= end:
            wins.append((series, t, t + length)); t += length
    info = {}
    for i in range(0, len(wins), 20):
        batch = wins[i:i + 20]
        j = get('https://gateway.polymarket.us/v1/markets?' + '&'.join('slug=' + slug(s, t) for s, t, _ in batch) + f'&limit={len(batch)}')
        for m in (j or {}).get('markets', []):
            ptb = ((m.get('assetPriceTerms') or {}).get('priceToBeat') or {}).get('value')
            prices = json.loads(m.get('outcomePrices') or '[]')
            li = next((k for k, x in enumerate(m.get('marketSides') or []) if x.get('long')), 0)
            if m.get('status') == 'MARKET_STATUS_RESOLVED' and ptb and len(prices) > li and prices[li] in ('0', '1'):
                info[m['slug']] = (float(ptb), int(prices[li]))
        time.sleep(0.15)
    closes, t = {}, start - 2 * 3600
    while t < end:
        iso = lambda x: dt.datetime.fromtimestamp(x, dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        for row in get(f"https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start={iso(t)}&end={iso(min(end, t + 18000))}") or []:
            closes[int(row[0]) + 60] = float(row[4])
        t += 18000; time.sleep(0.2)

    def sigma(t, minutes=15):
        rs = [math.log(closes[t - 60 * i] / closes[t - 60 * (i + 1)]) for i in range(minutes) if closes.get(t - 60 * i) and closes.get(t - 60 * (i + 1))]
        return math.sqrt(sum(r * r for r in rs) / len(rs) / 60) if len(rs) >= minutes * 0.8 else None

    loss, W, n, cal = {m: 0.0 for m in GRID}, 0, 0, {}
    for series, s, e in wins:
        if slug(series, s) not in info: continue
        k, y = info[slug(series, s)]
        marks = [(closes[t], sigma(t), e - t) for t in range(s + 60, e - 59, 60) if closes.get(t) and sigma(t)]
        if not marks: continue
        W += 1; n += len(marks)
        for spot, sg, tau in marks:
            for m in GRID: loss[m] += ll(fair(spot, k, sg * m, tau), y) / len(marks)
            p = fair(spot, k, sg, tau); c = cal.setdefault(min(9, int(p * 10)), [0, 0, 0])
            c[0] += 1 / len(marks); c[1] += p / len(marks); c[2] += y / len(marks)
    best = min(GRID, key=lambda m: loss[m])
    print(f'{W} windows, {n} checkpoints. Log loss at x1.0 {loss[1] / W:.4f}, best x{best} {loss[best] / W:.4f} (coin flip 0.6931)')
    print('By scale:', ' '.join(f'x{m}:{loss[m] / W:.4f}' for m in GRID))
    print('Said -> happened:', ' '.join(f'{c[1] / c[0]:.2f}->{c[2] / c[0]:.2f}' for _, c in sorted(cal.items())))

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 7)
