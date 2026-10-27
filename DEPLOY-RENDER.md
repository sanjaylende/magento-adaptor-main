# Deploying to Render

End-to-end runbook for the Magento adapter on Render: one **Web Service** (Node 22, Express 5) + one managed **PostgreSQL**. No Vercel: this is a stateful Node process with a scheduler and connection pool — serverless does not fit (see the "Why not Vercel" note at the end).

The source of truth for infra is `render.yaml` (Render Blueprint). This file is the human runbook that goes with it.

---

## 0. Prerequisites

- A Render account with a payment method on file (free Postgres expires after 30 days; free web services sleep after 15 min, which breaks the in-process scheduler, webhooks, and session TTLs).
- A GitHub repo Render can read (push this repo to GitHub first — **but do not commit `.env`**; `.gitignore` already excludes it, verify with `git ls-files .env` returning nothing).
- Production ICICI PG credentials (merchant id, aggregator id, secret key, callback source IPs). The UAT credentials in your local `.env` will not pass the production safety check in `src/config/safety.js`.
- Production Flipick video-engine URL + API keys.

### Already created a manual Render service and database?

Do not apply the Blueprint as well: `render.yaml` creates a separate database and service, and currently targets `main` in Oregon. For an existing staging setup on `stage` in Singapore, continue with those existing resources and use their Singapore **Internal Database URL** for the Web Service. Use the database's **External Database URL** only for commands run from your computer, after allowing your current IP in the database access settings.

For the existing Web Service, use Node runtime, `npm ci --omit=dev` as the build command, `npm start` as the start command, `/health` as the health check, and keep the Web Service and database in the same region. Do not deploy payment production credentials to staging unless you intend to use the live ICICI gateway.

---

## 1. Push the repo to GitHub

```bash
git remote -v                   # confirm the remote; add one if missing
git status                      # confirm clean, confirm .env is NOT staged
git push origin main
```

If `git ls-files .env` prints anything, stop and `git rm --cached .env` before pushing — the current `.env` contains real UAT secrets.

---

## 2. Create the blueprint on Render

1. Render dashboard → **New** → **Blueprint**.
2. Pick the repo, pick the `main` branch, Render detects `render.yaml`.
3. Review the plan tiers (we default to **starter** for the web service and **basic-256mb** for Postgres) — adjust if you need more RAM, then **Apply**.

Render provisions in parallel:
- A PostgreSQL instance named `magento-adapter-db`.
- A Web Service named `magento-adapter` (first deploy will fail at boot — the DB has no schema yet; fix that in step 3).

---

## 3. Bootstrap the database (one-time)

The adapter's provisioning script (`scripts/db/provision.js`) expects **two** database roles: an owner (runs migrations, owns the schema) and an app role (runs the service, without `BYPASSRLS` so row-level security applies). Render Postgres gives you **one** role. You have two choices:

### 3a. Preferred: create a second role (keeps RLS enforcement)

This option requires the Render database login to have `CREATEROLE` (or superuser) permission. Do not assume it does. If it lacks that permission, use the database provider's supported role-management process or keep the staging deployment on one role; do not claim the separate-role security checks passed.

Open the Postgres instance in the Render dashboard → **Connect** → copy the **External Database URL** (uses TLS). From your laptop, with `psql` installed:

```bash
# The URL Render gives you connects as the owner role (whatever Render named it, e.g. ltx_1jnl_user).
# Create the app role, then grant it CONNECT so our provision script can finish the rest.
psql "<external-database-url>" <<SQL
CREATE ROLE magento_adapter_app LOGIN PASSWORD '<pick-a-strong-password>' NOINHERIT;
GRANT CONNECT ON DATABASE ltx_1jnl TO magento_adapter_app;
SQL
```

Then run the provisioning script against Render, from your laptop:

```bash
# The owner URL is Render's "External Database URL" (as the Render-provided role).
# The app URL swaps the user/password you just created.
export DATABASE_SUPERUSER_URL="<external-database-url>"
export DATABASE_ADMIN_URL="<external-database-url>"
export DATABASE_URL="postgresql://magento_adapter_app:<your-password>@<render-host>:5432/ltx_1jnl?sslmode=require"
export DB_SCHEMA=magento_adapter
export DB_SSL=require
npm run db:bootstrap
npm run db:migrate
npm run db:verify
```

Back in the Render dashboard, set these two env vars on the Web Service:

- `DATABASE_URL` — the app role URL (already auto-filled by the blueprint from the DB; **override it** with the app-role URL you just built).
- `DATABASE_ADMIN_URL` — Render's provided URL (the owner role).

### 3b. Simpler, less safe: use one role for both URLs

If `CREATE ROLE` is refused (older Render tiers), point both URLs at Render's single role. Row-level security policies still exist in the schema but have no effect on this role — treat the service as fully trusted inside the DB.

```bash
export DATABASE_SUPERUSER_URL="<external-database-url>"
export DATABASE_ADMIN_URL="<external-database-url>"
export DATABASE_URL="<external-database-url>"
# provision.js requires distinct roles, so skip it and run migrations directly:
export DB_SCHEMA=magento_adapter
export DB_SSL=require
npm run db:migrate
npm run db:status
```

In the Render dashboard set both `DATABASE_URL` and `DATABASE_ADMIN_URL` to the Render-provided string.

