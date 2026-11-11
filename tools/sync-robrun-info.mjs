#!/usr/bin/env node
// Refresh game data from robrun.info (a volunteer fan site; no official ROB RUN API exists).
//
//   node tools/sync-robrun-info.mjs            fetch the live site
//   node tools/sync-robrun-info.mjs --from DIR  read a saved copy instead (see --save)
//   node tools/sync-robrun-info.mjs --save DIR  also save every fetched page into DIR
//
// Writes data/larry-tree.psv (Larry's Tree research nodes), data/products.psv (the cargo and
// goods the three businesses use) and public/data/board.json (the Shipments board layout), and
// downloads any icons the hub does not have yet into public/img/. Review `git diff data/` before
// seeding. Add --no-images to skip the icon downloads.
//
// The icons are the game's art (all rights with the game's developer), re-hosted by robrun.info.
// Only missing files are fetched, so a normal re-sync downloads nothing or a handful.
//
// Be polite: run it by hand after a game patch, never on a schedule. robrun.info has no
// published reuse terms; email support@robrun.info before automating this.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://robrun.info';
const DELAY_MS = 750;

// Products the Money model reads. price_from picks which price becomes the item's main price.
export const PRODUCTS = [
  // Chemical Laboratory
  { id: 'reagents_1', group: 'chem', price_from: 'smuggler' },
  { id: 'reagents_2', group: 'chem', price_from: 'smuggler' },
  { id: 'soft_crystal_1', group: 'chem', price_from: 'smuggler' },
  { id: 'soft_crystal_2', group: 'chem', price_from: 'smuggler' },
  { id: 'soft_crystal_3', group: 'chem', price_from: 'smuggler' },
  { id: 'hard_crystal_1', group: 'chem', price_from: 'smuggler' },
  { id: 'hard_crystal_2', group: 'chem', price_from: 'smuggler' },
  { id: 'hard_crystal_3', group: 'chem', price_from: 'smuggler' },
  { id: 'lab_crystal_1', group: 'chem', price_from: 'fence' },
  { id: 'lab_crystal_2', group: 'chem', price_from: 'fence' },
  { id: 'lab_crystal_3', group: 'chem', price_from: 'fence' },
  // Grow Room
  { id: 'bush_growing_1', group: 'grow', price_from: 'smuggler' },
  { id: 'bush_growing_2', group: 'grow', price_from: 'smuggler' },
  { id: 'bush_growing_3', group: 'grow', price_from: 'smuggler' },
  { id: 'bush_mature_1', group: 'grow', price_from: 'smuggler' },
  { id: 'bush_mature_2', group: 'grow', price_from: 'smuggler' },
  { id: 'bush_mature_3', group: 'grow', price_from: 'smuggler' },
  { id: 'bush_drugs_1', group: 'grow', price_from: 'fence' },
  { id: 'bush_drugs_2', group: 'grow', price_from: 'fence' },
  { id: 'bush_drugs_3', group: 'grow', price_from: 'fence' },
  // Contraband repack
  { id: 'cargo_alcohol_grade_1', group: 'repack', price_from: 'hub_buy' },
  { id: 'cargo_alcohol_grade_2', group: 'repack', price_from: 'smuggler' },
  { id: 'cargo_alcohol_grade_3', group: 'repack', price_from: 'smuggler' },
];

const CATEGORY = {
  custom_node_documents: 'Documents', custom_node_cars: 'Vehicles', custom_node_houses: 'Construction',
  custom_node_ammo: 'Weapons', custom_node_furniture: 'Furnishings', custom_node_gears: 'Gear',
  custom_node_farm: 'Production', custom_node_gadjets: 'Gadgets',
};

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const fromDir = opt('--from');
const saveDir = opt('--save');
const noImages = args.includes('--no-images') || Boolean(fromDir);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fetched = 0;

