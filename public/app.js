import { summarize, buildPositions, cashFlows, priceBucket, dayKey } from './analytics.js';

// ---------------------------------------------------------------- state
const store = {
  activities: [],
  state: null,     // { snapshot, lastSync, apiConfigured }
  bot: null,      // /api/bot: the bot's own ledger
  botRange: 'all', // bot chart: 1h | 1d | 1w | all
  botGroup: 'all', // all | btc | hoops
  botCurve: {},    // range -> { at, data } from /api/bot/curve
  range: 'all',
  mode: 'live',    // live | cached | preview
  betFilter: 'All',
  betQuery: '',
  activityLimit: 80,
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const TZ = 'America/New_York';

// ---------------------------------------------------------------- format
const MINUS = '−';
const money = (v, { sign = false, cents = true } = {}) => {
  const a = Math.abs(v || 0);
  const s = a.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  if (!sign) return (v < 0 ? MINUS : '') + '$' + s;
  if (Math.abs(v) < 0.005) return '$' + s;
  return (v > 0 ? '+' : MINUS) + '$' + s;
};
const tone = (v) => (v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : '');
const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const signedPct = (v, d = 1) => (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%';
const cents = (p) => (p == null ? '–' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(new Date(iso));
const fmtTime = (iso) => fmtDate(iso, { hour: 'numeric', minute: '2-digit' });
const dayLabel = (key) => {
  const today = dayKey(new Date().toISOString());
  const yest = dayKey(new Date(Date.now() - 864e5).toISOString());
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const sameYear = y === new Date().getFullYear();
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(dt);
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return fmtDate(iso, { month: 'short', day: 'numeric' });
};
const initials = (title) => {
  if (title === 'Combo') return 'P';
  const w = String(title || '').split(/\s+/).filter((x) => /^[A-Za-z]/.test(x));
  return (w.slice(0, 2).map((x) => x[0]).join('') || '•').toUpperCase();
};
const badge = (title, color) => {
  const bg = title === 'Combo' ? 'linear-gradient(135deg,#5e5ce6,#bf5af2)' : color || 'var(--surface-3)';
  return `<span class="badge" style="background:${bg}">${esc(initials(title))}</span>`;
};
const chev = '<svg class="chev" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5 6.5 6.5l-5 5"/></svg>';

// ---------------------------------------------------------------- data
async function load({ quiet = false } = {}) {
  try {
    const [a, s] = await Promise.all([fetch('/api/activities'), fetch('/api/state')]);
    if (a.status === 401 || s.status === 401) { location.href = '/login'; return; }
    if (!a.ok || !s.ok) throw new Error('api');
    store.activities = await a.json();
    store.state = await s.json();
    store.mode = 'live';
    try { localStorage.setItem('pm-cache', JSON.stringify({ a: store.activities, s: store.state })); } catch {}
    refreshBot();
  } catch {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('pm-cache') || 'null'); } catch {}
    if (cached?.a?.length) {
      store.activities = cached.a; store.state = cached.s; store.mode = 'cached';
    } else if (window.__SEED__) {
      store.activities = window.__SEED__.activities;
      store.state = window.__SEED__.state;
      store.mode = 'preview';
    }
    if (!quiet && store.mode !== 'preview') toast('Offline. Showing your last sync.');
  }
  renderAll();
}

async function syncNow() {
  const btn = $('#sync-btn');
  if (store.mode === 'preview') { toast('Preview copy. Sync runs on your Cloudflare app.'); return; }
  btn.classList.add('spinning');
  try {
    const r = await fetch('/api/sync', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    toast(j.added ? `Synced · ${j.added} new` : 'Up to date');
    await load({ quiet: true });
  } catch (e) {
    toast(/not configured/i.test(e.message) ? 'Add your API key first (see Lab)' : 'Sync failed. Try again.');
  } finally {
    btn.classList.remove('spinning');
  }
}

function reserved() {
  return store.state?.snapshot?.reserved || 0;
}
function sinceFor(range) {
  return range === 'all' ? null : new Date(Date.now() - Number(range) * 864e5).toISOString();
}

// ---------------------------------------------------------------- render
let firstPaint = true;
function renderAll() {
  renderOverview();
  renderBets();
  renderActivity();
  renderBot();
  renderLab();
  if (firstPaint) {
    firstPaint = false;
    requestAnimationFrame(() => requestAnimationFrame(() => $('#view-overview').classList.add('revealed')));
  }
}

function renderOverview() {
  const body = $('#overview-body');
  if (!store.activities.length) {
    $('#hero-value').textContent = '$0.00';
    $('#hero-sub').innerHTML = '';
    $('#chart').innerHTML = ''; $('#chart-axis').innerHTML = '';
    body.innerHTML = connectCard();
    return;
  }
  const S = summarize(store.activities, { since: sinceFor(store.range), reserved: reserved() });
  overviewStats = S;
  paintHero(S);
  drawChart(S.series);

  const cash = store.state?.snapshot?.cash;
  const tiles = [
    { label: 'Win rate', value: pct(S.winRate), foot: `${S.record.wins}–${S.record.losses} record` },
    { label: 'Return on stakes', value: signedPct(S.roi), foot: `${money(S.staked, { cents: false })} staked`, cls: tone(S.roi) },
    { label: 'Win vs. loss size', value: S.avgLoss ? `${(S.avgWin / Math.abs(S.avgLoss)).toFixed(1)}×` : '–', foot: `${money(S.avgWin)} vs. ${money(Math.abs(S.avgLoss))}` },
    { label: 'Fees paid', value: money(S.fees), foot: S.volume ? `${pct(S.fees / S.volume, 1)} of what you bet` : '' },
    S.bestDay && { label: 'Best day', value: money(S.bestDay.pnl, { sign: true }), foot: dayLabel(S.bestDay.day), cls: tone(S.bestDay.pnl) },
    S.best && { label: 'Biggest win', value: money(S.best.pnl, { sign: true }), foot: S.best.title, cls: tone(S.best.pnl) },
    { label: 'Streak', value: S.streaks.current ? `${S.streaks.current}${S.streaks.currentType === 'win' ? 'W' : 'L'}` : '–', foot: `Best ${S.streaks.bestWin}W · worst ${S.streaks.bestLoss}L`, cls: S.streaks.currentType === 'win' ? 'pos' : S.streaks.currentType === 'loss' ? 'neg' : '' },
    { label: cash != null ? 'Cash' : 'Bet volume', value: cash != null ? money(cash) : money(S.volume, { cents: false }), foot: cash != null ? `${S.trades} trades · ${money(S.volume, { cents: false })} bet` : `${S.trades} trades` },
  ].filter(Boolean);

  const order = ['Longshot · under 15¢', 'Underdog · 15–35¢', 'Coin flip · 35–55¢', 'Favorite · 55–75¢', 'Heavy fav · 75¢+'];
  const byPrice = [...S.byPrice].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  body.innerHTML = `
    <div class="section reveal" style="--i:4"><div class="stats">${tiles.map(statTile).join('')}</div></div>
    ${insightsBlock(S)}
    ${breakdown('By sport', S.byLeague)}
    ${breakdown('By entry price', byPrice, 'What you paid per share')}
    ${breakdown('By bet type', S.byType)}
    ${breakdown('Exit', S.byExit)}
    <p class="faint" style="font-size:12px;text-align:center;margin:26px 0 0">${store.mode === 'preview' ? 'Preview copy · snapshot from Nov 22' : store.state?.lastSync ? `Synced ${ago(store.state.lastSync.t)}` : ''}</p>`;
}

function statTile(t) {
  return `<div class="stat"><div class="stat-label">${esc(t.label)}</div><div class="stat-value ${t.cls || ''}">${esc(t.value)}</div><div class="stat-foot">${esc(t.foot || '')}</div></div>`;
}

function insightsBlock(S) {
  const items = [];
  const leagues = S.byLeague.filter((g) => g.n >= 2);
  if (leagues.length >= 2) {
    const top = leagues.slice(0, 2).filter((g) => g.pnl > 0);
    const rest = S.byLeague.filter((g) => !top.includes(g)).reduce((s, g) => s + g.pnl, 0);
    if (top.length === 2) items.push([`${top[0].key} and ${top[1].key} made you <b class="pos">${money(top[0].pnl + top[1].pnl, { sign: true })}</b>. Everything else combined: <b class="${tone(rest)}">${money(rest, { sign: true })}</b>.`, 'var(--green)']);
  }
  if (S.record.wins && S.record.losses && S.avgLoss) {
    const ratio = S.avgWin / Math.abs(S.avgLoss);
    items.push([`You win ${pct(S.winRate)} of bets, but your average win is ${ratio.toFixed(1)}× your average loss. That's why the total is up.`, 'var(--blue)']);
  }
  const exit = Object.fromEntries(S.byExit.map((g) => [g.key, g]));
  const sold = exit['Sold before the end'], held = exit['Held to settlement'];
  if (sold && held) items.push([`Selling before the final: <b class="${tone(sold.pnl)}">${money(sold.pnl, { sign: true })}</b> over ${sold.n} bets. Holding to the end: <b class="${tone(held.pnl)}">${money(held.pnl, { sign: true })}</b> over ${held.n}.`, 'var(--blue)']);
  const long = S.byPrice.find((g) => g.key.startsWith('Longshot'));
  if (long && long.n >= 3) items.push([`Longshots under 15¢ went ${long.wins}–${long.losses} for <b class="${tone(long.pnl)}">${money(long.pnl, { sign: true })}</b>.`, long.pnl < 0 ? 'var(--red)' : 'var(--green)']);
  const parlay = S.byType.find((g) => g.key === 'Parlay');
  if (parlay && parlay.n >= 3) items.push([`Parlays: ${parlay.wins}–${parlay.losses}, <b class="${tone(parlay.pnl)}">${money(parlay.pnl, { sign: true })}</b>.`, parlay.pnl < 0 ? 'var(--red)' : 'var(--green)']);
  const worst = [...S.byLeague].sort((a, b) => a.pnl - b.pnl)[0];
  if (worst && worst.pnl < -50 && worst.key !== 'Parlays') items.push([`${worst.key} is your leakiest spot: ${worst.wins}–${worst.losses}, <b class="neg">${money(worst.pnl, { sign: true })}</b>.`, 'var(--red)']);
  if (!items.length) return '';
  return `<div class="section"><div class="section-title">What the numbers say</div><div class="card insights">${items.map(([t, c]) => `<div class="insight"><i style="background:${c}"></i><div>${t}</div></div>`).join('')}</div></div>`;
}

function breakdown(title, groups, note = '') {
  if (!groups.length) return '';
  const max = Math.max(...groups.map((g) => Math.abs(g.pnl)), 1);
  const rows = groups.map((g) => {
    const w = (Math.abs(g.pnl) / max) * 50;
    const left = g.pnl >= 0 ? 50 : 50 - w;
    return `<div class="bar-row">
      <div class="bar-head"><span>${esc(g.key)}</span><span class="num ${tone(g.pnl)}" style="font-weight:600">${money(g.pnl, { sign: true })}</span></div>
      <div class="bar-track"><span class="mid"></span><span class="bar-fill" style="left:${left}%;width:${w}%;background:${g.pnl >= 0 ? 'var(--green)' : 'var(--red)'}"></span></div>
      <div class="bar-foot">${g.wins}–${g.losses} · ${signedPct(g.roi, 0)} on ${money(g.staked, { cents: false })}</div>
    </div>`;
  }).join('');
  return `<div class="section"><div class="section-title">${esc(title)}${note ? `<small>${esc(note)}</small>` : ''}</div><div class="card">${rows}</div></div>`;
}

// hero ----------------------------------------------------------
let overviewStats = null;
function heroDefault(S) {
  const all = store.range === 'all';
  return {
    label: all ? 'All-time profit' : store.range === '7' ? 'Profit · last 7 days' : 'Profit · last 30 days',
    value: all ? S.total : S.realized,
  };
}
function paintHero(S, animate = firstPaint && !reduceMotion) {
  const { label, value } = heroDefault(S);
  $('#hero-label').textContent = label;
  const el = $('#hero-value');
  el.className = `hero-value num ${tone(value)}`;
  if (animate) countUp(el, value); else el.textContent = money(value, { sign: true });
  const sub = [];
  if (store.range === 'all') {
    sub.push(`<span>Trading <b class="${tone(S.realized)}">${money(S.realized, { sign: true })}</b></span>`);
    if (S.flows.bonusesCredited) sub.push(`<span>Promos <b>${money(S.flows.bonusesCredited, { sign: true })}</b></span>`);
  } else {
    sub.push(`<span><b>${S.record.wins}–${S.record.losses}</b> record</span>`, `<span>Fees <b>${money(S.fees)}</b></span>`);
  }
  $('#hero-sub').innerHTML = sub.join('');
}
function countUp(el, target) {
  const start = performance.now(), dur = 750;
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = money(target * ease(t), { sign: true });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// chart ----------------------------------------------------------
let chartEntered = false;
function drawChart(series) {
  const wrap = $('#chart');
  const axis = $('#chart-axis');
  const W = wrap.clientWidth || 360, H = wrap.clientHeight || 190, padY = 16;
  if (series.length < 2) {
    wrap.innerHTML = `<div class="empty" style="padding-top:60px">Not enough settled bets in this range yet.</div>`;
    axis.innerHTML = '';
    return;
  }
  const pts = [{ y: 0, t: series[0].t, label: 'Start' }, ...series];
  const ys = pts.map((p) => p.y);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  const span = max - min || 1;
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => padY + (1 - (v - min) / span) * (H - padY * 2);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const up = pts.at(-1).y >= 0;
  const color = up ? 'var(--green)' : 'var(--red)';
  const gid = `g${Math.random().toString(36).slice(2, 7)}`;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${chartEntered || reduceMotion ? '' : 'chart-enter'}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#30d158' : '#ff453a'}" stop-opacity=".28"/><stop offset="1" stop-color="${up ? '#30d158' : '#ff453a'}" stop-opacity="0"/></linearGradient></defs>
    <line class="chart-zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
    <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${gid})"/>
    <path class="chart-line" d="${d}" stroke="${color}"/>
    <line class="chart-cursor" y1="0" y2="${H}" x1="-10" x2="-10" visibility="hidden"/>
    <circle class="chart-dot" r="6" fill="${color}" cx="-10" cy="-10" visibility="hidden"/>
  </svg>`;
  chartEntered = true;
  axis.innerHTML = `<span>${fmtDate(series[0].t, { month: 'short', day: 'numeric' })}</span><span>${series.length} settled</span><span>${fmtDate(series.at(-1).t, { month: 'short', day: 'numeric' })}</span>`;

  // Scrub: the hero number follows your finger, like Stocks.
  const svg = $('svg', wrap), cur = $('.chart-cursor', svg), dot = $('.chart-dot', svg);
  const show = (clientX) => {
    const r = wrap.getBoundingClientRect();
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((clientX - r.left) / r.width) * (pts.length - 1))));
    const p = pts[i];
    cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.y));
    cur.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    const el = $('#hero-value');
    el.textContent = money(p.y, { sign: true });
    el.className = `hero-value num ${tone(p.y)}`;
    $('#hero-label').textContent = i === 0 ? 'Start' : `${fmtDate(p.t, { month: 'short', day: 'numeric' })} · ${p.label === 'Combo' ? 'Parlay' : p.label}`;
  };
  const hide = () => {
    cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
    if (overviewStats) paintHero(overviewStats, false);
  };
  wrap.onpointerdown = (e) => { wrap.setPointerCapture(e.pointerId); show(e.clientX); };
  wrap.onpointermove = (e) => { if (wrap.hasPointerCapture(e.pointerId)) show(e.clientX); };
  wrap.onpointerup = wrap.onpointercancel = (e) => { if (wrap.hasPointerCapture?.(e.pointerId)) wrap.releasePointerCapture(e.pointerId); hide(); };
}

// range control ----------------------------------------------------------
function setupRange() {
  const seg = $('#range'), thumb = $('.thumb', seg), btns = $$('button', seg);
  const place = () => {
    const i = btns.findIndex((b) => b.dataset.range === store.range);
    const w = (seg.clientWidth - 4) / btns.length;
    thumb.style.width = `${w}px`;
    thumb.style.transform = `translateX(${i * w}px)`;
    btns.forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
  };
  btns.forEach((b) => b.addEventListener('click', () => {
    if (store.range === b.dataset.range) return;
    store.range = b.dataset.range;
    place();
    renderOverview();
  }));
  new ResizeObserver(() => { place(); if (store.activities.length) renderOverview(); }).observe(seg);
  place();
}

// bets ----------------------------------------------------------
function renderBets() {
  const list = $('#bets-list');
  const positions = buildPositions(store.activities).filter((p) => p.staked > 0.009 || p.returned > 0.009);
  const closed = positions.filter((p) => p.result !== 'open');
  const wins = closed.filter((p) => p.outcome === 'win').length;
  $('#bets-sub').textContent = positions.length ? `${positions.length} bets · ${wins} up · ${closed.length - wins} down` : 'Nothing yet.';

  const leagues = [...new Set(positions.map((p) => p.league))];
  const chips = ['All', 'Up', 'Down', 'Sold early', 'Open', ...leagues].filter((c) => c !== 'Open' || positions.some((p) => p.result === 'open'));
  $('#bet-chips').innerHTML = chips.map((c) => `<button class="chip ${store.betFilter === c ? 'on' : ''}" data-chip="${esc(c)}">${esc(c)}</button>`).join('');

  const q = store.betQuery.trim().toLowerCase();
  const f = store.betFilter;
  const shown = positions.filter((p) => {
    if (f === 'Up' && p.outcome !== 'win') return false;
    if (f === 'Down' && p.outcome !== 'loss') return false;
    if (f === 'Sold early' && p.result !== 'sold') return false;
    if (f === 'Open' && p.result !== 'open') return false;
    if (!['All', 'Up', 'Down', 'Sold early', 'Open'].includes(f) && p.league !== f) return false;
    if (q && !`${p.title} ${p.matchup} ${p.league} ${p.betType}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!shown.length) { list.innerHTML = `<div class="empty">${positions.length ? 'No bets match that.' : 'Your bets show up here after the first sync.'}</div>`; return; }

  const groups = new Map();
  for (const p of shown) {
    const k = dayKey(p.closed);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  let html = '';
  for (const [k, ps] of groups) {
    const dayPnl = ps.reduce((s, p) => s + p.pnl, 0);
    html += `<div class="group-head" style="display:flex;justify-content:space-between"><span>${esc(dayLabel(k))}</span><span class="num ${tone(dayPnl)}">${money(dayPnl, { sign: true })}</span></div><div class="card">`;
    html += ps.map((p) => `<button class="row with-badge" data-pos="${esc(p.key)}">
      ${badge(p.title, p.color)}
      <div class="row-main"><div class="row-title">${esc(p.title === 'Combo' ? 'Parlay' : p.title)}</div><div class="row-sub">${esc(p.matchup)} · ${esc(p.league)}</div></div>
      <div class="row-end"><div class="row-amt ${tone(p.pnl)}">${p.result === 'open' ? money(p.staked) : money(p.pnl, { sign: true })}</div><div class="row-meta"><span class="pill ${pillClass(p)}">${pillText(p)}</span></div></div>
    </button>`).join('');
    html += '</div>';
  }
  list.innerHTML = html;
}
const pillClass = (p) => (p.result === 'open' ? 'open' : p.result === 'sold' ? 'sold' : p.result === 'won' ? 'won' : 'lost');
const pillText = (p) => (p.result === 'open' ? 'Open' : p.result === 'sold' ? 'Sold' : p.result === 'won' ? 'Won' : 'Lost');

function setupBets() {
  $('#bet-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]'); if (!c) return;
    store.betFilter = c.dataset.chip; renderBets();
  });
  $('#bet-search').addEventListener('input', (e) => { store.betQuery = e.target.value; renderBets(); });
  $('#bets-list').addEventListener('click', (e) => {
    const r = e.target.closest('[data-pos]'); if (!r) return;
    const p = buildPositions(store.activities).find((x) => x.key === r.dataset.pos);
    if (p) openSheet(positionSheet(p));
  });
}

