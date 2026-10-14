`# SQL injection review
`
`Date: 2026-10-14. Scope: Magento extension, Magento adapter, WooCommerce plugin, WooCommerce adapter (the code on `main`). Method: (1) read every place that builds or runs SQL, with a scanner that lists each SQL string containing an interpolation or concatenation; (2) a live test that sends classic injection payloads to every input an attacker controls and checks the answers and the database.
`
`**Result: no SQL injection found in any of the four components.** Details below; the live test is part of the regression suite (case `sqli`, `npm run regression -- sqli`) so it runs on every change.
`
`## 1. Adapters (Node.js, PostgreSQL), Magento and WooCommerce alike
`
`| Question | Answer |
`|---|---|
`| How is SQL run? | Only through `query(sql, params)` of `src/db/connection.js` (node-postgres) and the migration runner. Every value reaches the database as a bound parameter (`$1`, `$2`, ...); the driver sends the text and the values separately, so a value can never become SQL. |
`| Is any SQL text built from request data? | A scan of all `src` and `migrations` files found **6 SQL strings with an interpolation** in each adapter. None carries request data: <br>- `EavRepository.js` (3 places, table name): `eav_entity_${safeTable(table)}`. `safeTable()` accepts only `varchar, int, text, datetime, decimal` and throws otherwise; the table comes from the attribute catalogue, not from a request. <br>- `EavRepository.js` (filters and inserts): the interpolated pieces are placeholder numbers (`$3`), loop counters (`v0`, `v1`) and the allow-listed table name; the values go into `params`. Attribute codes are looked up in the schema map and unknown ones throw. <br>- `rateLimit.js`: builds `($2, $1, 1), ($3, $1, 1)` placeholders; the bucket names are in `params`. <br>- `admin/routes.js` (payments list): `status ? "WHERE o.status = $1" : ""`, the status is a parameter and is also checked against a fixed list by the request schema. |
`| Time arithmetic | `make_interval(days => $1)` and fixed `interval '30 days'`: never built from text. |
`| Row-level security | `set_config('app.store_id', $1, ...)` is parameterised; the policies filter every tenant table by it. The application connects as the role `adapter_app`, which is **not** a superuser, cannot create roles or databases and does **not** bypass row-level security (checked in both databases). Even a hypothetical injection would therefore see only one store's rows and could not drop tables (the tables belong to `adapter_owner`). |
`| Input validation in front of the database | Every route has a strict schema (zod): unknown fields are refused, enums and regular expressions for tags, ids, versions and tokens, size limits on bodies (2 KB to 128 KB) and a 15 MB limit on uploads. |
`| Errors | The error handler answers with a generic message; no SQL or stack text is sent to the client (checked by the live test). |
`
`### Live test (case `sqli`, both adapters)
`
`644 requests per adapter, 14 payloads each (`' OR '1'='1`, `' OR 1=1--`, `"; DROP TABLE stores;--`, `'; DELETE FROM installations;--`, `1; SELECT pg_sleep(6)--`, `' || (SELECT pg_sleep(6)) || '`, `UNION SELECT`, `$1`, URL-encoded and backslash variants, ...) in: every path parameter (tag, version, order, invoice, signed-link tokens), every query string of the product, overlay, download and payment-return routes, the JSON bodies of generate, checkout, update-overlay, prompt-default, discard, register (all fields) and session, the headers `Authorization`, `X-Flipick-*`, `Idempotency-Key`, `Origin`, `Referer`, the upload file name, the webhook paths and bodies, the bank callback, the staff-console sign-in (e-mail, password, two-factor code), the payment filter and the id pages.
`
`Checks: no answer is a server error (5xx); no answer contains database or code detail (`syntax error at or near`, `SQLSTATE`, `relation ... does not exist`, stack frames); no answer is delayed by a `pg_sleep` payload (a slow answer is asked again: a sleep payload would be slow every time); no table is dropped; no row of merchants, installations, stores, subscriptions, orders or staff users disappears; a staff sign-in with `' OR '1'='1` as password or e-mail, and a session token of `' OR '1'='1`, are refused (401); payload text that was saved (merchant names) is stored as plain text; the adapter still serves a store normally afterwards. **Result: all pass on both adapters.**
`
`## 2. WooCommerce plugin (PHP)
`
`All database access in the plugin is two calls in `includes/class-flipick-vg-connection.php`: `$wpdb->insert()` and `$wpdb->delete()` on WooCommerce's `woocommerce_api_keys` table, both with the array form (WordPress escapes and formats every value), the table name from `$wpdb->prefix`, the user id from `get_current_user_id()` and the key id cast to an integer. There is no `$wpdb->query()`, `get_results()` or hand-written SQL. Everything else uses WordPress APIs (`get_option`, `update_option`, `get_post_meta`, transients), which are parameterised by WordPress. The only request inputs are `product_id` (`absint`), the log file name (`sanitize_file_name` plus a fixed pattern) and the nonce-protected admin-post actions. Plugin Check (the WordPress.org review tool) reports no database finding apart from the two documented direct calls.
`
`## 3. Magento extension (PHP)
`
`No hand-written SQL. The only direct statement is in `Setup/Uninstall.php`: `$connection->delete($setup->getTable('core_config_data'), ['path LIKE ?' => 'flipick_videogenerator/%'])`: a constant pattern through Magento's bound-parameter API, no request data. Attributes are created by Magento's EAV setup API with constants (`Setup/Patch/Data`); configuration is read and written through `ScopeConfigInterface` and `WriterInterface`; there are no collections filtered by request input and no `ResourceConnection` use.
`
`## 4. Things that are not SQL injection but were looked at
`
`- Product data that the adapters read from the stores is stored through the same parameterised API, so a product named `'; DROP TABLE ...` is stored as text (covered by the register-name payloads).
`- Values the adapters write back to the stores (video address) go through the WooCommerce / Magento REST APIs, which have their own sanitising; the plugin refuses any video address that is not an absolute http(s) address when printing it.
`
`## 5. Keeping it that way
`
`- Do not build SQL with template strings or `+`. If a table or column name must vary, choose it from a fixed list as `safeTable()` does.
`- The suite fails if a payload causes a 5xx, an error text, a delay or a changed table (\`npm run regression -- sqli\`).
`- A production database role like the local `adapter_app` (not superuser, no row-level-security bypass) must be used by the application; see \`docs/security/DATABASE.md\`.