async function get(path) {
  const file = path.replace(/^\//, '').replace(/[/?=&]+/g, '_') || 'index';
  if (fromDir) return readFile(join(fromDir, file), 'utf8');
  if (fetched++) await sleep(DELAY_MS);
  const res = await fetch(BASE + path, { headers: { 'user-agent': 'robrun-clan-hub-sync (manual, after patches)' } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  const text = await res.text();
  if (saveDir) { await mkdir(saveDir, { recursive: true }); await writeFile(join(saveDir, file), text); }
  return text;
}

const exists = (file) => access(file).then(() => true, () => false);

// Download one image unless we already have it. Returns 'new', 'kept' or 'missing'.
async function image(path, file) {
  const out = join(ROOT, 'public/img', file);
  if (await exists(out)) return 'kept';
  if (fetched++) await sleep(DELAY_MS);
  const res = await fetch(BASE + path, { headers: { 'user-agent': 'robrun-clan-hub-sync (manual, after patches)' } });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('image/')) return 'missing';
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return 'new';
}

// Planner asset paths are relative to /en/planner/ ("../../shared/items/x.webp").
const sitePath = (rel) => new URL(rel, BASE + '/en/planner/').pathname;

// --- Larry's Tree -------------------------------------------------------------------------

async function loadPlanner() {
  const page = await get('/en/planner/');
  const m = page.match(/src="(data\.js\?v=[^"]+)"/);
  if (!m) throw new Error('planner page: could not find data.js script tag');
  const js = (await get('/en/planner/' + m[1])).trim();
  const prefix = 'window.PLANNER_DATA=';
  if (!js.startsWith(prefix)) throw new Error('planner data.js: unexpected format (no window.PLANNER_DATA=)');
  // Parsed as JSON, never executed.
  const data = JSON.parse(js.slice(prefix.length).replace(/;\s*$/, ''));
  if (!Array.isArray(data.nodes) || !data.build) throw new Error('planner data: missing nodes or build');
  return data;
}

function treeRows(data) {
  const rows = data.nodes.map((n) => {
    const cash = n.cost.filter((c) => c.id === 'cash_1').reduce((s, c) => s + c.n, 0);
    const other = n.cost.filter((c) => c.id !== 'cash_1').map((c) => `${c.id}*${c.n}`).join(',');
    return {
      id: n.id,
      name: clean(n.name),
      category: CATEGORY[n.cat] ?? n.cat,
      tier: n.tier ?? '',
      rarity: n.rarity ?? 0,
      requires: (n.req ?? []).join(','),
      research_cost: cash,
      price: n.buyPrice ?? '',
      sentence_years: n.years || '',
      other_cost: other,
      enabled: n.enabled === false ? 0 : 1,
    };
  });
  // Order each branch so prerequisites come before what they unlock.
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const depth = (id, seen = new Set()) => {
    const r = byId[id];
    if (!r || !r.requires || seen.has(id)) return 0;
    seen.add(id);
    return 1 + Math.max(...r.requires.split(',').map((q) => depth(q, seen)));
  };
  for (const r of rows) r._depth = depth(r.id);
  rows.sort((a, b) => a.category.localeCompare(b.category) || (a.tier || 0) - (b.tier || 0) || a._depth - b._depth || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const r of rows) delete r._depth;
  return rows;
}

// --- Item pages ---------------------------------------------------------------------------

function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
}
const money = (s) => (s == null ? '' : Number(s.replace(/,/g, '')));
const clean = (s) => String(s).replace(/[|\r\n]+/g, ' ').trim();