function positionSheet(p) {
  const events = [...p.events].sort((a, b) => b.t.localeCompare(a.t)).map((a) => {
    let title, amt, cls = '';
    if (a.type === 'POSITION_RESOLUTION') { title = a.action === 'won' ? 'Settled · won' : 'Settled · lost'; amt = money(a.payout || 0); cls = a.action === 'won' ? 'pos' : 'dim'; }
    else if (a.action === 'sold') { title = `Sold ${a.qty} @ ${cents(a.price)}`; amt = '+' + money(a.cost); cls = 'pos'; }
    else { title = `Bought ${a.qty} @ ${cents(a.price)}`; amt = MINUS + money(a.cost); }
    const meta = a.pnl != null && a.type !== 'TRADE' || a.action === 'sold' ? `P&L ${money(a.pnl || 0, { sign: true })}` : a.fee ? `Fee ${money(a.fee)}` : '';
    return `<div class="row"><div class="row-main"><div class="row-title" style="font-size:15px">${esc(title)}</div><div class="row-sub">${fmtDate(a.t, { month: 'short', day: 'numeric' })} · ${fmtTime(a.t)}</div></div><div class="row-end"><div class="row-amt ${cls}" style="font-size:15px">${amt}</div><div class="row-meta">${esc(meta)}</div></div></div>`;
  }).join('');
  return {
    top: `<div class="sheet-head">${badge(p.title, p.color)}<div style="min-width:0"><div class="sheet-title">${esc(p.title === 'Combo' ? 'Parlay' : p.title)}</div><div class="sheet-sub">${esc(p.matchup)} · ${esc(p.league)} · ${esc(p.betType)}</div></div></div>`,
    body: `<div class="sheet-pnl ${tone(p.pnl)}">${p.result === 'open' ? money(p.staked) : money(p.pnl, { sign: true })}</div>
      <div class="card kv" style="margin-bottom:22px">
        <div><span>Staked</span><strong>${money(p.staked)}</strong></div>
        <div><span>Returned</span><strong>${money(p.returned)}</strong></div>
        <div><span>Avg entry</span><strong>${cents(p.avgEntry)}</strong></div>
        <div><span>Return</span><strong class="${tone(p.roi)}">${signedPct(p.roi, 0)}</strong></div>
        <div><span>Fees</span><strong>${money(p.fees)}</strong></div>
        <div><span>Exit</span><strong>${p.result === 'sold' ? 'Sold early' : p.result === 'open' ? 'Still open' : 'Held to end'}</strong></div>
      </div>
      <div class="section-title" style="font-size:17px">Trades<small>${p.buys} buys · ${p.sells} sells</small></div>
      <div class="card">${events}</div>
      ${p.avgEntry != null && p.betType !== 'Parlay' ? `<p class="dim" style="font-size:13px;margin:12px 4px 0">${esc(priceBucket(p))}</p>` : ''}`,
  };
}

