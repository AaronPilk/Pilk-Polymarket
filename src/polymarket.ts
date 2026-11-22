// Polymarket US Retail API client for Cloudflare Workers.
// Auth: Ed25519 signature over `${timestampMs}${METHOD}${path}`, sent as
// X-PM-Access-Key / X-PM-Timestamp / X-PM-Signature. Docs: docs.polymarket.us

export interface PmEnv {
  POLYMARKET_KEY_ID: string;
  POLYMARKET_SECRET_KEY: string; // base64; first 32 bytes are the Ed25519 seed
}

const API = 'https://api.polymarket.us';
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

let cachedKey: { secret: string; key: CryptoKey } | null = null;

export async function importSigningKey(secretB64: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secretB64) return cachedKey.key;
  const raw = Uint8Array.from(atob(secretB64.trim()), (c) => c.charCodeAt(0));
  if (raw.length < 32) throw new Error('POLYMARKET_SECRET_KEY must decode to at least 32 bytes');
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(raw.slice(0, 32), 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  cachedKey = { secret: secretB64, key };
  return key;
}

function b64(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

export async function signedHeaders(env: PmEnv, method: string, path: string): Promise<Record<string, string>> {
  const key = await importSigningKey(env.POLYMARKET_SECRET_KEY);
  const ts = Date.now().toString();
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(`${ts}${method}${path}`));
  return {
    'X-PM-Access-Key': env.POLYMARKET_KEY_ID,
    'X-PM-Timestamp': ts,
    'X-PM-Signature': b64(sig),
    'Content-Type': 'application/json',
  };
}

