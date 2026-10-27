# Magento → Flipick adapter

One central, multi-tenant service for many Magento installations. Merchants install the Flipick extension (Marketplace,
Composer or ZIP); every installation talks to this service, which holds the video logic, plans, usage, payments, refunds and
invoices. UI and billing behaviour follow the Shopify adapter (`../shopify-adapter`).

```
Magento admin (extension)  --signed HTTPS-->  this adapter  --> Flipick video engine (LTX)
        |  grid + launch links                  |   PostgreSQL (EAV + billing tables)
        '-- iframe: one-time launch token -----'   --> payment gateway (ICICI)
                                                  --> staff console at /admin
```

## Tenancy

| Level | Meaning | Holds |
|---|---|---|
| Merchant | the paying organisation | contact, country, GST number |
| Installation | one Magento deployment (base URL) | install key, encrypted secret, encrypted Magento token |
| Store | one Magento **website** | plan, period, usage, credit, videos, settings |

Subscriptions belong to a store (website). Every tenant row carries `store_id`; the repository filters on it **and**
PostgreSQL row-level security enforces it (the service connects as a role without `BYPASSRLS`).

## Run locally

```
# the database: schema magento_adapter in the shared PostgreSQL database ltx_1jnl (127.0.0.1:5432), created once by an administrator:
DATABASE_SUPERUSER_URL=postgresql://<admin>@127.0.0.1:5432/ltx_1jnl npm run db:bootstrap
cp .env.example .env             # set the role passwords, ADAPTER_SECRET_KEY, INTERNAL_API_SECRET, video engine keys
npm install
npm start                        # migrations run automatically; http://localhost:4200
npm test                         # creates and drops its own scratch database (magento_adapter_test) on the same server (TEST_DATABASE_SUPERUSER_URL, see docs/testing/HOW-TO-RUN.md)
```