// activity ----------------------------------------------------------
function renderActivity() {
  const el = $('#activity-body');
  const acts = store.activities;
  if (!acts.length) { el.innerHTML = `<div class="empty">Nothing here until the first sync.</div>`; return; }
  const f = cashFlows(acts, reserved());
  const cash = store.state?.snapshot?.cash;
  const sorted = [...acts].sort((a, b) => b.t.localeCompare(a.t));
  const slice = sorted.slice(0, store.activityLimit);
  const groups = new Map();
  for (const a of slice) { const k = dayKey(a.t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  let list = '';
  for (const [k, as] of groups) list += `<div class="group-head">${esc(dayLabel(k))}</div><div class="card">${as.map(activityRow).join('')}</div>`;
  el.innerHTML = `
    <div class="card kv">
      <div><span>Deposited</span><strong>${money(f.deposits)}</strong></div>
      <div><span>Withdrawn</span><strong>${money(f.withdrawals)}</strong></div>
      <div><span>Promos</span><strong>${money(f.bonusesCredited)}</strong></div>
      <div><span>${cash != null ? 'Cash now' : 'Net taken out'}</span><strong>${cash != null ? money(cash) : money(f.withdrawals - f.deposits, { sign: true })}</strong></div>
    </div>
    <div style="margin-top:8px">${list}</div>
    ${sorted.length > store.activityLimit ? `<button class="more" id="more-activity">Show more</button>` : ''}`;
  $('#more-activity')?.addEventListener('click', () => { store.activityLimit += 120; renderActivity(); });
}

const ICONS = {
  in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M5.5 12.5 12 19l6.5-6.5"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M12 9v11M3.5 13h17M12 9S9.5 3.5 7 5.5 9 9 12 9Zm0 0s2.5-5.5 5-3.5S15 9 12 9Z"/></svg>',
};
function activityRow(a) {
  let icon, title, sub, amt, cls = '', meta = '';
  const status = a.status && a.status !== 'COMPLETED' ? `<span class="pill ${a.status === 'REJECTED' ? 'lost' : 'open'}">${a.status === 'REJECTED' ? 'Declined' : 'Pending'}</span>` : '';
  switch (a.type) {
    case 'ACCOUNT_DEPOSIT':
      icon = `<span class="badge" style="background:rgba(48,209,88,.16);color:var(--green)">${ICONS.in}</span>`;
      title = 'Deposit'; sub = a.method === 'APPLE_PAY' ? 'Apple Pay' : a.method === 'BANK' ? 'Bank' : 'Deposit';
      amt = '+' + money(a.amount); cls = a.status === 'REJECTED' ? 'faint' : 'pos'; meta = status; break;
    case 'ACCOUNT_WITHDRAWAL':
      icon = `<span class="badge" style="background:rgba(10,132,255,.16);color:var(--blue)">${ICONS.out}</span>`;
      title = 'Withdrawal'; sub = 'To bank'; amt = MINUS + money(a.amount); meta = status; break;
    case 'REFERRAL_BONUS': case 'TRANSFER': case 'TAKER_FEE_REBATE': case 'LIQUIDITY_PROGRAM':
      icon = `<span class="badge" style="background:rgba(255,159,10,.16);color:var(--orange)">${ICONS.gift}</span>`;
      title = a.type === 'REFERRAL_BONUS' ? 'Referral bonus' : a.type === 'TAKER_FEE_REBATE' ? 'Fee rebate' : 'Promo credit'; sub = 'Polymarket';
      amt = '+' + money(a.amount); cls = 'pos'; break;
    case 'POSITION_RESOLUTION':
      icon = badge(a.title, a.color);
      title = `${a.action === 'won' ? 'Won' : 'Lost'} · ${a.title === 'Combo' ? 'Parlay' : a.title || a.mkt || 'market'}`; sub = a.sub || '';
      amt = a.action === 'won' ? '+' + money(a.payout) : money(0); cls = a.action === 'won' ? 'pos' : 'faint';
      meta = `P&L ${money(a.pnl || 0, { sign: true })}`; break;
    default:
      icon = badge(a.title, a.color);
      title = `${a.action === 'sold' ? 'Sold' : 'Bought'} ${a.title === 'Combo' ? 'parlay' : a.title || a.mkt || 'market'}`; sub = `${a.qty ?? 0} @ ${cents(a.price)} · ${a.sub || ''}`;
      amt = a.action === 'sold' ? '+' + money(a.cost) : MINUS + money(a.cost); cls = a.action === 'sold' ? 'pos' : '';
      meta = a.action === 'sold' ? `P&L ${money(a.pnl || 0, { sign: true })}` : fmtTime(a.t);
  }
  return `<div class="row with-badge">${icon}<div class="row-main"><div class="row-title">${esc(title)}</div><div class="row-sub">${esc(sub)}</div></div><div class="row-end"><div class="row-amt ${cls}">${amt}</div><div class="row-meta">${meta.startsWith('<') ? meta : esc(meta)}</div></div></div>`;
}

// bot ----------------------------------------------------------
const SIGNAL_LABEL = { favorite_fade: 'Favorite fading', swing: 'Big swing', cheap_spike: 'Cheap spike', late_close: 'Close and late', fair_gap: 'Price vs math' };
const SIGNAL_ICON = {
  favorite_fade: ['rgba(255,159,10,.16)', 'var(--orange)', '<path d="M4 7l6 6 3-3 7 7"/><path d="M15 17h5v-5"/>'],
  swing: ['rgba(10,132,255,.16)', 'var(--blue)', '<path d="M3 13l4-6 4 10 4-8 3 4h3"/>'],
  cheap_spike: ['rgba(48,209,88,.16)', 'var(--green)', '<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/>'],
  late_close: ['rgba(255,69,58,.16)', 'var(--red)', '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/>'],
  fair_gap: ['rgba(191,90,242,.16)', 'var(--purple, #bf5af2)', '<path d="M5 9h14M5 15h14"/>'],
};
// Closing-line value: how far the price moved our way by game time (positive = we beat it).
const clvText = (p) => {
  const v = Math.round((p.close_price - p.avg_entry) * 100);
  return `line ${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v)}¢`;
};
// Bitcoin first: that's where the testing is focused.
const STRATEGY_LABEL = {
  crypto_fair_v1: 'Bitcoin · price vs math',
  crypto_fair_strict: 'Bitcoin · price vs math, strict',
  crypto_fair_max: 'Bitcoin · price vs math, bigger bets',
  crypto_hold_v1: 'Bitcoin · price vs math, hold to the end',
  crypto_double_v1: 'Bitcoin · cash out at 2× (your move)',
  crypto_cheap_v1: 'Bitcoin · cheap side, sell at 2×',
  crypto_late_v1: 'Bitcoin · final two minutes',
  crypto_lag_v1: 'Bitcoin · beat the lag after a jump',
  crypto_fade_v1: 'Bitcoin · fade jumps the math doesn’t back',
  crypto_ladder_v1: 'Bitcoin · price ladders',
  hoops_trailer_v1: 'Basketball · your style',
  hoops_trailer_h1: 'Basketball · your style, first half',
  hoops_trailer_deep: 'Basketball · your style, deeper dips',
  hoops_value_v1: 'Basketball · model value',
};
const variantOf = (id) => (STRATEGY_LABEL[id] || id || '').split(' · ')[1] || '';
const groupOf = (s) => (s?.startsWith('crypto_') ? 'btc' : s?.startsWith('hoops_') ? 'hoops' : 'other');
const GROUP_LABEL = { all: 'All', btc: 'Bitcoin', hoops: 'Basketball' };
const BOT_RANGE_LABEL = { '1h': 'Last hour', '1d': 'Last 24 hours', '1w': 'Last 7 days', all: 'Since it started' };
const signalBadge = (kind) => {
  const [bg, fg, path] = SIGNAL_ICON[kind] || SIGNAL_ICON.swing;
  return `<span class="badge" style="background:${bg};color:${fg}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
};

async function loadCurve(range) {
  try {
    const r = await fetch(`/api/bot/curve?range=${range}`);
    if (r.ok) store.botCurve[range] = { at: Date.now(), data: await r.json() };
  } catch {}
}

// /api/bot every 5 s while the tab is open; the chart's data every 30 s, or right away when a
// trade closes so the line steps the moment it happens.
async function refreshBot({ curve = false } = {}) {
  if (store.mode === 'preview') return;
  try {
    const r = await fetch('/api/bot');
    if (!r.ok) return;
    const b = await r.json();
    const closedChanged = !!store.bot && b.record?.closed !== store.bot.record?.closed;
    store.bot = b;
    const c = store.botCurve[store.botRange];
    if (curve || closedChanged || !c || Date.now() - c.at > 30_000) await loadCurve(store.botRange);
    renderBot();
  } catch {}
}

let botBuilt = false, botScrub = false, botAnimate = true;
function renderBot() {
  const el = $('#bot-body');
  if (!el) return;
  const b = store.bot;
  if (!b) {
    botBuilt = false;
    el.innerHTML = `<div class="card empty"><h3>${store.mode === 'preview' ? 'Bot data lives in the app' : 'Loading the bot…'}</h3>${store.mode === 'preview' ? "This preview copy can't reach the bot's ledger." : ''}</div>`;
    return;
  }
  if (!botBuilt) {
    el.innerHTML = `
      <div class="hero"><div class="hero-label" id="bot-label"></div><div class="hero-value num" id="bot-value">–</div><div class="hero-sub" id="bot-sub"></div></div>
      <div class="chips bot-chips" id="bot-groups"></div>
      <div class="chart-wrap" id="bot-chart"></div>
      <div class="chart-axis" id="bot-axis"></div>
      <div class="segmented" id="bot-range" role="tablist" aria-label="Chart range"><div class="thumb"></div>
        <button data-range="1h" role="tab">1H</button><button data-range="1d" role="tab">1D</button><button data-range="1w" role="tab">1W</button><button data-range="all" role="tab">All</button>
      </div>
      <div id="bot-rest"></div>`;
    botBuilt = true;
    setupBotControls();
  }
  $('#bot-groups').innerHTML = ['all', 'btc', 'hoops'].map((g) => `<button class="chip ${store.botGroup === g ? 'on' : ''}" data-group="${g}">${GROUP_LABEL[g]}</button>`).join('');
  if (!botScrub) { paintBotHero(); drawBotChart(); }
  $('#bot-rest').innerHTML = botRest(b);
}

function setupBotControls() {
  const seg = $('#bot-range'), thumb = $('.thumb', seg), btns = $$('button', seg);
  const place = () => {
    const i = Math.max(0, btns.findIndex((x) => x.dataset.range === store.botRange));
    const w = (seg.clientWidth - 4) / btns.length;
    thumb.style.width = `${w}px`;
    thumb.style.transform = `translateX(${i * w}px)`;
    btns.forEach((x, j) => x.setAttribute('aria-selected', String(j === i)));
  };
  btns.forEach((btn) => btn.addEventListener('click', async () => {
    if (store.botRange === btn.dataset.range) return;
    store.botRange = btn.dataset.range;
    place();
    const c = store.botCurve[store.botRange];
    if (!c || Date.now() - c.at > 30_000) await loadCurve(store.botRange);
    botAnimate = true;
    paintBotHero(); drawBotChart();
    $('#bot-rest').innerHTML = botRest(store.bot);
  }));
  new ResizeObserver(() => { place(); if (!botScrub) drawBotChart(); }).observe(seg);
  place();
  $('#bot-groups').addEventListener('click', (e) => {
    const c = e.target.closest('[data-group]');
    if (!c || store.botGroup === c.dataset.group) return;
    store.botGroup = c.dataset.group;
    botAnimate = true;
    renderBot();
  });
}

// The line: realized P&L in the range, bucket by bucket, ending "now" with open positions marked
// at what they'd sell for.
function botSeries() {
  const c = store.botCurve[store.botRange]?.data, b = store.bot;
  if (!c || !b) return null;
  const g = store.botGroup;
  const ys = c[g] || [], ns = c.n?.[g] || [];
  const pts = [{ t: c.from, y: 0, n: 0 }];
  for (let i = 0; i < c.t.length; i++) pts.push({ t: c.t[i], y: ys[i] ?? 0, n: ns[i] ?? 0 });
  const open = (b.positions || []).filter((p) => g === 'all' || groupOf(p.strategy) === g).reduce((s, p) => s + (p.upnl || 0), 0);
  const now = Math.max(Date.now(), c.to);
  pts.push({ t: now, y: pts.at(-1).y + open, n: 0, now: true });
  return { pts, from: c.from, to: now, open, wins: c.wins?.[g] || 0, losses: c.losses?.[g] || 0 };
}

const botTime = (t) => (store.botRange === '1h' || store.botRange === '1d'
  ? fmtDate(new Date(t).toISOString(), { hour: 'numeric', minute: '2-digit' })
  : fmtDate(new Date(t).toISOString(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

function paintBotHero() {
  const b = store.bot, S = botSeries();
  if (!b) return;
  const live = b.mode === 'live';
  const group = store.botGroup === 'all' ? '' : ` · ${GROUP_LABEL[store.botGroup]}`;
  $('#bot-label').innerHTML = `${live ? 'Bot account' : 'Paper test'} · ${BOT_RANGE_LABEL[store.botRange]}${esc(group)} <span class="pill ${live ? 'won' : 'open'}" style="vertical-align:2px;margin-left:4px">${live ? 'Live' : 'Paper'}</span>`;
  const v = S ? S.pts.at(-1).y : (b.realized || 0) + (b.unrealized || 0);
  const el = $('#bot-value');
  el.className = `hero-value num ${tone(v)}`;
  el.textContent = money(v, { sign: true });
  const parts = [];
  if (S) {
    const n = S.wins + S.losses;
    parts.push(n ? `<span><b>${S.wins}–${S.losses}</b> on ${n} closed</span>` : '<span>Nothing closed in this range</span>');
    if (Math.abs(S.open) >= 0.005) parts.push(`<span>Open <b class="${tone(S.open)}">${money(S.open, { sign: true })}</b></span>`);
  }
  if (!live) parts.push(`<span><b>${Object.keys(STRATEGY_LABEL).length}</b> strategies, <b>${money(b.allocation, { cents: false })}</b> each</span>`);
  $('#bot-sub').innerHTML = parts.join('');
}

function drawBotChart() {
  const wrap = $('#bot-chart'), axis = $('#bot-axis');
  if (!wrap) return;
  const S = botSeries();
  if (!S) { wrap.innerHTML = `<div class="empty" style="padding-top:70px">Loading the chart…</div>`; axis.innerHTML = ''; return; }
  const { pts, from, to } = S;
  const W = wrap.clientWidth || 360, H = wrap.clientHeight || 190, padY = 16;
  const ys = pts.map((p) => p.y);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys), span = max - min || 1;
  const x = (t) => ((t - from) / (to - from || 1)) * W;
  const y = (v) => padY + (1 - (v - min) / span) * (H - padY * 2);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const up = pts.at(-1).y >= 0;
  const color = up ? 'var(--green)' : 'var(--red)';
  const gid = `bg${Math.random().toString(36).slice(2, 7)}`;
  const animate = botAnimate && !reduceMotion;
  botAnimate = false;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${animate ? 'chart-enter' : ''}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#30d158' : '#ff453a'}" stop-opacity=".26"/><stop offset="1" stop-color="${up ? '#30d158' : '#ff453a'}" stop-opacity="0"/></linearGradient></defs>
    <line class="chart-zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
    <path d="${d}L${x(to)},${H}L0,${H}Z" fill="url(#${gid})"/>
    <path class="chart-line" d="${d}" stroke="${color}"/>
    <circle class="chart-now" r="3.5" fill="${color}" cx="${x(to)}" cy="${y(pts.at(-1).y)}"/>
    <line class="chart-cursor" y1="0" y2="${H}" x1="-10" x2="-10" visibility="hidden"/>
    <circle class="chart-dot" r="6" fill="${color}" cx="-10" cy="-10" visibility="hidden"/>
  </svg>`;
  const trades = S.wins + S.losses;
  axis.innerHTML = `<span>${botTime(from)}</span><span>${trades ? `${trades} closed` : ''}</span><span>Now</span>`;

  // Scrub: the number follows your finger, like Stocks.
  const svg = $('svg', wrap), cur = $('.chart-cursor', svg), dot = $('.chart-dot', svg);
  const show = (clientX) => {
    const r = wrap.getBoundingClientRect();
    const t = from + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (to - from);
    let i = 0;
    for (let k = 0; k < pts.length; k++) if (Math.abs(pts[k].t - t) < Math.abs(pts[i].t - t)) i = k;
    const p = pts[i];
    cur.setAttribute('x1', x(p.t)); cur.setAttribute('x2', x(p.t));
    dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.y));
    cur.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    const el = $('#bot-value');
    el.textContent = money(p.y, { sign: true });
    el.className = `hero-value num ${tone(p.y)}`;
    $('#bot-label').textContent = i === 0 ? `Start · ${botTime(p.t)}` : p.now ? 'Now · open positions at what they’d sell for' : `${botTime(p.t)}${p.n ? ` · ${p.n} closed here` : ''}`;
  };
  const hide = () => {
    botScrub = false;
    cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
    paintBotHero();
  };
  wrap.onpointerdown = (e) => { botScrub = true; wrap.setPointerCapture(e.pointerId); show(e.clientX); };
  wrap.onpointermove = (e) => { if (wrap.hasPointerCapture(e.pointerId)) show(e.clientX); };
  wrap.onpointerup = wrap.onpointercancel = (e) => { if (wrap.hasPointerCapture?.(e.pointerId)) wrap.releasePointerCapture(e.pointerId); hide(); };
}

