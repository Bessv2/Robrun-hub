# Migrations

`schema.sql` is the base schema. Every change after that goes here as a new numbered file:
`0001_short_name.sql`, `0002_...`. Never edit a migration that has been applied remotely.

Apply locally, test, back up, then apply remotely:

    npx wrangler d1 execute robrun-hub --local  --file=migrations/0001_short_name.sql
    npm run smoke
    npx wrangler d1 export robrun-hub --remote --output=backup-$(date +%F).sql
    npx wrangler d1 execute robrun-hub --remote --file=migrations/0001_short_name.sql

Also fold the change into `schema.sql` so a fresh database gets it.