Staff console: `http://localhost:4200/admin` (sign in with your LTX account: Flipick superadmins and this tenant's admins).

## How an installation connects

1. In the Magento admin (Flipick → Video Generator) the merchant clicks **Connect**. The extension creates a limited Magento
   integration, then calls `POST /api/v1/register` with the store URL and that token.
2. The adapter checks the token against the store (`/rest/V1/store/websites`), creates merchant, installation and one store per
   website (each on the free trial), and returns an install key and secret **once**. The extension stores the secret encrypted.
3. Server-to-server calls are signed:

   ```
   X-Flipick-Key        install key
   X-Flipick-Timestamp  unix seconds (accepted within 5 minutes)
   X-Flipick-Nonce      random, single use
   X-Flipick-Signature  hex HMAC-SHA256(secret, "<ts>\n<nonce>\n<METHOD>\n<path+query>\n<sha256 hex of raw body>")
   X-Flipick-Website    Magento website id
   ```
4. The browser UI never sees the secret. The extension builds a one-time **launch token** (HMAC of
   `{k: installKey, w: websiteId, e: expiry, n: nonce}`) into the iframe URL; `POST /api/session` swaps it for an 8-hour
   session token that the page sends as `Authorization: Bearer`.

Also: per-installation and per-store rate limits (Postgres-backed, `429` + `Retry-After`), `Idempotency-Key` on generate /
preview / checkout, and an append-only `audit_log`.

## Plans, usage and credit

Ported from the Shopify adapter and made data-driven (`plans`, `plan_prices`, `plan_video_rates`; edit them in `/admin/plans`).

* **Trial:** 5 free videos per store, kept for life.
* **Starter / Pro:** pay for one period (monthly or annual, in USD or INR). The included budget is in USD cents whatever the
  currency paid. Each video draws its own rate; the video that exactly exhausts the budget is still included.
* **Beyond the budget:** prepaid **credit** (top-up packs). No credit and no budget means generation answers `402` with
  `trial_exhausted`, `subscription_inactive` or `usage_cap_reached`, as in the Shopify adapter.
* **Only a video that reaches "ready" counts.** Failures, cancels and Update Overlay never do. One usage row per video version.
* **Period end:** `active` → `grace` (3 days, still allowed) → `expired` (blocked). No auto-renewal in v1: reminder
  notifications are queued before the end and the merchant renews from Plans & Billing.
* **Cancel Plan** (as in Shopify) takes effect immediately and returns the store to the free plan. Used free videos and credit are kept; the paid period is not refunded automatically. Staff can refund from the console.

## Payments

`src/payments/` holds the gateways behind one interface (`createPayment`, `verifyReturn`, `checkStatus`, `refund`).
The automated tests use a fake ICICI bank (`test/fakeIcici.js`) so no network or bank account is needed.

Rules: a plan or credit is granted only after the gateway's own **status check** says paid for exactly the order amount; every
gateway result is stored once (`gateway_events` unique key), so duplicate or late callbacks change nothing; pending orders are
re-checked every minute and closed after 24 hours. Paid orders get a numbered invoice; refunds (staff only) produce a credit
note and can end the plan or take back the credit. GST (default 18%, placeholder) is added to INR orders of Indian merchants.

### ICICI

`IciciGateway.js` implements order creation (`initiateSale`), the secure hash and return verification from the public
description of ICICI's payment gateway. **Status checks and refunds are deliberately disabled** until ICICI's API document
(issued with the UAT credentials) is implemented; they refuse to run while `ICICI_PG_SPEC_CONFIRMED` is not `true`.

To go live on ICICI:
1. Get UAT credentials and the API document from ICICI (merchant id, aggregator id, secret key, status and refund calls,
   test cards, callback URL registration). Ask about international cards and settlement currency.
2. Implement `checkStatus` and `refund`, confirm field names / date format / response codes, add tests for them.
3. Set the `ICICI_PG_*` values and `ICICI_PG_SPEC_CONFIRMED=true`; register
   `PUBLIC_BASE_URL/api/payments/callback/icici` as the callback and `PUBLIC_BASE_URL/billing/return?gw=icici` as the return URL.
4. Run the scenarios in `test/platform.e2e.test.js` against UAT by hand: pay, decline, pending then paid, duplicate callback, refund.

## Layout

```
server.js, src/app.js        entry and assembly
src/routes, controllers      HTTP
src/services                 billing rules/metering, payments, tenants, registration, scheduler
src/payments                 gateway (icici)
src/repositories, models     video history on EAV (video_slot, video_version, store_setting)
src/db                       connection + tenant context, migrations runner, generic EAV repository
src/middleware               tenant auth (signature / session), rate limit, idempotency
src/admin                    staff console
migrations/                  SQL, applied in order and checksummed
public/, views/              browser UI (boot.js signs in, billing.js = Plans & Billing, app.js = picker)
test/                        unit tests and an end-to-end suite against PostgreSQL + a fake Magento
```

## Logs

Written to the console and to `logs/app.log` (everything) and `logs/error.log` (warnings and errors). **Rotation:** every day at
**00:05:00** (server local time) and **at once whenever a file passes 10 MB**, the file is zipped (`app-2026-10-08.zip`, or
`app-2026-10-08-153012.zip` for a size rotation) and a new file is started. The rename is atomic, so no line is lost or split; if the
process was down at 00:05 the old file is rotated at the next start. Settings: `LOG_TO_FILE`, `LOG_DIR`, `LOG_MAX_BYTES`, `LOG_ROTATE_AT`,
`LOG_RETENTION_DAYS` (0 = keep all archives), `LOG_LEVEL`, `LOG_FORMAT`. Secrets are redacted.

## Database

The adapter keeps its data in its **own schema** (`DB_SCHEMA`, default `magento_adapter`) of the PostgreSQL database `ltx_1jnl`, next to
`shopify_adapter`, `woocommerce_adapter` and the other applications' schemas, which it never reads or changes. Every connection is opened with
`search_path` set to that schema, so nothing can fall back to `public`; the migration history (`schema_migrations`) is inside the schema.

### Runbook: a clean install on local, stage or production (details: [db/README.md](db/README.md))

1. **Once, by a database administrator:** `DATABASE_SUPERUSER_URL=postgresql://<admin>@<host>:5432/<database> npm run db:bootstrap` with `DATABASE_URL`, `DATABASE_ADMIN_URL` and `DB_SCHEMA` set to the two new roles' URLs (choose their passwords, keep them in a secret manager) and the schema name. Creates the schema and two least-privilege roles. Idempotent.
2. **On every deploy:** `npm run db:migrate` (owner role, advisory lock, one transaction per migration, idempotent). Then start the service. With `RUN_MIGRATIONS_ON_START=true` (the default) the service does this itself when it starts; set it to `false` when a deploy step runs `db:migrate` and the service should only check that nothing is pending.
3. **Check:** `npm run db:status` and `npm run db:verify -- --expect-empty-install` (drift in structure, roles, grants, isolation from other schemas; a clean install holds only the plan catalogue).
4. Stage and production: `DB_SSL=require` (certificate verified, `DB_SSL_CA` for a private CA); never put the administrator URL in `.env`.

- `scripts/db/provision.js` (`npm run db:bootstrap`): the bootstrap above.
- `scripts/db/migrate.js` (`npm run db:migrate`): applies pending migrations (the service also does so at start-up unless `RUN_MIGRATIONS_ON_START=false`).
- `scripts/db/move-data.js`: one-off, repeatable move from the old database (`SOURCE_DATABASE_URL`, read only): copies every table in one snapshot with primary keys and sequences preserved, refuses a non-empty target, then prints row counts and md5 checksums per table. `--verify-only` just compares. Stop the adapter while it runs.
- `npm run db:status`, `npm run db:verify`, `npm run db:manifest`: see [db/README.md](db/README.md).
- `DB_POOL_MAX` (default 8) keeps the service's share of the shared server's connections small.
- Rollback: set `DATABASE_URL` / `DATABASE_ADMIN_URL` back to the old database (`docker compose up -d db`, port 5434) and `DB_SCHEMA=public`.

## Deploying

Needs a public HTTPS address (`PUBLIC_BASE_URL`), managed PostgreSQL (create the schema and roles with `npm run db:bootstrap`, set `DB_SSL=require`), `ADAPTER_SECRET_KEY` and the other secrets from the environment, and `NODE_ENV=production`
(which also blocks private-network store URLs at registration). Back up the database; the secret key is needed to read
stored credentials.
