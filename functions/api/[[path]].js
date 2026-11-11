// ROB RUN clan hub API. One Pages Function handles every /api/* route.
//
// Environment (Cloudflare Pages > Settings > Variables and Secrets):
//   DB                     D1 binding (wrangler.toml)
//   DISCORD_CLIENT_ID      OAuth app id
//   DISCORD_CLIENT_SECRET  OAuth app secret (encrypted)
//   DISCORD_GUILD_ID       clan server id; only its members can log in
//   DISCORD_WEBHOOK_URL    alert channel webhook (encrypted)
//   INGEST_TOKEN           bearer token for POST /api/raids/ingest (encrypted)
//   ADMIN_IDS              comma-separated Discord user ids
//   DEV_LOGIN              "1" only in local dev (`npm run dev` sets it); never in production

const SESSION_COOKIE = 'rr_session';
const STATE_COOKIE = 'rr_oauth_state';
const SESSION_DAYS = 30;
const WIPE_DAYS = 7;
const DISCORD_API = 'https://discord.com/api/v10';

export const RAID_KINDS = ['defend', 'attack', 'info'];
const INPUT_STATUSES = ['assumed', 'reported', 'measured', 'game', 'unknown', 'setup'];
const PENDING_STATUSES = ['assumed', 'reported', 'unknown'];
// Criminal level bonuses, from robrun.info (game data; the in-game calculation is untested there).
const LEVEL_BONUS = { smuggler: [0, 0.05, 0.1, 0.15, 0.25], fence: [0, 0.1, 0.2, 0.35, 0.5] };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function htmlPage(status, title, message, headers = {}) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="notice"><h1>${escHtml(title)}</h1><p>${escHtml(message)}</p><p><a class="btn" href="/">Back to the hub</a></p></main></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

// ---------------------------------------------------------------------------------------------
// Entry point

