// The per-second record (Nov 23): one row a second with the bot's bitcoin price (its read of the
// settlement index), Coinbase's and Gemini's raw mids, and for each open Up/Down window (5m, 15m, 1h)
// the Up side's best bid and ask, the shares at each, and what the math says Up is worth.
//
// The bot already reacts to every price as it arrives; this keeps a copy one second apart, so rules
// that work within seconds (beat the lag, the 0.6 s hold, resting-order fills) can be replayed on days
// of real data instead of waiting on live test bets. Polymarket's public history has one point a
// minute and no trade prints, so this is the only fine-grained record there is.
//
// Recording only: nothing here feeds a trading decision, and the rows go in their own batch, so a
// failed write never touches trading.

export const SEC_SERIES = ['5m', '15m', '1h'] as const;
const SUFFIX: Record<(typeof SEC_SERIES)[number], string> = { '5m': '5', '15m': '15', '1h': '60' };
// sec: epoch second · spot: the bot's index estimate · cb, gm: raw exchange mids
// b/a: Up best bid / ask · bq/aq: shares at them · f: the math's fair value for Up (5 = 5m, 15 = 15m, 60 = 1h)
export const SEC_COLS = ['sec', 'spot', 'cb', 'gm', ...SEC_SERIES.flatMap((s) => ['b', 'a', 'bq', 'aq', 'f'].map((c) => `${c}${SUFFIX[s]}`))];
export const SEC_DDL = `CREATE TABLE IF NOT EXISTS btc_sec (sec INTEGER PRIMARY KEY, ${SEC_COLS.slice(1).map((c) => `${c} REAL`).join(', ')})`;
export const SEC_KEEP_DAYS = 60;   // about 15 MB a day
export const SEC_BUFFER = 900;     // seconds held in memory if writes fail (then the oldest go)
const MAX_PARAMS = 100;            // D1's limit on bound parameters per statement

export type SecRow = Array<number | null>;

// Multi-row inserts that stay under D1's parameter limit (5 rows of 19 columns each).
export function secInserts(rows: SecRow[]): Array<{ sql: string; params: Array<number | null> }> {
  const per = Math.max(1, Math.floor(MAX_PARAMS / SEC_COLS.length));
  const one = `(${SEC_COLS.map(() => '?').join(',')})`;
  const out: Array<{ sql: string; params: Array<number | null> }> = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push({ sql: `INSERT OR IGNORE INTO btc_sec (${SEC_COLS.join(', ')}) VALUES ${chunk.map(() => one).join(', ')}`, params: chunk.flat() });
  }
  return out;
}