export async function pm<T = any>(env: PmEnv, method: string, path: string, query?: URLSearchParams, body?: unknown): Promise<T> {
  const qs = query && [...query.keys()].length ? `?${query}` : '';
  // The docs sign the bare path. If the server wants the query signed too, retry once that way.
  for (const signPath of qs ? [path, path + qs] : [path]) {
    const res = await fetch(API + path + qs, {
      method,
      headers: await signedHeaders(env, method, signPath),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && signPath !== path + qs && qs) continue;
    if (!res.ok) throw new Error(`Polymarket ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
  throw new Error(`Polymarket ${method} ${path} -> 401 unauthorized`);
}

// ---- Normalization: one flat row per activity, same shape the dashboard reads.

const n = (v: any): number | null => (v == null ? null : Number(v?.value ?? v));

export interface Row {
  id: string; type: string; t: string;
  action?: string; title?: string; sub?: string; ev?: string; evSlug?: string; mkt?: string;
  cat?: string; smt?: string; sub2?: string; gameStart?: string;
  price?: number | null; entry?: number | null; qty?: number | null; cost?: number | null; basis?: number | null;
  fee?: number | null; settle?: number | null; payout?: number | null; pnl?: number | null;
  order?: string; color?: string; done?: string; amount?: number | null; status?: string; method?: string;
}

// Two shapes reach us: the website's rich activity feed (title, action, cost, fee...)
// and the public API's lean v1 feed (createTime, qtyDecimal, costBasis, before/after
// positions). Read whichever fields exist; never invent a value we can't see.
export function normalize(a: any): Row {
  const type = String(a.type || '').replace('ACTIVITY_TYPE_', '');
  if (a.trade) return normalizeTrade(a, type);
  if (a.positionResolution) return normalizeResolution(a, type);
  return normalizeBalance(a, type);
}

function normalizeTrade(a: any, type: string): Row {
  const x = a.trade, m = x.market || {}, meta = x.marketMetadata || {};
  const qtyRaw = n(x.qtyDecimal ?? x.qty);
  const qty = qtyRaw == null ? null : Math.abs(qtyRaw);
  const price = n(x.price);
  const side = String(x.side || x.action || '').toLowerCase();
  const pnl = n(x.realizedPnl);
  const sold = side.includes('sell') || side === 'sold' || (qtyRaw != null && qtyRaw < 0) || (!side && pnl != null && pnl !== 0);
  const cost = n(x.cost) ?? (price != null && qty != null ? price * qty : null);
  return clean({
    id: a.id || `trade_${x.id}`, type, t: x.time || x.createTime || x.updateTime,
    action: x.action || (sold ? 'sold' : 'bought'),
    title: x.title || meta.outcome || meta.title, sub: x.subtitle || meta.title,
    ev: x.eventMetadata?.title, evSlug: x.eventMetadata?.slug || meta.eventSlug, mkt: x.marketSlug || meta.slug,
    cat: m.category, smt: m.sportsMarketType, sub2: m.eventSubcategory, gameStart: m.gameStartTime,
    price, entry: n(x.entryPrice), qty, cost, basis: n(x.costBasis), fee: n(x.commission ?? x.fee),
    pnl: sold ? pnl : null, order: x.orderId, color: x.color?.dark,
  });
}

// ---- Fills: the public API returns one TRADE per fill. An order that fills in pieces
// shows up as several trades. We store fills and roll them up into one row per order,
// which is how the website shows them.

export interface Fill {
  id: string; orderId: string; t: string; mkt: string; action: 'bought' | 'sold';
  title?: string; sub?: string; evSlug?: string;
  shares: number; price: number; pnl: number | null; feeCum: number | null;
}

export function isApiFill(a: any): boolean {
  return !!(a?.trade && (a.trade.aggressorExecution || a.trade.passiveExecution));
}

export function parseFill(a: any): Fill | null {
  const x = a.trade;
  if (!x) return null;
  const exec = x.isAggressor === false ? x.passiveExecution : (x.aggressorExecution || x.passiveExecution);
  const order = exec?.order;
  if (!order?.id) return null;
  const intent = String(order.intent || '');
  const isShort = intent.endsWith('SHORT');
  const isBuy = intent.startsWith('ORDER_INTENT_BUY') || (!intent && String(order.action || '').endsWith('BUY'));
  const pxLong = n(exec.lastPx) ?? n(x.price);
  const shares = n(exec.lastShares) ?? n(x.qtyDecimal ?? x.qty);
  if (pxLong == null || shares == null) return null;
  const meta = order.marketMetadata || x.marketMetadata || {};
  const longTeam = meta.team?.safeName || meta.team?.name || meta.outcome;
  return {
    id: `fill_${x.id}`, orderId: order.id, t: order.insertTime || x.createTime || x.updateTime,
    mkt: order.marketSlug || meta.slug, action: isBuy ? 'bought' : 'sold',
    title: isShort ? otherSide(meta.title, longTeam) : longTeam, sub: meta.title, evSlug: meta.eventSlug,
    shares, price: isShort ? 1 - pxLong : pxLong, pnl: n(x.realizedPnl), feeCum: n(order.commissionNotionalTotalCollected),
  };
}

// "LSU vs. Tennessee" with LSU as the long side -> "Tennessee".
function otherSide(gameTitle: string | undefined, longTeam: string | undefined): string | undefined {
  if (!gameTitle) return longTeam ? `Against ${longTeam}` : undefined;
  const parts = gameTitle.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return gameTitle;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const l = norm(longTeam || '');
  const pick = parts.find((p) => !l || (!norm(p).includes(l) && !l.includes(norm(p))));
  return pick || parts[1];
}

export function aggregateOrder(fills: Fill[]): Row | null {
  if (!fills.length) return null;
  const f0 = fills[0];
  const qty = fills.reduce((s, f) => s + f.shares, 0);
  const notional = fills.reduce((s, f) => s + f.shares * f.price, 0);
  const fees = fills.map((f) => f.feeCum).filter((v): v is number => v != null);
  const fee = fees.length ? Math.max(...fees) : null;
  const pnls = fills.map((f) => f.pnl).filter((v): v is number => v != null);
  const sold = f0.action === 'sold';
  return clean({
    id: `ord_${f0.orderId}`, type: 'TRADE', t: fills.map((f) => f.t).sort()[0], action: f0.action,
    title: f0.title, sub: f0.sub, evSlug: f0.evSlug, mkt: f0.mkt,
    price: qty ? notional / qty : null, qty, cost: sold ? notional - (fee || 0) : notional + (fee || 0),
    fee, pnl: sold && pnls.length ? pnls.reduce((s, v) => s + v, 0) : null, order: f0.orderId,
  });
}

function normalizeResolution(a: any, type: string): Row {
  const x = a.positionResolution, m = x.market || {};
  const before = x.beforePosition || {}, after = x.afterPosition || {};
  const meta = after.marketMetadata || before.marketMetadata || {};
  const t = x.time || x.updateTime;
  const basis = n(x.costBasis) ?? n(before.cost);
  const pnl = n(x.realizedPnl) ?? (n(after.realized) != null && n(before.realized) != null ? (n(after.realized) as number) - (n(before.realized) as number) : null);
  const payout = n(x.payout) ?? (pnl != null && basis != null ? pnl + basis : null);
  const slug = x.marketSlug || meta.slug;
  // Same id the website uses: `${slug}_${epochMs}`, so both feeds land on one row.
  const id = a.id || (x.id ? `pos_${x.id}` : `pos_${slug}_${Date.parse(t)}`);
  return clean({
    id, type, t, action: x.action || (pnl == null ? undefined : pnl > 0 ? 'won' : 'lost'),
    title: x.title || resolutionTitle(x, meta), sub: x.subtitle || meta.title,
    ev: x.eventMetadata?.title, evSlug: x.eventMetadata?.slug || meta.eventSlug, mkt: slug,
    cat: m.category, smt: m.sportsMarketType, sub2: m.eventSubcategory, gameStart: m.gameStartTime,
    entry: n(x.entryPrice), qty: n(x.qtyDecimal ?? x.qty ?? before.netPositionDecimal), basis,
    settle: n(x.settlementPrice), payout, pnl, color: x.color?.dark,
  });
}

function resolutionTitle(x: any, meta: any): string | undefined {
  const longTeam = meta.team?.safeName || meta.team?.name || meta.outcome;
  const side = String(x.side || '');
  return /SHORT|_NO$/.test(side) ? otherSide(meta.title, longTeam) : longTeam;
}

function normalizeBalance(a: any, type: string): Row {
  const b = a.accountBalanceChange || {};
  return clean({
    id: a.id || `bal_${b.transactionId}`, type, t: b.createTime || b.updateTime, done: b.updateTime,
    amount: n(b.amount), status: String(b.status || '').replace('ACCOUNT_BALANCE_CHANGE_STATUS_', ''),
    method: b.paymentMethod?.type,
  });
}

function clean<T extends Record<string, any>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
  return o;
}