async function productRow(p) {
  const html = await get(`/en/items/${p.id}/`);
  const t = pageText(html);
  const name = t.match(/In English (.+?) ID /)?.[1] ?? html.match(/<h1[^>]*>([^<]+)</)?.[1];
  const rarity = t.match(/\b(Common|Uncommon|Rare|Epic|Legendary|Exotic)\b/)?.[1] ?? '';
  const row = {
    id: p.id,
    name: clean(name ?? p.id),
    rarity,
    group: p.group,
    price_from: p.price_from,
    smuggler: money(t.match(/Handed in to the Smuggler i Handed in to the Smuggler Level 1 \$([\d,]+)/)?.[1]),
    fence: money(t.match(/Selling to a Fence Level 1 \$([\d,]+)/)?.[1]),
    hub_buy: money(t.match(/Cargo seller in the hub \$([\d,]+)/)?.[1]),
    seized: money(t.match(/Seized by a cop \$([\d,]+)/)?.[1]),
  };
  row.icon = html.match(/property="og:image" content="https:\/\/robrun\.info([^"]+)"/)?.[1] ?? null;
  if (!t.includes(`ID ${p.id}`)) throw new Error(`item page ${p.id}: id not found on page`);
  if (row[p.price_from] === '') throw new Error(`item page ${p.id}: no ${p.price_from} price found`);
  return row;
}

// --- Output -------------------------------------------------------------------------------

function psv(rows, header) {
  const cols = Object.keys(rows[0]);
  return header + cols.join('|') + '\n' + rows.map((r) => cols.map((c) => r[c]).join('|')).join('\n') + '\n';
}

async function main() {
  const planner = await loadPlanner();
  const tree = treeRows(planner);
  const products = [];
  for (const p of PRODUCTS) products.push(await productRow(p));

  const head = (what) =>
    `# ${what} from robrun.info, game build ${planner.build} (site data dated ${planner.date}).\n` +
    `# Generated by tools/sync-robrun-info.mjs. Do not hand-edit: re-run the sync, or edit prices on the site.\n`;
  await writeFile(join(ROOT, 'data/larry-tree.psv'), psv(tree, head("Larry's Tree research nodes")));
  const icons = products.map((p) => [p.id, p.icon]);
  for (const p of products) delete p.icon;
  await writeFile(join(ROOT, 'data/products.psv'), psv(products, head('Business products')));
  console.log(`build ${planner.build}: ${tree.length} tree nodes, ${products.length} products written to data/`);

  // Shipments board layout: positions and branches exactly as the game's tree is drawn.
  const board = {
    source: `robrun.info planner, game build ${planner.build} (site data dated ${planner.date})`,
    build: planner.build,
    layout: planner.layout,
    larry: { x: planner.larry.x, name: planner.larry.name, text: planner.larry.text },
    categories: planner.categories.map((c) => ({ id: c.id, label: c.label, x: c.x, up: Boolean(c.up) })),
    nodes: Object.fromEntries(planner.nodes.map((n) => [n.id, { x: n.x, y: n.y, cat: n.cat, years: n.years || 0, isNew: Boolean(n.isNew) }])),
  };
  await mkdir(join(ROOT, 'public/data'), { recursive: true });
  await writeFile(join(ROOT, 'public/data/board.json'), JSON.stringify(board) + '\n');
  console.log(`public/data/board.json: ${planner.categories.length} branches, ${planner.nodes.length} node positions`);

  if (noImages) return console.log('icons: skipped');
  const jobs = [
    ...planner.nodes.map((n) => [sitePath(n.icon), `items/${n.id}.webp`]),
    ...icons.filter(([, path]) => path).map(([id, path]) => [path, `items/${id}.webp`]),
    ...planner.categories.map((c) => [sitePath(c.art), `branches/${c.id}.webp`]),
    [sitePath(planner.larry.art), 'larry.webp'],
  ];
  const tally = { new: 0, kept: 0, missing: [] };
  for (const [path, file] of jobs) {
    const r = await image(path, file);
    if (r === 'missing') tally.missing.push(file); else tally[r]++;
  }
  console.log(`icons: ${tally.new} downloaded, ${tally.kept} already present` + (tally.missing.length ? `, missing: ${tally.missing.join(', ')}` : ''));
}

main().catch((e) => {
  console.error('sync failed:', e.message);
  if (e.message === 'fetch failed' && process.env.HTTPS_PROXY) console.error('Behind a proxy? Re-run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).');
  process.exit(1);
});