function spark(vals) {
  if (!vals || vals.length < 2 || vals.every((v) => v === 0)) return '<span class="spark"></span>';
  const W = 56, H = 22, pad = 2;
  const ys = [0, ...vals];
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys), span = max - min || 1;
  const x = (i) => (i / (ys.length - 1)) * W;
  const y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2);
  const d = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line class="spark-zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/><path d="${d}" stroke="${ys.at(-1) >= 0 ? 'var(--green)' : 'var(--red)'}"/></svg>`;
}

// Calibration: dots on the diagonal mean honest odds. A dot above it means Up happened more often
// than that call said.
function calChart(math, market) {
  const W = 300, H = 170, L = 26, B = 18, T = 8, R = 8;
  const x = (p) => L + p * (W - L - R), y = (p) => T + (1 - p) * (H - T - B);
  const maxN = Math.max(1, ...math.map((k) => k.n), ...market.map((k) => k.n));
  const r = (n) => 2.5 + 5.5 * Math.sqrt(n / maxN);
  const dots = (ks, cls) => ks.map((k) => `<circle class="${cls}" cx="${x(k.p).toFixed(1)}" cy="${y(k.hit).toFixed(1)}" r="${r(k.n).toFixed(1)}"/>`).join('');
  return `<svg class="cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration chart">
    <line class="cal-grid" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}"/>
    <line class="cal-grid" x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}"/>
    <line class="cal-diag" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>
    ${dots(market, 'cal-mkt')}${dots(math, 'cal-math')}
    <text x="${x(0)}" y="${H - 4}" class="cal-t">0%</text><text x="${x(0.5)}" y="${H - 4}" class="cal-t" text-anchor="middle">what it said</text><text x="${x(1)}" y="${H - 4}" class="cal-t" text-anchor="end">100%</text>
    <text x="${L - 6}" y="${y(1) + 9}" class="cal-t" text-anchor="end">100</text><text x="${L - 6}" y="${y(0)}" class="cal-t" text-anchor="end">0</text>
  </svg>`;
}

