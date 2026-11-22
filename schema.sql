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
  done TEXT, amount REAL, status TEXT, method TEXT,
  raw TEXT                       -- the API payload, kept so parsing can be audited
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

-- One row per fill from the public API. Rolled up into one TRADE activity per order.
CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  t TEXT NOT NULL,
  mkt TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);

-- Market recorder: one row per game market (moneyline), updated as prices move.
CREATE TABLE IF NOT EXISTS markets (
  slug TEXT PRIMARY KEY,
  league TEXT, event_slug TEXT, title TEXT,
  long_team TEXT, short_team TEXT,
  game_start TEXT NOT NULL,
  fee_coef REAL, status TEXT,
  last_bid REAL, last_ask REAL,     -- latest quote for the long side
  result INTEGER,                   -- 1 long side won, 0 short side won, NULL unsettled
  settled_at TEXT, updated_at TEXT,
  espn_id TEXT,
  start_mid REAL                -- long-side mid at tip-off (live feed)
);
CREATE INDEX IF NOT EXISTS idx_markets_start ON markets(game_start);

-- Price history for the long side. Written only when the quote changes.
CREATE TABLE IF NOT EXISTS prices (
  slug TEXT NOT NULL,
  t TEXT NOT NULL,                  -- minute bucket, ISO
  bid REAL, ask REAL,
  live INTEGER,                     -- 1 if the game had started
  PRIMARY KEY (slug, t)
);

-- Live feed: every quote change for games in progress (checked every 5 seconds).
CREATE TABLE IF NOT EXISTS ticks (
  slug TEXT NOT NULL,
  ts INTEGER NOT NULL,                 -- epoch ms
  bid REAL, ask REAL,                  -- long side, every row
  last REAL, vol REAL,                 -- last trade price, shares traded so far (rows with per-game data only)
  bid_depth REAL, ask_depth REAL,
  state TEXT,                          -- MARKET_STATUS_OPEN / ...
  PRIMARY KEY (slug, ts)
) WITHOUT ROWID;

-- Live feed: game situation from ESPN on every change, with a 30 s heartbeat for the clock.
CREATE TABLE IF NOT EXISTS game_states (
  espn_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  league TEXT, home TEXT, away TEXT,
  home_score INTEGER, away_score INTEGER,
  period INTEGER, clock TEXT, state TEXT,   -- state: in / post
  possession TEXT,                          -- home / away (football)
  down INTEGER, distance INTEGER, yard_line INTEGER,
  last_play TEXT,
  PRIMARY KEY (espn_id, ts)
) WITHOUT ROWID;

-- Sportsbook line in the last 10 minutes before start (closing line), American odds.
CREATE TABLE IF NOT EXISTS lines (
  espn_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  provider TEXT, home TEXT, away TEXT,
  home_ml INTEGER, away_ml INTEGER, home_ml_open INTEGER, away_ml_open INTEGER,
  spread REAL,                              -- home team's line
  total REAL,
  PRIMARY KEY (espn_id, ts)
) WITHOUT ROWID;

-- Running counters (prices, ticks, game_states, lines, live_now) so the dashboard never counts big tables.
CREATE TABLE IF NOT EXISTS stats (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  last INTEGER                              -- epoch ms of the latest write
);

-- The bot's eye: every trigger that put a game in focus, with the price at that moment.
-- Graded later against how the game ended and how far the price moved after.
CREATE TABLE IF NOT EXISTS signals (
  slug TEXT NOT NULL,
  ts INTEGER NOT NULL,                      -- epoch ms
  kind TEXT NOT NULL,                       -- favorite_fade / swing / cheap_spike / late_close
  side TEXT,                                -- long / short: the side the signal points at
  price REAL,                               -- that side's ask (bid for cheap_spike) at the signal
  ref REAL,                                 -- tip-off price (favorite_fade) or price 2 minutes earlier
  detail TEXT,
  PRIMARY KEY (slug, ts, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);

-- Crypto feed: bitcoin spot (Coinbase) every 5 s, and each Up/Down window.
CREATE TABLE IF NOT EXISTS spot (
  asset TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (asset, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS windows (
  slug TEXT PRIMARY KEY,                    -- cpc-btc-updown-5m-2026-11-22-1810z
  asset TEXT, series TEXT,                  -- btc, 5m / 15m / 1h
  start_ts INTEGER, end_ts INTEGER,
  strike REAL,                              -- our estimate of the official start price
  result INTEGER,                           -- 1 = Up, 0 = Down
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_windows_end ON windows(end_ts);

-- The bot's own ledger. Aaron's trades never go here, the bot's never go in activities.
CREATE TABLE IF NOT EXISTS bot_positions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                       -- paper | live
  strategy TEXT,
  market_slug TEXT NOT NULL,
  title TEXT,                               -- game or market
  side TEXT NOT NULL,                       -- long | short
  side_name TEXT,                           -- team or outcome held
  status TEXT NOT NULL DEFAULT 'open',      -- open | closed | settled
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  qty REAL NOT NULL DEFAULT 0,              -- contracts still held
  avg_entry REAL,
  cost REAL NOT NULL DEFAULT 0,             -- dollars in, fees included
  proceeds REAL NOT NULL DEFAULT 0,         -- dollars out from sells and settlement, after fees
  fees REAL NOT NULL DEFAULT 0,
  adds INTEGER NOT NULL DEFAULT 0,
  take_profit REAL,                         -- resting take-profit price
  pnl REAL,                                 -- proceeds - cost once closed
  result INTEGER,                           -- 1 won / 0 lost if held to settlement
  close_price REAL,                         -- price at start, for closing-line value
  reason TEXT                               -- what opened it (signal kind)
);
CREATE INDEX IF NOT EXISTS idx_bot_positions_status ON bot_positions(mode, status, opened_at);
CREATE TABLE IF NOT EXISTS bot_orders (
  id TEXT PRIMARY KEY,                      -- our client order id; live orders carry it to the exchange
  position_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,                       -- paper | live
  market_slug TEXT NOT NULL,
  side TEXT NOT NULL,                       -- long | short
  action TEXT NOT NULL,                     -- buy | sell
  order_type TEXT,                          -- limit (resting) | market
  price REAL NOT NULL,
  qty REAL NOT NULL,
  filled_qty REAL NOT NULL DEFAULT 0,
  avg_fill REAL,
  fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                     -- resting | filled | partial | cancelled | rejected
  reason TEXT,                              -- starter / add / take_profit / blowout_exit / ...
  exchange_order_id TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bot_orders_position ON bot_orders(position_id, ts);
