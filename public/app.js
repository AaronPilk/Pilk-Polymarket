import { summarize, buildPositions, cashFlows, priceBucket, dayKey } from './analytics.js';

// ---------------------------------------------------------------- state
const store = {
  activities: [],
  state: null,     // { snapshot, lastSync, apiConfigured }
  bot: null,      // /api/bot: the bot's own ledger
  botRange: 'run', // bot chart: run (bets on the current rules) | 1h | 1d | 1w | all
  botBook: (() => { try { return localStorage.getItem('pm-bot-book') === 'sports' ? 'sports' : 'btc'; } catch { return 'btc'; } })(), // btc | sports: two bots, two books
  botGroup: 'btc', // live | btc | hoops
  botGroupSet: false,
  botCurve: {},    // 'paper:1d' | 'live:all' ... -> { at, data } from /api/bot/curve
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
const SIGNAL_LABEL = { favorite_fade: 'Favorite fading', swing: 'Big swing', cheap_spike: 'Cheap spike', late_close: 'Close and late', fair_gap: 'Price vs math', bad_data: 'Skipped: data check' };
const SIGNAL_ICON = {
  favorite_fade: ['rgba(255,159,10,.16)', 'var(--orange)', '<path d="M4 7l6 6 3-3 7 7"/><path d="M15 17h5v-5"/>'],
  swing: ['rgba(10,132,255,.16)', 'var(--blue)', '<path d="M3 13l4-6 4 10 4-8 3 4h3"/>'],
  cheap_spike: ['rgba(48,209,88,.16)', 'var(--green)', '<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/>'],
  late_close: ['rgba(255,69,58,.16)', 'var(--red)', '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/>'],
  fair_gap: ['rgba(191,90,242,.16)', 'var(--purple, #bf5af2)', '<path d="M5 9h14M5 15h14"/>'],
  bad_data: ['rgba(255,159,10,.16)', 'var(--orange)', '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>'],
};
// What the bot did with real money, by kind.
const EVENT_ICON = {
  buy: ['rgba(48,209,88,.16)', 'var(--green)', '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'],
  sell: ['rgba(10,132,255,.16)', 'var(--blue)', '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'],
  settle: ['rgba(191,90,242,.16)', 'var(--purple, #bf5af2)', '<circle cx="12" cy="12" r="8"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'],
  preview: ['rgba(48,209,88,.16)', 'var(--green)', '<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  miss: ['rgba(118,118,128,.24)', 'var(--label-2)', '<path d="M6 12h12"/>'],
  skip: ['rgba(255,159,10,.16)', 'var(--orange)', '<path d="M5 12h14M13 6l6 6-6 6"/>'],
  error: ['rgba(255,69,58,.16)', 'var(--red)', '<path d="M12 7v6"/><path d="M12 17h.01"/>'],
  pause: ['rgba(255,69,58,.16)', 'var(--red)', '<path d="M9 6v12M15 6v12"/>'],
};
const EVENT_LABEL = { buy: 'Bought', sell: 'Sold', settle: 'Settled', preview: 'Order check', miss: 'Missed', skip: 'Skipped', error: 'Error', pause: 'Paused' };
// Closing-line value: how far the price moved our way by game time (positive = we beat it).
const clvText = (p) => {
  const v = Math.round((p.close_price - p.avg_entry) * 100);
  return `line ${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v)}¢`;
};
const API_FEE_SHARE = (0.0695 * 0.3) / 0.095;   // API taker fees after the 70% rebate, as a share of paper's
const STRATEGY_LABEL = {
  crypto_fair_v1: 'Bitcoin · price vs math',
  crypto_fair_strict: 'Bitcoin · price vs math, strict',
  crypto_fair_max: 'Bitcoin · price vs math, bigger bets',
  crypto_fair_maker: 'Bitcoin · price vs math, resting exits',
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
  hoops_comeback_v1: 'Basketball · your comeback cash-out',
  hoops_swing_v1: 'Basketball · late swing, cash out at 2×',
  hoops_swing_stop: 'Basketball · late swing, cut at half',
  hoops_swing_model: 'Basketball · late swing, math picks',
};
const variantOf = (id) => (STRATEGY_LABEL[id] || id || '').split(' · ')[1] || '';
const groupOf = (s) => (s?.startsWith('crypto_') ? 'btc' : s?.startsWith('hoops_') ? 'hoops' : 'other');
const GROUP_LABEL = { live: 'Real money', btc: 'Paper · Bitcoin', hoops: 'Paper · Basketball' };
const BOOK_LABEL = { btc: 'Bitcoin bot', sports: 'Sports bot' };
const BOOK_GROUP = { btc: 'btc', sports: 'hoops' };
const BOT_RANGE_LABEL = { run: 'This run, on the new rules', '1h': 'Last hour', '1d': 'Last 24 hours', '1w': 'Last 7 days', all: 'Since it started' };
const iconBadge = ([bg, fg, path]) => `<span class="badge" style="background:${bg};color:${fg}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
const signalBadge = (kind) => iconBadge(SIGNAL_ICON[kind] || SIGNAL_ICON.swing);

const botMode = () => (store.botGroup === 'live' ? 'live' : 'paper');
const curveKey = (mode = botMode(), range = store.botRange) => `${mode}:${range}`;
async function loadCurve(range, mode) {
  try {
    const r = await fetch(`/api/bot/curve?range=${range}&mode=${mode}`);
    if (r.ok) store.botCurve[curveKey(mode, range)] = { at: Date.now(), data: await r.json() };
  } catch {}
}
// Each bot shows only its own book: the Bitcoin bot's paper lineup (and real money once it trades),
// or the Sports bot's paper lineup. They're never added together.
const botGroups = (b) => (b?.book === 'sports' ? ['hoops'] : [...(b?.live ? ['live'] : []), 'btc']);

// /api/bot every 5 s while the tab is open; the chart data every 30 s, or right away when a trade
// closes so the line steps the moment it happens.
async function refreshBot({ curve = false } = {}) {
  if (store.mode === 'preview') return;
  try {
    const book = store.botBook;
    const r = await fetch(`/api/bot?book=${book}`);
    if (!r.ok) return;
    const b = await r.json();
    if (book !== store.botBook) return; // switched bots while this was loading
    const prev = store.bot;
    const closedChanged = !!prev && (b.record?.closed !== prev.record?.closed || b.live?.record?.closed !== prev.live?.record?.closed);
    store.bot = b;
    if (!store.botGroupSet || !botGroups(b).includes(store.botGroup)) { store.botGroup = b.book === 'sports' ? 'hoops' : b.live ? 'live' : 'btc'; store.botGroupSet = true; }
    const need = [['paper', store.botRange], ...(b.live ? [['live', store.botRange]] : [])];
    await Promise.all(need.map(([mode, range]) => {
      const c = store.botCurve[curveKey(mode, range)];
      return curve || closedChanged || !c || Date.now() - c.at > 30_000 ? loadCurve(range, mode) : null;
    }));
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
      <div class="segmented book-switch" id="bot-book" role="tablist" aria-label="Which bot"><div class="thumb"></div>
        <button data-book="btc" role="tab">Bitcoin bot</button><button data-book="sports" role="tab">Sports bot</button>
      </div>
      <div class="hero"><div class="hero-label" id="bot-label"></div><div class="hero-value num" id="bot-value">–</div><div class="hero-sub" id="bot-sub"></div></div>
      <div class="chips bot-chips" id="bot-groups"></div>
      <div class="chart-wrap" id="bot-chart"></div>
      <div class="chart-axis" id="bot-axis"></div>
      <div class="segmented" id="bot-range" role="tablist" aria-label="Chart range"><div class="thumb"></div>
        <button data-range="run" role="tab">Run</button><button data-range="1h" role="tab">1H</button><button data-range="1d" role="tab">1D</button><button data-range="1w" role="tab">1W</button><button data-range="all" role="tab">All</button>
      </div>
      <div id="bot-rest"></div>`;
    botBuilt = true;
    setupBotControls();
  }
  const groups = botGroups(b);
  $('#bot-groups').innerHTML = groups.length > 1 ? groups.map((g) => `<button class="chip ${store.botGroup === g ? 'on' : ''}" data-group="${g}">${GROUP_LABEL[g]}</button>`).join('') : '';
  if (!botScrub) { paintBotHero(); drawBotChart(); }
  $('#bot-rest').innerHTML = botRest(b);
}

