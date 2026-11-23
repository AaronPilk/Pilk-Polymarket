import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEC_COLS, SEC_DDL, secInserts, type SecRow } from '../src/seconds.ts';

const row = (sec: number): SecRow => [sec, 87_000.12, 86_990.5, 86_995.25, 0.52, 0.53, 120, 80, 0.5312, 0.4, 0.42, 50, null, 0.41, null, null, null, null, 0.66];

test('per-second record: 19 columns, and the schema file matches the table the bot creates', () => {
  assert.equal(SEC_COLS.length, 19);
  assert.deepEqual(SEC_COLS.slice(0, 9), ['sec', 'spot', 'cb', 'gm', 'b5', 'a5', 'bq5', 'aq5', 'f5']);
  assert.deepEqual(SEC_COLS.slice(-5), ['b60', 'a60', 'bq60', 'aq60', 'f60']);
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.ok(schema.includes(`${SEC_DDL};`), 'schema.sql has the same CREATE TABLE as src/seconds.ts');
});

test('per-second record: inserts stay under D1s 100 parameters and land every row once', async () => {
  const rows = Array.from({ length: 23 }, (_, i) => row(1_795_470_000 + i));
  const ins = secInserts(rows);
  assert.equal(ins.length, 5);   // 5 rows a statement
  for (const s of ins) {
    assert.ok(s.params.length <= 100);
    assert.equal((s.sql.match(/\?/g) || []).length, s.params.length);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(SEC_DDL);
  for (const s of [...ins, ...secInserts(rows.slice(0, 3))]) db.prepare(s.sql).run(...s.params);   // repeats are ignored
  const got = db.prepare('SELECT COUNT(*) AS n, MIN(sec) AS lo, MAX(sec) AS hi, SUM(b5) AS b, COUNT(aq15) AS aq FROM btc_sec').get() as Record<string, number>;
  assert.equal(got.n, 23);
  assert.equal(got.lo, 1_795_470_000);
  assert.equal(got.hi, 1_795_470_022);
  assert.equal(Math.round(got.b * 100), 23 * 52);
  assert.equal(got.aq, 0);       // nulls stay null
  assert.deepEqual(secInserts([]), []);
});
