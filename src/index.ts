import { normalize, pm, type PmEnv, type Row } from './polymarket';

interface Env extends PmEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  DASH_PASSWORD?: string;   // wrangler secret put DASH_PASSWORD
  SESSION_SECRET?: string;  // wrangler secret put SESSION_SECRET (any long random string)
}

const COLS = ['id', 'type', 't', 'action', 'title', 'sub', 'ev', 'ev_slug', 'mkt', 'cat', 'smt', 'sub2', 'game_start',
  'price', 'entry', 'qty', 'cost', 'basis', 'fee', 'settle', 'payout', 'pnl', 'order_id', 'color', 'done', 'amount', 'status', 'method'] as const;
const KEYMAP: Record<string, string> = { ev_slug: 'evSlug', game_start: 'gameStart', order_id: 'order' };
const camel = (c: string) => KEYMAP[c] || c;

const PUBLIC_PATHS = new Set(['/login', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/favicon.svg']);
const ONE_YEAR = 60 * 60 * 24 * 365;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/login') return login(req, env);
    if (url.pathname === '/logout') return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': cookie('', 0) } });
    if (!PUBLIC_PATHS.has(url.pathname) && !(await authed(req, env))) {
      if (url.pathname.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
      return Response.redirect(new URL('/login', url).toString(), 303);
    }

    try {
      if (url.pathname === '/api/activities' && req.method === 'GET') return json(await listActivities(env));
      if (url.pathname === '/api/state' && req.method === 'GET') return json(await state(env));
      if (url.pathname === '/api/sync' && req.method === 'POST') return json(await sync(env));
      if (url.pathname === '/api/paper') {
        if (req.method === 'GET') return json(await listPaper(env));
        if (req.method === 'POST') return json(await addPaper(env, await req.json()));
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500);
    }

    const res = await env.ASSETS.fetch(req);
    // The app shell should always revalidate so new deploys show up on the home-screen app.
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
      const r = new Response(res.body, res);
      r.headers.set('Cache-Control', 'no-cache');
      return r;
    }
    return res;
  },

  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sync(env).catch((e) => logSync(env, false, 0, String(e?.message || e))));
  },
};

// ---------- data