function modelCard(m) {
  if (!m || !m.windows) {
    return `<div class="card empty"><h3>Grading starts soon</h3>Every 30 seconds the bot writes down what its math and the market said about each bitcoin window. When a window finishes, both get scored against what happened. The first real verdict comes after about 40 finished windows, roughly 3 hours.</div>`;
  }
  let verdict = 'Not enough to compare yet', cls = '';
  if (m.modelLoss != null && m.marketLoss != null) {
    const d = (m.marketLoss - m.modelLoss) / m.marketLoss;
    if (d > 0.005) { verdict = `Math ${pct(d, 1)} sharper than the market`; cls = 'pos'; }
    else if (d < -0.005) { verdict = `Market ${pct(-d, 1)} sharper than the math`; cls = 'neg'; }
    else verdict = 'Math and market about even';
  }
  const ready = m.windows >= (m.need || 40);
  const mult = Number(m.mult || 1);
  return `<div class="card pad model">
    <div class="model-verdict ${cls}">${esc(verdict)}</div>
    <div class="row-sub">${m.windows} finished windows · ${Number(m.marks).toLocaleString()} checkpoints${ready ? '' : ` · early read, real verdict at ${m.need || 40} windows`}</div>
    ${calChart(m.buckets || [], m.marketBuckets || [])}
    <div class="model-foot"><span><i class="cal-key math"></i>Math</span><span><i class="cal-key mkt"></i>Market</span><span>Volatility ×${mult.toFixed(2)}${ready ? ' (self-tuned)' : ''}</span></div>
  </div>`;
}

