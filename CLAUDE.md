# CLAUDE.md

## Project

Rob Run Clan Hub: a private web hub for a ROB RUN clan. Members log in with Discord (clan server
members only) and track progress and metrics: who has unlocked what in Larry's Tree (shown as the
game's Shipments board), clan metrics, a business money model, a wipe planner, item prices and raid
alerts that ping a Discord channel through a webhook. It is not an online/activity tracker.

Stack: Cloudflare Pages serving `public/` + one Pages Function (`functions/api/[[path]].js`) + D1.
No build step, no front-end dependencies, no frameworks. Keep it that way.

Game data is imported from robrun.info (a volunteer fan site, no official API) by
`tools/sync-robrun-info.mjs`.

## Commands

- `npm run db:local`: build `seed.sql` and load `schema.sql` + seed into the local D1 database
- `npm run dev`: local site on http://localhost:8788 with dev login on
- `npm run smoke`: API smoke test; needs `npm run dev` running. Run it before every merge.
- `npm run seed:build`: rebuild `seed.sql` from `data/*.psv`
- `npm run db:remote`: load schema + seed into the production database (ask first, see rules)
- `npm run sync`: re-import game data from robrun.info (behind a proxy: `NODE_USE_ENV_PROXY=1`)

## Rules

- Never commit secrets, `.dev.vars` or `seed.sql`. Never paste a secret value into a prompt, commit,
  log or screenshot; refer to it by variable name.
- Never set `DEV_LOGIN` outside local dev. `npm run dev` sets it as a command-line binding; it must
  never be added to Cloudflare or to a committed file.
- Escape all user input rendered in `public/app.js` with `esc()`. That includes API data, since it
  came from users or a third-party site.
- Every schema change goes in a new numbered file under `migrations/` (`0001_name.sql`, ...) and is
  applied locally and smoke-tested before remote. Back up the remote database before applying.
- Never run a `--remote` wrangler command (including `npm run db:remote`) or `git push` without asking
  first.
- Work on a branch, one phase per branch. Never commit directly to `main`.
- Never hand-edit `data/larry-tree.psv` or `data/products.psv`; re-run the sync. Run the sync only
  by hand after a game patch, and summarise `git diff data/` before any re-seed.

## File map

- `public/index.html`, `public/app.js`, `public/style.css`: the whole front end (hash-routed pages:
  overview, clan roster and member pages (`#clan/<id>`), shipments board and list, money, items, wipe planner, raid alerts)
- `public/data/board.json`: Shipments board layout (synced); `public/data/items.json`: full item
  catalog with stats, loot spots, sellers and barters (synced); `public/img/`: icons (synced);
  `public/fonts/`: self-hosted fonts (SIL OFL)
- `functions/api/[[path]].js`: every `/api/*` route: Discord OAuth, sessions, members, progress,
  money model (`computeIncome`), plan, wipes, items, raids, Discord webhook, ingest hook
- `schema.sql`: base D1 schema (idempotent); `migrations/`: numbered changes after that
- `data/larry-tree.psv`, `data/products.psv`: synced game data; `data/model-inputs.psv`: model defaults
- `tools/sync-robrun-info.mjs`: robrun.info import; `tools/make-seed.mjs`: builds `seed.sql`
- `tools/smoke.sh`: API smoke test
- `wrangler.toml`: Pages config and the `DB` D1 binding