async function listActivities(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${COLS.join(',')} FROM activities ORDER BY t DESC`).all();
  return results.map((r: any) => {
    const o: Record<string, unknown> = {};
    for (const c of COLS) if (r[c] !== null && r[c] !== undefined && r[c] !== '') o[camel(c)] = r[c];
    return o;
  });
}

async function state(env: Env) {
  const snap = await env.DB.prepare('SELECT * FROM snapshots ORDER BY t DESC LIMIT 1').first<any>();
  const last = await env.DB.prepare('SELECT * FROM sync_log ORDER BY t DESC LIMIT 1').first<any>();
  return {
    snapshot: snap ? { t: snap.t, cash: snap.cash, positions: snap.positions, portfolio: snap.portfolio, reserved: snap.reserved } : null,
    lastSync: last ? { t: last.t, ok: !!last.ok, added: last.added, msg: last.msg } : null,
    apiConfigured: !!(env.POLYMARKET_KEY_ID && env.POLYMARKET_SECRET_KEY),
  };
}

async function upsert(env: Env, rows: Row[]) {
  if (!rows.length) return;
  const placeholders = COLS.map(() => '?').join(',');
  const updates = COLS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',');
  const stmt = env.DB.prepare(`INSERT INTO activities (${COLS.join(',')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`);
  const batch = rows.map((r: any) => stmt.bind(...COLS.map((c) => r[camel(c)] ?? null)));
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
}

// Pull newest-first until a page brings nothing new. Pending deposits/withdrawals
// get re-upserted so their status flips to COMPLETED on their own.
async function sync(env: Env) {
  if (!env.POLYMARKET_KEY_ID || !env.POLYMARKET_SECRET_KEY) throw new Error('Polymarket API key not configured');
  const known = new Set(
    (await env.DB.prepare('SELECT id FROM activities').all<{ id: string }>()).results.map((r) => r.id),
  );
  let cursor: string | undefined, added = 0, pages = 0;
  while (pages++ < 40) {
    const q = new URLSearchParams({ limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const page = await pm<any>(env, 'GET', '/v1/portfolio/activities', q);
    const rows: Row[] = (page.activities || []).map(normalize).filter((r: Row) => r.id && r.t);
    const fresh = rows.filter((r) => !known.has(r.id));
    added += fresh.length;
    await upsert(env, rows);
    if ((known.size && !fresh.length) || page.eof || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  try {
    const b = await pm<any>(env, 'GET', '/v1/account/balances');
    const usd = (b.balances || []).find((x: any) => (x.currency || 'USD') === 'USD') || b.balances?.[0];
    if (usd) {
      const cash = Number(usd.currentBalance ?? 0), pos = Number(usd.assetNotional ?? 0);
      await env.DB.prepare('INSERT OR REPLACE INTO snapshots (t, cash, positions, portfolio, reserved, raw) VALUES (?,?,?,?,?,?)')
        .bind(new Date().toISOString(), cash, pos, cash + pos, Number(usd.balanceReservation ?? 0), JSON.stringify(b)).run();
    }
  } catch (e: any) {
    await logSync(env, false, added, `balances: ${e?.message || e}`);
    return { ok: true, added, warning: 'balances failed' };
  }
  await logSync(env, true, added, null);
  return { ok: true, added };
}

async function logSync(env: Env, ok: boolean, added: number, msg: string | null) {
  await env.DB.prepare('INSERT OR REPLACE INTO sync_log (t, ok, added, msg) VALUES (?,?,?,?)')
    .bind(new Date().toISOString(), ok ? 1 : 0, added, msg).run();
}

// Paper trades: the bot (or you) logs a call here instead of placing it.
// Graded later against how the market settled. Nothing here touches real money.
async function listPaper(env: Env) {
  return (await env.DB.prepare('SELECT * FROM paper_trades ORDER BY created_at DESC LIMIT 500').all()).results;
}

async function addPaper(env: Env, b: any) {
  const required = ['market_slug', 'side', 'price', 'stake'];
  for (const k of required) if (b?.[k] === undefined) throw new Error(`missing ${k}`);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO paper_trades (id, created_at, strategy, market_slug, title, side, price, stake, rationale, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, new Date().toISOString(), b.strategy || 'manual', b.market_slug, b.title || null, b.side, Number(b.price), Number(b.stake), b.rationale || null, 'open').run();
  return { id };
}

// ---------- auth: one password, then a signed cookie good for a year.
// (Home-screen web apps on iOS handle HTTP basic auth badly, so no basic auth.)

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function secretOf(env: Env) {
  return env.SESSION_SECRET || `pm:${env.DASH_PASSWORD}`;
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authed(req: Request, env: Env) {
  if (!env.DASH_PASSWORD) return true; // local dev without a password
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)pm_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(secretOf(env), exp));
}

function cookie(value: string, maxAge: number) {
  return `pm_session=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function login(req: Request, env: Env) {
  let error = '';
  if (req.method === 'POST') {
    const form = await req.formData();
    const pw = String(form.get('password') || '');
    if (env.DASH_PASSWORD && safeEqual(pw, env.DASH_PASSWORD)) {
      const exp = String(Math.floor(Date.now() / 1000) + ONE_YEAR);
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': cookie(`${exp}.${await hmac(secretOf(env), exp)}`, ONE_YEAR) } });
    }
    error = 'That password didn’t match.';
  }
  return new Response(loginPage(error), { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function loginPage(error: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Pilk Bets">
<meta name="theme-color" content="#000000"><link rel="apple-touch-icon" href="/icon-180.png"><link rel="manifest" href="/manifest.webmanifest">
<title>Pilk Bets</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#000;color:#f5f5f7;font:17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom))}
form{width:100%;max-width:340px;display:grid;gap:14px}
img{width:72px;height:72px;border-radius:17px;margin:0 auto 6px}
h1{font:600 28px/1.1 -apple-system,"SF Pro Display",system-ui;letter-spacing:-.02em;text-align:center;margin:0}
p{margin:0 0 10px;text-align:center;color:#8e8e93;font-size:15px}
input{font:inherit;font-size:17px;color:inherit;background:#1c1c1e;border:1px solid #2c2c2e;border-radius:14px;padding:15px 16px;outline:none;transition:border-color 160ms ease}
input:focus{border-color:#0a84ff}
button{font:600 17px/1 -apple-system,system-ui;color:#000;background:#f5f5f7;border:0;border-radius:14px;padding:16px;transition:transform 120ms cubic-bezier(.23,1,.32,1)}
button:active{transform:scale(.97)}.err{color:#ff453a;text-align:center;font-size:15px;min-height:1.2em}
</style></head><body><form method="post" action="/login">
<img src="/icon-180.png" alt=""><h1>Pilk Bets</h1><p>Your Polymarket record, on your home screen.</p>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Unlock</button><div class="err">${error}</div></form></body></html>`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
