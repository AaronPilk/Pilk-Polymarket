"""Aaron's gold method (Nov 25), scored against what Polymarket charged on its gold Up/Down windows.

How he traded gold: read the trend on the week, then on the day; when both agree, drop to the 5-minute chart and
wait for price to consolidate (go sideways in a range), break out of it in the trend's direction, then come back
and retest the edge it broke. If the edge holds, get in with the trend; if price falls back inside, it was a fake.

The gold chart here is PAXG-USD 5-minute candles from Coinbase (a token backed 1:1 by gold that trades around the
clock; Polymarket's gold windows settle on XAU/USD, which it follows closely). A signal is taken on the next gold
window that starts after it (15-minute and hourly), buying the trend's side at the first ask 1-3 minutes into the
window and holding to the result, with the exact taker fee. A rule only counts if it wins more often than the
price it paid says.

Rules:
  trend_only        week and day agree -> that side, every window (the trend filter on its own)
  brk_trend         plus a 5-minute breakout of the last hour's range in that direction (no retest)
  retest_trend      plus the retest: within 30 minutes price comes back to the broken edge and closes beyond it
  retest_tight      retest_trend, but only out of a tight range (range under the median of the last day's)
  retest_any        the retest pattern in either direction, with no trend filter (does the trend filter help?)
  fake_fade         the breakout fails (closes back inside the range): bet against the breakout
  fake_follow       the opposite of fake_fade (added after seeing fake_fade lose: a post-hoc check, not a find)

Run: python3 scripts/gold_retest.py [days]
"""
import bisect, concurrent.futures as cf, datetime as dt, json, math, statistics, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fav_replay as fr
import pvm_replay as pv
from chart_replay import entry_ask, fee, score

PREFIX, SERIES = 'cpausp-gold-updown', (('15m', 900), ('1h', 3600))
BOX, RETEST_BARS, TOL = 12, 6, 0.0005   # 1 hour of 5-min bars; retest within 30 minutes; "touch" = within 0.05%

def iso(t): return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def candles(t0, t1):
    """5-minute PAXG bars: start -> (low, high, close)."""
    out, step, t = {}, 299 * 300, t0 - t0 % 300
    while t < t1:
        a, b = t, min(t + step, t1)
        url = f'https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=300&start={iso(a)}&end={iso(b)}'
        j = fr.get(url) if b > time.time() - 900 else fr.cached(f'cb5-PAXG-{a}-{b}', lambda: fr.get(url))
        for row in j or []:
            if isinstance(row, list) and len(row) >= 5: out[int(row[0])] = (float(row[1]), float(row[2]), float(row[4]))
        t = b
    return out

def signals(bars):
    """Walk the 5-minute bars; return {rule: [(time the signal is known, side 1=Up/0=Down)]}."""
    T = sorted(bars); L = [bars[t][0] for t in T]; H = [bars[t][1] for t in T]; C = [bars[t][2] for t in T]
    cum = [0.0]
    for c in C: cum.append(cum[-1] + c)
    def avg_since(i, secs):   # mean close over the last `secs` up to bar i
        j = bisect.bisect_left(T, T[i] - secs)
        return (cum[i + 1] - cum[j]) / (i + 1 - j) if i + 1 - j >= 0.8 * secs / 300 else None
    widths = []
    out = {k: [] for k in ('brk_trend', 'retest_trend', 'retest_tight', 'retest_any', 'fake_fade', 'fake_follow')}
    trend_at = {}
    pending = []   # breakouts waiting for a retest or a failure: (expires at index, side, edge, tight, trend)
    for i in range(BOX, len(T)):
        if T[i] - T[i - BOX] != BOX * 300: pending.clear(); continue   # gap in the data
        wk, dy = avg_since(i, 7 * 86400), avg_since(i, 86400)
        trend = None
        if wk is not None and dy is not None:
            if C[i] > wk and C[i] > dy: trend = 1
            elif C[i] < wk and C[i] < dy: trend = 0
        trend_at[T[i] + 300] = trend
        known = T[i] + 300                      # the bar's close is known at its end
        # Resolve pending breakouts with this bar.
        keep = []
        for exp, side, edge, tight, tr in pending:
            if side == 1:
                touched, held, failed = L[i] <= edge * (1 + TOL), C[i] >= edge, C[i] < edge
            else:
                touched, held, failed = H[i] >= edge * (1 - TOL), C[i] <= edge, C[i] > edge
            if failed:
                out['fake_fade'].append((known, 1 - side)); out['fake_follow'].append((known, side)); continue
            if touched and held:
                out['retest_any'].append((known, side))
                if tr == side:
                    out['retest_trend'].append((known, side))
                    if tight: out['retest_tight'].append((known, side))
                continue
            if i < exp: keep.append((exp, side, edge, tight, tr))
        pending = keep
        # A new breakout of the last hour's range (the BOX bars before this one).
        hi, lo = max(H[i - BOX:i]), min(L[i - BOX:i])
        width = (hi - lo) / C[i]
        tight = len(widths) >= 50 and width <= statistics.median(widths[-288:])
        widths.append(width)
        side = 1 if C[i] > hi else 0 if C[i] < lo else None
        if side is None or any(p[1] == side for p in pending): continue
        if trend == side: out['brk_trend'].append((known, side))
        pending.append((i + RETEST_BARS, side, hi if side == 1 else lo, tight, trend))
    return out, trend_at

