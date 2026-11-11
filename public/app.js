// Clan Hub front end. No dependencies, no build step.
// Every value from the API, board.json or a user goes through esc() before it reaches innerHTML.

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const short$ = (n) => (n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const RARITY = { Common: '#9a9894', Uncommon: '#67f835', Rare: '#00a6ec', Epic: '#e375ff', Legendary: '#ffd500', Exotic: '#d93f3f' };
const KIND_LABEL = { defend: 'Base under attack', attack: 'Raid planned', info: 'Clan alert' };
const SOURCE_LABEL = { laptop: 'Trade Laptop', smuggler: 'Smuggler', fence: 'Fence', hub_buy: 'Hub seller (buy)', seized: 'Seized value' };
const GROUP = { chem: 'Chemical Laboratory', grow: 'Grow Room', repack: 'Contraband repack' };
const TIER = ['', 'I', 'II', 'III', 'IV'];
const STALE_DAYS = 3;
const iconUrl = (id) => `/img/items/${encodeURIComponent(id)}.webp`;
const icon = (id, cls = '') => `<img class="ic ${cls}" src="${esc(iconUrl(id))}" alt="" loading="lazy" draggable="false">`;

let me = null;
let wipe = null;
const cache = { board: null, progress: null };

// Images that fail to load (missing icon) are hidden rather than shown broken.
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('noimg'); }, true);

