-- D1 schema. Apply with: npm run db:init

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- TRADE | POSITION_RESOLUTION | ACCOUNT_DEPOSIT | ACCOUNT_WITHDRAWAL | REFERRAL_BONUS | TRANSFER ...
  t TEXT NOT NULL,               -- ISO timestamp
  action TEXT,                   -- bought | sold | won | lost
  title TEXT, sub TEXT, ev TEXT, ev_slug TEXT, mkt TEXT,
  cat TEXT, smt TEXT, sub2 TEXT, game_start TEXT,
  price REAL, entry REAL, qty REAL, cost REAL, basis REAL, fee REAL,
  settle REAL, payout REAL, pnl REAL,
  order_id TEXT, color TEXT,
  done TEXT, amount REAL, status TEXT, method TEXT
);
CREATE INDEX IF NOT EXISTS idx_activities_t ON activities(t);
CREATE INDEX IF NOT EXISTS idx_activities_mkt ON activities(mkt);

CREATE TABLE IF NOT EXISTS snapshots (
  t TEXT PRIMARY KEY,
  cash REAL, positions REAL, portfolio REAL, reserved REAL,
  raw TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  t TEXT PRIMARY KEY, ok INTEGER, added INTEGER, msg TEXT
);

-- The bot logs calls here in paper mode. Grade them before any real money moves.
CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  strategy TEXT,
  market_slug TEXT NOT NULL,
  title TEXT,
  side TEXT NOT NULL,
  price REAL NOT NULL,           -- entry price in dollars (0-1)
  stake REAL NOT NULL,           -- dollars
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | won | lost | void
  settled_at TEXT,
  pnl REAL
);
CREATE INDEX IF NOT EXISTS idx_paper_created ON paper_trades(created_at);
