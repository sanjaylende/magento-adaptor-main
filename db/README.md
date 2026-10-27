# Database set-up

The adapter's data is the schema `DB_SCHEMA` (default `magento_adapter`) of one PostgreSQL database (`ltx_1jnl` locally, next to `shopify_adapter` and `public`, which it never touches). A clean install is set up by two stages, because the privileges differ; the same commands work on local, stage and production.

| Stage | Who runs it | Command | What it does |
|---|---|---|---|
| 1. Bootstrap | a database administrator, **once** | `DATABASE_SUPERUSER_URL=... npm run db:bootstrap` | creates the schema, the owner role (runs migrations, owns the schema) and the service role (what the running app uses): no superuser, createdb, createrole, replication or bypassrls; `USAGE` on this schema only; default `search_path`; default privileges for future tables and sequences. Creates a PostgreSQL extension only if one is ever required, and only if missing (none today). Idempotent; passwords are read from the environment and never printed. |
| 2. Migrate | the owner role, on **every deploy** | `npm run db:migrate` | applies `migrations/*.sql` in order, one transaction each, under an advisory lock (two instances starting together queue instead of racing). The history table `schema_migrations` is inside the schema. Idempotent. Forward-only: no down-migrations (to start over in development, drop a scratch database). |

Other commands

- `npm run db:status` shows applied, pending and changed migrations (`-- --exit-code` fails when something is pending: for a deploy script).
- `npm run db:verify` reports drift: schema owner, migrations, structure compared with `db/structure.manifest.json`, role attributes and `search_path`, grants of the service role, and isolation from every other schema. `-- --expect-empty-install` also checks that nothing but the plan catalogue holds rows. Exit code 1 on any failure.
- `npm run db:manifest` compares the live structure with the manifest; `npm run db:manifest -- --write` rewrites it (after a migration that changes the structure; review the diff).

A clean install holds **no rows except the plan catalogue** (`plans`, `plan_prices`, `plan_video_rates`, from migration 006: the app cannot sell a plan without them; the INR prices in it are placeholders, edit them in the staff console). The app also writes its EAV attribute definitions (`eav_entity_type`, `eav_attribute`) at start-up, idempotently, from the model definitions in code. No data is copied from any other database.

Environment (see `.env.example`): `DATABASE_URL` (service role), `DATABASE_ADMIN_URL` (owner role), `DB_SCHEMA`, `DB_SSL=require` for any non-local host (certificate verified; `DB_SSL_CA` for a private CA), `DB_POOL_MAX`, `RUN_MIGRATIONS_ON_START`. The administrator URL for bootstrap (`DATABASE_SUPERUSER_URL`) is used only by that one command and is never kept in `.env`.