function setupBotControls() {
  // Bitcoin bot | Sports bot
  const bseg = $('#bot-book'), bthumb = $('.thumb', bseg), bbtns = $$('button', bseg);
  const bplace = () => {
    const i = Math.max(0, bbtns.findIndex((x) => x.dataset.book === store.botBook));
    const w = (bseg.clientWidth - 4) / bbtns.length;
    bthumb.style.width = `${w}px`;
    bthumb.style.transform = `translateX(${i * w}px)`;
    bbtns.forEach((x, j) => x.setAttribute('aria-selected', String(j === i)));
  };
  bbtns.forEach((btn) => btn.addEventListener('click', () => {
    if (store.botBook === btn.dataset.book) return;
    store.botBook = btn.dataset.book;
    try { localStorage.setItem('pm-bot-book', store.botBook); } catch {}
    store.botGroup = BOOK_GROUP[store.botBook];
    store.botGroupSet = false;
    bplace();
    botAnimate = true;
    refreshBot({ curve: true });
  }));
  new ResizeObserver(bplace).observe(bseg);
  bplace();

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
    const modes = ['paper', ...(store.bot?.live ? ['live'] : [])];
    await Promise.all(modes.map((m) => {
      const c = store.botCurve[curveKey(m)];
      return !c || Date.now() - c.at > 30_000 ? loadCurve(store.botRange, m) : null;
    }));
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
  const c = store.botCurve[curveKey()]?.data, b = store.bot;
  if (!c || !b) return null;
  const live = store.botGroup === 'live';
  const g = live ? 'all' : store.botGroup;
  const ys = c[g] || [], ns = c.n?.[g] || [];
  const pts = [{ t: c.from, y: 0, n: 0 }];
  for (let i = 0; i < c.t.length; i++) pts.push({ t: c.t[i], y: ys[i] ?? 0, n: ns[i] ?? 0 });
  const onRules = (p) => { try { return (JSON.parse(p.meta || '{}').rules || 0) >= (b.rules || 0); } catch { return false; } };
  const positions = (live ? b.live?.positions || [] : (b.positions || []).filter((p) => g === 'all' || groupOf(p.strategy) === g))
    .filter((p) => store.botRange !== 'run' || onRules(p));
  const open = positions.reduce((s, p) => s + (p.upnl || 0), 0);
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
  const live = store.botGroup === 'live';
  const pill = live
    ? `<span class="pill ${b.live?.on ? 'won' : 'lost'}" style="vertical-align:2px;margin-left:4px">${b.live?.on ? 'Live' : 'Off'}</span>`
    : '<span class="pill open" style="vertical-align:2px;margin-left:4px">Paper</span>';
  $('#bot-label').innerHTML = `${live ? 'Real money' : GROUP_LABEL[store.botGroup]} · ${BOT_RANGE_LABEL[store.botRange]} ${pill}`;
  const fallback = live ? (b.live?.realized || 0) + (b.live?.unrealized || 0) : (b.realized || 0) + (b.unrealized || 0);
  const v = S ? S.pts.at(-1).y : fallback;
  const el = $('#bot-value');
  el.className = `hero-value num ${tone(v)}`;
  el.textContent = money(v, { sign: true });
  const parts = [];
  if (live && b.live) parts.push(`<span>Account <b>${money(b.live.equity)}</b></span>`);
  // Paper: every strategy runs its own account, so the total is out of all of them together.
  const nAcc = Object.keys(STRATEGY_LABEL).filter((id) => groupOf(id) === BOOK_GROUP[b.book || 'btc']).length;
  const paperCap = nAcc * (b.allocation || 100);
  if (!live && paperCap > 0) parts.push(`<span><b class="${tone(v)}">${signedPct(v / paperCap)}</b> of ${money(paperCap, { cents: false })} paper (${nAcc} accounts × ${money(b.allocation, { cents: false })})</span>`);
  // Fees so far, as a share of the money bet, and what the same trades would cost through the API
  // (flat 0.0695 with 70% rebated, Nov 21 to Dec 31, 2026) against paper's full 0.095.
  const onRun = store.botRange === 'run' && b.run;
  const fees = onRun ? b.run.fees || 0 : b.fees, staked = onRun ? b.run.staked || 0 : b.staked;
  if (!live && staked > 0 && fees > 0) parts.push(`<span>Fees <b>${money(fees)}</b> (${pct(fees / staked, 1)} of ${money(staked, { cents: false })} bet), about ${money(fees * API_FEE_SHARE)} through the API</span>`);
  if (!live && onRun) {
    const allTime = (b.realized || 0) + (b.unrealized || 0);
    parts.push(`<span>All-time <b class="${tone(allTime)}">${money(allTime, { sign: true })}</b>, retired tests included</span>`);
  }
  if (S) {
    const n = S.wins + S.losses;
    parts.push(n ? `<span><b>${S.wins}–${S.losses}</b> on ${n} closed</span>` : '<span>Nothing closed in this range</span>');
    if (Math.abs(S.open) >= 0.005) parts.push(`<span>Open <b class="${tone(S.open)}">${money(S.open, { sign: true })}</b></span>`);
  }
  if (live && b.live) parts.push(`<span>Trading <b>${esc(variantOf(b.live.strategy))}</b></span>`);
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

// What the bot has learned so far: how it weighs its math against the market, how far each exchange
// reads from the official index, and the times it held off (bad data, a jump, a scheduled release).
const clock = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function learnRows(m) {
  const b = m?.basis, n = Math.max(b?.n?.cb || 0, b?.n?.gm || 0);
  const reads = (name, v) => (v == null || Math.abs(v) < 0.005 ? `${name} on the index` : `${name} reads ${money(Math.abs(v))} ${v < 0 ? 'high' : 'low'}`);
  const act = m?.active || {}, start = { a: 0, b: 0.5, c: 0.5 };
  const eBl = act.early || start, lBl = act.late || (act.b != null ? act : start);
  const wOf = (x) => (x.b + x.c > 0 ? x.b / (x.b + x.c) : 0.5);
  const eN = m?.bands?.early?.windows || 0, lN = m?.bands?.late?.windows || 0;
  const bandLine = (name, x, n) => `${name}: ${n >= 100 ? `fitted from ${n} windows, ${pct(wOf(x))} math` : `starting at 50/50, fits at 100 windows (${n} so far)`}`;
  const pz = m?.paused || {}, ev = m?.nextEvent;
  const held = (pz.feeds || 0) + (pz.jumps || 0) + (pz.news || 0);
  return `<div class="learn">
    <div class="learn-row"><span>Math vs market</span><b>4+ min left ${pct(wOf(eBl))} math · last 4 min ${pct(wOf(lBl))} math</b><small>Learned separately, because late in a window the market makers' price is faster than ours. ${bandLine('4+ minutes left', eBl, eN)}; ${bandLine('last 4 minutes', lBl, lN)}. Every bet is sized and fee-checked on its band's blend.</small></div>
    <div class="learn-row"><span>Price check</span><b>${n ? `${reads('Coinbase', b.cb)} · ${reads('Gemini', b.gm)}` : 'Learning'}</b><small>${n ? `Lined up against ${n} official start prices; the bot shifts each feed onto the index.` : 'Each window start, Polymarket publishes the official price; the bot learns each exchange’s offset from it.'}</small></div>
    <div class="learn-row"><span>Fee check</span><b>${Number(m?.feeSkips || 0).toLocaleString()} skipped</b><small>Trades the math flagged where the bot's real estimate (math and market, weighed the way the grading has learned) didn't beat the price after the fee. Fees run 0.095 × price × (1 − price) per contract each way, so a buy and an early sell near 30–50¢ costs about 10% of the bet.</small></div>
    <div class="learn-row"><span>Data check</span><b>${Number(m?.skips || 0).toLocaleString()} skipped</b><small>Trades where the math and the market were more than 15 points apart. That big a gap is almost always our data, not a gift.</small></div>
    <div class="learn-row"><span>Index copy</span><b>${m?.replica?.n ? `off by ${money(m.replica.mae.corr)} vs ${money(m.replica.mae.comp)}` : 'Scoring soon'}</b><small>${m?.replica?.n ? `A copy of the settlement index rebuilt from Coinbase, Gemini and Bitstamp order books, against the bot's own price: average miss on ${m.replica.n} official start prices. Shadow only; it doesn't trade.` : 'A copy of the settlement index rebuilt from exchange order books, scored against each official start price next to the bot’s own price. Shadow only.'}</small></div>
    <div class="learn-row"><span>Held off</span><b>${held ? `${Number(pz.feeds || 0).toLocaleString()} data · ${Number(pz.jumps || 0).toLocaleString()} jumps · ${Number(pz.news || 0).toLocaleString()} news` : 'Not yet'}</b><small>Windows it sat out because Coinbase and Gemini disagreed, bitcoin had just jumped, or a jobs, CPI or Fed release was due.${ev ? ` Next pause: ${esc(ev.name)}, ${clock(ev.from)} to ${new Date(ev.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</small></div>
  </div>`;
}

function modelCard(m) {
  if (!m || !m.windows) {
    return `<div class="card pad model"><div class="model-verdict">Grading starts soon</div><div class="row-sub">Every 30 seconds the bot writes down what its math and the market said about each bitcoin window. When a window finishes, both are scored at a few fixed moments (early, middle, late) against what happened. The first fitted read comes at 100 windows, about 6 hours.</div>${learnRows(m)}</div>`;
  }
  const e = m.edge || {};
  const sure = e.t != null && Math.abs(e.t) >= 2;
  let verdict = 'Not enough to compare yet', cls = '';
  if (m.modelLoss != null && m.marketLoss != null) {
    const d = (m.marketLoss - m.modelLoss) / m.marketLoss;
    if (d > 0.005) { verdict = `Math ${pct(d, 1)} sharper than the market`; cls = sure ? 'pos' : ''; }
    else if (d < -0.005) { verdict = `Market ${pct(-d, 1)} sharper than the math`; cls = sure ? 'neg' : ''; }
    else verdict = 'Math and market about even';
  }
  const luck = e.t == null ? 'too early to say if it’s real' : sure ? `beyond luck (t ${e.t.toFixed(1)})` : `could still be luck (t ${e.t.toFixed(1)}; real at 2)`;
  const mult = Number(m.mult || 1);
  const vol = `Volatility ×${mult.toFixed(2)}${m.best != null && Math.abs(m.best - mult) > 1e-9 ? ` · best fit ×${Number(m.best).toFixed(2)}${m.gridT != null ? `, t ${Number(m.gridT).toFixed(1)}` : ''} (steps there at t 2)` : ''}`;
  return `<div class="card pad model">
    <div class="model-verdict ${cls}">${esc(verdict)}</div>
    <div class="row-sub">${m.windows} graded windows over ${e.hours || 0} hours · ${esc(luck)}</div>
    ${calChart(m.buckets || [], m.marketBuckets || [])}
    <div class="model-foot"><span><i class="cal-key math"></i>Math</span><span><i class="cal-key mkt"></i>Market</span><span>${esc(vol)}</span></div>
    ${learnRows(m)}
  </div>`;
}

// The Sports bot's math vs the market on finished games: one score per game at fixed points.
function sportsModelCard(m) {
  if (!m || !m.games) {
    return `<div class="card pad model"><div class="model-verdict">Grading starts after tonight's games</div><div class="row-sub wrap">At four points in every game (after the first quarter, halftime, after the third, about five minutes left) the bot writes down what its math and the market said. When the game is final, both get scored.${m?.pending ? ` ${m.pending} game${m.pending > 1 ? 's' : ''} waiting on a result.` : ''}</div></div>`;
  }
  const e = m.edge || {};
  const sure = e.t != null && Math.abs(e.t) >= 2;
  let verdict = 'Not enough to compare yet', cls = '';
  if (m.modelLoss != null && m.marketLoss != null) {
    const d = (m.marketLoss - m.modelLoss) / m.marketLoss;
    if (d > 0.005) { verdict = `Math ${pct(d, 1)} sharper than the market`; cls = sure ? 'pos' : ''; }
    else if (d < -0.005) { verdict = `Market ${pct(-d, 1)} sharper than the math`; cls = sure ? 'neg' : ''; }
    else verdict = 'Math and market about even';
  }
  const luck = e.t == null ? 'too early to say if it’s real' : sure ? `beyond luck (t ${e.t.toFixed(1)})` : `could still be luck (t ${e.t.toFixed(1)}; real at 2)`;
  const bl = m.blend, w = bl && bl.b + bl.c > 0 ? bl.b / (bl.b + bl.c) : null;
  return `<div class="card pad model">
    <div class="model-verdict ${cls}">${esc(verdict)}</div>
    <div class="row-sub">${m.games} graded game${m.games > 1 ? 's' : ''} · ${esc(luck)}${m.pending ? ` · ${m.pending} waiting on a result` : ''}</div>
    ${calChart(m.buckets || [], m.marketBuckets || [])}
    <div class="model-foot"><span><i class="cal-key math"></i>Math</span><span><i class="cal-key mkt"></i>Market</span>${w != null ? `<span>Best blend ${pct(w)} math</span>` : ''}</div>
  </div>`;
}

// Selling early vs holding to the result, per strategy, against how each window actually settled.
function exitCard(x) {
  const rows = Object.entries(x || {}).filter(([, v]) => v.early > 0);
  if (!rows.length) return '';
  const tot = rows.reduce((a, [, v]) => ({ vs: a.vs + v.vsHold, saved: a.saved + v.saved, gave: a.gave + v.gaveUp, early: a.early + v.early, winners: a.winners + v.winners }), { vs: 0, saved: 0, gave: 0, early: 0, winners: 0 });
  return `<div class="card">
    <div class="row"><div class="row-main"><div class="row-title">${tot.vs >= 0 ? `Selling early beat holding by ${money(tot.vs)}` : `Holding would have made ${money(-tot.vs)} more`}</div><div class="row-sub wrap">${tot.early} early sales against how their windows settled: ${money(tot.saved)} kept on ${tot.early - tot.winners} that would have lost, ${money(tot.gave)} left on ${tot.winners} that would have won.</div></div></div>
    ${rows.sort((a, b) => b[1].vsHold - a[1].vsHold).map(([id, v]) => `<div class="row"><div class="row-main"><div class="row-title">${esc(variantOf(id) || id)}</div><div class="row-sub">${v.early} sold early · ${money(v.saved)} kept · ${money(v.gaveUp)} left</div></div><div class="row-end"><div class="row-amt ${tone(v.vsHold)}">${money(v.vsHold, { sign: true })}</div></div></div>`).join('')}
  </div>`;
}

// Head to head: both bots on the same rules. Return on money bet is the fair yardstick, since the
// Bitcoin bot places far more (and smaller) bets than the Sports bot.
const STATUS_PILL = { proven: ['won', 'Proven'], promising: ['open', 'Promising'], testing: ['', 'Testing'], retired: ['lost', 'Retired'] };
function researchCard(lab) {
  if (!lab?.strategies) return '<div class="card pad">Every 5 minutes the board judges each strategy on its bets under the new rules: losers retire, winners bet more. First verdicts in a few minutes.</div>';
  const order = { proven: 0, promising: 1, testing: 2, retired: 3 };
  const rows = Object.entries(lab.strategies).filter(([id]) => STRATEGY_LABEL[id])
    .sort((x, y) => order[x[1].status] - order[y[1].status] || (y[1].low ?? -9) - (x[1].low ?? -9) || (y[1].n || 0) - (x[1].n || 0));
  const top = (lab.top || []).filter((id) => STRATEGY_LABEL[id]).map((id) => esc(variantOf(id)));
  const count = (k) => rows.filter(([, v]) => v.status === k).length;
  return `<div class="card">
    <div class="row"><div class="row-main"><div class="row-title">Top 3 so far</div><div class="row-sub">${top.length ? top.join(' · ') : 'Nothing has earned it yet. A strategy needs 30 bets on the new rules and to be ahead by more than its noise.'}</div></div><div class="row-end dim">${count('proven')} proven · ${count('promising')} promising · ${count('testing')} testing · ${count('retired')} retired</div></div>
    ${rows.map(([id, v]) => `<div class="row"><div class="row-main"><div class="row-title">${esc(variantOf(id))} <span class="pill ${STATUS_PILL[v.status]?.[0] || ''}">${STATUS_PILL[v.status]?.[1] || esc(v.status)}</span></div><div class="row-sub">${esc(v.reason || '')}</div></div><div class="row-end"><div class="row-amt ${tone(v.pnl || 0)}">${v.n ? money(v.pnl || 0, { sign: true }) : '–'}</div></div></div>`).join('')}
  </div>`;
}

function compareCard(c) {
  if (!c || !c.btc || !c.sports) return '';
  const col = (k, name) => {
    const x = c[k];
    return `<div class="vs-col"><div class="vs-name">${name}</div>
      <div class="vs-big num ${x.roi == null ? '' : tone(x.roi)}">${x.roi == null ? '–' : signedPct(x.roi)}</div>
      <div class="vs-sub">return on ${money(x.staked)} bet</div>
      <div class="vs-line"><span>P&L</span><b class="num ${tone(x.pnl)}">${money(x.pnl, { sign: true })}</b></div>
      <div class="vs-line"><span>Record</span><b class="num">${x.closed ? `${x.wins}–${x.closed - x.wins}` : '–'}</b></div>
      <div class="vs-line"><span>${k === 'btc' ? 'Windows' : 'Games'}</span><b class="num">${x.markets}</b></div>
      <div class="vs-line"><span>Best</span><b>${x.best ? esc(variantOf(x.best.strategy) || x.best.strategy) : '–'}</b></div>
    </div>`;
  };
  const a = c.btc, s2 = c.sports;
  const enough = a.closed >= 100 && s2.closed >= 100 && s2.markets >= 30;
  const lead = a.roi != null && s2.roi != null && a.closed && s2.closed
    ? (Math.abs(a.roi - s2.roi) < 0.01 ? 'Even so far' : `${a.roi > s2.roi ? 'Bitcoin' : 'Sports'} is ahead per dollar bet`)
    : 'Not enough closed trades to compare yet';
  return `<div class="card pad">
    <div class="vs">${col('btc', 'Bitcoin bot')}${col('sports', 'Sports bot')}</div>
    <div class="row-sub wrap" style="margin-top:10px">${esc(lead)}${enough ? '.' : '. Early: a fair read needs 100+ closed trades on each side and 30+ different games.'}</div>
  </div>`;
}

// Ready for real money? Five checks on the strategy that would trade it, each asking whether the
// result could be luck. All green means it has been consistent on paper; the switch is still Aaron's.
function readyCard(r) {
  if (!r) return '';
  const need = r.need || { windows: 300, edgeT: 2, trades: 200, block: 50, profitT: 2, maxDD: 0.2, games: 40 };
  const sports = r.kind === 'sports';
  const t = (x) => (x == null ? '–' : Number(x).toFixed(1));
  const rows = [
    sports
      ? ['math', 'Enough different games', `${r.games ?? 0} of ${need.games} games (trades in one game count as one bet)`]
      : ['math', 'The math beats the market, beyond luck', r.ok.math ? `${pct(r.sharper, 1)} sharper over ${r.windows} windows, t ${t(r.edgeT)}`
        : r.windows < need.windows ? `${r.windows} of ${need.windows} windows graded${r.edgeT != null ? ` · t ${t(r.edgeT)} so far (needs ${need.edgeT})` : ''}`
        : r.edgeT == null ? 'Not scored yet' : `Needs t ${need.edgeT}; it's ${t(r.edgeT)}${r.sharper != null ? ` (${signedPct(r.sharper)} vs the market)` : ''}`],
    ['trades', 'Enough trades', `${r.n} of ${need.trades} closed${sports ? '' : ' since the fix'}`],
    ['profit', 'Making money, beyond luck', r.n ? `${money(r.pnl, { sign: true })} on ${money(r.staked)} bet · t ${t(r.profitT)} across ${r.groups} ${sports ? 'games' : 'hours'} (needs ${need.profitT})` : 'No closed trades yet'],
    ['steady', 'Consistent', r.blocks ? `Last ${need.block * 3} trades in blocks of ${need.block}: ${r.blocks.map((x) => money(x, { sign: true })).join(' · ')}. The newest and two of three must be up.` : `Needs ${need.block * 3} trades to split into three blocks`],
    ['drawdown', 'Small drawdowns', r.n >= need.block ? `Worst drop from its high: ${pct(r.maxDD, 1)} (limit ${pct(need.maxDD)})` : `Needs ${need.block} trades`],
  ];
  const done = rows.filter(([k]) => r.ok[k]).length;
  return `<div class="card">
    <div class="row"><div class="row-main"><div class="row-title">${r.ready ? 'Ready for real money' : `Not yet: ${done} of 5 checks`}</div><div class="row-sub wrap">${esc(variantOf(r.strategy) || r.strategy)} on paper${sports ? '' : ' since the fix'}. All five green means it has been consistent, not lucky.${sports ? ' The Sports bot has no real-money engine yet; this says when it is worth building.' : ' The switch is still yours.'}</div></div><div class="row-end"><span class="pill ${r.ready ? 'won' : 'open'}">${r.ready ? 'Ready' : 'Paper'}</span></div></div>
    ${rows.map(([k, label, detail]) => `<div class="row check-row"><span class="check ${r.ok[k] ? 'ok' : ''}">${r.ok[k] ? '✓' : ''}</span><div class="row-main"><div class="row-title">${label}</div><div class="row-sub wrap">${esc(detail)}</div></div></div>`).join('')}
  </div>`;
}

// The risk ladder: where the account is now, and the rungs above it.
function riskCard(k) {
  if (!k) return '';
  const rung = (at) => (at >= 1000 ? `$${(at / 1000).toLocaleString()}K` : `$${at}`);
  const under = k.peak > 0 ? (k.peak - k.equity) / k.peak : 0;
  const now = k.ladder.reduce((a, x) => (k.peak >= x.at ? x : a), k.ladder[0]);
  return `<div class="card pad">
    <div class="risk-now">Up to ${money(k.equity * k.bet)} a bet · ${money(Math.max(0, k.equity * k.open))} open at once</div>
    <div class="row-sub wrap">${k.account === 'live' ? 'Real-money account' : `${esc(variantOf(k.strategy) || 'Paper account')}`} at ${money(k.equity)}, high ${money(k.peak)}. Floor ${money(k.floor)}: ${under > 0.0005 ? `it's ${pct(under, 1)} under its high, so bets run at ${pct(k.scale)} size` : 'at its high, so bets run at full size'}. Half way to the floor means half size; at the floor it stops.</div>
    <table class="ladder"><thead><tr><th>Account</th><th>A bet</th><th>All open</th><th>Gives back</th></tr></thead><tbody>
      ${k.ladder.map((x) => `<tr class="${x === now ? 'on' : ''}"><td>${rung(x.at)}</td><td>${pct(x.bet, x.bet < 0.02 ? 1 : 0)}</td><td>${pct(x.open)}</td><td>${pct(x.dd)}</td></tr>`).join('')}
    </tbody></table>
    <div class="row-sub wrap" style="margin-top:8px">Between rungs it slides smoothly. Kelly picks the bet inside these limits from the edge over the blended price (math and market, weighted by the grading), so it bets what it wants until the ladder says enough.</div>
  </div>`;
}

const posRow = (p) => {
  const plan = [`in at ${cents(p.avg_entry)}`, p.adds ? `${p.adds} add${p.adds > 1 ? 's' : ''}` : null, p.take_profit ? `sells at ${cents(p.take_profit)}` : null, String(p.reason || '').startsWith('probe') ? 'probe' : null, p.mode === 'live' ? null : variantOf(p.strategy) || null].filter(Boolean).join(' · ');
  return `<div class="row with-badge">${badge(p.side_name || p.title)}<div class="row-main"><div class="row-title">${esc(p.side_name || p.side)}${p.qty ? ` <span class="faint">× ${Number(p.qty)}</span>` : ''}</div><div class="row-sub">${esc(plan)}</div></div><div class="row-end"><div class="row-amt">${cents(p.price)}</div><div class="row-meta ${p.upnl != null ? tone(p.upnl) : ''}">${p.upnl != null ? money(p.upnl, { sign: true }) : '–'}</div></div></div>`;
};
const histRow = (p) => {
  const how = p.status === 'settled' ? (p.result ? 'Won' : 'Lost') : 'Sold';
  const sub = [`in at ${cents(p.avg_entry)}`, p.adds ? `${p.adds} add${p.adds > 1 ? 's' : ''}` : null, p.close_price != null && p.avg_entry != null ? clvText(p) : null, String(p.reason || '').startsWith('probe') ? 'probe' : null, p.mode === 'live' ? null : variantOf(p.strategy) || null].filter(Boolean).join(' · ');
  return `<div class="row with-badge">${badge(p.side_name || p.title)}<div class="row-main"><div class="row-title">${how} · ${esc(p.side_name || p.side)}</div><div class="row-sub">${esc(sub)}</div></div><div class="row-end"><div class="row-amt ${tone(p.pnl || 0)}">${money(p.pnl || 0, { sign: true })}</div><div class="row-meta">${p.closed_at ? ago(new Date(p.closed_at).toISOString()) : ''}</div></div></div>`;
};
const sigRow = (s) => `<div class="row with-badge">${signalBadge(s.kind)}<div class="row-main"><div class="row-title">${esc(SIGNAL_LABEL[s.kind] || s.kind)}</div><div class="row-sub">${esc(s.detail || s.title || s.slug)}</div></div><div class="row-end"><div class="row-amt">${s.price != null ? cents(s.price) : ''}</div><div class="row-meta">${ago(new Date(s.ts).toISOString())}</div></div></div>`;
const eventRow = (e) => `<div class="row with-badge event">${iconBadge(EVENT_ICON[e.kind] || EVENT_ICON.miss)}<div class="row-main"><div class="row-title">${esc(EVENT_LABEL[e.kind] || e.kind)}</div><div class="row-sub wrap">${esc(e.detail || '')}</div></div><div class="row-end"><div class="row-meta">${ago(new Date(e.ts).toISOString())}</div></div></div>`;

// The real-money account: its numbers, positions, history and a log of every order in plain words.
function liveSection(L) {
  const losses = (L.record?.closed || 0) - (L.record?.wins || 0);
  const tiles = [
    { label: 'Account', value: money(L.equity), foot: `started ${money(store.bot.allocation, { cents: false })}` },
    { label: 'Available', value: money(L.available), foot: `${money(L.atRisk)} in ${L.positions.length} open` },
    { label: 'Record', value: L.record?.closed ? `${L.record.wins}–${losses}` : '–', foot: 'closed, real money' },
    { label: 'Realized', value: money(L.realized || 0, { sign: true }), cls: tone(L.realized || 0), foot: 'after fees, before rebates' },
  ];
  return `
    <div class="section"><div class="stats">${tiles.map(statTile).join('')}</div></div>
    ${L.on ? '' : `<div class="section"><div class="card pad off-note"><b>Real trading is off.</b> Open positions ride to their result; set LIVE_TRADING to on in Cloudflare to start again.</div></div>`}
    <div class="section">
      <div class="section-title">Open · real money<small>${L.positions.length ? 'live prices' : ''}</small></div>
      ${L.positions.length ? `<div class="card">${L.positions.map(posRow).join('')}</div>`
        : `<div class="card empty"><h3>No open positions</h3>${L.on ? `Trading ${esc(variantOf(L.strategy))}. When it buys, the position shows up here.` : 'Real trading is off.'}</div>`}
    </div>
    <div class="section">
      <div class="section-title">What it did<small>every order, in order</small></div>
      ${L.events.length ? `<div class="card">${L.events.slice(0, 25).map(eventRow).join('')}</div>`
        : `<div class="card empty"><h3>Nothing yet</h3>Its first move will be an order check with Polymarket, then a real buy when the math finds a mispriced window.</div>`}
    </div>
    <div class="section">
      <div class="section-title">History · real money<small>${L.history.length ? `last ${Math.min(50, L.history.length)}` : ''}</small></div>
      ${L.history.length ? `<div class="card">${L.history.slice(0, 50).map(histRow).join('')}</div>`
        : `<div class="card empty"><h3>Nothing closed yet</h3>Every closed real-money position lands here with its result and P&L after fees.</div>`}
    </div>`;
}

function botRest(b) {
  const L = b.live;
  const losses = (b.record?.closed || 0) - (b.record?.wins || 0);
  // Each paper strategy runs its own account; the sparkline is its P&L over the chart's range.
  const strat = store.botCurve[curveKey('paper')]?.data?.strat || {};
  const book = b.book || 'btc', group = BOOK_GROUP[book];
  const ids = Object.keys(STRATEGY_LABEL).filter((id) => groupOf(id) === group);
  const lineup = ids.map((id) => ({ strategy: id, closed: 0, wins: 0, open: 0, pnl: 0, staked: 0, ...((b.byStrategy || []).find((x) => x.strategy === id) || {}) }));
  const leader = lineup.filter((x) => x.closed).sort((x, y) => y.pnl - x.pnl)[0];
  const tiles = [
    { label: 'Open', value: String(b.positions.length), foot: `${money(b.atRisk)} at risk` },
    { label: 'Record', value: b.record?.closed ? `${b.record.wins}–${losses}` : '–', foot: 'all paper, all time' },
    { label: 'Realized', value: money(b.realized || 0, { sign: true }), cls: tone(b.realized || 0), foot: 'paper, after fees' },
    { label: 'Leading', value: leader ? money(leader.pnl, { sign: true }) : '–', cls: leader ? tone(leader.pnl) : '', foot: leader ? variantOf(leader.strategy) || leader.strategy : 'no closed trades yet' },
  ];
  const stratGroup = (g, title) => {
    const rows = lineup.filter((x) => groupOf(x.strategy) === g);
    if (!rows.length) return '';
    const total = rows.reduce((s, x) => s + (x.pnl || 0), 0);
    return `<div class="group-head" style="display:flex;justify-content:space-between"><span>${title}</span><span class="num ${tone(total)}">${money(total, { sign: true })}</span></div>
      <div class="card">${rows.map((x) => `<div class="row"><div class="row-main"><div class="row-title">${esc(variantOf(x.strategy))}${L && L.strategy === x.strategy ? ' <span class="pill won">Real money</span>' : ''}</div><div class="row-sub">${x.closed ? `${x.wins}–${x.closed - x.wins} · ${x.staked ? signedPct(x.pnl / x.staked) : '–'} on ${money(x.staked)}` : 'No closed trades yet'}${x.open ? ` · ${x.open} open` : ''}${b.exits?.[x.strategy]?.early ? ` · early sells ${money(b.exits[x.strategy].vsHold, { sign: true })} vs holding` : ''}${b.records?.[x.strategy]?.f > 0 ? ` · sizing up on its record (${signedPct(b.records[x.strategy].mean)} a dollar, t ${Number(b.records[x.strategy].t).toFixed(1)})` : ''}</div></div><div class="row-end strat-end">${spark(strat[x.strategy])}<div class="row-amt ${tone(x.pnl)}">${money(x.pnl, { sign: true })}</div></div></div>`).join('')}</div>`;
  };
  const showLive = L && store.botGroup === 'live';

  return `
    ${showLive ? liveSection(L) : ''}

    <div class="section">
      <div class="section-title">Research board<small>judged every 5 minutes on the new rules</small></div>
      ${researchCard(b.lab)}
    </div>

    <div class="section">
      <div class="section-title">Head to head<small>paper, same rules</small></div>
      ${compareCard(b.compare)}
    </div>

    ${L?.on ? '' : `<div class="section">
      <div class="section-title">Ready for real money?<small>${esc(variantOf(b.ready?.strategy) || '')}</small></div>
      ${readyCard(b.ready)}
    </div>`}

    ${book === 'btc' ? `<div class="section">
      <div class="section-title">Bitcoin model check<small>math vs market</small></div>
      ${modelCard(b.model)}
    </div>` : ''}

    ${book === 'sports' ? `<div class="section">
      <div class="section-title">Sports model check<small>math vs market, per game</small></div>
      ${sportsModelCard(b.model)}
    </div>` : ''}

    ${book === 'btc' && exitCard(b.exits) ? `<div class="section">
      <div class="section-title">Sell early or hold?<small>since the 4 PM fix, against how each window settled</small></div>
      ${exitCard(b.exits)}
    </div>` : ''}

    <div class="section">
      <div class="section-title">Risk ladder<small>grows the account, protects the high</small></div>
      ${riskCard(b.risk)}
    </div>

    <div class="section">
      <div class="section-title">Paper strategies<small>each its own ${money(b.allocation, { cents: false })}</small></div>
      <div class="stats" style="margin-bottom:6px">${tiles.map(statTile).join('')}</div>
      ${stratGroup(group, book === 'btc' ? 'Bitcoin' : 'Basketball')}
      ${book === 'sports' && !b.sports ? '<div class="card pad off-note"><b>The Sports bot is asleep.</b> SPORTS is set to off in Cloudflare.</div>' : ''}
    </div>

    ${showLive ? '' : `<div class="section">
      <div class="section-title">Open · paper<small>${b.positions.length ? 'live prices' : ''}</small></div>
      ${b.positions.length ? `<div class="card">${b.positions.map(posRow).join('')}</div>`
        : `<div class="card empty"><h3>No open paper positions</h3>When a paper strategy buys, it shows up here with its live price and P&L.</div>`}
    </div>
    <div class="section">
      <div class="section-title">History · paper<small>${b.history.length ? `last ${Math.min(50, b.history.length)}` : ''}</small></div>
      ${b.history.length ? `<div class="card">${b.history.slice(0, 50).map(histRow).join('')}</div>`
        : `<div class="card empty"><h3>Nothing closed yet</h3>Every closed paper position lands here with its result and P&L after fees.</div>`}
    </div>`}

    <div class="section">
      <div class="section-title">Bot's eye<small>what it's flagging</small></div>
      ${b.signals.length ? `<div class="card">${b.signals.slice(0, 20).map(sigRow).join('')}</div>`
        : `<div class="card empty"><h3>Nothing flagged yet</h3>${book === 'btc' ? 'It watches the bitcoin windows and flags the moments worth a look.' : 'It watches live NBA and college games and flags the moments worth a look.'}</div>`}
    </div>

    <div class="section">
      <div class="section-title">The rules</div>
      <div class="card steps">
        <div class="step"><div><b>Two bots, separate books</b>The Bitcoin bot and the Sports bot each keep their own accounts, their own learning and their own records. Nothing is ever added together; the head-to-head just compares them on the same rules.</div></div>
        <div class="step"><div><b>Never deposits</b>Only you add money. The bot has no way to.</div></div>
        <div class="step"><div><b>Its own ${money(b.allocation, { cents: false })}</b>It trades its bankroll plus what it wins. Your money and your bets are off limits, and it skips any window where you hold a position or have orders.</div></div>
        <div class="step"><div><b>Your switch</b>Real orders only while LIVE_TRADING is on in Cloudflare, and only the Bitcoin bot has a real-money engine so far. Turn it off and it stops placing orders right away; open positions ride to their result.</div></div>
        <div class="step"><div><b>Never pays more than it saw</b>Every buy is a limit order at the price it saw, cancelled if it doesn't fill on the spot. It checks its first order with Polymarket's preview before placing anything real.</div></div>
        <div class="step"><div><b>Bets grow with the account, inside the ladder</b>Sized off what the account is worth now, the blend of math and market the grading has fitted, and the strategy's own record once it has shown an edge beyond luck. When the math flags a trade nothing backs, paper strategies still buy one contract so they keep learning; real money never does. Small accounts can bet up to 10% at a time; by $100K it's 1.5%. Below its high, bets shrink in step toward a floor, so a bad run can't dig a deep hole. Never more than the market can fill. Your own cap per bet (BOT_MAX_BET) beats all of it.</div></div>
        <div class="step"><div><b>Checks its data first</b>It only trades on prices fresh off live streams, bitcoin and Polymarket both, lined up with the official index. If its math and the market are more than 15 points apart it skips the trade, and after a losing exit it stays out of that window. It sits out while Coinbase and Gemini disagree, for 20 seconds after a sudden jump, and around jobs, CPI and Fed releases.</div></div>
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
      ${st.money?.sports ? '' : '<!-- sports off -->'}<div class="row" ${st.money?.sports ? '' : 'hidden'}><div class="row-main"><div class="row-title">Live game feed</div><div class="row-sub">${st.live?.now ? `${st.live.now} live · ${st.live.focus || 0} in focus · ` : 'Waiting for games · '}${Number(st.live?.ticks || 0).toLocaleString()} price ticks</div></div><div class="row-end dim" style="font-size:15px">${st.live?.last ? ago(st.live.last) : 'Every 5 s'}</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Bot's eye</div><div class="row-sub">${st.live?.lastSignal ? `${esc(SIGNAL_LABEL[st.live.lastSignal.kind] || st.live.lastSignal.kind)} · ${esc(st.live.lastSignal.detail || st.live.lastSignal.title || '')}` : 'Flags favorites fading, big swings, cheap spikes, close finishes'}</div></div><div class="row-end dim" style="font-size:15px">${Number(st.live?.signals || 0).toLocaleString()} flagged</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Game data</div><div class="row-sub">${Number(st.live?.states || 0).toLocaleString()} score updates · ${Number(st.live?.lines || 0).toLocaleString()} closing lines</div></div><div class="row-end dim" style="font-size:15px">ESPN</div></div>
      <div class="row"><div class="row-main"><div class="row-title">Real-money trading</div><div class="row-sub">${st.money?.on ? `${esc(variantOf(st.money.strategy))} · ` : 'Off · '}${st.money?.last ? esc(String(st.money.last.detail || '').slice(0, 90)) : 'no orders yet'}</div></div><div class="row-end"><span class="pill ${st.money?.on ? 'won' : 'open'}">${st.money?.on ? 'On' : 'Off'}</span></div></div>
      <div class="row"><div class="row-main"><div class="row-title">Live prices</div><div class="row-sub">${st.crypto?.stream ? `Polymarket ${st.crypto.stream.toFixed(1)}/s` : 'Polymarket stream offline, polling every 5 s'} · ${st.crypto?.gemini ? `Gemini ${Number(st.crypto.gemini).toFixed(1)}/s` : 'Gemini offline'} · ${st.crypto?.ticker ? `Coinbase ${Number(st.crypto.ticker).toFixed(1)}/s` : 'Coinbase quiet'}</div></div><div class="row-end"><span class="pill ${st.crypto?.stream && (st.crypto?.ticker || st.crypto?.gemini) ? 'won' : 'open'}">${st.crypto?.stream && (st.crypto?.ticker || st.crypto?.gemini) ? 'Live' : st.crypto?.stream || st.crypto?.ticker || st.crypto?.gemini ? 'Partly live' : 'Polling'}</span></div></div>
      <div class="row"><div class="row-main"><div class="row-title">Crypto windows</div><div class="row-sub">${st.crypto?.btc ? `BTC ${money(st.crypto.btc, { cents: false })} · 5m 15m 1h · ` : 'Bitcoin Up or Down · '}${Number(st.crypto?.ticks || 0).toLocaleString()} ticks · volatility ×${Number(st.crypto?.volScale || 1).toFixed(2)} · math weight ${pct(st.crypto?.mathWeight ?? 0.5)} · ${Number(st.crypto?.skipped || 0).toLocaleString()} skipped by the data check · ${Number(st.crypto?.feeSkips || 0).toLocaleString()} on fees · ${Number((st.crypto?.paused?.feeds || 0) + (st.crypto?.paused?.jumps || 0) + (st.crypto?.paused?.news || 0)).toLocaleString()} held off · index copy ${st.crypto?.replicaBooks ? `on ${st.crypto.replicaBooks} of 3 books` : 'offline'}</div></div><div class="row-end dim" style="font-size:15px">${st.crypto?.at ? ago(st.crypto.at) : 'Every 5 s'}</div></div>
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
