# Rob Run Clan Hub

A private web hub for a ROB RUN clan. Members log in with Discord (only members of the clan
server get in) and share:

| Tab | What it does |
| --- | --- |
| **Status** | Who is online, at base, raiding or farming this wipe, with a short note. |
| **Progress** | Who has unlocked what. Each member ticks the Larry's Tree nodes they have researched (ticking a node also ticks what it requires). Pick any member on the roster to see their unlocks; every node lists who has it. Admins can tick on a member's behalf. Resets each wipe. |
| **Money** | Ranks the three businesses (Chemical Laboratory, Grow Room, Contraband repack) by $/hour with setup cost and payback, from game prices plus clan-measured model inputs. |
| **Wipe planner** | Goals for this wipe, optionally linked to a tree node and assigned to a member. Admins start the next wipe here. |
| **Items** | Every tree node and business good with its price. Members can correct a price; edits are shared and survive data refreshes. |
| **Raid alerts** | Send an alert that posts in the clan Discord channel with an @here ping. Scripts can send one through the ingest hook. |

Stack: Cloudflare Pages (static `public/`), one Pages Function (`functions/api/[[path]].js`) and a
D1 database. No build step and no front-end dependencies.

Game data comes from [robrun.info](https://robrun.info), a volunteer fan site (build 26509119 at the
time of writing). There is no official ROB RUN API.

## Run it locally

Needs Node.js 20+.

```bash
npm install
npm run db:local     # build seed.sql, load schema + seed into a local D1 database
npm run dev          # http://localhost:8788
```

Open http://localhost:8788 and click **Dev login (local only)** (an admin), or type a name to log in as an ordinary test member, so you can try the hub as several people. `npm run dev` turns dev login on
with a command-line binding; it only works on localhost and is never set in production.

With `npm run dev` running, in another terminal:

```bash
npm run smoke        # logs in via dev login and exercises every API area
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local site with D1 and dev login on port 8788 |
| `npm run db:local` | Rebuild `seed.sql` and apply `schema.sql` + seed to the local database |
| `npm run seed:build` | Rebuild `seed.sql` from `data/*.psv` |
| `npm run db:remote` | Same as `db:local` against the production database |
| `npm run sync` | Re-import game data from robrun.info into `data/` (after a game patch only) |
| `npm run smoke` | API smoke test against a running `npm run dev` |

Re-seeding is safe: it upserts game data and leaves everything the clan entered alone (price
edits, model inputs, members, status, progress, plan, raids).

## Deploy

Follow the runbook (Phase 3). In short:

1. `npx wrangler d1 create robrun-hub`, put the `database_id` in `wrangler.toml`, `npm run db:remote`.
2. Cloudflare Pages > Connect to Git > this repo. Build command: none. Output directory: `public`.
3. Discord Developer Portal: add the redirect `https://<your-site>/api/auth/callback`.
4. Pages > Settings > Variables and Secrets (Production):

   | Variable | Value |
   | --- | --- |
   | `DISCORD_CLIENT_ID` | OAuth2 client id |
   | `DISCORD_CLIENT_SECRET` | OAuth2 secret (encrypt) |
   | `DISCORD_GUILD_ID` | Clan server id |
   | `DISCORD_WEBHOOK_URL` | Alert channel webhook (encrypt) |
   | `INGEST_TOKEN` | `openssl rand -hex 32` (encrypt) |
   | `ADMIN_IDS` | Comma-separated Discord user ids |

5. Check the `DB` D1 binding under Settings > Bindings, then redeploy.

Never set `DEV_LOGIN` in Cloudflare. `curl https://<your-site>/api/auth/dev` must return 404.

## Game data

| File | Source | Edited by |
| --- | --- | --- |
| `data/larry-tree.psv` | robrun.info planner data (`/en/planner/data.js`) | `npm run sync` |
| `data/products.psv` | robrun.info item pages for the goods the businesses use | `npm run sync` |
| `data/model-inputs.psv` | Starting values for the Money model | Hand, then the site |

After a game patch:

```bash
npm run sync               # behind a proxy: NODE_USE_ENV_PROXY=1 npm run sync
git diff data/             # read it: new items, removed items, changed prices
npm run seed:build && npm run db:remote
```

robrun.info has no published API or reuse terms. Keep the sync manual, run it only after a patch,
and email support@robrun.info before automating it. `node tools/sync-robrun-info.mjs --save DIR`
keeps a copy of every fetched page; `--from DIR` re-runs against that copy without touching the site.

## Money model

Setup is research cost plus Trade Laptop price for the tier I buildings. It does not include the
house each building needs. Sale prices get the criminal level bonus (Smuggler +5/10/15/25%, Fence
+10/20/35/50% at levels 2-5, per robrun.info).

- **Chemical Laboratory**: the freezer is the bottleneck. Concentrate/hour = freezer places × 60 /
  (freezer ticks × 6 min). Each Concentrate is worth the quality-weighted Hard Crystal price (or
  powder, once powder per crystal is measured), minus the reagent canisters used, valued at what the
  Smuggler pays for them.
- **Grow Room**: tables × bushes per table × bags per bush × Uncommon Harvest Bag price / hours per
  harvest. Bushes are loot and keep producing, so they are not a cost.
- **Contraband repack**: slots × repacks/hour × (Premium/Rarity Cargo price − Contraband Cargo hub
  price).

A business is marked provisional while any of its inputs is `assumed`, `reported` (one player's
report) or `unknown`. Measure them in game and enter the results under Money > Model inputs.

## Raid ingest hook

Scripts can raise an alert without a login:

```bash
curl -X POST https://<your-site>/api/raids/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"defend","target":"Main base","note":"alarm tripped","source":"base alarm"}'
```

`kind` is `defend`, `attack` or `info`. `at_time` (ISO 8601) is optional.

## API

All routes are under `/api` and need a session cookie except the auth routes, `GET /me` and the
ingest hook.

| Route | Notes |
| --- | --- |
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Discord OAuth (`identify guilds.members.read`) |
| `GET /auth/dev[?as=Name]` | Local dev login (admin, or a test member with `as`); 404 unless `DEV_LOGIN=1` on localhost |
| `GET /me` | Current member, admin flag, wipe |
| `GET/PUT /status` | Member status for this wipe |
| `GET/PUT /progress` | Larry's Tree unlocks for this wipe. PUT `{item_id, done, member_id?}`: `member_id` other than your own is admin only. Returns the nodes `added` or `removed` (prerequisites and dependents cascade) |
| `GET /income?level=1..5`, `PUT /inputs/:key` | Money model and its inputs |
| `GET/POST /plan`, `PATCH/DELETE /plan/:id` | Wipe plan |
| `POST /wipes` | Start the next wipe (admin) |
| `GET /items`, `PUT /items/:id` | Prices; `{"price": null}` resets to the synced price |
| `GET/POST /raids`, `DELETE /raids/:id`, `POST /raids/ingest` | Raid alerts |

Sessions last 30 days. Removing someone from the Discord server stops their next login; to end an
existing session now, delete their rows from `sessions`.
