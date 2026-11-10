// Rob Run Clan Hub front end. No dependencies, no build step.
// Every value from the API or a user goes through esc() before it reaches innerHTML.

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const RARITY = { Common: '#9a9894', Uncommon: '#67f835', Rare: '#00a6ec', Epic: '#e375ff', Legendary: '#ffd500', Exotic: '#d93f3f' };
const STATE_LABEL = { online: 'Online', base: 'At base', raiding: 'Raiding', farming: 'Farming', away: 'Away', offline: 'Offline' };
const KIND_LABEL = { defend: 'Base under attack', attack: 'Raid planned', info: 'Clan alert' };
const SOURCE_LABEL = { laptop: 'Trade Laptop', smuggler: 'Smuggler', fence: 'Fence', hub_buy: 'Hub seller (buy)', seized: 'Seized value' };
const TIER = ['', 'I', 'II', 'III', 'IV'];

let me = null;
let wipe = null;

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

// ------------------------------------------------------------------------------------------
// Shell

function showLogin(devLogin = false) {
  $('#top').hidden = true;
  $('#tabs').hidden = true;
  view.innerHTML = `
    <section class="login card">
      <div class="logo big">RR</div>
      <h1>Rob Run Clan Hub</h1>
      <p class="muted">Members of the clan Discord server only.</p>
      <a class="btn discord" href="/api/auth/login">Log in with Discord</a>
      ${devLogin ? `
        <a class="btn ghost" href="/api/auth/dev">Dev login (local only)</a>
        <form action="/api/auth/dev" method="get" class="row">
          <input name="as" maxlength="32" placeholder="or test as a member, e.g. Alice" aria-label="Test member name" class="grow">
          <button class="btn ghost small">Go</button>
        </form>` : ''}
    </section>`;
}

function renderHeader() {
  $('#top').hidden = false;
  $('#tabs').hidden = false;
  const opened = parseTime(wipe.opened_at);
  const day = Math.max(1, Math.floor((Date.now() - opened) / 864e5) + 1);
  $('#wipe-info').innerHTML = `Wipe #${esc(wipe.id)} · day ${esc(day)} of 7 · next ${esc(when(wipe.next_at))}`;
  $('#me-info').innerHTML = `
    ${me.avatar ? `<img src="${esc(me.avatar)}" alt="" width="24" height="24">` : ''}
    <span>${esc(me.name)}</span>${me.isAdmin ? '<span class="badge admin">admin</span>' : ''}
    <button class="link" id="logout">Log out</button>`;
  $('#logout').onclick = async () => {
    await api('POST', 'auth/logout').catch(() => {});
    location.hash = '';
    boot();
  };
}

const TABS = { status: renderStatus, progress: renderProgress, money: renderMoney, plan: renderPlan, items: renderItems, raids: renderRaids };

async function route() {
  if (!me) return;
  const tab = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'status';
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('on', a.dataset.tab === tab);
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await TABS[tab]();
  } catch (e) {
    if (e.message !== 'Not logged in') view.innerHTML = `<p class="bad card">Could not load this tab: ${esc(e.message)}</p>`;
  }
}