// What has to be true before real money: enough trades to tell skill from luck, the math beating
// the market's own prices on finished windows, Polymarket's OK, and the order engine.
function goLive(b, lineup) {
  const btc = lineup.filter((x) => groupOf(x.strategy) === 'btc');
  const trades = btc.reduce((s, x) => s + (x.closed || 0), 0);
  const m = b.model;
  const sharper = m && m.windows >= (m.need || 40) && m.modelLoss != null && m.marketLoss != null && m.modelLoss < m.marketLoss;
  const items = [
    [trades >= 200, 'Enough trades to trust it', `${trades} of 200 bitcoin trades closed`],
    [!!sharper, 'Math beats the market', m?.windows ? `${m.windows} of ${m.need || 40} windows graded${m.windows >= (m.need || 40) ? (sharper ? ', math ahead' : ', market ahead so far') : ''}` : 'grading starts after the update'],
    [false, 'Polymarket OK for API trading', 'their agreement asks for written approval first'],
    [false, 'Live order engine', 'placing, tracking and cancelling real orders: next build'],
  ];
  return `<div class="section">
    <div class="section-title">Ready for real money?<small>${items.filter((i) => i[0]).length} of ${items.length}</small></div>
    <div class="card">${items.map(([ok, t, sub]) => `<div class="row"><span class="check ${ok ? 'ok' : ''}">${ok ? '✓' : ''}</span><div class="row-main"><div class="row-title">${esc(t)}</div><div class="row-sub">${esc(sub)}</div></div></div>`).join('')}</div>
  </div>`;
}

