// Pure analytics over normalized Polymarket US activities.
// No DOM access here, so it runs the same in the browser and in Node tests.

const LEAGUES = {
  cfb: 'College Football', nfl: 'NFL', nba: 'NBA', cbb: 'College Hoops',
  ufc: 'UFC', fwc: 'World Cup', mlb: 'MLB', nhl: 'NHL', wnba: 'WNBA',
  epl: 'Premier League', mls: 'MLS',
};

export function leagueOf(a) {
  if (a.title === 'Combo') return 'Parlays';
  const key = (a.evSlug || '').split('-')[0];
  if (LEAGUES[key]) return LEAGUES[key];
  if (a.cat && a.cat !== 'sports') return a.cat[0].toUpperCase() + a.cat.slice(1);
  return 'Other';
}

export function betTypeOf(a) {
  if (a.title === 'Combo') return 'Parlay';
  const t = a.smt || '';
  if (t.includes('spread')) return 'Spread';
  if (t.includes('total')) return 'Total';
  if (t.includes('method')) return 'Method of victory';
  if (t === 'futures') return 'Futures';
  return 'Moneyline';
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

// Group trades and settlements into one row per market you played.
export function buildPositions(activities) {
  const map = new Map();
  const sorted = [...activities].sort((a, b) => a.t.localeCompare(b.t));
  for (const a of sorted) {
    if (a.type !== 'TRADE' && a.type !== 'POSITION_RESOLUTION') continue;
    // One row per side: you sometimes trade both teams in the same game.
    const key = `${a.mkt || a.id}|${a.title || ''}`;
    let p = map.get(key);
    if (!p) {
      p = {
        key, title: a.title || a.mkt || 'Market', matchup: a.sub || a.ev || '', league: leagueOf(a),
        betType: betTypeOf(a), color: a.color || null, gameStart: a.gameStart || null,
        opened: a.t, closed: a.t, staked: 0, returned: 0, fees: 0, pnl: 0,
        qtyBought: 0, qtySold: 0, buys: 0, sells: 0, entryCost: 0,
        result: 'open', settled: false, events: [],
      };
      map.set(key, p);
    }
    p.closed = a.t;
    p.events.push(a);
    p.fees += num(a.fee);
    if (a.type === 'TRADE' && a.action === 'bought') {
      p.staked += num(a.cost); p.qtyBought += num(a.qty); p.buys++;
      p.entryCost += num(a.price) * num(a.qty);
    } else if (a.type === 'TRADE' && a.action === 'sold') {
      p.returned += num(a.cost); p.qtySold += num(a.qty); p.sells++; p.pnl += num(a.pnl);
    } else if (a.type === 'POSITION_RESOLUTION') {
      p.returned += num(a.payout); p.pnl += num(a.pnl); p.settled = true;
      p.result = a.action === 'won' ? 'won' : 'lost';
    }
  }
  for (const p of map.values()) {
    p.avgEntry = p.qtyBought ? p.entryCost / p.qtyBought : null;
    if (!p.settled) {
      const flat = p.qtyBought > 0 && p.qtySold >= p.qtyBought - 0.5;
      p.result = flat || p.sells > 0 ? 'sold' : 'open';
    }
    p.outcome = p.pnl > 0.005 ? 'win' : p.pnl < -0.005 ? 'loss' : 'push';
    p.roi = p.staked > 0 ? p.pnl / p.staked : 0;
  }
  return [...map.values()].sort((a, b) => b.closed.localeCompare(a.closed));
}

export function cashFlows(activities, reserved = 0) {
  let deposits = 0, withdrawals = 0, bonuses = 0;
  for (const a of activities) {
    if (a.type === 'ACCOUNT_DEPOSIT' && a.status !== 'REJECTED') deposits += num(a.amount);
    if (a.type === 'ACCOUNT_WITHDRAWAL' && a.status !== 'REJECTED') withdrawals += num(a.amount);
    if (a.type === 'REFERRAL_BONUS' || a.type === 'TRANSFER' || a.type === 'TAKER_FEE_REBATE' || a.type === 'LIQUIDITY_PROGRAM') bonuses += num(a.amount);
  }
  return { deposits, withdrawals, bonuses, bonusesCredited: bonuses - reserved, reserved };
}

// Every moment money was realized, in order: sells, settlements, promos.
export function equitySeries(activities, { includeBonuses = false } = {}) {
  const pts = [];
  for (const a of activities) {
    let v = 0;
    if (a.type === 'TRADE' && a.action === 'sold') v = num(a.pnl);
    else if (a.type === 'POSITION_RESOLUTION') v = num(a.pnl);
    else if (includeBonuses && (a.type === 'REFERRAL_BONUS' || a.type === 'TRANSFER')) v = num(a.amount);
    else continue;
    pts.push({ t: a.t, v, label: a.title || a.type });
  }
  pts.sort((a, b) => a.t.localeCompare(b.t));
  let run = 0;
  return pts.map((p) => ({ ...p, y: (run += p.v) }));
}

function streaks(positions) {
  const chron = [...positions].filter((p) => p.result !== 'open').sort((a, b) => a.closed.localeCompare(b.closed));
  let bestW = 0, bestL = 0, w = 0, l = 0;
  for (const p of chron) {
    if (p.outcome === 'win') { w++; l = 0; } else if (p.outcome === 'loss') { l++; w = 0; }
    bestW = Math.max(bestW, w); bestL = Math.max(bestL, l);
  }
  const last = chron.at(-1);
  let cur = 0, curType = last?.outcome ?? null;
  for (let i = chron.length - 1; i >= 0 && chron[i].outcome === curType; i--) cur++;
  return { bestWin: bestW, bestLoss: bestL, current: cur, currentType: curType };
}

function groupBy(positions, keyFn) {
  const m = new Map();
  for (const p of positions) {
    const k = keyFn(p);
    const g = m.get(k) || { key: k, n: 0, wins: 0, losses: 0, pnl: 0, staked: 0 };
    g.n++; g.pnl += p.pnl; g.staked += p.staked;
    if (p.outcome === 'win') g.wins++; else if (p.outcome === 'loss') g.losses++;
    m.set(k, g);
  }
  return [...m.values()]
    .map((g) => ({ ...g, winRate: g.wins + g.losses ? g.wins / (g.wins + g.losses) : 0, roi: g.staked ? g.pnl / g.staked : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
}

export function priceBucket(p) {
  const e = p.avgEntry;
  if (e == null) return 'n/a';
  if (e < 0.15) return 'Longshot · under 15¢';
  if (e < 0.35) return 'Underdog · 15–35¢';
  if (e < 0.55) return 'Coin flip · 35–55¢';
  if (e < 0.75) return 'Favorite · 55–75¢';
  return 'Heavy fav · 75¢+';
}

export function dayKey(iso, tz = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function summarize(activities, { since = null, reserved = 0 } = {}) {
  const inRange = since ? activities.filter((a) => a.t >= since) : activities;
  const positions = buildPositions(inRange).filter((p) => p.staked > 0.009 || p.returned > 0.009);
  const closed = positions.filter((p) => p.result !== 'open');
  const wins = closed.filter((p) => p.outcome === 'win');
  const losses = closed.filter((p) => p.outcome === 'loss');
  const trades = inRange.filter((a) => a.type === 'TRADE');
  const realized = closed.reduce((s, p) => s + p.pnl, 0);
  const staked = closed.reduce((s, p) => s + p.staked, 0);
  const fees = trades.reduce((s, a) => s + num(a.fee), 0);
  const volume = trades.filter((a) => a.action === 'bought').reduce((s, a) => s + num(a.cost), 0);
  const flows = cashFlows(inRange, since ? 0 : reserved);

  const daily = new Map();
  for (const p of equitySeries(inRange)) {
    const k = dayKey(p.t);
    daily.set(k, (daily.get(k) || 0) + p.v);
  }
  const days = [...daily.entries()].map(([day, pnl]) => ({ day, pnl })).sort((a, b) => a.day.localeCompare(b.day));

  const sum = (xs) => xs.reduce((s, p) => s + p.pnl, 0);
  return {
    positions, closed,
    realized, staked, fees, volume,
    roi: staked ? realized / staked : 0,
    record: { wins: wins.length, losses: losses.length, pushes: closed.length - wins.length - losses.length },
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    best: [...closed].sort((a, b) => b.pnl - a.pnl)[0] || null,
    worst: [...closed].sort((a, b) => a.pnl - b.pnl)[0] || null,
    bestDay: [...days].sort((a, b) => b.pnl - a.pnl)[0] || null,
    worstDay: [...days].sort((a, b) => a.pnl - b.pnl)[0] || null,
    days,
    streaks: streaks(closed),
    trades: trades.length,
    flows,
    total: realized + flows.bonusesCredited,
    byLeague: groupBy(closed, (p) => p.league),
    byType: groupBy(closed, (p) => p.betType),
    byPrice: groupBy(closed.filter((p) => p.avgEntry != null && p.betType !== 'Parlay'), priceBucket),
    byExit: groupBy(closed, (p) => (p.result === 'sold' ? 'Sold before the end' : 'Held to settlement')),
    series: equitySeries(inRange),
  };
}
