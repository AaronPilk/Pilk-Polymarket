// Polymarket US order client for the bot. Limit orders only, every one tagged as automatic
// (exchange rule 5.2(i)). On the wire a price is always the YES (Up) price: there is one instrument
// per market, so buying Down at 36c is selling YES at 64c, and selling Down at 40c is buying YES back
// at 60c. Docs: docs.polymarket.us/api-reference/orders/*.
//
//   placeOrder    POST /v1/orders with synchronousExecution, so the reply carries the actual fills,
//                 prices and fees before the bot records anything
//   previewOrder  POST /v1/order/preview: the exchange checks the order without placing it
//   cancelOrder   POST /v1/order/{id}/cancel
//   getOrder      GET  /v1/order/{id}
//   accountPosition / openOrders: what the whole account holds in a market, so the bot never trades
//                 a window where Aaron has his own position or orders

import { signedHeaders, type PmEnv } from './polymarket';

const API = 'https://api.polymarket.us';

export type Side = 'long' | 'short';
export type Action = 'buy' | 'sell';
export type Intent = 'ORDER_INTENT_BUY_LONG' | 'ORDER_INTENT_SELL_LONG' | 'ORDER_INTENT_BUY_SHORT' | 'ORDER_INTENT_SELL_SHORT';

export const intentFor = (side: Side, action: Action): Intent =>
  `ORDER_INTENT_${action === 'buy' ? 'BUY' : 'SELL'}_${side === 'long' ? 'LONG' : 'SHORT'}` as Intent;

// A side's price (what Up or Down costs) to the YES price sent to the exchange, and back.
export const toYes = (side: Side, sidePx: number) => Math.round((side === 'long' ? sidePx : 1 - sidePx) * 100) / 100;
export const fromYes = (side: Side, yesPx: number) => (side === 'long' ? yesPx : 1 - yesPx);

export interface OrderSpec {
  slug: string; side: Side; action: Action;
  sidePx: number;            // limit, as the side's own price (buy: at most this, sell: at least this)
  qty: number;               // whole contracts
  tif: 'ioc' | 'gtc';
  postOnly?: boolean;        // resting take-profit: must rest on the book (maker), never take
}

export function orderBody(o: OrderSpec, sync = o.tif === 'ioc') {
  return {
    marketSlug: o.slug,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: toYes(o.side, o.sidePx).toFixed(2), currency: 'USD' },
    quantity: o.qty,
    tif: o.tif === 'ioc' ? 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL' : 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    intent: intentFor(o.side, o.action),
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    ...(o.postOnly ? { participateDontInitiate: true } : {}),
    ...(sync ? { synchronousExecution: true, maxBlockTime: '3' } : {}),
  };
}

export interface OrderResult {
  ok: boolean;               // the exchange accepted the request
  id: string | null;         // exchange order id
  filled: number;            // contracts filled
  avgSidePx: number | null;  // average fill, as the side's own price
  fee: number;               // commission actually charged, dollars
  state: string | null;      // last known order state
  reject: string | null;     // reject reason, if rejected
  error: string | null;      // HTTP or network error text
}

const num = (v: any): number => {
  const x = Number(v?.value ?? v);
  return Number.isFinite(x) ? x : 0;
};

// Sum the fills in a synchronous create-order reply.
export function parseExecutions(resp: any, side: Side): OrderResult {
  const ex: any[] = Array.isArray(resp?.executions) ? resp.executions : [];
  let qty = 0, notional = 0, fee = 0, state: string | null = null, reject: string | null = null;
  for (const e of ex) {
    if (e?.order?.state) state = e.order.state;
    if (e?.type === 'EXECUTION_TYPE_FILL' || e?.type === 'EXECUTION_TYPE_PARTIAL_FILL') {
      const q = num(e.lastShares), px = num(e.lastPx);
      qty += q; notional += q * px;
      fee += num(e.commissionNotionalCollected);
    }
    if (e?.type === 'EXECUTION_TYPE_REJECTED') reject = e.orderRejectReason || e.text || 'rejected';
  }
  const avgYes = qty > 0 ? notional / qty : null;
  return {
    ok: !reject, id: resp?.id ?? ex[0]?.order?.id ?? null, filled: qty,
    avgSidePx: avgYes == null ? null : Math.round(fromYes(side, avgYes) * 10_000) / 10_000,
    fee: Math.round(fee * 100) / 100, state, reject, error: null,
  };
}

