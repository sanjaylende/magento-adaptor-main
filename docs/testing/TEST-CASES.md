# Test cases: Flipick Video Generator for Magento and WooCommerce

> This copy lives in: Magento adapter (Node.js). Commands here: `npm run regression`, `npm test`, `npm run lint`. The same file is kept in every repo and in the workspace root; the whole-system command is `scripts/run-all-tests.sh` in the workspace root (`D:\Flipick-Video-Genertor`).

This file is the list of what "testing" means for the four components. When the user says "carry out testing", "run the tests" or
"run regression", run every case below (automated ones with the commands given, manual ones from the checklist) and report in the format of
`docs/testing/REPORT-FORMAT.md`. When a change adds or changes a feature, add or update its case **first**.

| Short name | Folder | What it is |
|---|---|---|
| Magento extension | `magento_module-main` | The module installed in the merchant's Magento (PHP) |
| Magento adapter | `magento-adaptor` | The Node.js service the extension talks to (billing, videos, merchant app) |
| WooCommerce plugin | `flipick-video-generator-for-woocommerce` (copy in `woocommerce-adaptor/wordpress-plugin/`) | The WordPress plugin (PHP) |
| WooCommerce adapter | `woocommerce-adaptor` | The Node.js service the plugin talks to |

Results use four words: **PASS**, **FAIL** (a regression: stop and fix), **KNOWN ISSUE** (a defect already written up in
`docs/performance/PERF-REPORT.md` section 4 or the QA report; the check turns PASS when it is fixed) and **BLOCKED** (could not be run here, with the reason).
Never write "tested" or "faster" for something that was not run and measured.

Safety: test only on the local Docker instances and the throwaway databases named below. No real payment gateway, no real video engine
(the in-repo pretend bank `test/fakeIcici.js` and the mock engine are used), no production, no push to GitHub, no real secrets in any file
or report (environment variable *names* only).

## Which cases run where

| Case | Magento ext. | Magento adapter | Woo plugin | Woo adapter | How |
|---|---|---|---|---|---|
| T1 Install and connect | manual + store script | store script | manual + store script | store script | `scripts/ui/*-stores.js` |
| T2 Monthly subscription | | automated | | automated | `npm run regression` (case `subscriptions`) |
| T3 Annual subscription | | automated | | automated | same |
| T4 Plan changes and edge cases | | automated | | automated | same |
| T5 Renditions and images | | automated | | automated | case `video` |
| T6 Regeneration and image replacement | | automated | | automated | case `video` |
| T7 Overlay | | automated (render check Blocked) | | automated (render check Blocked) | case `video` |
| T8 Uploaded images, bad files | | automated | | automated | case `video` |
| T9 Free plan limits | | automated | | automated | case `subscriptions` |
| T10 Security regression | php lint + compat | automated | php lint + load tests | automated | cases `security` and `sqli`, `npm test`, `npm run lint`, `tests/regression/run.sh` |
| T11 UI consistency | | automated (Chrome, Firefox, desktop, phone) | | automated | case `ui` + screenshot review |
| T12 Uninstall and reinstall | store script | store script | store script | store script | `scripts/ui/*-stores.js` |
| T13 Load and 30-minute soak | | automated | | automated | cases `perf` and `soak` |
| PHP checks (compile, Magento compatibility, log rotator, lazy loading, slow adapter) | automated | | automated | | `bash tests/regression/run.sh` in the PHP repos |

## T1 Install and connect

*Steps.* Install the extension / plugin into a clean store, open Flipick in the store admin, press **Connect**, wait for "Store connected".
Open the video grid.
*Expected.* The store appears once in the adapter (one installation, one store, a Free subscription row); the grid lists the store's products;
no browser console errors or CSP violations; a second store connected to the same adapter gets its own installation and sees none of the first store's data;
logging in to the second store's admin does not log the first one out.
*Automation.* `scripts/ui/woo-stores.js` (stores :8085 and :8086) and `scripts/ui/magento-stores.js` (:8080 and :8081); adapter side by `connectStore()` in every adapter case.
*Known limitation.* The adapter caches the allowed frame origins for 60 s (`frameAncestors()`), so the grid of a brand-new connection can show a blocked frame for up to a minute (finding F-FRAME in `PERF-REPORT.md`). The scripts wait 65 s.

