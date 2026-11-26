import test from 'node:test';
import assert from 'node:assert/strict';
import { BookFeed, DAY_CAP, PRE_WINDOW, POST_WINDOW, inWindow, insertsFor, topLevels } from '../src/books.ts';

// A D1 stand-in that keeps every statement it's handed.
function fakeDb() {
  const batches: Array<Array<{ sql: string; params: any[] }>> = [];
  const db: any = {
    batches,
    prepare(sql: string) {
      const st: any = { sql, params: [] as any[] };
      st.bind = (...p: any[]) => ({ sql, params: p });
      st.run = async () => ({});
      st.all = async () => ({ results: [] });
      st.first = async () => null;
      return st;
    },
    async batch(stmts: any[]) { batches.push(stmts.map((s) => ({ sql: s.sql, params: s.params }))); return []; },
  };
  return db;
}

const SLUG = 'aec-cbb-gtwn-tex-2026-11-26';
function feed(start = Date.now() + 60 * 60_000) {
  const db = fakeDb();
  const f: any = new BookFeed({} as any, { DB: db } as any);
  f.games = new Map([[SLUG, { slug: SLUG, start }]]);
  const conn = { ws: null, slugs: [SLUG], at: Date.now(), last: 0, n: 0 };
  const send = (o: any) => f.onMessage(conn, JSON.stringify(o));
  return { f, db, send, conn };
}
const rows = (db: any, table: string) => db.batches.flat().filter((s: any) => s.sql.includes(`INTO ${table} `));

test('books: levels, inserts and the recording window', () => {
  assert.deepEqual(topLevels([{ px: { value: '0.88' }, qty: '120' }, { px: { value: '0.87' }, qty: 40 }, { px: null, qty: 1 }]), [[0.88, 120], [0.87, 40]]);
  assert.equal(topLevels(Array.from({ length: 20 }, (_, i) => ({ px: 0.5 - i / 100, qty: 1 }))).length, 8);
  assert.deepEqual(topLevels(undefined), []);
  const ins = insertsFor('book_quotes', Array.from({ length: 23 }, (_, i) => ['s', i, 1, 2, 3, 4, 5, 6, 7, 'x', 1]));
  assert.ok(ins.every((s) => s.params.length <= 100));
  assert.equal(ins.reduce((n, s) => n + s.params.length, 0), 23 * 11);
  assert.match(insertsFor('book_trades', [['s', 1, 2, 0.5, 10, 'a', 'b', 'c', 1]])[0].sql, /^INSERT INTO book_trades/);
  const tip = Date.parse('2026-11-26T19:00:00Z');
  assert.equal(inWindow('2026-11-26T19:00:00Z', tip - PRE_WINDOW - 1), false);
  assert.equal(inWindow('2026-11-26T19:00:00Z', tip - PRE_WINDOW), true);
  assert.equal(inWindow('2026-11-26T19:00:00Z', tip + POST_WINDOW), true);
  assert.equal(inWindow('2026-11-26T19:00:00Z', tip + POST_WINDOW + 1), false);
});

test('books: quotes are written on every price change, side fields at most every 5 s', async () => {
  const { f, db, send } = feed();
  const lite = (o: any) => send({ marketDataLite: { marketSlug: SLUG, bestBid: { value: '0.87' }, bestAsk: { value: '0.89' }, currentPx: { value: '0.88' }, bidDepth: 100, askDepth: 50, lastTradePx: '0.88', sharesTraded: 1000, ...o } });
  lite({});
  lite({});                          // same: skipped
  lite({ bidDepth: 90 });            // depth only, under 5 s: skipped
  lite({ bestBid: { value: '0.70' } }); // price change: written
  lite({ currentPx: { value: '0.20' } }); // displayed price change: written
  await f.flush(Date.now());
  const q = rows(db, 'book_quotes');
  assert.equal(q.reduce((n: number, s: any) => n + s.params.length / 11, 0), 3);
  assert.equal(q[0].params[2], 0.87);
  assert.equal(q[0].params[10], 1);   // before tip-off
  assert.equal(f.msgs.lite, 5);
});

test('books: book shape right away on a new best price, otherwise held 10 s and never lost', async () => {
  const { f, db, send } = feed();
  const full = (bid: number, qty: number) => send({ marketData: { marketSlug: SLUG, bids: [{ px: { value: bid }, qty }], offers: [{ px: { value: 0.9 }, qty: 10 }], state: 'MARKET_STATE_OPEN' } });
  full(0.88, 100);   // first: written
  full(0.88, 80);    // same best, new size, under 10 s: held
  full(0.88, 60);    // newer shape replaces the held one... keeps the time it first changed
  full(0.85, 60);    // new best price: written now
  full(0.85, 50);    // held
  const l = f.lastLevels.get(SLUG);
  assert.ok(l.pending);
  const firstSeen = l.pending.ts;
  l.at -= 11_000;    // pretend 10 s passed
  f.duePending(Date.now());
  await f.flush(Date.now());
  const lv = rows(db, 'book_levels').flatMap((s: any) => { const out = []; for (let i = 0; i < s.params.length; i += 5) out.push(s.params.slice(i, i + 5)); return out; });
  assert.equal(lv.length, 3);
  assert.deepEqual(JSON.parse(lv[0][2]), [[0.88, 100]]);
  assert.deepEqual(JSON.parse(lv[1][2]), [[0.85, 60]]);
  assert.deepEqual(JSON.parse(lv[2][2]), [[0.85, 50]]);
  // Kept at the time it first appeared (nudged by a millisecond or two when rows share one).
  assert.ok(lv[2][1] >= firstSeen && lv[2][1] <= firstSeen + 3);
  assert.ok(lv[0][1] < lv[1][1] && lv[1][1] < lv[2][1]);
  // Back to the last written shape: nothing pending.
  full(0.85, 50);
  assert.equal(f.lastLevels.get(SLUG).pending, null);
});

test('books: every trade print kept with the taker side; unknown messages noted', async () => {
  const { f, db, send } = feed(Date.now() - 60_000);   // tipped off a minute ago
  send({ trade: { marketSlug: SLUG, price: { value: '0.81' }, quantity: '25', tradeTime: '2026-11-26T19:35:00Z', taker: { side: 'ORDER_SIDE_SELL', intent: 'ORDER_INTENT_SELL_LONG' }, maker: { side: 'ORDER_SIDE_BUY', intent: 'ORDER_INTENT_BUY_LONG' } } });
  send({ subscribeResponse: { requestId: 'bk0' } });
  await f.flush(Date.now());
  const t = rows(db, 'book_trades')[0].params;
  assert.equal(t[0], SLUG);
  assert.equal(t[1], Date.parse('2026-11-26T19:35:00Z'));
  assert.equal(t[3], 0.81);
  assert.equal(t[4], 25);
  assert.equal(t[5], 'ORDER_SIDE_SELL');
  assert.equal(f.msgs.other, 1);
  assert.equal(f.others.length, 1);
});

test('books: past the daily cap only trade prints are kept', () => {
  const { f } = feed();
  f.day = new Date().toISOString().slice(0, 10);
  f.dayRows = DAY_CAP;
  f.push('book_quotes', [SLUG, 1]);
  f.push('book_trades', [SLUG, 1]);
  assert.equal(f.buf.book_quotes.length, 0);
  assert.equal(f.buf.book_trades.length, 1);
  assert.equal(f.capped, true);
});