async function call(env: PmEnv, method: 'GET' | 'POST', path: string, query = '', body?: unknown): Promise<{ status: number; json: any; text: string }> {
  // The docs sign the bare path; if the server wants the query signed too, retry once that way.
  for (const signPath of query ? [path, path + query] : [path]) {
    const res = await fetch(API + path + query, {
      method,
      headers: await signedHeaders(env, method, signPath),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    if (res.status === 401 && query && signPath === path) continue;
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text };
  }
  return { status: 401, json: null, text: 'unauthorized' };
}

const fail = (error: string): OrderResult => ({ ok: false, id: null, filled: 0, avgSidePx: null, fee: 0, state: null, reject: null, error });

export async function placeOrder(env: PmEnv, o: OrderSpec): Promise<OrderResult> {
  try {
    const r = await call(env, 'POST', '/v1/orders', '', orderBody(o));
    if (r.status !== 200) return fail(`HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    const out = parseExecutions(r.json, o.side);
    if (!out.id && r.json?.id) out.id = r.json.id;
    return out;
  } catch (e: any) {
    return fail(String(e?.message || e));
  }
}

export async function previewOrder(env: PmEnv, o: OrderSpec): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await call(env, 'POST', '/v1/order/preview', '', { request: orderBody(o, false) });
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}: ${r.text.slice(0, 300)}` };
    const ord = r.json?.order || {};
    return { ok: true, detail: `${ord.state || 'ok'}${ord.avgPx ? ` at ${ord.avgPx.value}` : ''}${ord.commissionNotionalTotalCollected ? `, fee ${ord.commissionNotionalTotalCollected.value}` : ''}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

export async function cancelOrder(env: PmEnv, id: string, slug: string): Promise<boolean> {
  try {
    const r = await call(env, 'POST', `/v1/order/${encodeURIComponent(id)}/cancel`, '', { marketSlug: slug });
    return r.status === 200;
  } catch {
    return false;
  }
}

export interface OrderState { state: string | null; filled: number; left: number; avgSidePx: number | null; fee: number }

export async function getOrder(env: PmEnv, id: string, side: Side): Promise<OrderState | null> {
  try {
    const r = await call(env, 'GET', `/v1/order/${encodeURIComponent(id)}`);
    const o = r.status === 200 ? r.json?.order : null;
    if (!o) return null;
    const avg = o.avgPx ? num(o.avgPx) : null;
    return {
      state: o.state || null, filled: num(o.cumQuantity), left: num(o.leavesQuantity),
      avgSidePx: avg ? fromYes(side, avg) : null, fee: num(o.commissionNotionalTotalCollected),
    };
  } catch {
    return null;
  }
}

// Net YES contracts the whole account holds in a market (long positive, short negative); null if
// the call failed, so the caller can refuse to trade rather than guess.
export async function accountPosition(env: PmEnv, slug: string): Promise<number | null> {
  try {
    const r = await call(env, 'GET', '/v1/portfolio/positions', `?market=${encodeURIComponent(slug)}`);
    if (r.status !== 200) return null;
    const p = r.json?.positions?.[slug];
    if (!p) return 0;
    return num(p.netPositionDecimal ?? p.netPosition);
  } catch {
    return null;
  }
}

// Open orders the account has in a market; null if the call failed.
export async function openOrders(env: PmEnv, slug: string): Promise<Array<{ id: string }> | null> {
  try {
    const r = await call(env, 'GET', '/v1/orders/open', `?slugs=${encodeURIComponent(slug)}`);
    if (r.status !== 200) return null;
    return ((r.json?.orders || []) as any[]).filter((o) => !o.marketSlug || o.marketSlug === slug).map((o) => ({ id: String(o.id) }));
  } catch {
    return null;
  }
}
