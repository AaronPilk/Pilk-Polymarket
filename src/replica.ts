// A copy of the settlement index, rebuilt from exchange order books (shadow mode).
//
// CF Benchmarks' BRTI, which every bitcoin window settles on, is built from the order books of its
// constituent exchanges, not from trades or tickers. The bot's own price is a ticker mid shifted by
// a learned offset. This keeps full books for three constituents the bot can reach from Cloudflare
// (Coinbase, Gemini, Bitstamp; Kraken refuses Workers) and reads each one at depth: the average
// price to buy and to sell DEPTH bitcoin, so a few stray orders at the top can't move it. The copy
// is the average of the fresh books.
//
// Shadow mode: the copy never trades. At every window start it is scored, next to the bot's own
// price, against Polymarket's official start price, and the app shows which one lands closer.
// Pure code (no Cloudflare imports) so it can be tested in Node.

export const DEPTH = 1;            // bitcoin per side for the depth-weighted mid
export const BOOK_FRESH = 5_000;   // a book quiet longer than this is left out of the copy

export class Book {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  at = 0;

  clear() { this.bids.clear(); this.asks.clear(); }

  set(side: 'bid' | 'ask', price: number, size: number) {
    if (!(price > 0) || !Number.isFinite(size)) return;
    const m = side === 'bid' ? this.bids : this.asks;
    if (size > 0) m.set(price, size); else m.delete(price);
  }

  load(bids: Array<[unknown, unknown]>, asks: Array<[unknown, unknown]>) {
    this.clear();
    for (const [p, s] of bids || []) this.set('bid', Number(p), Number(s));
    for (const [p, s] of asks || []) this.set('ask', Number(p), Number(s));
  }

  // Drop levels more than `band` away from `mid` (they never reach the depth the copy reads).
  prune(mid: number, band = 0.05) {
    for (const m of [this.bids, this.asks]) for (const p of m.keys()) if (Math.abs(p - mid) > mid * band) m.delete(p);
  }

  // Best bid and best ask, the middle of the two: the same number an exchange ticker's bid/ask gives.
  // A plain scan, no sort. Null when a side is empty or the book is crossed.
  topMid(): number | null {
    let bid = -Infinity, ask = Infinity;
    for (const p of this.bids.keys()) if (p > bid) bid = p;
    for (const p of this.asks.keys()) if (p < ask) ask = p;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return null;
    return (bid + ask) / 2;
  }

  // The average price of the first `q` bitcoin on each side, then the middle of the two. Null when
  // a side is thinner than q or the book is crossed (a sign it's out of sync).
  depthMid(q = DEPTH): number | null {
    const vwap = (m: Map<number, number>, desc: boolean) => {
      const px = [...m.keys()].sort((a, b) => (desc ? b - a : a - b));
      let left = q, cost = 0;
      for (const p of px) {
        const take = Math.min(left, m.get(p)!);
        cost += take * p;
        left -= take;
        if (left <= 1e-12) return cost / q;
      }
      return null;
    };
    const b = vwap(this.bids, true), a = vwap(this.asks, false);
    if (b == null || a == null || a < b) return null;
    return (a + b) / 2;
  }
}

// ---------- the three feeds' messages

// Coinbase Exchange level2_batch: a full snapshot, then batched changes ["buy"|"sell", price, size].
export function applyCoinbase(book: Book, j: any): boolean {
  if (j?.type === 'snapshot' && j.product_id === 'BTC-USD') { book.load(j.bids, j.asks); return true; }
  if (j?.type === 'l2update' && j.product_id === 'BTC-USD' && Array.isArray(j.changes)) {
    for (const c of j.changes) book.set(c[0] === 'buy' ? 'bid' : 'ask', Number(c[1]), Number(c[2]));
    return true;
  }
  return false;
}

// Gemini market data v1, full book: the first update carries every level (reason "initial"), later
// ones each changed level with what now remains there (0 = gone).
export function applyGemini(book: Book, j: any): boolean {
  if (j?.type !== 'update' || !Array.isArray(j.events)) return false;
  let any = false;
  for (const e of j.events) {
    if (e?.type !== 'change') continue;
    if (e.reason === 'initial' && !any && j.socket_sequence === 0) book.clear();
    book.set(e.side === 'bid' ? 'bid' : 'ask', Number(e.price), Number(e.remaining));
    any = true;
  }
  return any;
}

// Bitstamp order_book_btcusd: every message is the top 100 levels on each side, whole.
export function applyBitstamp(book: Book, j: any): boolean {
  if (j?.event !== 'data' || j.channel !== 'order_book_btcusd' || !j.data) return false;
  book.load(j.data.bids, j.data.asks);
  return true;
}

// The copy right now: the depth mids of the books heard from in the last BOOK_FRESH, averaged.
export function replicaPrice(books: Book[], now: number): { price: number; n: number } | null {
  let sum = 0, n = 0;
  for (const b of books) {
    if (now - b.at > BOOK_FRESH) continue;
    const m = b.depthMid();
    if (m != null) { sum += m; n++; }
  }
  return n ? { price: sum / n, n } : null;
}