## T2 Subscription, monthly (`cases/subscriptions.js`)

Starts on Free with the full free allowance; buys Starter monthly in USD through the pretend bank; checks the database row (plan, interval, currency, status),
the order (total from the plan table, no tax in USD, status paid), renewal date = purchase + 1 month, API status equals the database (plan, interval, period end, budget),
a plan adds no prepaid credit, one invoice exists; cancel drops to Free at once, keeps used free videos, creates no charge; a second cancel is refused with a 4xx.

## T3 Subscription, annual

Buys Starter annual: row annual/active, price = 10 x the monthly price (two months free), budget = 12 x the monthly budget, renewal = purchase + 12 months; cancel drops to Free.

## T4 Plan changes, failed payment, replay, isolation

Failed payment: a clear message and the plan unchanged. Repeated bank confirmation (replay): period, invoices and credit unchanged. Monthly -> annual,
annual -> monthly (observation recorded: periods stack, no proration), Starter -> Pro with the Pro budget, buy-cancel-buy leaves one subscription row with fresh usage,
INR with 18 % GST for an Indian merchant, credit top-up added once even when the confirmation arrives three times. A second store stays on Free with no orders and cannot read the first store's order (404) or history.

## T9 Free plan limits

A fresh store gets exactly the Free allowance (5 videos), the next generation is refused with `402 trial_exhausted`, the status shows the allowance used,
and buying then cancelling a plan does not bring the used videos back.

## T5 Renditions and images (`cases/video.js`, "Case I")