export async function onRequest(context) {
  const { request, env, params } = context;
  try {
    if (!env.DB) throw new HttpError(500, 'DB binding missing: add the D1 binding "DB" in Pages > Settings > Bindings');
    const url = new URL(request.url);
    const raw = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
    // Path parts arrive URL-encoded (a member id like "dev:alice" comes in as "dev%3Aalice").
    const parts = raw.map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    const method = request.method.toUpperCase();
    const ctx = { request, env, url, db: env.DB, method, parts };

    if (method !== 'GET' && method !== 'HEAD' && !(parts[0] === 'raids' && parts[1] === 'ingest')) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
    }

    const route = `${method} /${parts.join('/')}`;
    if (parts[0] === 'auth') return await authRoutes(ctx, route);
    if (route === 'GET /me') return await getMe(ctx);
    if (route === 'POST /raids/ingest') return await ingestRaid(ctx);

    ctx.me = await requireMember(ctx);
    ctx.wipe = await currentWipe(ctx.db);
    switch (`${method} /${parts[0] ?? ''}`) {
      case 'GET /progress': return await getProgress(ctx);
      case 'PUT /progress': return await putProgress(ctx);
      case 'GET /income': return await getIncome(ctx);
      case 'PUT /inputs': return await putInput(ctx);
      case 'GET /plan': return await getPlan(ctx);
      case 'POST /plan': return await postPlan(ctx);
      case 'PATCH /plan': return await patchPlan(ctx);
      case 'DELETE /plan': return await deletePlan(ctx);
      case 'POST /wipes': return await postWipe(ctx);
      case 'GET /items': return await getItems(ctx);
      case 'PUT /items': return await putItemPrice(ctx);
      case 'GET /raids': return await getRaids(ctx);
      case 'POST /raids': return await postRaid(ctx);
      case 'DELETE /raids': return await deleteRaid(ctx);
      case 'DELETE /members': return await deleteMember(ctx);
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: `Server error: ${e.message}` }, 500);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(url, name, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function body(request) {
  try {
    const data = await request.json();
    if (data && typeof data === 'object') return data;
  } catch {}
  throw new HttpError(400, 'Expected a JSON object body');
}

function text(value, field, max, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const v = value.trim();
  if (required && !v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return v;
}

function isoTime(value, field) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new HttpError(400, `${field} is not a valid date and time`);
  return new Date(t).toISOString();
}

const adminIds = (env) => new Set(String(env.ADMIN_IDS ?? '').split(/[\s,]+/).filter(Boolean));
const isLocal = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const devLoginOn = (env, url) => env.DEV_LOGIN === '1' && isLocal(url);

async function sessionMember(ctx) {
  const token = cookies(ctx.request)[SESSION_COOKIE];
  if (!token) return null;
  const row = await ctx.db
    .prepare(`SELECT m.id, m.name, m.avatar FROM sessions s JOIN members m ON m.id = s.member_id
              WHERE s.token_hash = ? AND s.expires_at > datetime('now')`)
    .bind(await sha256(token))
    .first();
  if (!row) return null;
  if (isDevId(row.id) && !devLoginOn(ctx.env, ctx.url)) return null;
  const isAdmin = isDevId(row.id) ? row.id === 'dev' : adminIds(ctx.env).has(row.id);
  return { ...row, isAdmin };
}

// Local dev accounts: "dev" (admin) and "dev:<name>" (ordinary members, for testing several people).
const isDevId = (id) => id === 'dev' || String(id).startsWith('dev:');
// SQL condition that hides dev accounts unless dev login is on. Bind devFlag(ctx) to the "?".
const MEMBER_VISIBLE = `(? = 1 OR (m.id != 'dev' AND m.id NOT LIKE 'dev:%'))`;
const devFlag = (ctx) => (devLoginOn(ctx.env, ctx.url) ? 1 : 0);

async function requireMember(ctx) {
  const me = await sessionMember(ctx);
  if (!me) throw new HttpError(401, 'Not logged in');
  return me;
}

function requireAdmin(ctx) {
  if (!ctx.me.isAdmin) throw new HttpError(403, 'Admins only');
}

async function currentWipe(db) {
  let w = await db.prepare('SELECT id, opened_at FROM wipes ORDER BY id DESC LIMIT 1').first();
  if (!w) {
    await db.prepare('INSERT INTO wipes (opened_at) VALUES (?)').bind(new Date().toISOString()).run();
    w = await db.prepare('SELECT id, opened_at FROM wipes ORDER BY id DESC LIMIT 1').first();
  }
  return { ...w, next_at: new Date(Date.parse(w.opened_at) + WIPE_DAYS * 864e5).toISOString() };
}

async function startSession(ctx, member) {
  await ctx.db
    .prepare(`INSERT INTO members (id, name, avatar) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, last_seen = datetime('now')`)
    .bind(member.id, member.name, member.avatar ?? null)
    .run();
  const token = randomToken();
  await ctx.db.batch([
    ctx.db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
    ctx.db
      .prepare(`INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
      .bind(await sha256(token), member.id, `+${SESSION_DAYS} days`),
  ]);
  return cookie(ctx.url, SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

// ---------------------------------------------------------------------------------------------
// Auth

async function authRoutes(ctx, route) {
  const { env, url, request } = ctx;

  if (route === 'GET /auth/dev') {
    if (!devLoginOn(env, url)) throw new HttpError(404, 'Not found');
    // ?as=Name logs in as a separate non-admin test member; without it, as the admin "Dev user".
    const as = (url.searchParams.get('as') ?? '').trim().slice(0, 32);
    const slug = as.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const member = slug ? { id: `dev:${slug}`, name: as } : { id: 'dev', name: 'Dev user' };
    const setCookie = await startSession(ctx, member);
    const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
    if (wantsHtml) return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': setCookie } });
    return json({ ok: true, member }, 200, { 'set-cookie': setCookie });
  }

  if (route === 'POST /auth/logout') {
    const token = cookies(request)[SESSION_COOKIE];
    if (token) await ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(url, SESSION_COOKIE, '', 0) });
  }

  if (route === 'GET /auth/login') {
    if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_GUILD_ID) {
      return htmlPage(500, 'Discord login is not set up', 'DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_GUILD_ID must all be set in Cloudflare, then redeploy.');
    }
    const state = randomToken(16);
    const q = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${url.origin}/api/auth/callback`,
      scope: 'identify guilds.members.read',
      state,
      prompt: 'none',
    });
    return new Response(null, {
      status: 302,
      headers: { location: `https://discord.com/oauth2/authorize?${q}`, 'set-cookie': cookie(url, STATE_COOKIE, state, 600) },
    });
  }

  if (route === 'GET /auth/callback') {
    const clearState = cookie(url, STATE_COOKIE, '', 0);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const expected = cookies(request)[STATE_COOKIE];
    if (!state || !expected || state !== expected) {
      return htmlPage(400, 'Bad OAuth state', 'Login started on a different address, or took longer than 10 minutes. Start again from the hub.', { 'set-cookie': clearState });
    }
    if (!code) return htmlPage(400, 'Discord login cancelled', url.searchParams.get('error_description') ?? 'No code was returned.', { 'set-cookie': clearState });

    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/api/auth/callback`,
      }),
    });
    if (!tokenRes.ok) {
      console.error('discord token exchange failed', tokenRes.status, await tokenRes.text());
      return htmlPage(502, 'Discord login failed', `Discord refused the login (HTTP ${tokenRes.status}). Check DISCORD_CLIENT_SECRET and the redirect URL, then redeploy.`, { 'set-cookie': clearState });
    }
    const { access_token } = await tokenRes.json();
    const auth = { authorization: `Bearer ${access_token}` };
    const [userRes, memberRes] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers: auth }),
      fetch(`${DISCORD_API}/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, { headers: auth }),
    ]);
    if (!userRes.ok) return htmlPage(502, 'Discord login failed', `Could not read your Discord profile (HTTP ${userRes.status}).`, { 'set-cookie': clearState });
    if (memberRes.status === 429 || memberRes.status >= 500) {
      return htmlPage(502, 'Discord login failed', `Discord is busy (HTTP ${memberRes.status}). Try again in a minute.`, { 'set-cookie': clearState });
    }
    if (!memberRes.ok) {
      return htmlPage(403, 'Not a member of the clan Discord server', 'Join the clan Discord server, then log in again.', { 'set-cookie': clearState });
    }
    const user = await userRes.json();
    const guildMember = await memberRes.json();
    const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
    const name = guildMember.nick || user.global_name || user.username;
    const setCookie = await startSession(ctx, { id: user.id, name, avatar });
    const headers = new Headers({ location: '/' });
    headers.append('set-cookie', setCookie);
    headers.append('set-cookie', clearState);
    return new Response(null, { status: 302, headers });
  }

  throw new HttpError(404, 'Not found');
}