// Dates from SQLite come as "YYYY-MM-DD HH:MM:SS" in UTC.
const parseTime = (s) => (s ? new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : null);
function ago(s) {
  const d = parseTime(s);
  if (!d) return '';
  const sec = Math.round((Date.now() - d) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
const daysSince = (s) => (s ? (Date.now() - parseTime(s)) / 864e5 : Infinity);
const when = (s) => {
  const d = parseTime(s);
  return d ? d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
};
const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('Not logged in'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'bad' ? 7000 : 3000);
}
const fail = (e) => toast(e.message, 'bad');

// Page header in the hub's style: small kicker, big condensed italic title, optional lead text.
const hero = (kicker, title, lead = '', extra = '') =>
  `<header class="hero"><p class="kicker">${kicker}</p><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}${extra}</header>`;

// ------------------------------------------------------------------------------------------
// Data shared by several pages

async function loadBoard() {
  if (!cache.board) {
    const res = await fetch('/data/board.json');
    if (!res.ok) throw new Error('Board layout missing: run the sync (npm run sync)');
    cache.board = await res.json();
  }
  return cache.board;
}

async function loadProgress() {
  const data = await api('GET', 'progress');
  data.byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  data.names = Object.fromEntries(data.members.map((m) => [m.id, m.name]));
  cache.progress = data;
  updateNavCounts();
  return data;
}

const countFor = (p, who) => p.nodes.filter((n) => n.have.includes(who)).length;
const spentFor = (p, who) => p.nodes.filter((n) => n.have.includes(who)).reduce((s, n) => s + (n.research_cost ?? 0), 0);

function updateNavCounts() {
  const p = cache.progress;
  if (p) $('#nav-ship').textContent = `${countFor(p, me.id)}/${p.nodes.length}`;
}

// Walk the tree up (prerequisites) or down (what depends on it). Mirrors treeWalk() in the API.
function treeWalk(nodes, start, direction) {
  const next = {};
  for (const n of nodes) {
    for (const req of n.requires ? n.requires.split(',') : []) {
      if (direction === 'up') (next[n.id] ??= []).push(req);
      else (next[req] ??= []).push(n.id);
    }
  }
  const seen = new Set();
  const stack = [...(next[start] ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (!seen.has(id)) { seen.add(id); stack.push(...(next[id] ?? [])); }
  }
  return [...seen];
}

const canEdit = (who) => who === me.id || cache.progress?.canEditOthers;

// Tick or untick a node for a member; prerequisites and dependents follow, as the API does.
async function setUnlocked(nodeId, who, done) {
  const p = cache.progress;
  const node = p.byId[nodeId];
  if (!done) {
    const deps = treeWalk(p.nodes, nodeId, 'down').filter((id) => p.byId[id]?.have.includes(who));
    if (deps.length && !confirm(`Unticking ${node.name} also unticks what needs it: ${deps.map((id) => p.byId[id].name).join(', ')}. Continue?`)) return false;
  }
  try {
    const r = await api('PUT', 'progress', { item_id: nodeId, done, member_id: who });
    for (const id of r.added) if (p.byId[id] && !p.byId[id].have.includes(who)) p.byId[id].have.push(who);
    for (const id of r.removed) if (p.byId[id]) p.byId[id].have = p.byId[id].have.filter((x) => x !== who);
    const m = p.members.find((x) => x.id === who);
    if (m) m.last_tick = new Date().toISOString();
    const extra = (r.added.length || r.removed.length) - 1;
    if (extra > 0) toast(r.added.length ? `Also unlocked ${extra} required node${extra > 1 ? 's' : ''}` : `Also removed ${extra} node${extra > 1 ? 's' : ''} that needed it`);
    updateNavCounts();
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

// ------------------------------------------------------------------------------------------
// Shell

function showLogin(devLogin = false) {
  $('#shell').hidden = true;
  closeDrawer();
  $('#login').innerHTML = `
    <section class="login">
      <div class="login-card">
        <span class="mark big" aria-hidden="true">CH</span>
        <p class="kicker">ROB RUN · CLAN</p>
        <h1>CLAN HUB</h1>
        <p class="lead">Who has unlocked what, what the clan is missing, and where the money is. Members of the clan Discord server only.</p>
        <a class="btn discord" href="/api/auth/login">Log in with Discord</a>
        ${devLogin ? `
          <a class="btn ghost" href="/api/auth/dev">Dev login (local only)</a>
          <form action="/api/auth/dev" method="get" class="row">
            <input name="as" maxlength="32" placeholder="or test as a member, e.g. Alice" aria-label="Test member name" class="grow">
            <button class="btn ghost small">Go</button>
          </form>` : ''}
      </div>
    </section>`;
}

function renderSide() {
  $('#shell').hidden = false;
  $('#login').innerHTML = '';
  const day = Math.max(1, Math.floor((Date.now() - parseTime(wipe.opened_at)) / 864e5) + 1);
  $('#brand-sub').textContent = `WIPE #${wipe.id} · DAY ${day} OF 7`;
  $('#me-card').innerHTML = `
    ${me.avatar ? `<img src="${esc(me.avatar)}" alt="" width="34" height="34" class="avatar">` : `<span class="avatar">${esc((me.name || '?')[0])}</span>`}
    <span class="grow"><b>${esc(me.name)}</b>${me.isAdmin ? '<span class="badge">ADMIN</span>' : ''}<small>Next wipe ${esc(when(wipe.next_at))}</small></span>
    <button class="link" id="logout">Log out</button>`;
  $('#logout').onclick = async () => {
    await api('POST', 'auth/logout').catch(() => {});
    location.hash = '';
    boot();
  };
}

$('#menu-btn').onclick = () => {
  const open = $('#side').classList.toggle('open');
  $('#menu-btn').setAttribute('aria-expanded', String(open));
};

const PAGES = { overview: renderOverview, shipments: renderShipments, money: renderMoney, items: renderItems, plan: renderPlan, raids: renderRaids };

async function route() {
  if (!me) return;
  const page = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  for (const a of document.querySelectorAll('#side nav a')) a.classList.toggle('on', a.dataset.page === page);
  $('#side').classList.remove('open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  closeDrawer();
  document.body.dataset.page = page;
  view.innerHTML = '<p class="muted pad">Loading…</p>';
  try {
    await PAGES[page]();
  } catch (e) {
    if (e.message !== 'Not logged in') view.innerHTML = `<p class="bad card pad">Could not load this page: ${esc(e.message)}</p>`;
  }
}

async function boot() {
  try {
    const data = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
    me = data.member;
    wipe = data.wipe;
    if (!me) return showLogin(data.devLogin);
    renderSide();
    route();
  } catch (e) {
    $('#login').innerHTML = `<p class="bad card pad">The hub API is not reachable: ${esc(e.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
boot();

// ------------------------------------------------------------------------------------------
// Drawer (details panel)

function openDrawer(html) {
  const d = $('#drawer');
  d.innerHTML = `<button class="drawer-close" data-close aria-label="Close">✕</button>${html}`;
  d.hidden = false;
  d.scrollTop = 0;
}
function closeDrawer() {
  const d = $('#drawer');
  d.hidden = true;
  d.innerHTML = '';
  document.querySelectorAll('.node.sel').forEach((n) => n.classList.remove('sel'));
}
$('#drawer').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ------------------------------------------------------------------------------------------
// Overview: clan metrics

async function renderOverview() {
  const [p, board, income] = await Promise.all([loadProgress(), loadBoard(), api('GET', 'income?level=1').catch(() => null)]);
  const total = p.nodes.length;
  const clanHas = p.nodes.filter((n) => n.have.length).length;
  const members = p.members.map((m) => ({ ...m, count: countFor(p, m.id), spent: spentFor(p, m.id) })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const tracking = members.filter((m) => m.count > 0).length;
  const avg = members.length ? Math.round(members.reduce((s, m) => s + pct(m.count, total), 0) / members.length) : 0;
  const fresh = members.filter((m) => daysSince(m.last_tick) <= STALE_DAYS).length;
  const label = Object.fromEntries(board.categories.map((c) => [c.id, c.label]));
  const branches = board.categories.slice().sort((a, b) => a.x - b.x).map((c) => {
    const nodes = p.nodes.filter((n) => board.nodes[n.id]?.cat === c.id);
    const owned = nodes.filter((n) => n.have.length);
    const show = (owned.length ? owned : nodes).slice().sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0)).slice(0, 3);
    return { ...c, total: nodes.length, owned: owned.length, show };
  });
  const gaps = p.nodes.filter((n) => !n.have.length).sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) || (a.research_cost ?? 0) - (b.research_cost ?? 0));
  const best = income?.businesses?.[0];

  view.innerHTML = `
    ${hero(`WIPE #${esc(wipe.id)} · NEXT WIPE ${esc(when(wipe.next_at)).toUpperCase()}`, 'CLAN PROGRESS',
      "Who has unlocked what in Larry's Tree. Each member keeps their own list up to date, so the clan can see it even when they are offline.")}
    <section class="stats-row">
      <div class="stat"><b>${esc(clanHas)}<small>/${esc(total)}</small></b><span>Nodes the clan has</span><i class="bar" style="--p:${pct(clanHas, total)}%"></i></div>
      <div class="stat"><b>${esc(avg)}<small>%</small></b><span>Average member completion</span><i class="bar" style="--p:${avg}%"></i></div>
      <div class="stat"><b>${esc(tracking)}<small>/${esc(members.length)}</small></b><span>Members tracking</span><i class="bar" style="--p:${pct(tracking, members.length)}%"></i></div>
      <div class="stat"><b>${esc(fresh)}<small>/${esc(members.length)}</small></b><span>Updated in the last ${STALE_DAYS} days</span><i class="bar" style="--p:${pct(fresh, members.length)}%"></i></div>
    </section>

    <section>
      <div class="sec-head"><h2>BRANCHES</h2><a class="more" href="#shipments">OPEN SHIPMENTS →</a></div>
      <div class="branches">
        ${branches.map((b) => `
          <a class="branch" href="#shipments" data-branch="${esc(b.id)}">
            <img class="branch-art" src="/img/branches/${esc(encodeURIComponent(b.id))}.webp" alt="" loading="lazy">
            <span class="branch-icons">${b.show.map((n) => icon(n.id)).join('')}</span>
            <span class="branch-name">${esc(b.label)}</span>
            <span class="branch-count">${esc(b.owned)}<small>/${esc(b.total)}</small></span>
            <i class="bar" style="--p:${pct(b.owned, b.total)}%"></i>
          </a>`).join('')}
      </div>
    </section>

    <section>
      <div class="sec-head"><h2>MEMBERS</h2><span class="muted small">Click a member to see their tree</span></div>
      <div class="card flush table-wrap">
        <table class="roster">
          <thead><tr><th>#</th><th>Member</th><th>Unlocked</th><th class="hide-sm">Research spent</th><th>Last update</th></tr></thead>
          <tbody>
            ${members.map((m, i) => `
              <tr data-member="${esc(m.id)}" tabindex="0">
                <td class="rank">${i + 1}</td>
                <td><span class="who-cell">${m.avatar ? `<img src="${esc(m.avatar)}" alt="" class="avatar sm">` : `<span class="avatar sm">${esc((m.name || '?')[0])}</span>`}<b>${esc(m.name)}</b>${m.id === me.id ? '<span class="tag">YOU</span>' : ''}</span></td>
                <td class="prog"><span>${esc(m.count)}/${esc(total)}</span><i class="bar" style="--p:${pct(m.count, total)}%"></i></td>
                <td class="hide-sm">${esc(short$(m.spent))}</td>
                <td>${m.last_tick ? `<span class="${daysSince(m.last_tick) > STALE_DAYS ? 'stale' : ''}">${esc(ago(m.last_tick))}</span>` : '<span class="stale">never</span>'}</td>
              </tr>`).join('') || '<tr><td colspan="5" class="muted">Nobody has logged in yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <div class="two-col">
      <section>
        <div class="sec-head"><h2>NOBODY HAS THESE YET</h2><span class="muted small">${esc(gaps.length)} nodes</span></div>
        <div class="tiles">
          ${gaps.slice(0, 12).map((n) => `
            <a class="tile" href="#shipments" data-node="${esc(n.id)}" style="--r:${esc(RARITY[n.rarity] ?? '#fff')}">
              ${icon(n.id)}<b>${esc(n.name)}</b><small>${esc(label[board.nodes[n.id]?.cat] ?? n.category)} · ${esc(TIER[n.tier] || '—')} · ${esc(short$(n.research_cost))}</small>
            </a>`).join('') || '<p class="muted">The clan has every node. Nice.</p>'}
        </div>
      </section>
      <section>
        <div class="sec-head"><h2>BEST BUSINESS</h2><a class="more" href="#money">MONEY →</a></div>
        ${best ? `
          <a class="card biz-mini" href="#money">
            ${icon(BIZ_ICON[best.id] ?? '')}
            <span><b>${esc(best.name)}</b><small>${esc(money(best.per_hour))}/hour · setup ${esc(short$(best.setup_cost))}${best.provisional ? ' · provisional' : ''}</small></span>
          </a>` : '<p class="muted">Money model unavailable.</p>'}
      </section>
    </div>`;

  view.querySelector('.roster tbody').onclick = (e) => {
    const tr = e.target.closest('tr[data-member]');
    if (tr) { ship.who = tr.dataset.member; location.hash = '#shipments'; }
  };
  view.querySelector('.roster tbody').onkeydown = (e) => { if (e.key === 'Enter') e.target.closest('tr[data-member]')?.click(); };
  view.querySelector('.branches').onclick = (e) => { const a = e.target.closest('[data-branch]'); if (a) ship.focus = { cat: a.dataset.branch }; };
  view.querySelector('.tiles').onclick = (e) => { const a = e.target.closest('[data-node]'); if (a) { ship.who = 'clan'; ship.focus = { node: a.dataset.node }; } };
}

// ------------------------------------------------------------------------------------------
// Shipments: Larry's Tree board

const ship = { who: null, mode: 'board', q: '', focus: null, edit: false, listShow: 'all', listCat: '' };
const BIZ_ICON = { chem: 'meth_lab_1', grow: 'narco_farm_1', repack: 'cargo_exchange_workbench_1' };

async function renderShipments() {
  const [p, board] = await Promise.all([loadProgress(), loadBoard()]);
  if (ship.who !== 'clan' && !p.names[ship.who]) ship.who = me.id;
  const who = ship.who;
  const clan = who === 'clan';
  const total = p.nodes.length;
  const editable = !clan && canEdit(who);
  if (!editable) ship.edit = false;
  const whoName = clan ? 'The clan' : p.names[who];
  const count = clan ? p.nodes.filter((n) => n.have.length).length : countFor(p, who);
  const spent = clan ? null : spentFor(p, who);
  const maxTier = clan ? null : Math.max(0, ...p.nodes.filter((n) => n.have.includes(who)).map((n) => n.tier ?? 0));

  view.innerHTML = `
    <div class="ship-top">
      ${hero("LARRY'S TREE / SHIPMENTS", 'SHIPMENTS', '', `
        <div class="hero-stats">
          <div><b>${esc(count)}<small>/${esc(total)}</small></b><span>${clan ? 'clan has' : 'unlocked'}</span></div>
          ${clan ? `<div><b>${esc(p.members.length)}</b><span>members</span></div>` : `<div><b>${esc(short$(spent))}</b><span>research spent</span></div><div><b>${esc(TIER[maxTier] || '—')}</b><span>top tier</span></div>`}
        </div>`)}
      <div class="ship-bar">
        <div class="who-chips" role="radiogroup" aria-label="Whose unlocks">
          <button role="radio" aria-checked="${clan}" class="chip-btn ${clan ? 'on' : ''}" data-who="clan">CLAN</button>
          ${p.members.map((m) => `<button role="radio" aria-checked="${m.id === who}" class="chip-btn ${m.id === who ? 'on' : ''}" data-who="${esc(m.id)}">${esc(m.name)}${m.id === me.id ? ' (you)' : ''} <small>${esc(countFor(p, m.id))}</small></button>`).join('')}
        </div>
        <div class="ship-tools">
          <input type="search" id="ship-q" placeholder="Find a node" value="${esc(ship.q)}" aria-label="Find a node">
          <div class="seg" role="radiogroup" aria-label="View">
            <button class="${ship.mode === 'board' ? 'on' : ''}" data-mode="board">BOARD</button>
            <button class="${ship.mode === 'list' ? 'on' : ''}" data-mode="list">LIST</button>
          </div>
          ${editable ? `<label class="switch"><input type="checkbox" id="ship-edit" ${ship.edit ? 'checked' : ''}><span>Quick tick</span></label>` : ''}
        </div>
      </div>
      <p class="ship-help">${clan
        ? 'Brighter nodes are owned by more members; the number shows how many. Click a node to see who has it.'
        : editable
          ? `${who === me.id ? 'Your' : `${esc(whoName)}'s`} tree. ${ship.mode === 'list' ? 'Tick each node' : ship.edit ? 'Quick tick is on: one click marks or unmarks a node' : 'Click a node, then mark it unlocked'}. Prerequisites are ticked with it.`
          : `${esc(whoName)}'s tree. Read only: only ${esc(whoName)} or an admin can change it.`}
        ${!clan ? `<span class="muted">Last updated ${esc(ago(p.members.find((m) => m.id === who)?.last_tick) || 'never')}.</span>` : ''}</p>
    </div>
    <div id="ship-body"></div>`;

  view.querySelector('.who-chips').onclick = (e) => {
    const b = e.target.closest('[data-who]');
    if (b) { ship.who = b.dataset.who; renderShipments(); }
  };
  view.querySelector('.seg').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) { ship.mode = b.dataset.mode; renderShipments(); }
  };
  const editBox = $('#ship-edit');
  if (editBox) editBox.onchange = () => { ship.edit = editBox.checked; renderShipments(); };
  $('#ship-q').oninput = (e) => { ship.q = e.target.value; ship.mode === 'board' ? highlightSearch() : drawList(p, board); };
  $('#ship-q').onkeydown = (e) => { if (e.key === 'Enter') panToFirstMatch(); };

  if (ship.mode === 'board') drawBoard(p, board);
  else drawList(p, board);
}

// --- Board -------------------------------------------------------------------------------

const TILE = 64;
let cam = null; // { x, y, k, w, h, minX, minY }

function boardNodeClass(n, who) {
  if (who === 'clan') return n.have.length ? 'owned' : 'none';
  return n.have.includes(who) ? 'owned' : 'locked';
}

function drawBoard(p, board) {
  const L = board.layout;
  const half = L.nodeSize / 2;
  const nodes = p.nodes.filter((n) => board.nodes[n.id]);
  const pos = (id) => board.nodes[id];
  const xs = nodes.map((n) => pos(n.id).x);
  const ys = nodes.map((n) => pos(n.id).y);
  const pad = 140;
  const minX = Math.min(...xs, board.larry.x) - pad;
  const minY = Math.min(...ys, -200) - pad;
  const w = Math.max(...xs) - minX + pad;
  const h = Math.max(...ys, 200) - minY + pad;
  const X = (x) => x - minX;
  const Y = (y) => y - minY;
  const cat = Object.fromEntries(board.categories.map((c) => [c.id, c]));
  const who = ship.who;
  const memberCount = Math.max(1, p.members.length);

  // Right-angle connectors, from each node to its first prerequisite, or to its branch's bus.
  const edge = (n) => {
    const q = pos(n.id);
    const dir = Math.sign(q.y) || 1;
    const endY = q.y - dir * half;
    const req = n.requires ? n.requires.split(',')[0] : '';
    if (!req || !pos(req)) {
      const c = cat[q.cat];
      const shape = c?.up ? L.up : L.down;
      return `M${X(c?.x ?? q.x)} ${Y(shape.start)}V${Y(shape.bus)}H${X(q.x)}V${Y(endY)}`;
    }
    const r = pos(req);
    return `M${X(r.x)} ${Y(r.y + dir * half)}V${Y(r.y + dir * L.busFromNode)}H${X(q.x)}V${Y(endY)}`;
  };
  const spine = (c) => `M${X(board.larry.x)} ${Y(0)}H${X(c.x)}V${Y((c.up ? L.up : L.down).start)}`;
  const lit = (n) => (who === 'clan' ? n.have.length > 0 : n.have.includes(who));

  $('#ship-body').innerHTML = `
    <div class="board ${who === 'clan' ? 'clanmode' : ''}" id="board" tabindex="0" aria-label="Larry's Tree board. Drag to pan, scroll or pinch to zoom.">
      <div class="world" id="world" style="width:${w}px;height:${h}px">
        <svg class="edges" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
          ${board.categories.map((c) => `<path class="spine" d="${spine(c)}"/>`).join('')}
          ${nodes.map((n) => `<path class="${lit(n) ? 'lit' : ''}" d="${edge(n)}"/>`).join('')}
        </svg>
        ${board.categories.map((c) => `
          <div class="polaroid" style="left:${X(c.x)}px;top:${Y(c.up ? L.artUp : L.artDown)}px">
            <img src="/img/branches/${esc(encodeURIComponent(c.id))}.webp" alt="" draggable="false"><span>${esc(c.label)}</span>
          </div>`).join('')}
        <div class="polaroid larry" style="left:${X(board.larry.x)}px;top:${Y(0)}px">
          <img src="/img/larry.webp" alt="" draggable="false"><span>${esc(board.larry.name)}</span>
        </div>
        ${nodes.map((n) => {
          const q = pos(n.id);
          const share = who === 'clan' ? n.have.length / memberCount : 0;
          return `
          <button class="node ${boardNodeClass(n, who)}" data-node="${esc(n.id)}" title="${esc(n.name)}"
            style="left:${X(q.x)}px;top:${Y(q.y)}px;--r:${esc(RARITY[n.rarity] ?? '#fff')};--share:${share.toFixed(2)}">
            ${icon(n.id)}
            ${n.tier ? `<span class="n-tier">${esc(TIER[n.tier])}</span>` : ''}
            ${q.years ? `<span class="n-years" title="Prison sentence needed">${esc(q.years)}y</span>` : ''}
            ${who === 'clan' && n.have.length ? `<span class="n-count">${esc(n.have.length)}</span>` : ''}
            ${who !== 'clan' && n.have.includes(who) ? '<span class="n-check">✓</span>' : ''}
          </button>`;
        }).join('')}
      </div>
      <div class="zoom">
        <button data-zoom="in" aria-label="Zoom in">+</button>
        <button data-zoom="out" aria-label="Zoom out">−</button>
        <button data-zoom="fit" aria-label="Fit the whole tree">⤢</button>
      </div>
      <p class="board-hint">DRAG: PAN · WHEEL / PINCH: ZOOM · CLICK: DETAILS</p>
    </div>`;

  const boardEl = $('#board');
  const world = $('#world');
  const keep = cam && cam.w === w && cam.h === h ? cam : null;
  cam = keep ?? { x: 0, y: 0, k: 1, w, h, minX, minY };
  const apply = () => { world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`; };
  const fit = () => {
    const bw = boardEl.clientWidth;
    const bh = boardEl.clientHeight;
    cam.k = Math.min(bw / w, bh / h);
    cam.x = (bw - w * cam.k) / 2;
    cam.y = (bh - h * cam.k) / 2;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const k = Math.min(2.5, Math.max(0.12, cam.k * factor));
    cam.x = cx - (cx - cam.x) * (k / cam.k);
    cam.y = cy - (cy - cam.y) * (k / cam.k);
    cam.k = k;
    apply();
  };
  const centerOn = (x, y, k = Math.max(cam.k, 0.9)) => {
    cam.k = k;
    cam.x = boardEl.clientWidth / 2 - X(x) * k;
    cam.y = boardEl.clientHeight / 2 - Y(y) * k;
    apply();
  };
  // Open like the game's board: on Larry, zoomed in enough to read the icons. ⤢ shows the whole tree.
  if (!keep) centerOn(board.larry.x + 120, 0, boardEl.clientWidth < 700 ? 0.42 : 0.62);
  else apply();

  if (ship.focus?.cat && cat[ship.focus.cat]) {
    const c = cat[ship.focus.cat];
    const ys2 = nodes.filter((n) => pos(n.id).cat === c.id).map((n) => pos(n.id).y);
    centerOn(c.x, ys2.length ? (Math.min(...ys2) + Math.max(...ys2)) / 2 : 0, 0.55);
  }
  if (ship.focus?.node && pos(ship.focus.node)) {
    const q = pos(ship.focus.node);
    centerOn(q.x, q.y, 1);
    showNode(ship.focus.node);
  }
  ship.focus = null;

  boardEl.onwheel = (e) => {
    e.preventDefault();
    const r = boardEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  };
  view.querySelector('.zoom').onclick = (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    const z = b.dataset.zoom;
    if (z === 'fit') fit();
    else zoomAt(z === 'in' ? 1.3 : 1 / 1.3, boardEl.clientWidth / 2, boardEl.clientHeight / 2);
  };

  // Pointer pan and pinch zoom. A press that moves more than a few pixels is a drag, not a click.
  const pts = new Map();
  let moved = 0;
  let pinch = null;
  boardEl.onpointerdown = (e) => {
    if (e.target.closest('.zoom')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  };
  boardEl.onpointermove = (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 5) {
        if (!boardEl.hasPointerCapture(e.pointerId)) boardEl.setPointerCapture(e.pointerId);
        boardEl.classList.add('dragging');
        cam.x += dx;
        cam.y += dy;
        apply();
      }
    } else if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = boardEl.getBoundingClientRect();
      zoomAt(d / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      pinch.d = d;
      moved = 99;
    }
  };
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) boardEl.classList.remove('dragging');
  };
  boardEl.onpointerup = up;
  boardEl.onpointercancel = up;

  world.onclick = async (e) => {
    const b = e.target.closest('.node');
    if (!b || moved > 5) return;
    const id = b.dataset.node;
    if (ship.edit && canEdit(ship.who) && ship.who !== 'clan') {
      const done = !cache.progress.byId[id].have.includes(ship.who);
      if (await setUnlocked(id, ship.who, done)) refreshBoard();
      return;
    }
    showNode(id);
  };

  window.__panToNode = (id) => { const q = pos(id); if (q) { centerOn(q.x, q.y, 1); showNode(id); } };
  highlightSearch();
}

// Redraw after a change. The camera is kept (same board size), and the node's details reopen.
async function refreshBoard(id) {
  await renderShipments();
  if (id) showNode(id);
}

function highlightSearch() {
  const q = ship.q.trim().toLowerCase();
  const p = cache.progress;
  document.querySelectorAll('.node').forEach((el) => {
    const n = p.byId[el.dataset.node];
    el.classList.toggle('match', Boolean(q) && n.name.toLowerCase().includes(q));
    el.classList.toggle('dim', Boolean(q) && !n.name.toLowerCase().includes(q));
  });
}

function panToFirstMatch() {
  const q = ship.q.trim().toLowerCase();
  if (!q) return;
  const hit = cache.progress.nodes.find((n) => n.name.toLowerCase().includes(q) && cache.board.nodes[n.id]);
  if (!hit) return toast('No node matches that name', 'bad');
  if (ship.mode === 'board') window.__panToNode?.(hit.id);
  else showNode(hit.id);
}

// Details for one node, in the drawer.
function showNode(id) {
  const p = cache.progress;
  const board = cache.board;
  const n = p.byId[id];
  if (!n) return;
  document.querySelectorAll('.node.sel').forEach((el) => el.classList.remove('sel'));
  document.querySelector(`.node[data-node="${CSS.escape(id)}"]`)?.classList.add('sel');
  const who = ship.who;
  const q = board.nodes[id] ?? {};
  const label = Object.fromEntries(board.categories.map((c) => [c.id, c.label]));
  const reqs = n.requires ? n.requires.split(',').map((r) => p.byId[r]).filter(Boolean) : [];
  const kids = p.nodes.filter((k) => (k.requires || '').split(',').includes(id));
  const haveNames = n.have.map((m) => p.names[m] ?? m).sort((a, b) => a.localeCompare(b));
  const missing = p.members.filter((m) => !n.have.includes(m.id)).map((m) => m.name);
  const subjectHas = who !== 'clan' && n.have.includes(who);
  const nodeChip = (k) => `<button class="mini-node" data-goto="${esc(k.id)}" style="--r:${esc(RARITY[k.rarity] ?? '#fff')}">${icon(k.id)}<span>${esc(k.name)} ${esc(TIER[k.tier] || '')}</span></button>`;

  openDrawer(`
    <div class="d-head" style="--r:${esc(RARITY[n.rarity] ?? '#fff')}">
      <div class="d-icon">${icon(n.id)}</div>
      <div>
        <p class="kicker">${esc(label[q.cat] ?? n.category)} · TIER ${esc(TIER[n.tier] || '—')}</p>
        <h2>${esc(n.name)}</h2>
        <p class="rar-name">${esc(n.rarity ?? '')}</p>
      </div>
    </div>
    <dl class="facts">
      <div><dt>Research</dt><dd>${esc(money(n.research_cost))}</dd></div>
      <div><dt>Trade Laptop</dt><dd>${esc(money(n.price))}</dd></div>
      ${q.years ? `<div><dt>Sentence needed</dt><dd>${esc(q.years)} years</dd></div>` : ''}
    </dl>
    ${who !== 'clan' && canEdit(who) ? `
      <button class="btn ${subjectHas ? 'ghost' : ''} wide" data-toggle="${esc(id)}">
        ${subjectHas ? `✓ Unlocked${who === me.id ? '' : ` for ${esc(p.names[who])}`}: click to remove` : `Mark unlocked${who === me.id ? '' : ` for ${esc(p.names[who])}`}`}
      </button>` : ''}
    <h3>Who has it <span class="muted">${esc(n.have.length)}/${esc(p.members.length)}</span></h3>
    <div class="chips">${haveNames.map((x) => `<span class="chip">${esc(x)}</span>`).join('') || '<span class="muted">Nobody yet</span>'}</div>
    ${missing.length && n.have.length ? `<p class="small muted">Missing: ${esc(missing.join(', '))}</p>` : ''}
    ${reqs.length ? `<h3>Requires</h3><div class="mini-nodes">${reqs.map(nodeChip).join('')}</div>` : ''}
    ${kids.length ? `<h3>Unlocks</h3><div class="mini-nodes">${kids.map(nodeChip).join('')}</div>` : ''}`);

  const d = $('#drawer');
  d.onclick = async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const done = !cache.progress.byId[id].have.includes(ship.who);
      if (await setUnlocked(id, ship.who, done)) refreshBoard(id);
      return;
    }
    const g = e.target.closest('[data-goto]');
    if (g) { if (ship.mode === 'board') window.__panToNode?.(g.dataset.goto); else showNode(g.dataset.goto); }
  };
}

// --- List view ---------------------------------------------------------------------------

function drawList(p, board) {
  const who = ship.who;
  const clan = who === 'clan';
  const editable = !clan && canEdit(who);
  const label = Object.fromEntries(board.categories.map((c) => [c.id, c.label]));
  const catOf = (n) => label[board.nodes[n.id]?.cat] ?? n.category;
  const cats = board.categories.slice().sort((a, b) => a.x - b.x).map((c) => c.label);
  const q = ship.q.trim().toLowerCase();
  const has = (n) => (clan ? n.have.length > 0 : n.have.includes(who));
  const shown = p.nodes.filter((n) =>
    (!q || n.name.toLowerCase().includes(q)) &&
    (!ship.listCat || catOf(n) === ship.listCat) &&
    (ship.listShow === 'all' || (ship.listShow === 'has' && has(n)) || (ship.listShow === 'missing' && !has(n))));
  const groups = {};
  for (const n of shown) (groups[catOf(n)] ??= []).push(n);

  $('#ship-body').innerHTML = `
    <div class="list-filters">
      <select id="l-cat" aria-label="Branch"><option value="">All branches</option>${cats.map((c) => `<option ${c === ship.listCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="l-show" aria-label="Show">
        ${[['all', 'All nodes'], ['has', clan ? 'Someone has it' : 'Unlocked'], ['missing', clan ? 'Nobody has it' : 'Not unlocked yet']].map(([v, l]) => `<option value="${v}" ${v === ship.listShow ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${cats.filter((c) => groups[c]).map((c) => `
      <section class="card list-branch">
        <h3>${esc(c)} <span class="muted">${esc(groups[c].filter(has).length)}/${esc(groups[c].length)}</span></h3>
        <ul class="nodes">
          ${groups[c].map((n) => `
            <li class="${has(n) ? 'has' : ''}" style="--r:${esc(RARITY[n.rarity] ?? '#fff')}">
              ${editable ? `<input type="checkbox" data-tick="${esc(n.id)}" ${has(n) ? 'checked' : ''} aria-label="Unlocked: ${esc(n.name)}">` : '<span></span>'}
              <button class="l-node" data-node="${esc(n.id)}">${icon(n.id)}<span><b>${esc(n.name)}</b><small>${esc(TIER[n.tier] || '—')} · ${esc(short$(n.research_cost))}</small></span></button>
              <span class="l-who">${n.have.length ? `${esc(n.have.length)} / ${esc(p.members.length)}` : '<span class="muted">nobody</span>'}</span>
            </li>`).join('')}
        </ul>
      </section>`).join('') || '<p class="muted card pad">No nodes match.</p>'}`;

  $('#l-cat').onchange = (e) => { ship.listCat = e.target.value; drawList(p, board); };
  $('#l-show').onchange = (e) => { ship.listShow = e.target.value; drawList(p, board); };
  $('#ship-body').onclick = (e) => { const b = e.target.closest('[data-node]'); if (b) showNode(b.dataset.node); };
  $('#ship-body').onchange = async (e) => {
    const box = e.target.closest('[data-tick]');
    if (!box) return;
    const ok = await setUnlocked(box.dataset.tick, who, box.checked);
    if (!ok) box.checked = !box.checked;
    renderShipments();
  };
}

// ------------------------------------------------------------------------------------------
// Money

let moneyLevel = 1;
const STATUSES = ['assumed', 'reported', 'measured', 'game', 'unknown', 'setup'];
const BIZ_GOODS = { chem: ['hard_crystal_1', 'hard_crystal_2', 'hard_crystal_3'], grow: ['bush_drugs_1', 'bush_drugs_2', 'bush_drugs_3'], repack: ['cargo_alcohol_grade_1', 'cargo_alcohol_grade_2', 'cargo_alcohol_grade_3'] };

async function renderMoney() {
  const data = await api('GET', `income?level=${moneyLevel}`);
  const provisional = data.businesses.some((b) => b.provisional);
  const hrs = (h) => (h == null ? 'never' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
  view.innerHTML = `
    ${hero('ECONOMY / BUSINESSES', 'MONEY', 'The three base businesses ranked by money per hour, from game prices and the inputs the clan has measured.', `
      <label class="level">CRIMINAL LEVEL <select id="level">${[1, 2, 3, 4, 5].map((l) => `<option ${l === data.level ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`)}
    ${provisional ? '<p class="warn">Provisional: some inputs below are assumed or come from a single player report. Measure them in game and enter the results.</p>' : ''}
    <section class="biz">
      ${data.businesses.map((b, i) => `
        <article class="card biz-card">
          <div class="biz-art">${icon(BIZ_ICON[b.id] ?? '')}<span class="biz-goods">${(BIZ_GOODS[b.id] ?? []).map((g) => icon(g)).join('')}</span></div>
          <header><span class="rank">#${i + 1}</span><h3>${esc(b.name)}</h3>${b.provisional ? '<span class="badge warn">PROVISIONAL</span>' : ''}</header>
          <dl class="figs">
            <div><dt>Setup</dt><dd>${esc(money(b.setup_cost))}</dd></div>
            <div><dt>$/hour</dt><dd class="big">${esc(money(b.per_hour))}</dd></div>
            <div><dt>Payback</dt><dd>${esc(hrs(b.payback_hours))}</dd></div>
          </dl>
          <details>
            <summary>How this is worked out</summary>
            <table class="mini">
              <tr><th>Setup</th><th>Research</th><th>Buy</th></tr>
              ${b.setup_lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(money(l.research))}</td><td>${esc(money(l.price))}</td></tr>`).join('')}
            </table>
            <ul class="small">${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
            ${b.pending.length ? `<p class="small warn">Not measured yet: ${esc(b.pending.join(', '))}</p>` : ''}
          </details>
        </article>`).join('')}
    </section>
    <p class="muted small">Setup is research plus Trade Laptop price at tier I and does not include the house each building needs. Sale prices include the criminal level bonus.</p>
    <section>
      <div class="sec-head"><h2>MODEL INPUTS</h2><span class="muted small">Shared with the clan. Measure in game, enter the number, mark it measured.</span></div>
      <div class="card flush table-wrap">
        <table class="inputs">
          <thead><tr><th>Input</th><th>Value</th><th>Status</th><th>How to measure</th><th></th></tr></thead>
          <tbody>
            ${data.inputs.map((r) => `
              <tr data-key="${esc(r.key)}">
                <td><span class="tag">${esc(r.business)}</span> ${esc(r.label)}</td>
                <td class="nowrap"><input type="number" step="any" min="0" value="${esc(r.value ?? '')}" placeholder="?"> <span class="muted small">${esc(r.unit)}</span></td>
                <td><select>${STATUSES.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
                <td class="small">${esc(r.how_to_measure)}${r.updated_by_name ? `<div class="muted">set by ${esc(r.updated_by_name)} ${esc(ago(r.updated_at))}</div>` : ''}</td>
                <td><button class="btn small" data-save>SAVE</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;

  $('#level').onchange = (e) => { moneyLevel = Number(e.target.value); renderMoney(); };
  const table = view.querySelector('table.inputs');
  table.onclick = async (e) => {
    if (!e.target.matches('[data-save]')) return;
    const tr = e.target.closest('tr');
    const value = tr.querySelector('input').value;
    let status = tr.querySelector('select').value;
    if (value === '') status = 'unknown';
    try {
      await api('PUT', `inputs/${encodeURIComponent(tr.dataset.key)}`, { value: value === '' ? null : Number(value), status });
      toast('Saved. Ranking updated.');
      renderMoney();
    } catch (err) { fail(err); }
  };
  table.oninput = (e) => {
    if (e.target.matches('input')) {
      const sel = e.target.closest('tr').querySelector('select');
      if (['assumed', 'reported', 'unknown'].includes(sel.value)) sel.value = 'measured';
    }
  };
}

// ------------------------------------------------------------------------------------------
// Items catalog

const itemFilter = { q: '', group: '', rarity: '' };

async function renderItems() {
  const data = await api('GET', 'items');
  $('#nav-items').textContent = data.items.length;
  const groups = [...new Set(data.items.map((i) => i.category))];
  const rarities = Object.keys(RARITY).filter((r) => data.items.some((i) => i.rarity === r));
  view.innerHTML = `
    ${hero(`CATALOG / ${esc(data.items.length)}`, 'ITEMS', "Every Larry's Tree node and business good with its price. Correct a price when the game shows a different one; edits are shared and survive data refreshes.")}
    <div class="filters">
      <div class="fchips" id="i-group">
        <button class="${!itemFilter.group ? 'on' : ''}" data-v="">ALL <small>${esc(data.items.length)}</small></button>
        ${groups.map((g) => `<button class="${g === itemFilter.group ? 'on' : ''}" data-v="${esc(g)}">${esc((GROUP[g] ?? g).toUpperCase())} <small>${esc(data.items.filter((i) => i.category === g).length)}</small></button>`).join('')}
      </div>
      <div class="row wrap">
        <div class="fchips" id="i-rar">${rarities.map((r) => `<button class="rar ${r === itemFilter.rarity ? 'on' : ''}" data-v="${esc(r)}" style="--r:${RARITY[r]}">${esc(r.toUpperCase())}</button>`).join('')}</div>
        <input type="search" id="i-q" placeholder="Filter by name" value="${esc(itemFilter.q)}" aria-label="Filter by name" class="grow">
      </div>
    </div>
    <p class="result-count" id="i-count"></p>
    <div class="catalog" id="i-grid"></div>`;

  const draw = () => {
    const q = itemFilter.q.toLowerCase();
    const rows = data.items.filter((i) => (!q || i.name.toLowerCase().includes(q)) && (!itemFilter.group || i.category === itemFilter.group) && (!itemFilter.rarity || i.rarity === itemFilter.rarity));
    $('#i-count').innerHTML = `<b>${esc(rows.length)}</b> items`;
    $('#i-grid').innerHTML = rows.map((i) => `
      <button class="item-card" data-id="${esc(i.id)}" style="--r:${esc(RARITY[i.rarity] ?? '#555')}">
        <span class="item-art">${icon(i.id)}</span>
        <b>${esc(i.name)}</b>
        <small>${esc(GROUP[i.category] ?? i.category)}${i.tier ? ` · ${esc(TIER[i.tier])}` : ''}</small>
        <span class="item-price">${esc(money(i.price))}${i.overridden ? '<i title="Edited price">✎</i>' : ''}</span>
      </button>`).join('') || '<p class="muted">No items match.</p>';
  };
  draw();
  $('#i-q').oninput = (e) => { itemFilter.q = e.target.value; draw(); };
  $('#i-group').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; itemFilter.group = b.dataset.v; renderItems(); };
  $('#i-rar').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; itemFilter.rarity = itemFilter.rarity === b.dataset.v ? '' : b.dataset.v; renderItems(); };
  $('#i-grid').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const i = data.items.find((x) => x.id === b.dataset.id);
    openDrawer(`
      <div class="d-head" style="--r:${esc(RARITY[i.rarity] ?? '#555')}">
        <div class="d-icon">${icon(i.id)}</div>
        <div><p class="kicker">${esc((GROUP[i.category] ?? i.category).toUpperCase())}${i.tier ? ` · TIER ${esc(TIER[i.tier])}` : ''}</p><h2>${esc(i.name)}</h2><p class="rar-name">${esc(i.rarity ?? '')}</p></div>
      </div>
      <dl class="facts">
        ${i.research_cost != null ? `<div><dt>Research</dt><dd>${esc(money(i.research_cost))}</dd></div>` : ''}
        ${i.smuggler != null ? `<div><dt>Smuggler pays</dt><dd>${esc(money(i.smuggler))}</dd></div>` : ''}
        ${i.fence != null ? `<div><dt>Fence pays</dt><dd>${esc(money(i.fence))}</dd></div>` : ''}
        ${i.hub_buy != null ? `<div><dt>Hub seller</dt><dd>${esc(money(i.hub_buy))}</dd></div>` : ''}
        ${i.seized != null ? `<div><dt>Seized by a cop</dt><dd>${esc(money(i.seized))}</dd></div>` : ''}
      </dl>
      <form class="price-form" id="price-form">
        <label>${esc(SOURCE_LABEL[i.price_source] ?? 'Price')} price used by the hub
          <input type="number" min="0" step="1" name="price" value="${esc(i.price ?? '')}"></label>
        <p class="small muted">Synced price ${esc(money(i.seed_price))}${i.overridden ? ` · edited by ${esc(i.override_by ?? 'someone')} ${esc(ago(i.price_override_at))}` : ''}. Clear the box and save to go back to the synced price.</p>
        <button class="btn">SAVE PRICE</button>
      </form>`);
    $('#price-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const v = new FormData(ev.target).get('price');
      try {
        const r = await api('PUT', `items/${encodeURIComponent(i.id)}`, { price: v === '' ? null : Number(v) });
        toast(r.reset ? 'Back to the synced price' : 'Price saved');
        closeDrawer();
        renderItems();
      } catch (err) { fail(err); }
    };
  };
}

// ------------------------------------------------------------------------------------------
// Wipe planner

async function renderPlan() {
  const data = await api('GET', 'plan');
  wipe = data.wipe;
  renderSide();
  const memberOpts = (sel) => `<option value="">Unassigned</option>` + data.members.map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const cats = {};
  for (const n of data.nodes) (cats[n.category] ??= []).push(n);
  const open = data.items.filter((i) => !i.done).length;

  view.innerHTML = `
    ${hero(`WIPE #${esc(data.wipe.id)}`, 'WIPE PLANNER', `Server opened ${esc(when(data.wipe.opened_at))}. Next wipe expected ${esc(when(data.wipe.next_at))}.`)}
    <section>
      <div class="sec-head"><h2>PLAN</h2><span class="muted small">${esc(open)} open of ${esc(data.items.length)}</span></div>
      <div class="card">
        <ul class="plan">
          ${data.items.map((p) => `
            <li data-id="${esc(p.id)}" class="${p.done ? 'done' : ''}">
              <label class="check"><input type="checkbox" data-done ${p.done ? 'checked' : ''}>${p.item_id ? icon(p.item_id, 'sm') : ''}<span>${esc(p.title)}</span></label>
              <select data-assignee aria-label="Assignee">${memberOpts(p.assignee)}</select>
              <button class="link danger" data-del title="Delete">✕</button>
            </li>`).join('') || '<li class="muted">Nothing planned yet. Add the first goal below.</li>'}
        </ul>
        <form id="plan-form" class="row wrap">
          <input name="title" maxlength="200" placeholder="Goal, e.g. Unlock Chemical Lab by day 2">
          <select name="item_id"><option value="">Link a Larry's Tree node (optional)</option>
            ${Object.entries(cats).map(([c, nodes]) => `<optgroup label="${esc(c)}">${nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.name)}${n.tier ? ` (${esc(TIER[n.tier])})` : ''}</option>`).join('')}</optgroup>`).join('')}
          </select>
          <select name="assignee">${memberOpts('')}</select>
          <button class="btn">ADD</button>
        </form>
      </div>
    </section>
    ${me.isAdmin ? `
    <section class="card admin">
      <h2>START NEXT WIPE</h2>
      <p class="small">Use this when the clan moves to a new state: progress in the game is lost there, so everyone's unlocks reset here too. The plan copies forward with every item unticked. Prices and model inputs stay. Back up the database first.</p>
      <form id="wipe-form" class="row wrap">
        <label>New server opened at <input type="datetime-local" name="opened_at" value="${esc(localInput())}" required></label>
        <button class="btn danger">START NEXT WIPE</button>
      </form>
    </section>` : ''}
    <section>
      <div class="sec-head"><h2>RECENT WIPES</h2></div>
      <ul class="card small wipes">${data.wipes.map((w) => `<li>#${esc(w.id)} opened ${esc(when(w.opened_at))}</li>`).join('')}</ul>
    </section>`;

  const list = view.querySelector('ul.plan');
  list.onchange = async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const patch = e.target.matches('[data-done]') ? { done: e.target.checked } : { assignee: e.target.value || null };
    try { await api('PATCH', `plan/${li.dataset.id}`, patch); renderPlan(); } catch (err) { fail(err); renderPlan(); }
  };
  list.onclick = async (e) => {
    if (!e.target.matches('[data-del]')) return;
    const li = e.target.closest('li[data-id]');
    if (!confirm('Delete this plan item?')) return;
    try { await api('DELETE', `plan/${li.dataset.id}`); renderPlan(); } catch (err) { fail(err); }
  };
  $('#plan-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', 'plan', { title: f.get('title'), item_id: f.get('item_id'), assignee: f.get('assignee') });
      toast('Added to the plan');
      renderPlan();
    } catch (err) { fail(err); }
  };
  const wf = $('#wipe-form');
  if (wf) wf.onsubmit = async (e) => {
    e.preventDefault();
    const local = new FormData(e.target).get('opened_at');
    if (!confirm(`Start wipe #${data.wipe.id + 1}, opened ${new Date(local).toLocaleString()}? Everyone's unlocks reset.`)) return;
    try {
      await api('POST', 'wipes', { opened_at: new Date(local).toISOString() });
      toast('New wipe started');
      renderPlan();
    } catch (err) { fail(err); }
  };
}

// ------------------------------------------------------------------------------------------
// Raid alerts

async function renderRaids() {
  const data = await api('GET', 'raids');
  view.innerHTML = `
    ${hero('TOOLS / DISCORD', 'RAID ALERTS', data.webhook ? 'Alerts post in the clan alert channel with an @here ping.' : '')}
    ${data.webhook ? '' : '<p class="warn">DISCORD_WEBHOOK_URL is not set, so alerts are saved here but nobody is pinged.</p>'}
    <section class="card">
      <form id="raid-form" class="stack">
        <div class="seg kinds" role="radiogroup" aria-label="Alert type">
          ${data.kinds.map((k, i) => `<label><input type="radio" name="kind" value="${esc(k)}" ${i === 0 ? 'checked' : ''}><span class="k-${esc(k)}">${esc(KIND_LABEL[k] ?? k)}</span></label>`).join('')}
        </div>
        <input name="target" maxlength="100" required placeholder="Where? e.g. our base, Sunny Beach plot, Grand Hotel">
        <label class="row small">When (optional) <input type="datetime-local" name="at_time"></label>
        <textarea name="note" maxlength="300" rows="2" placeholder="Note (optional): what to bring, who leads"></textarea>
        <button class="btn danger big">SEND ALERT</button>
      </form>
    </section>
    <section>
      <div class="sec-head"><h2>ALERTS THIS WIPE</h2></div>
      <ul class="raids">
        ${data.raids.map((r) => `
          <li class="card raid k-${esc(r.kind)}" data-id="${esc(r.id)}">
            <div class="row spread">
              <strong>${esc(KIND_LABEL[r.kind] ?? r.kind)}: ${esc(r.target)}</strong>
              ${me.isAdmin || r.created_by === me.id ? '<button class="link danger" data-del title="Delete">✕</button>' : ''}
            </div>
            ${r.at_time ? `<div>When: ${esc(when(r.at_time))}</div>` : ''}
            ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
            <div class="muted small">${esc(r.created_by_name ?? (r.source === 'ingest' ? 'raid hook' : 'unknown'))} · ${esc(ago(r.created_at))} · ${r.pinged ? 'Discord pinged' : '<span class="bad">not pinged</span>'}</div>
          </li>`).join('') || '<li class="muted card">No alerts this wipe.</li>'}
      </ul>
    </section>`;

  $('#raid-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const at = f.get('at_time');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('POST', 'raids', { kind: f.get('kind'), target: f.get('target'), at_time: at ? new Date(at).toISOString() : null, note: f.get('note') });
      if (r.warning) toast(r.warning, 'bad'); else toast('Alert sent to Discord');
      renderRaids();
    } catch (err) { fail(err); btn.disabled = false; }
  };
  view.querySelector('ul.raids').onclick = async (e) => {
    if (!e.target.matches('[data-del]')) return;
    if (!confirm('Delete this alert from the hub? The Discord message stays.')) return;
    try { await api('DELETE', `raids/${e.target.closest('li').dataset.id}`); renderRaids(); } catch (err) { fail(err); }
  };
}