function botRest(b) {
  const live = b.mode === 'live';
  const losses = (b.record?.closed || 0) - (b.record?.wins || 0);
  const posRow = (p) => {
    const plan = [`in at ${cents(p.avg_entry)}`, p.adds ? `${p.adds} add${p.adds > 1 ? 's' : ''}` : null, p.take_profit ? `sells at ${cents(p.take_profit)}` : null, variantOf(p.strategy) || null].filter(Boolean).join(' · ');
    return `<div class="row with-badge">${badge(p.side_name || p.title)}<div class="row-main"><div class="row-title">${esc(p.side_name || p.side)}</div><div class="row-sub">${esc(plan)}</div></div><div class="row-end"><div class="row-amt">${cents(p.price)}</div><div class="row-meta ${p.upnl != null ? tone(p.upnl) : ''}">${p.upnl != null ? money(p.upnl, { sign: true }) : '–'}</div></div></div>`;
  };
  const histRow = (p) => {
    const how = p.status === 'settled' ? (p.result ? 'Won' : 'Lost') : 'Sold';
    const sub = [`in at ${cents(p.avg_entry)}`, p.adds ? `${p.adds} add${p.adds > 1 ? 's' : ''}` : null, p.close_price != null && p.avg_entry != null ? clvText(p) : null, variantOf(p.strategy) || null].filter(Boolean).join(' · ');
    return `<div class="row with-badge">${badge(p.side_name || p.title)}<div class="row-main"><div class="row-title">${how} · ${esc(p.side_name || p.side)}</div><div class="row-sub">${esc(sub)}</div></div><div class="row-end"><div class="row-amt ${tone(p.pnl || 0)}">${money(p.pnl || 0, { sign: true })}</div><div class="row-meta">${p.closed_at ? ago(new Date(p.closed_at).toISOString()) : ''}</div></div></div>`;
  };
  const sigRow = (s) => `<div class="row with-badge">${signalBadge(s.kind)}<div class="row-main"><div class="row-title">${esc(SIGNAL_LABEL[s.kind] || s.kind)}</div><div class="row-sub">${esc(s.detail || s.title || s.slug)}</div></div><div class="row-end"><div class="row-amt">${s.price != null ? cents(s.price) : ''}</div><div class="row-meta">${ago(new Date(s.ts).toISOString())}</div></div></div>`;

  // Each paper strategy runs its own account; the sparkline is its P&L over the chart's range.
  const strat = store.botCurve[store.botRange]?.data?.strat || {};
  const lineup = Object.keys(STRATEGY_LABEL).map((id) => ({ strategy: id, closed: 0, wins: 0, open: 0, pnl: 0, staked: 0, ...((b.byStrategy || []).find((x) => x.strategy === id) || {}) }));
  const leader = lineup.filter((x) => x.closed).sort((x, y) => y.pnl - x.pnl)[0];
  const tiles = live ? [
    { label: 'Available', value: money(b.available), foot: 'for new bets' },
    { label: 'At risk', value: money(b.atRisk), foot: `${b.positions.length} open` },
    { label: 'Record', value: b.record?.closed ? `${b.record.wins}–${losses}` : '–', foot: 'closed positions' },
    { label: 'Realized', value: money(b.realized || 0, { sign: true }), cls: tone(b.realized || 0), foot: 'after fees' },
  ] : [
    { label: 'Open', value: String(b.positions.length), foot: `${money(b.atRisk)} at risk` },
    { label: 'Record', value: b.record?.closed ? `${b.record.wins}–${losses}` : '–', foot: 'all closed, all time' },
    { label: 'Realized', value: money(b.realized || 0, { sign: true }), cls: tone(b.realized || 0), foot: 'after fees, all time' },
    { label: 'Leading', value: leader ? money(leader.pnl, { sign: true }) : '–', cls: leader ? tone(leader.pnl) : '', foot: leader ? variantOf(leader.strategy) || leader.strategy : 'no closed trades yet' },
  ];
  const stratGroup = (g, title) => {
    const rows = lineup.filter((x) => groupOf(x.strategy) === g);
    const total = rows.reduce((s, x) => s + (x.pnl || 0), 0);
    return `<div class="group-head" style="display:flex;justify-content:space-between"><span>${title}</span><span class="num ${tone(total)}">${money(total, { sign: true })}</span></div>
      <div class="card">${rows.map((x) => `<div class="row"><div class="row-main"><div class="row-title">${esc(variantOf(x.strategy))}</div><div class="row-sub">${x.closed ? `${x.wins}–${x.closed - x.wins} · ${x.staked ? signedPct(x.pnl / x.staked) : '–'} on ${money(x.staked)}` : 'No closed trades yet'}${x.open ? ` · ${x.open} open` : ''}</div></div><div class="row-end strat-end">${spark(strat[x.strategy])}<div class="row-amt ${tone(x.pnl)}">${money(x.pnl, { sign: true })}</div></div></div>`).join('')}</div>`;
  };

  return `
    <div class="section"><div class="stats">${tiles.map(statTile).join('')}</div></div>

    <div class="section">
      <div class="section-title">Bitcoin model check<small>math vs market</small></div>
      ${modelCard(b.model)}
    </div>
    ${live ? '' : goLive(b, lineup)}

    <div class="section">
      <div class="section-title">By strategy<small>${live ? 'results' : `each its own ${money(b.allocation, { cents: false })}`}</small></div>
      ${stratGroup('btc', 'Bitcoin')}
      ${stratGroup('hoops', 'Basketball')}
    </div>

    <div class="section">
      <div class="section-title">Open<small>${b.positions.length ? 'live prices' : ''}</small></div>
      ${b.positions.length ? `<div class="card">${b.positions.map(posRow).join('')}</div>`
        : `<div class="card empty"><h3>No open positions</h3>When the bot buys, the position shows up here with its live price and P&L.</div>`}
    </div>

    <div class="section">
      <div class="section-title">History<small>${b.history.length ? `last ${Math.min(50, b.history.length)}` : ''}</small></div>
      ${b.history.length ? `<div class="card">${b.history.slice(0, 50).map(histRow).join('')}</div>`
        : `<div class="card empty"><h3>Nothing closed yet</h3>Every closed position lands here with its result and P&L after fees.</div>`}
    </div>

    <div class="section">
      <div class="section-title">Bot's eye<small>what it's flagging</small></div>
      ${b.signals.length ? `<div class="card">${b.signals.slice(0, 20).map(sigRow).join('')}</div>`
        : `<div class="card empty"><h3>Nothing flagged yet</h3>It watches every live game and the bitcoin windows, and flags the moments worth a look.</div>`}
    </div>

    <div class="section">
      <div class="section-title">The rules</div>
      <div class="card steps">
        <div class="step"><div><b>Never deposits</b>Only you add money. The bot has no way to.</div></div>
        <div class="step"><div><b>Its own ${money(b.allocation, { cents: false })}</b>It trades its bankroll plus what it wins. Your money and your bets are off limits.</div></div>
        <div class="step"><div><b>Paper until you say go</b>Live trading stays off until you switch it on and Polymarket approves API trading.</div></div>
        <div class="step"><div><b>Bets grow with the account</b>Sized off what the account is worth now, so $100 that grows to $10,000 bets a hundred times bigger, and losses shrink the bets. Never more than a sixth of the account on one bitcoin window or a third on one game, never more than the market can fill, and a stop for the day after losing a third. Your own cap per bet (BOT_MAX_BET) beats all of it.</div></div>
      </div>
    </div>`;
}

// lab ----------------------------------------------------------
function renderLab() {
  const el = $('#lab-body');
  const st = store.state || {};
  const live = store.mode !== 'preview';
  const configured = !!st.apiConfigured;
  const last = st.lastSync;
  el.innerHTML = `
    <div class="card">
      <div class="row"><div class="row-main"><div class="row-title">Polymarket API</div><div class="row-sub">${!live ? 'Preview copy' : configured ? 'Key saved in Cloudflare' : 'No key yet'}</div></div><div class="row-end"><span class="pill ${configured && live ? 'won' : 'open'}">${configured && live ? 'Connected' : 'Not connected'}</span></div></div>
      <div class="row"><div class="row-main"><div class="row-title">Last sync</div><div class="row-sub">${last ? `${last.ok ? 'OK' : 'Failed'}${last.added ? ` · ${last.added} new` : ''}${last.msg && !last.ok ? ` · ${esc(last.msg).slice(0, 80)}` : ''}` : 'Never'}</div></div><div class="row-end dim" style="font-size:15px">${last ? ago(last.t) : '–'}</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Auto sync</div><div class="row-sub">Runs on Cloudflare, phone can stay closed</div></div><div class="row-end dim" style="font-size:15px">Every 15 min</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Live game feed</div><div class="row-sub">${st.live?.now ? `${st.live.now} live · ${st.live.focus || 0} in focus · ` : 'Waiting for games · '}${Number(st.live?.ticks || 0).toLocaleString()} price ticks</div></div><div class="row-end dim" style="font-size:15px">${st.live?.last ? ago(st.live.last) : 'Every 5 s'}</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Bot's eye</div><div class="row-sub">${st.live?.lastSignal ? `${esc(SIGNAL_LABEL[st.live.lastSignal.kind] || st.live.lastSignal.kind)} · ${esc(st.live.lastSignal.detail || st.live.lastSignal.title || '')}` : 'Flags favorites fading, big swings, cheap spikes, close finishes'}</div></div><div class="row-end dim" style="font-size:15px">${Number(st.live?.signals || 0).toLocaleString()} flagged</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Game data</div><div class="row-sub">${Number(st.live?.states || 0).toLocaleString()} score updates · ${Number(st.live?.lines || 0).toLocaleString()} closing lines</div></div><div class="row-end dim" style="font-size:15px">ESPN</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Live prices</div><div class="row-sub">${st.crypto?.stream ? `Polymarket ${st.crypto.stream.toFixed(1)}/s` : 'Polymarket stream offline, polling every 5 s'} · ${st.crypto?.ticker ? `bitcoin ${Number(st.crypto.ticker).toFixed(1)}/s from Coinbase` : 'bitcoin ticker offline'}</div></div><div class="row-end"><span class="pill ${st.crypto?.stream && st.crypto?.ticker ? 'won' : 'open'}">${st.crypto?.stream && st.crypto?.ticker ? 'Live' : st.crypto?.stream || st.crypto?.ticker ? 'Partly live' : 'Polling'}</span></div></div>
      <div class="row"><div class="row-main"><div class="row-title">Crypto windows</div><div class="row-sub">${st.crypto?.btc ? `BTC ${money(st.crypto.btc, { cents: false })} · 5m 15m 1h · ` : 'Bitcoin Up or Down · '}${Number(st.crypto?.ticks || 0).toLocaleString()} ticks · volatility ×${Number(st.crypto?.volScale || 1).toFixed(2)}</div></div><div class="row-end dim" style="font-size:15px">${st.crypto?.at ? ago(st.crypto.at) : 'Every 5 s'}</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Market recorder</div><div class="row-sub">${st.recorder ? `${st.recorder.games} games tracked · ${Number(st.recorder.totalPoints || 0).toLocaleString()} price points` : 'Starting up'}</div></div><div class="row-end dim" style="font-size:15px">${st.recorder?.last ? ago(st.recorder.last) : '–'}</div></div>
    </div>
    <div style="margin-top:12px"><button class="btn" id="lab-sync">Sync now</button></div>`;
  $('#lab-sync').addEventListener('click', syncNow);
}