async function getMe(ctx) {
  const me = await sessionMember(ctx);
  return json({
    member: me,
    devLogin: devLoginOn(ctx.env, ctx.url),
    wipe: me ? await currentWipe(ctx.db) : null,
  });
}

// ---------------------------------------------------------------------------------------------
// Progress (Larry's Tree research, per member, per wipe)

async function getProgress(ctx) {
  const [nodes, rows, members] = await ctx.db.batch([
    ctx.db.prepare(`SELECT id, name, category, tier, rarity, requires, research_cost,
                    COALESCE(price_override, price) AS price, sentence_years
                    FROM items WHERE kind = 'node' AND retired = 0 ORDER BY category, tier, sort`),
    ctx.db.prepare('SELECT member_id, item_id, updated_at FROM progress WHERE wipe_id = ?').bind(ctx.wipe.id),
    ctx.db.prepare(`SELECT m.id, m.name, m.avatar, m.first_seen, m.last_seen FROM members m WHERE ${MEMBER_VISIBLE} ORDER BY m.name`).bind(devFlag(ctx)),
  ]);
  const have = {};
  const lastTick = {};
  for (const r of rows.results) {
    (have[r.item_id] ??= []).push(r.member_id);
    if (!lastTick[r.member_id] || r.updated_at > lastTick[r.member_id]) lastTick[r.member_id] = r.updated_at;
  }
  return json({
    wipe: ctx.wipe,
    me: ctx.me.id,
    canEditOthers: ctx.me.isAdmin,
    members: members.results.map((m) => ({ ...m, last_tick: lastTick[m.id] ?? null, is_admin: m.id === 'dev' || adminIds(ctx.env).has(m.id) })),
    nodes: nodes.results.map((n) => ({ ...n, have: have[n.id] ?? [], mine: (have[n.id] ?? []).includes(ctx.me.id) })),
  });
}

// Walk the tree from one node: up to everything it requires, or down to everything that requires it.
export function treeWalk(nodes, start, direction) {
  const next = {};
  for (const n of nodes) {
    for (const req of (n.requires ? n.requires.split(',') : [])) {
      if (direction === 'up') (next[n.id] ??= []).push(req);
      else (next[req] ??= []).push(n.id);
    }
  }
  const seen = new Set();
  const stack = [...(next[start] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next[id] ?? []));
  }
  return [...seen];
}

