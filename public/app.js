import { summarize, buildPositions, cashFlows, priceBucket, dayKey } from './analytics.js';

// ---------------------------------------------------------------- state
const store = {
  activities: [],
  state: null,     // { snapshot, lastSync, apiConfigured }
  paper: [],
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
    fetch('/api/paper').then((r) => (r.ok ? r.json() : [])).then((p) => { store.paper = p; renderLab(); }).catch(() => {});
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

// lab ----------------------------------------------------------
function renderLab() {
  const el = $('#lab-body');
  const st = store.state || {};
  const live = store.mode !== 'preview';
  const configured = !!st.apiConfigured;
  const last = st.lastSync;
  const paper = store.paper || [];
  const graded = paper.filter((p) => p.status === 'won' || p.status === 'lost');
  const paperPnl = graded.reduce((s, p) => s + (p.pnl || 0), 0);
  el.innerHTML = `
    <div class="card">
      <div class="row"><div class="row-main"><div class="row-title">Polymarket API</div><div class="row-sub">${!live ? 'Preview copy' : configured ? 'Key saved in Cloudflare' : 'No key yet'}</div></div><div class="row-end"><span class="pill ${configured && live ? 'won' : 'open'}">${configured && live ? 'Connected' : 'Not connected'}</span></div></div>
      <div class="row"><div class="row-main"><div class="row-title">Last sync</div><div class="row-sub">${last ? `${last.ok ? 'OK' : 'Failed'}${last.added ? ` · ${last.added} new` : ''}${last.msg && !last.ok ? ` · ${esc(last.msg).slice(0, 80)}` : ''}` : 'Never'}</div></div><div class="row-end dim" style="font-size:15px">${last ? ago(last.t) : '–'}</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Auto sync</div><div class="row-sub">Runs on Cloudflare, phone can stay closed</div></div><div class="row-end dim" style="font-size:15px">Every 15 min</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Market recorder</div><div class="row-sub">${st.recorder ? `${st.recorder.games} games tracked · ${Number(st.recorder.totalPoints || 0).toLocaleString()} price points` : 'Starting up'}</div></div><div class="row-end dim" style="font-size:15px">${st.recorder?.last ? ago(st.recorder.last) : '–'}</div></div>
    </div>
    <div style="margin-top:12px"><button class="btn" id="lab-sync">Sync now</button></div>

    <div class="section">
      <div class="section-title">Paper trades<small>${graded.length ? `${graded.filter((p) => p.status === 'won').length}–${graded.filter((p) => p.status === 'lost').length} · ${money(paperPnl, { sign: true })}` : ''}</small></div>
      ${paper.length ? `<div class="card">${paper.slice(0, 50).map((p) => `<div class="row"><div class="row-main"><div class="row-title">${esc(p.title || p.market_slug)}</div><div class="row-sub">${esc(p.strategy || 'manual')} · ${esc(p.side)} @ ${cents(p.price)} · ${money(p.stake)}</div></div><div class="row-end"><span class="pill ${p.status === 'won' ? 'won' : p.status === 'lost' ? 'lost' : 'open'}">${esc(p.status)}</span>${p.pnl != null ? `<div class="row-meta ${tone(p.pnl)}">${money(p.pnl, { sign: true })}</div>` : ''}</div></div>`).join('')}</div>`
        : `<div class="card empty"><h3>No paper trades yet</h3>When a strategy runs in paper mode, every trade it would have made lands here, then gets graded when the game settles.</div>`}
    </div>

    <div class="section">
      <div class="section-title">How the experiment runs</div>
      <div class="card steps">
        <div class="step"><div><b>Paper first</b>A strategy watches markets and logs what it would buy, at what price, and why. No orders go out.</div></div>
        <div class="step"><div><b>Graded on results</b>Each paper trade settles with the real game, so the record is honest, fees included.</div></div>
        <div class="step"><div><b>Compare to you</b>After a couple of months, line its record up against yours on the Overview tab. Live trading stays off unless you switch it on in your own bot code.</div></div>
      </div>
    </div>`;
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.mode !== 'preview') load({ quiet: true }); });
