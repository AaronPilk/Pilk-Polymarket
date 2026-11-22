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

export function normalize(a: any): Row {
  const type = String(a.type || '').replace('ACTIVITY_TYPE_', '');
  const x = a.trade || a.positionResolution;
  if (x) {
    const m = x.market || {};
    const id = a.id || (a.trade ? `trade_${x.id}` : `pos_${x.id}`);
    return clean({
      id, type, t: x.time, action: x.action, title: x.title, sub: x.subtitle,
      ev: x.eventMetadata?.title, evSlug: x.eventMetadata?.slug, mkt: x.marketSlug,
      cat: m.category, smt: m.sportsMarketType, sub2: m.eventSubcategory, gameStart: m.gameStartTime,
      price: n(x.price), entry: n(x.entryPrice), qty: x.qty == null ? null : Number(x.qty), cost: n(x.cost),
      basis: n(x.costBasis), fee: n(x.commission), settle: n(x.settlementPrice), payout: n(x.payout),
      pnl: n(x.realizedPnl), order: x.orderId, color: x.color?.dark,
    });
  }
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