// Ticking a node also ticks what it requires (you cannot research it without them).
// Unticking a node also unticks what depends on it. Members change their own list; admins anyone's.
async function putProgress(ctx) {
  const b = await body(ctx.request);
  const id = text(b.item_id, 'item_id', 120, { required: true });
  let memberId = ctx.me.id;
  if (b.member_id != null && b.member_id !== ctx.me.id) {
    if (!ctx.me.isAdmin) throw new HttpError(403, "Only admins can change another member's unlocks");
    const m = await ctx.db.prepare('SELECT id FROM members WHERE id = ?').bind(String(b.member_id)).first();
    if (!m) throw new HttpError(400, 'Unknown member');
    memberId = m.id;
  }
  const { results: nodes } = await ctx.db.prepare(`SELECT id, requires FROM items WHERE kind = 'node' AND retired = 0`).all();
  if (!nodes.some((n) => n.id === id)) throw new HttpError(400, 'Unknown tree node');
  const { results: owned } = await ctx.db
    .prepare('SELECT item_id FROM progress WHERE wipe_id = ? AND member_id = ?')
    .bind(ctx.wipe.id, memberId)
    .all();
  const has = new Set(owned.map((r) => r.item_id));

  if (b.done) {
    const added = [id, ...treeWalk(nodes, id, 'up')].filter((x) => !has.has(x));
    if (added.length) {
      await ctx.db.batch(added.map((x) =>
        ctx.db.prepare('INSERT OR IGNORE INTO progress (wipe_id, member_id, item_id) VALUES (?, ?, ?)').bind(ctx.wipe.id, memberId, x)));
    }
    return json({ ok: true, member_id: memberId, added, removed: [] });
  }
  const removed = [id, ...treeWalk(nodes, id, 'down')].filter((x) => has.has(x));
  if (removed.length) {
    await ctx.db.batch(removed.map((x) =>
      ctx.db.prepare('DELETE FROM progress WHERE wipe_id = ? AND member_id = ? AND item_id = ?').bind(ctx.wipe.id, memberId, x)));
  }
  return json({ ok: true, member_id: memberId, added: [], removed });
}

// ---------------------------------------------------------------------------------------------
// Money: business model

async function getIncome(ctx) {
  const level = Math.min(5, Math.max(1, Number(ctx.url.searchParams.get('level')) || 1));
  const [items, inputs] = await ctx.db.batch([
    ctx.db.prepare(`SELECT id, name, kind, rarity, research_cost, price_source,
                    COALESCE(price_override, price) AS price, price_override IS NOT NULL AS overridden
                    FROM items WHERE retired = 0`),
    ctx.db.prepare(`SELECT i.*, m.name AS updated_by_name FROM model_inputs i
                    LEFT JOIN members m ON m.id = i.updated_by ORDER BY i.sort`),
  ]);
  const businesses = computeIncome(items.results, inputs.results, level);
  return json({ level, businesses, inputs: inputs.results });
}