For each video type (image_transition, hero_product, lifestyle) and each size (16:9, 9:16, 1:1, 5:4): the picker lists the product's own 4 pictures in gallery order and shows them correctly;
generation is accepted; the request that reaches the engine carries the right pictures in the right order and the right aspect ratio; the finished video has that shape;
the frames of the video show those pictures (colour match against the source pictures, which are solid colours); every finished video is charged exactly once.
The result is printed as the table "Case I: pictures -> request -> video".
*Known issue.* F-RATIO: asking for 5:4 makes the adapter send 16:9 to the engine, so the video is 16:9 (Hero Product and Image Transitions, both adapters; Lifestyle sends 5:4 correctly).
Lifestyle runs through the same engine job/poll path as Hero Product, so the mock engine covers it (the real engine's prompt and picture quality are not covered: see M4).

## T6 Regeneration and image replacement

First generation shows picture 1 first. A second request while one is running is refused with 409. Regeneration makes version 2 and charges once more; the history lists both.
After the store replaces a picture under the same file name, a new generation uses the new picture and the picker also shows the new picture (no stale copy).
Restoring version 1 shows version 1 again; a version can be deleted; another store sees none of these videos.

## T7 Overlay

Hero video with an overlay family: the engine receives the family and every value the merchant typed, the values are stored on the version. **Update Overlay** re-uses the engine project
(no new generation), sends the new text, makes a new version. After signing in again the text is still there. Another store sees neither video nor text.
Update Overlay without an existing overlay video is refused with a clear message (400).
*Blocked with the mock engine.* Overlay text drawn inside the picture (legible, not cut off): check by eye with the real engine (manual checklist M3).

## T8 Uploaded pictures

A real PNG is accepted and served back unchanged with `nosniff`; over 15 MB -> 413; a text file renamed .png -> 415; an SVG -> 415; an empty body -> 400; a hostile file name is cleaned before it is stored;
no sign-in -> 401; unknown product -> 404; an uploaded picture used as frame 1 appears first in the video; a second store is unaffected.

## T10 Security regression

1. Case `security`: the repo's live security journey against the running adapter (bad signature, replayed nonce, timestamps, body size limits, unknown fields, prototype pollution, SSRF refusals, store isolation of orders and videos, staff lock-out and CSRF, rate limiting of sessions).
1b. Case `sqli`: 644 requests with 14 SQL-injection payloads (path, query, body, headers, file name, sign-in forms, staff console) must give no 5xx, no database or code text, no sleep delay, no dropped table or deleted row, and no sign-in by a boolean payload. Review and findings: `docs/security/SQL-INJECTION-REVIEW.md`.
1c. Staff sign-in (Magento adapter, `test/security.e2e.test.js` H4): staff sign in with their LTX account against a pretend LTX (`test/fakeLtx.js`). An LTX superadmin and an admin of this tenant get in as `admin`; a wrong password, unknown e-mail, another tenant's admin and a non-admin LTX user all get the identical refusal and no cookie. The adapter keeps no staff table, and the password is not in the session cookie or the audit log. A session ends the moment LTX revokes the account; if LTX is down the answer is 503. The old local two-factor and My-security pages are gone. Idle timeout, cookie flags and CSRF still hold.
1d. Internal token route (Magento adapter, `test/internalToken.e2e.test.js`): `GET /internal/magento-token/:shop` hands the store's Magento integration token to LTX only with the right `X-Internal-Secret` (`INTERNAL_API_SECRET`). A missing, wrong or misnamed secret, or one in the query string, is 401; with no secret configured everything is 401 (fail closed). An unknown, suspended or uninstalled store is 404 `not_installed`; a host with a scheme, path or odd characters is 400. Each hand-out is audited and the token never appears in the audit log.
2. `npm test` (all unit and end-to-end tests of the adapter, including the security tests) must stay green.
3. `npm run lint` clean; `npm run audit:prod` no high findings.
4. PHP repos: every file compiles; the extension is checked against the installed Magento's interfaces.
Never weaken validation, rate limits, headers or signature checks to make a test pass.

## T11 UI consistency (`cases/ui.js` plus manual review)

Every merchant-app screen (no launch link, list, no search results, very long search text, detail with a ready video, generate dialog, dialog settings, long prompt, stills picker, plan dialog, payment history)
and every staff-console screen (login, dashboard, merchants, payments, plans, audit) in Chrome and Firefox at 1400 px and 390 px: the screen is reached, no console errors or CSP violations,
no failed request, and on the phone nothing sticks out sideways. Screenshots are saved in `tests/regression/reports/ui/`; look at a few by eye and compare with the pre-change build.
*Known issue.* FND-UI-1: on a 390 px phone the product list (filter row, table, search echo) is wider than the screen; a 300-character search term pushes the page 1300 px wide.

## T12 Uninstall and reinstall

WooCommerce: deactivate the plugin (menu gone, store front still works, settings kept), reactivate (still connected, grid loads), disconnect (Connect button back, other store untouched),
run `uninstall.php` (every option, transient and log file removed, adapter told), reinstall and connect again (no duplicate installation).
Magento: run the module's `Setup/Uninstall` (adapter told, credentials and integration removed), then connect again through the Connect page; disabling and re-enabling the module keeps the connection.
The adapter keeps the merchant's data after an uninstall (installation marked uninstalled, not deleted).

## T13 Load and soak

`perf`: p95 latency of the seven main routes under 10 concurrent workers, compared with `docs/performance/TARGETS.json` (fails when a route is more than 10 % over its target, with a 15 ms floor for noise).
`soak`: mixed traffic for `SOAK_MINUTES` (the acceptance run uses 30), no errors, heap and resident memory growth below 15 %.
Both run against the adapter with the rate limits scaled up (`RATE_LIMIT_SCALE`, ignored in production) so that the handlers, not the limiter, are measured.

## Manual checklist (run by the person or agent carrying out testing, with the real engine where stated)

| ID | Item | How |
|---|---|---|
| M1 | Open the merchant app in the store admin of each platform and look at the list, a ready video, the generate dialog, the plan dialog | Chrome, desktop and a 390 px window; compare with the screenshots of the previous run |
| M2 | Press Play on a generated video from the grid and from the storefront product page; check it plays and is the right shape | Chrome |
| M3 | Overlay text legible and not cut off in all four sizes | needs the real engine (LTX on :3000); BLOCKED with the mock engine |
| M4 | Lifestyle video end to end with the real engine (prompt and picture quality) | needs the real engine (LTX on :3000) and costs credits; BLOCKED with the mock engine |
| M5 | Pay with the real ICICI sandbox | never done in this environment; BLOCKED by policy |
| M6 | Look at the `docs/testing` report of the previous run and confirm that nothing that passed before fails now | compare the two reports |

## Adding a case

1. Write the case in this file (steps, expected result, how it is automated or the manual item).
2. Add the checks to a file in `tests/regression/cases/` (adapters) or `tests/regression/run.sh` (PHP repos).
3. Run it on the version before your change (it must show the old behaviour) and after (it must pass).