async function boot() {
  try {
    const data = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
    me = data.member;
    wipe = data.wipe;
    if (!me) return showLogin(data.devLogin);
    renderHeader();
    route();
  } catch (e) {
    view.innerHTML = `<p class="bad card">The hub API is not reachable: ${esc(e.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
boot();

// ------------------------------------------------------------------------------------------
// Status

async function renderStatus() {
  const data = await api('GET', 'status');
  const mine = data.members.find((m) => m.is_me) ?? {};
  const online = data.members.filter((m) => m.state && m.state !== 'offline').length;
  view.innerHTML = `
    <section class="card">
      <h2>My status</h2>
      <form id="status-form" class="row wrap">
        <div class="seg" role="radiogroup" aria-label="Status">
          ${data.states.map((s) => `<label><input type="radio" name="state" value="${esc(s)}" ${s === (mine.state ?? 'online') ? 'checked' : ''}><span class="st-${esc(s)}">${esc(STATE_LABEL[s] ?? s)}</span></label>`).join('')}
        </div>
        <input name="note" maxlength="140" placeholder="What are you doing? (optional)" value="${esc(mine.note ?? '')}">
        <button class="btn">Update</button>
      </form>
    </section>
    <section>
      <h2>Clan this wipe <span class="muted">${esc(online)} active of ${esc(data.members.length)}</span></h2>
      <ul class="members">
        ${data.members.map((m) => `
          <li class="card member ${m.is_me ? 'me' : ''}">
            ${m.avatar ? `<img src="${esc(m.avatar)}" alt="" width="36" height="36">` : `<span class="avatar">${esc((m.name || '?')[0])}</span>`}
            <div class="grow">
              <div><strong>${esc(m.name)}</strong> <span class="pill st-${esc(m.state ?? 'offline')}">${esc(STATE_LABEL[m.state] ?? 'No status yet')}</span></div>
              ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
              <div class="muted small">${m.updated_at ? `updated ${esc(ago(m.updated_at))}` : `last seen ${esc(ago(m.last_seen))}`}</div>
            </div>
          </li>`).join('')}
      </ul>
    </section>`;
  $('#status-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('PUT', 'status', { state: f.get('state'), note: f.get('note') });
      toast('Status updated');
      renderStatus();
    } catch (err) { fail(err); }
  };
}

// ------------------------------------------------------------------------------------------
// Progress

const progressFilter = { q: '', show: 'all', cat: '', who: null };

// Upward/downward walk of Larry's Tree, mirroring treeWalk() in the API.
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

async function renderProgress() {
  const data = await api('GET', 'progress');
  const names = Object.fromEntries(data.members.map((m) => [m.id, m.name]));
  const nodeById = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  const cats = [...new Set(data.nodes.map((n) => n.category))];
  if (!names[progressFilter.who]) progressFilter.who = me.id;

  view.innerHTML = `
    <section class="card">
      <div class="row wrap spread">
        <h2>Who has unlocked what</h2>
        <span class="muted small">Wipe #${esc(data.wipe.id)} · resets when an admin starts the next wipe</span>
      </div>
      <div class="stats" id="p-stats"></div>
      <ul class="roster" id="p-roster" aria-label="Clan members"></ul>
    </section>
    <section class="card">
      <h2 id="p-title"></h2>
      <p class="muted small" id="p-help"></p>
      <div class="row wrap filters">
        <input type="search" id="p-q" placeholder="Search nodes, e.g. Chemical Reactor" value="${esc(progressFilter.q)}">
        <select id="p-cat"><option value="">All branches</option>${cats.map((c) => `<option ${c === progressFilter.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="p-show">
          ${[['all', 'All nodes'], ['has', 'Unlocked'], ['missing', 'Not unlocked yet'], ['nobody', 'Nobody in the clan has it']].map(([v, l]) => `<option value="${v}" ${v === progressFilter.show ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    </section>
    <div id="p-list"></div>`;

  const whoNames = (ids) => {
    const list = ids.map((id) => names[id] ?? id).sort((a, b) => a.localeCompare(b));
    if (!list.length) return '<span class="muted">nobody yet</span>';
    const shown = list.slice(0, 3).map((n) => `<span class="chip">${esc(n)}</span>`).join('');
    return shown + (list.length > 3 ? `<span class="chip more" title="${esc(list.join(', '))}">+${esc(list.length - 3)}</span>` : '');
  };

  const draw = () => {
    const who = progressFilter.who;
    const isMe = who === me.id;
    const canEdit = isMe || data.canEditOthers;
    const whoName = names[who] ?? 'Unknown';
    const total = data.nodes.length;
    const count = (id) => data.nodes.filter((n) => n.have.includes(id)).length;
    const clanCount = data.nodes.filter((n) => n.have.length).length;

    $('#p-stats').innerHTML = `
      <div><b>${esc(count(me.id))}/${esc(total)}</b><span>unlocked by you</span></div>
      <div><b>${esc(clanCount)}</b><span>unlocked by someone in the clan</span></div>
      <div><b>${esc(total - clanCount)}</b><span>nobody has yet</span></div>`;

    $('#p-roster').innerHTML = data.members.map((m) => {
      const c = count(m.id);
      return `
        <li><button class="member-pick ${m.id === who ? 'on' : ''}" data-who="${esc(m.id)}" aria-pressed="${m.id === who}">
          <span class="row"><strong>${esc(m.name)}</strong>${m.id === me.id ? '<span class="tag">you</span>' : ''}</span>
          <span class="bar" style="--p:${esc(Math.round((c / total) * 100))}%"></span>
          <span class="muted small">${esc(c)} of ${esc(total)} unlocked${m.last_tick ? ` · updated ${esc(ago(m.last_tick))}` : ''}</span>
        </button></li>`;
    }).join('');

    $('#p-title').innerHTML = `${isMe ? 'Your unlocks' : `${esc(whoName)}'s unlocks`} <span class="muted">${esc(count(who))} of ${esc(total)}</span>`;
    $('#p-help').textContent = isMe
      ? 'Tick each node you have researched. Ticking a node also ticks the nodes it requires.'
      : canEdit
        ? `You are an admin, so you can tick nodes for ${whoName}.`
        : `Read only: only ${whoName} or an admin can change this list.`;

    const q = progressFilter.q.toLowerCase();
    const shown = data.nodes.filter((n) => {
      const has = n.have.includes(who);
      return (!q || n.name.toLowerCase().includes(q)) &&
        (!progressFilter.cat || n.category === progressFilter.cat) &&
        (progressFilter.show === 'all' || (progressFilter.show === 'has' && has) || (progressFilter.show === 'missing' && !has) || (progressFilter.show === 'nobody' && !n.have.length));
    });
    const groups = {};
    for (const n of shown) (groups[n.category] ??= []).push(n);
    $('#p-list').innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([cat, nodes]) => `
      <section class="card">
        <h3>${esc(cat)} <span class="muted">${esc(data.nodes.filter((n) => n.category === cat && n.have.includes(who)).length)}/${esc(data.nodes.filter((n) => n.category === cat).length)}</span></h3>
        <ul class="nodes">
          ${nodes.map((n) => `
            <li class="${n.have.includes(who) ? 'has' : ''}">
              <label class="check">
                <input type="checkbox" data-node="${esc(n.id)}" ${n.have.includes(who) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
                <span class="rar" style="--r:${esc(RARITY[n.rarity] ?? '#fff')}"></span>
                <span class="nname">${esc(n.name)}</span>
              </label>
              <span class="meta">
                <span class="tier">${esc(TIER[n.tier] ?? '—')}</span>
                <span title="Research cost">${esc(money(n.research_cost))}</span>
                ${n.requires ? `<span class="muted small">needs ${esc(n.requires.split(',').map((r) => nodeById[r] ? `${nodeById[r].name}${nodeById[r].tier ? ' ' + TIER[nodeById[r].tier] : ''}` : r).join(', '))}</span>` : ''}
              </span>
              <span class="who">${whoNames(n.have)}</span>
            </li>`).join('')}
        </ul>
      </section>`).join('') : '<p class="muted card">No nodes match.</p>';
  };
  draw();

  $('#p-roster').onclick = (e) => {
    const b = e.target.closest('[data-who]');
    if (!b) return;
    progressFilter.who = b.dataset.who;
    draw();
  };
  $('#p-q').oninput = (e) => { progressFilter.q = e.target.value; draw(); };
  $('#p-cat').onchange = (e) => { progressFilter.cat = e.target.value; draw(); };
  $('#p-show').onchange = (e) => { progressFilter.show = e.target.value; draw(); };
  $('#p-list').onchange = async (e) => {
    const box = e.target.closest('input[data-node]');
    if (!box) return;
    const who = progressFilter.who;
    const node = nodeById[box.dataset.node];
    if (!box.checked) {
      const dependents = treeWalk(data.nodes, node.id, 'down').filter((id) => nodeById[id]?.have.includes(who));
      if (dependents.length && !confirm(`Unticking ${node.name} also unticks what needs it: ${dependents.map((id) => nodeById[id].name).join(', ')}. Continue?`)) {
        box.checked = true;
        return;
      }
    }
    try {
      const r = await api('PUT', 'progress', { item_id: node.id, done: box.checked, member_id: who });
      for (const id of r.added) nodeById[id]?.have.push(who);
      for (const id of r.removed) if (nodeById[id]) nodeById[id].have = nodeById[id].have.filter((x) => x !== who);
      const extra = (r.added.length || r.removed.length) - 1;
      if (extra > 0) toast(r.added.length ? `Also ticked ${extra} required node${extra > 1 ? 's' : ''}` : `Also unticked ${extra} node${extra > 1 ? 's' : ''} that needed it`);
      draw();
    } catch (err) {
      box.checked = !box.checked;
      fail(err);
    }
  };
}

// ------------------------------------------------------------------------------------------
// Money

let moneyLevel = 1;
const STATUSES = ['assumed', 'reported', 'measured', 'game', 'unknown', 'setup'];

async function renderMoney() {
  const data = await api('GET', `income?level=${moneyLevel}`);
  const provisional = data.businesses.some((b) => b.provisional);
  const hrs = (h) => (h == null ? 'never' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
  view.innerHTML = `
    <section class="card">
      <div class="row wrap spread">
        <h2>Businesses, ranked by $/hour</h2>
        <label class="row">Criminal level
          <select id="level">${[1, 2, 3, 4, 5].map((l) => `<option ${l === data.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
      </div>
      ${provisional ? '<p class="warn">Provisional: some model inputs below are assumed or come from a single player report. Measure them in game and enter the results.</p>' : ''}
      <div class="biz">
        ${data.businesses.map((b, i) => `
          <article class="card inner">
            <header><span class="rank">#${i + 1}</span><h3>${esc(b.name)}</h3>${b.provisional ? '<span class="badge warn">provisional</span>' : ''}</header>
            <dl class="figs">
              <div><dt>Setup cost</dt><dd>${esc(money(b.setup_cost))}</dd></div>
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
      </div>
      <p class="muted small">Setup is research plus Trade Laptop price at tier I and does not include the house each building needs. Sale prices include the criminal level bonus.</p>
    </section>
    <section class="card">
      <h2>Model inputs</h2>
      <p class="muted small">Shared with the whole clan. Measure in game, enter the number, and mark it measured.</p>
      <div class="table-wrap">
        <table class="inputs">
          <thead><tr><th>Input</th><th>Value</th><th>Status</th><th>How to measure</th><th></th></tr></thead>
          <tbody>
            ${data.inputs.map((r) => `
              <tr data-key="${esc(r.key)}">
                <td><span class="tag">${esc(r.business)}</span> ${esc(r.label)}</td>
                <td class="nowrap"><input type="number" step="any" min="0" value="${esc(r.value ?? '')}" placeholder="?"> <span class="muted small">${esc(r.unit)}</span></td>
                <td><select>${STATUSES.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
                <td class="small">${esc(r.how_to_measure)}${r.updated_by_name ? `<div class="muted">set by ${esc(r.updated_by_name)} ${esc(ago(r.updated_at))}</div>` : ''}</td>
                <td><button class="btn small" data-save>Save</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;

  $('#level').onchange = (e) => { moneyLevel = Number(e.target.value); renderMoney(); };
  view.querySelector('table.inputs').onclick = async (e) => {
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
  view.querySelector('table.inputs').oninput = (e) => {
    if (e.target.matches('input')) {
      const sel = e.target.closest('tr').querySelector('select');
      if (['assumed', 'reported', 'unknown'].includes(sel.value)) sel.value = 'measured';
    }
  };
}

// ------------------------------------------------------------------------------------------
// Wipe planner

async function renderPlan() {
  const data = await api('GET', 'plan');
  wipe = data.wipe;
  renderHeader();
  const memberOpts = (sel) => `<option value="">Unassigned</option>` + data.members.map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const cats = {};
  for (const n of data.nodes) (cats[n.category] ??= []).push(n);
  const open = data.items.filter((i) => !i.done).length;

  view.innerHTML = `
    <section class="card">
      <h2>Wipe #${esc(data.wipe.id)}</h2>
      <p>Server opened <b>${esc(when(data.wipe.opened_at))}</b>. Next wipe expected <b>${esc(when(data.wipe.next_at))}</b>.</p>
    </section>
    <section class="card">
      <h2>Plan <span class="muted">${esc(open)} open of ${esc(data.items.length)}</span></h2>
      <ul class="plan">
        ${data.items.map((p) => `
          <li data-id="${esc(p.id)}" class="${p.done ? 'done' : ''}">
            <label class="check"><input type="checkbox" data-done ${p.done ? 'checked' : ''}><span>${esc(p.title)}</span></label>
            ${p.item_name && p.item_name !== p.title.replace(/^Research /, '') ? `<span class="tag">${esc(p.item_name)}</span>` : ''}
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
        <button class="btn">Add</button>
      </form>
    </section>
    ${me.isAdmin ? `
    <section class="card admin">
      <h2>Start next wipe</h2>
      <p class="small">Member status and progress reset. The plan copies forward with every item unticked. Prices and model inputs stay. Back up the database first.</p>
      <form id="wipe-form" class="row wrap">
        <label>New server opened at <input type="datetime-local" name="opened_at" value="${esc(localInput())}" required></label>
        <button class="btn danger">Start next wipe</button>
      </form>
    </section>` : ''}
    <section class="card">
      <h3>Recent wipes</h3>
      <ul class="small">${data.wipes.map((w) => `<li>#${esc(w.id)} opened ${esc(when(w.opened_at))}</li>`).join('')}</ul>
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
    if (!confirm(`Start wipe #${data.wipe.id + 1}, opened ${new Date(local).toLocaleString()}? Status and progress reset for everyone.`)) return;
    try {
      await api('POST', 'wipes', { opened_at: new Date(local).toISOString() });
      toast('New wipe started');
      renderPlan();
    } catch (err) { fail(err); }
  };
}

// ------------------------------------------------------------------------------------------
// Items

const itemFilter = { q: '', kind: '', cat: '' };

async function renderItems() {
  const data = await api('GET', 'items');
  const cats = [...new Set(data.items.map((i) => i.category))];
  const GROUP = { chem: 'Chemical Laboratory', grow: 'Grow Room', repack: 'Contraband repack' };
  view.innerHTML = `
    <section class="card">
      <h2>Items and prices</h2>
      <p class="muted small">Game data from robrun.info. Edit a price when the game shows a different one; edits are shared and survive data refreshes. Clear the box and save to go back to the synced price.</p>
      <div class="row wrap filters">
        <input type="search" id="i-q" placeholder="Search items" value="${esc(itemFilter.q)}">
        <select id="i-kind">
          ${[['', 'Everything'], ['node', "Larry's Tree"], ['product', 'Business goods']].map(([v, l]) => `<option value="${v}" ${v === itemFilter.kind ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="i-cat"><option value="">All categories</option>${cats.map((c) => `<option value="${esc(c)}" ${c === itemFilter.cat ? 'selected' : ''}>${esc(GROUP[c] ?? c)}</option>`).join('')}</select>
      </div>
    </section>
    <div class="card table-wrap"><table class="items"><thead><tr>
      <th>Item</th><th class="hide-sm">Category</th><th class="hide-sm">Tier</th><th class="hide-sm">Research</th><th>Price</th><th></th>
    </tr></thead><tbody id="i-body"></tbody></table></div>`;

  const draw = () => {
    const q = itemFilter.q.toLowerCase();
    const rows = data.items.filter((i) => (!q || i.name.toLowerCase().includes(q) || i.id.includes(q)) && (!itemFilter.kind || i.kind === itemFilter.kind) && (!itemFilter.cat || i.category === itemFilter.cat));
    $('#i-body').innerHTML = rows.map((i) => `
      <tr data-id="${esc(i.id)}">
        <td><span class="rar" style="--r:${esc(RARITY[i.rarity] ?? '#fff')}"></span> ${esc(i.name)} <span class="muted small">${esc(i.rarity ?? '')}</span></td>
        <td class="hide-sm">${esc(GROUP[i.category] ?? i.category)}</td>
        <td class="hide-sm">${esc(TIER[i.tier] ?? '')}</td>
        <td class="hide-sm">${i.research_cost != null ? esc(money(i.research_cost)) : ''}</td>
        <td class="nowrap">
          <input type="number" min="0" step="1" value="${esc(i.price ?? '')}" aria-label="Price of ${esc(i.name)}">
          <div class="muted small">${esc(SOURCE_LABEL[i.price_source] ?? '')}${i.overridden ? ` · <span class="edited" title="Synced price ${esc(money(i.seed_price))}">edited by ${esc(i.override_by ?? 'someone')}</span>` : ''}</div>
        </td>
        <td><button class="btn small" data-save>Save</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No items match.</td></tr>';
  };
  draw();
  $('#i-q').oninput = (e) => { itemFilter.q = e.target.value; draw(); };
  $('#i-kind').onchange = (e) => { itemFilter.kind = e.target.value; draw(); };
  $('#i-cat').onchange = (e) => { itemFilter.cat = e.target.value; draw(); };
  $('#i-body').onclick = async (e) => {
    if (!e.target.matches('[data-save]')) return;
    const tr = e.target.closest('tr');
    const v = tr.querySelector('input').value;
    try {
      const r = await api('PUT', `items/${encodeURIComponent(tr.dataset.id)}`, { price: v === '' ? null : Number(v) });
      toast(r.reset ? 'Back to the synced price' : 'Price saved');
      Object.assign(data, await api('GET', 'items'));
      draw();
    } catch (err) { fail(err); }
  };
}

// ------------------------------------------------------------------------------------------
// Raids

async function renderRaids() {
  const data = await api('GET', 'raids');
  view.innerHTML = `
    <section class="card">
      <h2>Send a raid alert</h2>
      ${data.webhook ? '<p class="muted small">Alerts post in the clan alert channel with an @here ping.</p>' : '<p class="warn">DISCORD_WEBHOOK_URL is not set, so alerts are saved here but nobody is pinged.</p>'}
      <form id="raid-form" class="stack">
        <div class="seg" role="radiogroup" aria-label="Alert type">
          ${data.kinds.map((k, i) => `<label><input type="radio" name="kind" value="${esc(k)}" ${i === 0 ? 'checked' : ''}><span class="k-${esc(k)}">${esc(KIND_LABEL[k] ?? k)}</span></label>`).join('')}
        </div>
        <input name="target" maxlength="100" required placeholder="Where? e.g. our base, Sunny Beach plot, Grand Hotel">
        <label class="row small">When (optional) <input type="datetime-local" name="at_time"></label>
        <textarea name="note" maxlength="300" rows="2" placeholder="Note (optional): what to bring, who leads"></textarea>
        <button class="btn danger big">Send alert</button>
      </form>
    </section>
    <section>
      <h2>Alerts this wipe</h2>
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