function connectCard() {
  return `<div class="section"><div class="card steps">
    <div class="step"><div><b>Add your Polymarket key</b>On your Mac, in the project folder: <code>npx wrangler secret put POLYMARKET_KEY_ID</code> then <code>npx wrangler secret put POLYMARKET_SECRET_KEY</code></div></div>
    <div class="step"><div><b>Tap sync</b>The first sync pulls your full history. After that it runs every 15 minutes on its own.</div></div>
  </div><div style="margin-top:12px"><button class="btn" onclick="document.getElementById('sync-btn').click()">Sync now</button></div></div>`;
}

// ---------------------------------------------------------------- springs
// Apple-style spring: response (s) + damping ratio. Starts from the current
// value with the current velocity, so any motion can be grabbed mid-flight.
function spring({ from, to, velocity = 0, damping = 1, response = 0.35, onUpdate, onDone }) {
  const k = Math.pow((2 * Math.PI) / response, 2);
  const c = (4 * Math.PI * damping) / response;
  let x = from, v = velocity, last = performance.now(), raf = 0, stopped = false;
  const tick = (now) => {
    if (stopped) return;
    const dt = Math.min(0.034, (now - last) / 1000); last = now;
    for (let i = 0; i < 6; i++) { const h = dt / 6; v += (-k * (x - to) - c * v) * h; x += v * h; }
    if (Math.abs(v) < 4 && Math.abs(x - to) < 0.4) { onUpdate(to); onDone?.(); return; }
    onUpdate(x);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { stop: () => { stopped = true; cancelAnimationFrame(raf); }, value: () => x, velocity: () => v };
}
const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
const project = (v, d = 0.998) => ((v / 1000) * d) / (1 - d);

// ---------------------------------------------------------------- sheet
const sheet = { y: 0, h: 0, anim: null, open: false };
function setSheetY(y) {
  sheet.y = y;
  $('#sheet').style.transform = `translateY(${y}px)`;
  const progress = Math.max(0, Math.min(1, 1 - y / (sheet.h || 1)));
  $('#scrim').style.opacity = String(progress);
}
function openSheet({ top, body }) {
  const el = $('#sheet');
  $('#sheet-body').innerHTML = `<div class="sheet-top">${top}</div>${body}`;
  $('#sheet-body').scrollTop = 0;
  el.style.visibility = 'hidden'; el.style.transform = 'translateY(0)';
  sheet.h = el.getBoundingClientRect().height;
  el.style.visibility = '';
  if (!sheet.open) setSheetY(sheet.h + 20);
  sheet.open = true;
  $('#scrim').style.pointerEvents = 'auto';
  sheet.anim?.stop();
  if (reduceMotion) { setSheetY(0); return; }
  sheet.anim = spring({ from: sheet.y, to: 0, damping: 1, response: 0.38, onUpdate: setSheetY });
}
function closeSheet(velocity = 0) {
  sheet.open = false;
  $('#scrim').style.pointerEvents = 'none';
  sheet.anim?.stop();
  if (reduceMotion) { setSheetY(sheet.h + 20); return; }
  sheet.anim = spring({ from: sheet.y, to: sheet.h + 20, velocity, damping: 1, response: 0.32, onUpdate: setSheetY });
}
function setupSheet() {
  const el = $('#sheet'), bodyEl = $('#sheet-body');
  $('#scrim').addEventListener('click', () => closeSheet());
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.open) closeSheet(); });

  // Drag from the grip/header anywhere, or from the body when it's scrolled to the top.
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (!sheet.open) return;
    const inBody = bodyEl.contains(e.target) && !e.target.closest('.sheet-top');
    drag = { id: e.pointerId, y0: e.clientY, start: sheet.y, inBody, active: !inBody, samples: [[performance.now(), e.clientY]] };
    if (drag.active) { sheet.anim?.stop(); el.setPointerCapture(e.pointerId); }
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (drag.inBody && bodyEl.scrollTop <= 0 && dy > 8) { drag.active = true; drag.y0 = e.clientY; sheet.anim?.stop(); el.setPointerCapture(e.pointerId); }
      else return;
    }
    const raw = drag.start + (e.clientY - drag.y0);
    setSheetY(raw < 0 ? -rubberband(-raw, sheet.h) : raw);
    drag.samples.push([performance.now(), e.clientY]);
    if (drag.samples.length > 6) drag.samples.shift();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.active) return;
    const s = d.samples, a = s[0], b = s.at(-1);
    const v = b && a && b[0] - a[0] > 0 ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;
    const landing = sheet.y + project(v);
    if (landing > sheet.h * 0.45 || v > 900) closeSheet(v);
    else { sheet.anim = spring({ from: sheet.y, to: 0, velocity: v, damping: Math.abs(v) > 300 ? 0.82 : 1, response: 0.34, onUpdate: setSheetY }); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- pull to refresh
function setupPullToRefresh(view) {
  const content = $('.content', view), ptr = $('.ptr', view), icon = $('svg', ptr);
  const THRESH = 70, HOLD = 54;
  let y0 = null, pull = 0, anim = null, busy = false, tracking = false;
  const paint = (p) => {
    pull = p;
    content.style.transform = p ? `translateY(${p}px)` : '';
    const prog = Math.min(1, p / THRESH);
    ptr.style.opacity = String(prog);
    if (!busy) icon.style.transform = `rotate(${prog * 270}deg)`;
  };
  view.addEventListener('touchstart', (e) => {
    if (busy || e.touches.length > 1) return;
    if (view.scrollTop <= 0) { anim?.stop(); y0 = e.touches[0].clientY - pull; tracking = true; } else tracking = false;
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!tracking || y0 == null || busy) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 && pull === 0) return;
    if (view.scrollTop > 0) return;
    e.preventDefault();
    paint(Math.max(0, rubberband(Math.max(0, dy), innerHeight, 0.5)));
  }, { passive: false });
  view.addEventListener('touchend', async () => {
    if (!tracking) return;
    tracking = false; y0 = null;
    if (pull >= THRESH && !busy) {
      busy = true; ptr.classList.add('loading'); icon.style.transform = '';
      anim = spring({ from: pull, to: HOLD, onUpdate: paint });
      await syncNow();
      busy = false; ptr.classList.remove('loading');
    }
    anim?.stop();
    anim = spring({ from: pull, to: 0, response: 0.4, onUpdate: paint });
  });
}

// ---------------------------------------------------------------- tabs + nav
let currentView = 'overview';
function setupTabs() {
  const navbar = $('#navbar'), small = $('#small-title');
  let current = 'overview';
  const syncNav = () => {
    const v = $(`#view-${current}`);
    small.textContent = v.dataset.title;
    navbar.classList.toggle('scrolled', v.scrollTop > 38);
  };
  $$('.view').forEach((v) => v.addEventListener('scroll', () => { if (v.classList.contains('active')) syncNav(); }, { passive: true }));
  $('#tabbar').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    const name = t.dataset.view;
    const v = $(`#view-${name}`);
    if (name === current) { v.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); return; }
    // Tabs switch instantly: you'll do this dozens of times a day.
    $(`#view-${current}`).classList.remove('active');
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    v.classList.add('active');
    current = name;
    currentView = name;
    if (name === 'bot') refreshBot({ curve: true });
    syncNav();
  });
  $('#sync-btn').addEventListener('click', syncNow);
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------- boot
setupTabs();
setupRange();
setupBets();
setupSheet();
$$('.view').forEach(setupPullToRefresh);
load();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
// Coming back to the app after a while: refresh quietly.
// The Bot tab stays live: open positions and flags refresh every 5 seconds while it's on screen.
setInterval(() => { if (currentView === 'bot' && document.visibilityState === 'visible') refreshBot(); }, 5000);

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.mode !== 'preview') load({ quiet: true }); });