def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fr.slug = lambda sn, t: f"{PREFIX}-{sn}-{dt.datetime.fromtimestamp(t, dt.timezone.utc):%Y-%m-%d-%H%M}z"
    fr.SERIES = SERIES
    fr.CACHE.mkdir(exist_ok=True)
    wins = fr.windows(days)
    info = {k: v for k, v in pv.load_markets().items() if k.startswith(PREFIX)}
    pv.fetch_missing(wins, info)
    todo = [w for w in wins if fr.slug(w[0], w[1]) in info]
    with cf.ThreadPoolExecutor(8) as ex:
        hists = dict(zip([fr.slug(*w[:2]) for w in todo], ex.map(lambda w: fr.history(*w), todo)))
    bars = candles(wins[0][1] - 8 * 86400, wins[-1][2])
    sig, trend_at = signals(bars)
    starts = {sn: sorted(s for n, s, e in todo if n == sn) for sn, _ in SERIES}
    by_start = {(sn, s): (sn, s, e) for sn, s, e in todo}
    split = (wins[0][1] + wins[-1][2]) // 2
    rows = {k: [] for k in ['trend_only', *sig]}

    def bet(rule, w, side):
        sn, s, e = w
        sl = fr.slug(sn, s)
        asks = entry_ask(hists.get(sl) or [], s, e)
        if not asks: return
        ask = asks[0] if side else asks[1]
        won = 1 if (info[sl]['up'] == 1) == (side == 1) else 0
        rows[rule].append({'series': sn, 's': s, 'hr': s // 3600, 'price': ask, 'won': won, 'pnl': (1 - ask if won else -ask) - fee(ask)})

    for sn, s, e in todo:   # the trend filter on its own, every window
        tr = trend_at.get(s - s % 300)
        if tr is not None: bet('trend_only', (sn, s, e), tr)
    for rule, lst in sig.items():   # each signal -> the next window of each length that starts after it
        for sn, _ in SERIES:
            used = set()
            for known, side in lst:
                k = bisect.bisect_left(starts[sn], known)
                if k >= len(starts[sn]): continue
                s = starts[sn][k]
                if s - known > 3600 or s in used: continue   # stale signal, or that window already bet
                used.add(s)
                bet(rule, by_start[(sn, s)], side)

    out = {'days': days, 'windows': len(wins), 'resolved': len(todo), 'bars': len(bars),
           'signals': {k: len(v) for k, v in sig.items()},
           'rules': {k: {'all': score(v, split), 'series': {sn: score([r for r in v if r['series'] == sn], split) for sn, _ in SERIES}} for k, v in rows.items()}}
    Path('gold_retest_result.json').write_text(json.dumps(out, indent=1, default=str))
    f = lambda v, d=3: '   —  ' if v is None else f'{v:+.{d}f}'
    print(f"gold {days} days: {len(wins)} windows, {len(todo)} resolved, {len(bars)} PAXG 5-min bars; signals {out['signals']}")
    for k, v in out['rules'].items():
        a = v['all']
        if not a: print(f'{k:13s} no bets'); continue
        print(f"{k:13s} n {a['n']:5d} won {a['win_rate']:.3f} at {a['avg_price']:.3f}  {f(a['per_contract'])}/contract  t {f(a['t'], 2)}  halves {f(a['first_half'])} {f(a['second_half'])}   "
              + '  '.join(f"{sn} n{x['n']} {f(x['per_contract'])}(t{f(x['t'], 1)})" for sn, x in v['series'].items() if x))

if __name__ == '__main__':
    main()