// Pure function so it can be checked without a database.
export function computeIncome(itemRows, inputRows, level = 1) {
  const items = Object.fromEntries(itemRows.map((r) => [r.id, r]));
  const inputs = Object.fromEntries(inputRows.map((r) => [r.key, r]));
  const val = (key) => (inputs[key] && inputs[key].value != null ? Number(inputs[key].value) : null);
  const price = (id) => {
    const it = items[id];
    if (!it || it.price == null) return null;
    const bonus = LEVEL_BONUS[it.price_source]?.[level - 1] ?? 0;
    return Math.round(it.price * (1 + bonus));
  };
  const setup = (parts) => {
    const lines = [];
    let total = 0;
    for (const [id, qty] of parts) {
      const it = items[id];
      if (!it) continue;
      const cost = ((it.research_cost ?? 0) + (it.price ?? 0)) * qty;
      total += cost;
      lines.push({ id, name: qty > 1 ? `${it.name} ×${qty}` : it.name, research: (it.research_cost ?? 0) * qty, price: (it.price ?? 0) * qty, cost });
    }
    return { total, lines };
  };
  const pending = (biz) =>
    inputRows.filter((r) => r.business === biz && PENDING_STATUSES.includes(r.status)).map((r) => r.label);
  const finish = (b) => ({
    ...b,
    payback_hours: b.per_hour > 0 ? b.setup_cost / b.per_hour : null,
    pending: pending(b.id),
    provisional: pending(b.id).length > 0,
  });

  // Chemical Laboratory ------------------------------------------------------------------
  const places = val('chem_freezer_places') ?? 0;
  const freezeMinutes = val('chem_freezer_minutes') || 30;
  const concPerHour = (places * 60) / freezeMinutes;
  const canistersPerConc = (val('chem_canisters_per_load') ?? 1) / (val('chem_concentrate_per_cycle') || 1);
  const split = [['1', val('chem_split_uncommon') ?? 0], ['2', val('chem_split_epic') ?? 0], ['3', val('chem_split_legendary') ?? 0]];
  const splitTotal = split.reduce((s, [, p]) => s + p, 0) || 1;
  const powder = val('chem_powder_per_crystal');
  let crystalValue = 0;
  const sellLines = [];
  for (const [r, pct] of split) {
    const crystal = price(`hard_crystal_${r}`) ?? 0;
    const crushed = powder ? powder * (price(`lab_crystal_${r}`) ?? 0) : 0;
    const best = Math.max(crystal, crushed);
    crystalValue += (pct / splitTotal) * best;
    sellLines.push(`${items[`hard_crystal_${r}`]?.rarity ?? r}: ${Math.round((pct / splitTotal) * 100)}% × $${best.toLocaleString('en-US')} (${crushed > crystal ? 'crushed to powder, Fence' : 'Hard Crystals, Smuggler'})`);
  }
  const reagent = price('reagents_1') ?? 0;
  const chemSetup = setup([['meth_lab_1', 1], ['cargo_production_workbench_1', 1], ['cargo_charge_workbench_lab_freezer_1', 1]]);
  const chemMargin = crystalValue - canistersPerConc * reagent;
  const chem = finish({
    id: 'chem',
    name: 'Chemical Laboratory',
    setup_cost: chemSetup.total,
    setup_lines: chemSetup.lines,
    per_hour: concPerHour * chemMargin,
    lines: [
      `Freezer: ${places} places, ${freezeMinutes} min per Concentrate = ${round(concPerHour)} Concentrate/hour`,
      `Value per Concentrate: $${Math.round(crystalValue).toLocaleString('en-US')} (${sellLines.join('; ')})`,
      `Reagents used: ${round(canistersPerConc)} canister per Concentrate × $${reagent.toLocaleString('en-US')} (Smuggler value) = $${Math.round(canistersPerConc * reagent).toLocaleString('en-US')}`,
      `Needs ${round(concPerHour * canistersPerConc)} Reagent Canisters per hour; the reactor is assumed not to be the bottleneck`,
      powder ? `Powder per crystal: ${powder}` : 'Powder per crystal is unknown, so crushing is not counted',
    ],
  });

  // Grow Room ------------------------------------------------------------------------------
  const tables = Math.max(1, Math.round(val('grow_tables') ?? 1));
  const bushes = val('grow_bushes_per_table') ?? 6;
  const bags = val('grow_bags_per_bush') ?? 3;
  const hours = val('grow_hours_per_harvest') || 1;
  const bag = price('bush_drugs_1') ?? 0;
  const growSetup = setup([['narco_farm_1', 1], ['cargo_charge_workbench_garden_bed', tables]]);
  const grow = finish({
    id: 'grow',
    name: 'Grow Room',
    setup_cost: growSetup.total,
    setup_lines: growSetup.lines,
    per_hour: (tables * bushes * bags * bag) / hours,
    lines: [
      `${tables} table${tables > 1 ? 's' : ''} × ${bushes} bushes × ${bags} bags every ${hours} h`,
      `Uncommon Harvest Bag: $${bag.toLocaleString('en-US')} (Fence)`,
      'Bushes are found as loot, so they are not in setup. Epic and Legendary bushes pay 1.5× and 2× per bag.',
    ],
  });

  // Contraband repack ----------------------------------------------------------------------
  const minutes = val('repack_minutes') || 30;
  const rarityRate = (val('repack_rarity_rate') ?? 0) / 100;
  const slots = Math.max(1, Math.round(val('repack_slots') ?? 1));
  const premium = price('cargo_alcohol_grade_2') ?? 0;
  const rarity = price('cargo_alcohol_grade_3') ?? 0;
  const cargoIn = price('cargo_alcohol_grade_1') ?? 0;
  const out = (1 - rarityRate) * premium + rarityRate * rarity;
  const repackSetup = setup([['cargo_exchange_workbench_1', 1]]);
  const repack = finish({
    id: 'repack',
    name: 'Contraband repack',
    setup_cost: repackSetup.total,
    setup_lines: repackSetup.lines,
    per_hour: slots * (60 / minutes) * (out - cargoIn),
    lines: [
      `${slots} slot${slots > 1 ? 's' : ''} × ${round(60 / minutes)} repacks/hour (${minutes} min each)`,
      `Out: ${Math.round((1 - rarityRate) * 100)}% Premium $${premium.toLocaleString('en-US')} + ${Math.round(rarityRate * 100)}% Rarity $${rarity.toLocaleString('en-US')} (Smuggler)`,
      `In: Contraband Cargo $${cargoIn.toLocaleString('en-US')} from the hub cargo seller`,
    ],
  });

  return [chem, grow, repack].sort((a, b) => b.per_hour - a.per_hour);
}