This is a staging convenience, not the preferred production configuration. `db:verify` is designed to reject a shared owner/service role (the service role has schema-creation privileges and RLS is bypassed by the table owner). Do not interpret that failure as a successful least-privilege check. Use separate roles for production.

---

## 4. Fill in the remaining secrets

In the Web Service → **Environment**:

| Variable | Value | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://<service>.onrender.com` | Must be `https://`. Replace with your custom domain once attached. |
| `ADAPTER_SECRET_KEY` | auto-generated by Render | Keep stable. Rotating it invalidates every stored installation secret. |
| `INTERNAL_API_SECRET` | long random string | Shared with LTX (header `X-Internal-Secret`) for `GET /internal/magento-token/:shop`. Never committed. |
| `ADMIN_AUTH_BASE_URL` | LTX address | Staff sign in with their LTX account; empty = `FLIPICK_VIDEO_ENGINE_BASE_URL`. No staff passwords are stored in the adapter. |
| `ICICI_PG_MERCHANT_ID` | from ICICI | Production, not UAT. |
| `ICICI_PG_AGGREGATOR_ID` | from ICICI | |
| `ICICI_PG_SECRET_KEY` | from ICICI | |
| `ICICI_CALLBACK_ALLOWED_IPS` | ICICI's webhook source ranges | Comma-separated, CIDR allowed. |
| `FLIPICK_SPONSORED_ADS_BASE_URL` | prod URL | |
| `FLIPICK_VVP_API_KEY` | prod key | |
| `FLIPICK_TENANT_ID` | prod tenant | |
| `FLIPICK_VIDEO_ENGINE_BASE_URL` | prod URL | |
| `FLIPICK_VIDEO_ENGINE_API_KEY` | prod key | |
| `VIDEO_ENGINE_WEBHOOK_SECRET` | shared with the engine | Empty = unsigned callbacks accepted (not recommended). |
| `SELLER_ADDRESS`, `SELLER_GST_NUMBER` | invoice footer / GST line | |

Click **Save, Rebuild and Deploy**.

---

## 5. Verify

Once the deploy is green:

```bash
curl -i https://<service>.onrender.com/health              # 200 ok
curl -i https://<service>.onrender.com/.well-known/security.txt
```

In the Render shell (Web Service → **Shell**):

```bash
npm run db:status                                           # all migrations applied
node scripts/check-health.js                                # business-level health (payments, refunds, notifications)
```

Run `npm run db:verify` only when the database has separate owner and service roles; it should fail in the one-role setup described in step 3b.

Sign in to `/admin` with the bootstrap credentials, enrol in TOTP (production requires it), and change the password.

---

## 6. Custom domain (optional, do this before go-live)

1. Web Service → **Settings** → **Custom Domains** → add `magento-adapter.yourdomain.com`.
2. In your DNS, add the `CNAME` Render shows you. Render will issue a Let's Encrypt cert automatically.
3. **Update `PUBLIC_BASE_URL`** to the new https URL and redeploy. Everything that builds absolute links (payment return URLs, invoice links, download links) uses it.
4. If you register the service with Magento stores from the Magento extension, re-register with the new URL — the installation base URL is signed into every request.

---

## 7. What Render does *not* give you (vs. the self-hosted runbook)

`DEPLOY.md` assumes nginx in front, Cloudflare-only ingress, `pg_hba.conf`-pinned TLS, host-level file-change monitoring, and a hardened systemd unit. On Render:

| Control | Render | Replacement |
|---|---|---|
| TLS termination | Render-managed Let's Encrypt | — |
| nginx request limits / timeouts | Render edge has global limits | app sets its own: `server.headersTimeout`, `requestTimeout`, 1 MB body limit, per-route rate limits |
| Cloudflare-only ingress | not supported (Render has its own IPs) | if you need Cloudflare, put the custom domain behind CF proxy; the service is still reachable at `*.onrender.com` — accept that trade-off or use a Render Private Service with an API gateway |
| `pg_hba.conf` IP-pinning | not available (managed DB) | TLS + Render's internal network isolation; set `ipAllowList: []` on the DB (default in `render.yaml`) to block external connections |
| Host-level file-change monitoring | containers are read-only, filesystem is ephemeral | file-change class of attack is largely moot; `LOG_TO_FILE=false` and ship logs to Render's log stream |
| Backups | **Render takes daily snapshots** on paid DB plans | restore test is still your job — do one monthly, see `docs/security/OPERATIONS.md` |

---

## 8. Why not Vercel

The frontend/backend split is tempting but does not apply here:

- There is **no separate frontend**. `public/` is three JS files and a CSS file served by Express. The merchant UI is the Magento extension (`magento_module-main`), installed into each merchant's Magento — not by us.
- The server-rendered admin console (`src/admin/views.js`) is HTML out of Express.
- Vercel serverless functions have 10–60 s limits; our migrations, payment flows, and webhooks exceed that.
- `src/services/scheduler.js` is started once on boot and runs in-process — serverless kills the process between requests.
- The `pg` pool, in-memory rate limiter, idempotency cache, and tenant-context `AsyncLocalStorage` all assume a long-lived process.

Deploy the single Node service to Render. If you later build a true SPA frontend, that one can go on Vercel and call this service's HTTPS API.