const round = (n) => Math.round(n * 100) / 100;

async function putInput(ctx) {
  const key = ctx.parts[1];
  const b = await body(ctx.request);
  const row = await ctx.db.prepare('SELECT key FROM model_inputs WHERE key = ?').bind(key ?? '').first();
  if (!row) throw new HttpError(404, 'Unknown model input');
  let value = null;
  if (b.value !== null && b.value !== '' && b.value !== undefined) {
    value = Number(b.value);
    if (!Number.isFinite(value) || value < 0 || value > 1e6) throw new HttpError(400, 'value must be a number from 0 to 1,000,000');
  }
  const status = b.status ?? (value == null ? 'unknown' : 'measured');
  if (!INPUT_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${INPUT_STATUSES.join(', ')}`);
  await ctx.db
    .prepare(`UPDATE model_inputs SET value = ?, status = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`)
    .bind(value, status, ctx.me.id, key)
    .run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// Wipe planner

async function getPlan(ctx) {
  const [items, members, nodes, wipes] = await ctx.db.batch([
    ctx.db.prepare(`SELECT p.*, m.name AS assignee_name, i.name AS item_name FROM plan p
                    LEFT JOIN members m ON m.id = p.assignee LEFT JOIN items i ON i.id = p.item_id
                    WHERE p.wipe_id = ? ORDER BY p.done, p.sort, p.id`).bind(ctx.wipe.id),
    ctx.db.prepare(`SELECT m.id, m.name FROM members m WHERE ${MEMBER_VISIBLE} ORDER BY m.name`).bind(devFlag(ctx)),
    ctx.db.prepare(`SELECT id, name, category, tier FROM items WHERE kind = 'node' AND retired = 0 ORDER BY category, tier, sort`),
    ctx.db.prepare('SELECT id, opened_at FROM wipes ORDER BY id DESC LIMIT 5'),
  ]);
  return json({ wipe: ctx.wipe, wipes: wipes.results, items: items.results, members: members.results, nodes: nodes.results });
}

async function postPlan(ctx) {
  const b = await body(ctx.request);
  const itemId = text(b.item_id, 'item_id', 120) || null;
  let title = text(b.title, 'title', 200);
  if (itemId) {
    const node = await ctx.db.prepare('SELECT name FROM items WHERE id = ?').bind(itemId).first();
    if (!node) throw new HttpError(400, 'Unknown item');
    title ||= `Research ${node.name}`;
  }
  if (!title) throw new HttpError(400, 'title is required');
  const assignee = await validAssignee(ctx, b.assignee);
  const r = await ctx.db
    .prepare(`INSERT INTO plan (wipe_id, title, item_id, assignee, sort, created_by)
              VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM plan WHERE wipe_id = ?), ?)`)
    .bind(ctx.wipe.id, title, itemId, assignee, ctx.wipe.id, ctx.me.id)
    .run();
  return json({ ok: true, id: r.meta.last_row_id });
}

async function validAssignee(ctx, value) {
  if (value == null || value === '') return null;
  const m = await ctx.db.prepare('SELECT id FROM members WHERE id = ?').bind(String(value)).first();
  if (!m) throw new HttpError(400, 'Unknown assignee');
  return m.id;
}

async function planRow(ctx) {
  const row = await ctx.db.prepare('SELECT * FROM plan WHERE id = ? AND wipe_id = ?').bind(Number(ctx.parts[1]), ctx.wipe.id).first();
  if (!row) throw new HttpError(404, 'Plan item not found in this wipe');
  return row;
}

async function patchPlan(ctx) {
  const row = await planRow(ctx);
  const b = await body(ctx.request);
  const done = b.done === undefined ? row.done : b.done ? 1 : 0;
  const title = b.title === undefined ? row.title : text(b.title, 'title', 200, { required: true });
  const assignee = b.assignee === undefined ? row.assignee : await validAssignee(ctx, b.assignee);
  await ctx.db.prepare('UPDATE plan SET done = ?, title = ?, assignee = ? WHERE id = ?').bind(done, title, assignee, row.id).run();
  return json({ ok: true });
}

async function deletePlan(ctx) {
  const row = await planRow(ctx);
  if (!ctx.me.isAdmin && row.created_by !== ctx.me.id) throw new HttpError(403, 'Only the creator or an admin can delete this');
  await ctx.db.prepare('DELETE FROM plan WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
}

async function postWipe(ctx) {
  requireAdmin(ctx);
  const b = await body(ctx.request);
  const openedAt = isoTime(b.opened_at, 'opened_at');
  if (!openedAt) throw new HttpError(400, 'opened_at is required: when the new server opened');
  if (Date.parse(openedAt) <= Date.parse(ctx.wipe.opened_at)) throw new HttpError(400, 'The new wipe must open after the current one');
  if (Date.parse(openedAt) > Date.now() + 2 * 864e5) throw new HttpError(400, 'opened_at is more than 2 days in the future');
  const prev = ctx.wipe.id;
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO wipes (opened_at, created_by) VALUES (?, ?)').bind(openedAt, ctx.me.id),
    ctx.db
      .prepare(`INSERT INTO plan (wipe_id, title, item_id, assignee, done, sort, created_by)
                SELECT (SELECT MAX(id) FROM wipes), title, item_id, assignee, 0, sort, created_by FROM plan WHERE wipe_id = ?`)
      .bind(prev),
  ]);
  return json({ ok: true, wipe: await currentWipe(ctx.db) });
}

// ---------------------------------------------------------------------------------------------
// Items and prices

async function getItems(ctx) {
  const { results } = await ctx.db
    .prepare(`SELECT i.id, i.kind, i.name, i.category, i.tier, i.rarity, i.research_cost, i.price AS seed_price,
              COALESCE(i.price_override, i.price) AS price, i.price_source, i.smuggler, i.fence, i.hub_buy, i.seized,
              i.sentence_years, i.price_override IS NOT NULL AS overridden, m.name AS override_by, i.price_override_at
              FROM items i LEFT JOIN members m ON m.id = i.price_override_by
              WHERE i.retired = 0 ORDER BY i.kind DESC, i.category, i.tier, i.sort`)
    .all();
  return json({ items: results });
}

async function putItemPrice(ctx) {
  const id = ctx.parts[1];
  const b = await body(ctx.request);
  const item = await ctx.db.prepare('SELECT id FROM items WHERE id = ?').bind(id ?? '').first();
  if (!item) throw new HttpError(404, 'Unknown item');
  if (b.price === null || b.price === '') {
    await ctx.db.prepare('UPDATE items SET price_override = NULL, price_override_by = NULL, price_override_at = NULL WHERE id = ?').bind(id).run();
    return json({ ok: true, reset: true });
  }
  const price = Number(b.price);
  if (!Number.isInteger(price) || price < 0 || price > 1e9) throw new HttpError(400, 'price must be a whole number from 0 to 1,000,000,000');
  await ctx.db
    .prepare(`UPDATE items SET price_override = ?, price_override_by = ?, price_override_at = datetime('now') WHERE id = ?`)
    .bind(price, ctx.me.id, id)
    .run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// Members

// Admin only. Removes a member from the clan list with their sessions and unlocks. Someone still
// in the Discord server can log in again later and is added back with an empty list.
async function deleteMember(ctx) {
  requireAdmin(ctx);
  const id = ctx.parts[1] ?? '';
  if (id === ctx.me.id) throw new HttpError(400, 'You cannot remove yourself');
  const m = await ctx.db.prepare('SELECT id, name FROM members WHERE id = ?').bind(id).first();
  if (!m) throw new HttpError(404, 'Member not found');
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM sessions WHERE member_id = ?').bind(id),
    ctx.db.prepare('DELETE FROM progress WHERE member_id = ?').bind(id),
    ctx.db.prepare('DELETE FROM status WHERE member_id = ?').bind(id),
    ctx.db.prepare('UPDATE plan SET assignee = NULL WHERE assignee = ?').bind(id),
    ctx.db.prepare('DELETE FROM members WHERE id = ?').bind(id),
  ]);
  return json({ ok: true, removed: m.name });
}

// ---------------------------------------------------------------------------------------------
// Raids

async function getRaids(ctx) {
  const { results } = await ctx.db
    .prepare(`SELECT r.*, m.name AS created_by_name FROM raids r LEFT JOIN members m ON m.id = r.created_by
              WHERE r.wipe_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 100`)
    .bind(ctx.wipe.id)
    .all();
  return json({ wipe: ctx.wipe, kinds: RAID_KINDS, raids: results, webhook: Boolean(ctx.env.DISCORD_WEBHOOK_URL) });
}

function raidInput(b) {
  if (!RAID_KINDS.includes(b.kind)) throw new HttpError(400, `kind must be one of ${RAID_KINDS.join(', ')}`);
  return {
    kind: b.kind,
    target: text(b.target, 'target', 100, { required: true }),
    at_time: isoTime(b.at_time, 'at_time'),
    note: text(b.note, 'note', 300),
  };
}

async function saveRaid(ctx, raid, createdBy, source, byName) {
  const wipe = ctx.wipe ?? (await currentWipe(ctx.db));
  const r = await ctx.db
    .prepare('INSERT INTO raids (wipe_id, kind, target, at_time, note, created_by, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(wipe.id, raid.kind, raid.target, raid.at_time, raid.note, createdBy, source)
    .run();
  const id = r.meta.last_row_id;
  const ping = await pingDiscord(ctx.env, raid, byName);
  if (ping.ok) await ctx.db.prepare('UPDATE raids SET pinged = 1 WHERE id = ?').bind(id).run();
  return json({ ok: true, id, pinged: ping.ok, ...(ping.ok ? {} : { warning: `Raid saved, but Discord was not pinged: ${ping.reason}` }) });
}

async function postRaid(ctx) {
  return saveRaid(ctx, raidInput(await body(ctx.request)), ctx.me.id, 'site', ctx.me.name);
}

async function ingestRaid(ctx) {
  if (!ctx.env.INGEST_TOKEN) throw new HttpError(404, 'Not found');
  const header = ctx.request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await safeEqual(token, ctx.env.INGEST_TOKEN))) throw new HttpError(401, 'Bad ingest token');
  const b = await body(ctx.request);
  return saveRaid(ctx, raidInput(b), null, 'ingest', text(b.source, 'source', 40) || 'raid hook');
}

async function deleteRaid(ctx) {
  const row = await ctx.db.prepare('SELECT id, created_by FROM raids WHERE id = ?').bind(Number(ctx.parts[1])).first();
  if (!row) throw new HttpError(404, 'Raid not found');
  if (!ctx.me.isAdmin && row.created_by !== ctx.me.id) throw new HttpError(403, 'Only the creator or an admin can delete this');
  await ctx.db.prepare('DELETE FROM raids WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
}

// Discord message text: neutralise mentions in user text so only our own @here pings.
const discordSafe = (s) => String(s).replace(/@/g, '@​').replace(/<(?=[@#&!:t])/g, '<​');

export function raidMessage(raid, byName) {
  const head = { defend: '🚨 **Base under attack**', attack: '⚔️ **Raid planned**', info: '📣 **Clan alert**' }[raid.kind];
  const lines = [`@here ${head}: ${discordSafe(raid.target)}`];
  if (raid.at_time) {
    const t = Math.floor(Date.parse(raid.at_time) / 1000);
    lines.push(`When: <t:${t}:t> (<t:${t}:R>)`);
  }
  if (raid.note) lines.push(discordSafe(raid.note));
  lines.push(`— ${discordSafe(byName)} via Clan Hub`);
  return lines.join('\n').slice(0, 1900);
}

async function pingDiscord(env, raid, byName) {
  const hook = env.DISCORD_WEBHOOK_URL;
  if (!hook) return { ok: false, reason: 'DISCORD_WEBHOOK_URL is not set' };
  if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook)) {
    return { ok: false, reason: 'DISCORD_WEBHOOK_URL is not a Discord webhook URL' };
  }
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: raidMessage(raid, byName), allowed_mentions: { parse: ['everyone'] } }),
    });
    if (!res.ok) return { ok: false, reason: `the webhook returned HTTP ${res.status}${res.status === 404 ? ' (was it deleted?)' : ''}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `could not reach Discord (${e.message})` };
  }
}
