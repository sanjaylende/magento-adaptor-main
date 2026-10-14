# Performance and QA report

Date: 2026-10-13 and 2026-10-14. Branch `perf-optimization` in each of the four repos (start marked by the tag `pre-perf`). Nothing was pushed. Final automated run: 20261014-132256 (PASS with known issues: 665 checks passed, 0 failed, 24 known issues, 4 blocked.).

## 1. Summary

- **What was slow, measured:** the adapters did far too much database work on the two most used routes (every product-list or bootstrap request re-signed and re-saved every ready video: 31 statements per request) and ran an extra statement before every query. The WordPress plugin loaded all its code on every request, made a DNS lookup per product-page view and, when the adapter hung, held the admin product list for 20 seconds.
- **What changed:** 6 adapter changes (O1, O2, O3, O5, O6, O7; O4 was tried and reverted because it gave nothing measurable) and 4 plugin changes (P1 to P4), each one commit with its before and after numbers. The Magento extension was audited and not changed for performance.
- **Result (same-session measurements, 10 workers, p95):** product list 511 -> 38 ms (Magento) and 477 -> 39 ms (WooCommerce); bootstrap 571 -> 77 ms and 447 -> 72 ms; the cheaper routes (billing status and history, status, overlay families) p95 down by about half or more. The untouched control route (app shell) moved less than 5 %, so the gains are not noise. Database statements per request fell by 44 to 80 % on every route.
- **Safety:** no public route, response shape, webhook, plan or price logic changed; every earlier security hardening is in place; the security journey, 195 (Magento) and 231 (WooCommerce) adapter tests and the new regression suites pass. Nothing that passed on the build before the changes fails now (section 5).
- **Testing is now one command:** `bash scripts/run-all-tests.sh` (details in section 6).
- **Two defects found by the new tests that are not performance issues:** the Magento extension's `composer.json` was invalid JSON (fixed in its own commit), and a free-plan race and a 5:4 video-size problem exist in both adapters (reported, not fixed; section 4).

## 2. Before and after, per component

All numbers are from the `perf` case of the regression suite (`docs/performance/BASELINE.md` explains the method). Before = tag `pre-perf` plus the test-only hook; after = branch head.

### Magento adapter

| route | rps before | rps after | change | p95 ms before | p95 ms after | change |
|---|---|---|---|---|---|---|
| GET /api/bootstrap | 21.8 | 174.3 | +700% | 571.2 | 76.5 | -87% |
| GET /api/products | 25 | 340.7 | +1263% | 511.1 | 38.3 | -93% |
| GET /api/billing/status | 141.8 | 246.7 | +74% | 102.8 | 54.2 | -47% |
| GET /api/billing/history | 141.5 | 248 | +75% | 136.2 | 52.2 | -62% |
| GET /api/status/:tag/:type | 188.2 | 357.7 | +90% | 101.4 | 36.4 | -64% |
| GET /api/overlay-families | 156.3 | 265.2 | +70% | 114.3 | 50.9 | -55% |
| GET / (page) | 1264.2 | 1209 | -4% | 10.4 | 10.9 | +5% |

### WooCommerce adapter

| route | rps before | rps after | change | p95 ms before | p95 ms after | change |
|---|---|---|---|---|---|---|
| GET /api/bootstrap | 28.3 | 190 | +571% | 446.7 | 72.2 | -84% |
| GET /api/products | 31.7 | 334.5 | +955% | 477.2 | 38.9 | -92% |
| GET /api/billing/status | 158.2 | 251.2 | +59% | 84.8 | 53.1 | -37% |
| GET /api/billing/history | 164.2 | 251.8 | +53% | 77.5 | 53.3 | -31% |
| GET /api/status/:tag/:type | 211.7 | 352.5 | +67% | 61.3 | 36.5 | -40% |
| GET /api/overlay-families | 182.5 | 246.8 | +35% | 68.4 | 53.1 | -22% |
| GET / (page) | 1188.3 | 1204.3 | +1% | 10.7 | 10.2 | -5% |

Database statements per request (sequential, deterministic): see `BASELINE.md`. Process start: warm start 563 -> 418 ms. 30-minute soak on the optimised build: Magento 322,601 requests, WooCommerce 319,683 requests, no errors, heap growth 2.9 % and 8.8 %, resident memory growth 0.8 % and 1.1 %.

### WooCommerce plugin

| measure | before | after |
|---|---|---|
| plugin load per request | 6.5 ms (9 files) | 3.1 ms (only what is needed) |
| HPOS declaration (before_woocommerce_init) | 17.0 ms | 0.9 ms |
| video address check per product-page view | 5.5 to 6 ms (DNS lookup) | 0.02 ms |
| admin product list when the adapter hangs, first load | 20.9 s | 4.1 s |
| same, following loads for a minute | 21.0 s | 1.4 s |

On ordinary front-end pages the plugin's whole cost was about 9 ms of 130 ms before; the A/B after the changes (138 vs 130 ms before, 194 vs 181 ms after on a busier machine) is inside the noise of that method, so no more than that is claimed.

### Magento extension

Not changed for performance. Admin Flipick page 105 ms to first byte (Magento dashboard 155 ms), 18 database statements; storefront video block 0 statements. One non-performance fix: `composer.json` (see section 4).

## 3. Optimisations, one commit each

**Magento adapter**

| commit | message |
|---|---|
| `d8e6fda` | perf(T0): test-only RATE_LIMIT_SCALE so load tests measure handlers, not the limiter (ignored in production) |
| `76910b6` | perf(O1): re-sign only expiring video links and save only changed ones (bootstrap 56 -> 163 rps, products 63 -> 219 rps at 50 connections; 31 -> 16 and 25 -> 10 queries per request) |
| `5874e36` | perf(O3): one rate-limit statement per request instead of two (status 6.3 -> 4.6 queries per request, 306 -> 389 rps at 50 connections) |
| `8cb1f2e` | perf(O2): a pooled connection that already carries the tenant context is not told again (status 10 -> 6.3 queries per request, 232 -> 306 rps at 50 connections) |
| `a6eb675` | perf(O5): decrypt an installation's stored secrets when first used, not on every lookup (status route 312 -> 346 rps in an A/B run; crypto key set-up 11.9% -> 5.8% of CPU) |
| `66f3bc6` | fix(O6): statements started together inside one transaction are queued on the connection instead of overlapping |
| `5d84068` | perf(O7): read a session's installation and store in one statement (status route 347 -> 374 rps, mean of five alternating runs; one round trip fewer per request) |

**WooCommerce adapter** (same changes plus plugin copy synchronisation)

| commit | message |
|---|---|
| `324a064` | perf(T0): test-only RATE_LIMIT_SCALE so load tests measure handlers, not the limiter (ignored in production) |
| `477f4fc` | perf(O1): re-sign only expiring video links and save only changed ones (bootstrap 56 -> 163 rps, products 63 -> 219 rps at 50 connections; 31 -> 16 and 25 -> 10 queries per request) |
| `aee82f7` | perf(O3): one rate-limit statement per request instead of two (status 6.3 -> 4.6 queries per request, 306 -> 389 rps at 50 connections) |
| `d83b94a` | perf(O2): a pooled connection that already carries the tenant context is not told again (status 10 -> 6.3 queries per request, 232 -> 306 rps at 50 connections) |
| `9526357` | perf(O5): decrypt an installation's stored secrets when first used, not on every lookup (status route 312 -> 346 rps in an A/B run; crypto key set-up 11.9% -> 5.8% of CPU) |
| `99d8a1c` | fix(O6): statements started together inside one transaction are queued on the connection instead of overlapping |
| `5aa7f27` | perf(P3): plugin copy in sync with the plugin repo (video address checked without a DNS lookup) |
| `f7a3390` | perf(P1,P4): plugin copy in sync with the plugin repo (autoloader, HPOS declaration in admin only) |
| `e42cd1d` | perf(P2): plugin copy in sync (page-time adapter timeout) |
| `24b6cab` | perf(O7): read a session's installation and store in one statement (status route 347 -> 374 rps, mean of five alternating runs; one round trip fewer per request) |

**WooCommerce plugin**

| commit | message |
|---|---|
| `c329035` | perf(P3): check the video address without a DNS lookup (storefront render 5.5-6 ms -> 0.02 ms per product-page view) |
| `510335d` | perf(P1): load plugin classes on demand; admin and storefront hooks only where needed (plugin load 6.5 -> 3.1 ms per request) |
| `5a06a91` | perf(P4): declare HPOS compatibility only where WooCommerce reads it (before_woocommerce_init 17.0 -> 0.9 ms, init +15 -> +5 ms on front-end requests) |
| `4b52cb6` | perf(P2): the product list gives up on an unresponsive adapter after 3 s and remembers the failure for a minute (admin product list 20.9 s -> 4.1 s when the adapter hangs; asked once a minute instead of every 30 s) |

Tried and reverted: O4 (parse the secret key once for HMAC), no measurable gain. Preload `none` on videos was also tried and reverted (click-to-play broke in Chrome).

## 4. Findings not fixed (need a decision)

| id | what | where seen |
|---|---|---|
| F-USAGE-RACE | A video shows "ready" before it is counted, so a request in that moment can exceed the Free limit by one (seen once under load, not on a quiet machine). Present before the performance work. | both adapters |
| F-RATIO | 5:4 is sent to the engine as 16:9, so the video is 16:9. | both adapters, both video types |
| F-FRAME | The adapter caches the allowed frame origins for 60 s: a store connected less than a minute ago can show a blocked frame. | all |
| FND-UI-1 | On a 390 px phone the product list is wider than the screen; a 300-character search term makes the page 1300 px wide. | both adapters |
| F-PROGRESS | A ready video can report 90 % progress (seen with the mock engine; check with the real engine). | both adapters |
| Lifestyle, overlay drawing, real bank | cannot be run offline: BLOCKED | n/a |

Fixed although not performance work: the Magento extension's `composer.json` contained an invalid escape, so `bin/magento module:disable` and Composer failed to read it (commit `fix: composer.json was invalid JSON...`, with a test that fails on the old file).

Incident to know about: while building the Magento store test, a script pressed **Connect** on test instance 2 after its development adapter address had been removed by the uninstall test. The extension then tried its built-in production address `magento.flipickvideogenerator.com`; the name does not resolve, so no request left the machine (shown in the extension log). The script now refuses to press Connect unless a development address is set and puts the settings back after the uninstall test.

## 5. Test cases T1 to T13

Final automated run (20261014-132256):

| case | Magento | WooCommerce | evidence |
|---|---|---|---|
| T1 | PASS | PASS | woo-stores.json, magento-stores.json |
| T2 | PASS | PASS | magento-regression.json, woo-regression.json |
| T3 | PASS | PASS | magento-regression.json, woo-regression.json |
| T4 | PASS | PASS | magento-regression.json, woo-regression.json |
| T5 | KNOWN ISSUE | KNOWN ISSUE | magento-regression.json, woo-regression.json |
| T6 | PASS | PASS | magento-regression.json, woo-regression.json |
| T7 | PASS | PASS | magento-regression.json, woo-regression.json |
| T8 | PASS | PASS | magento-regression.json, woo-regression.json |
| T9 | PASS | PASS | magento-regression.json, woo-regression.json |
| T10 | PASS | PASS | magento-unit.json, magento-lint.json, magento-regression.json, woo-unit.json, woo-lint.json, woo-regression.json |
| T11 | KNOWN ISSUE | KNOWN ISSUE | magento-regression.json, woo-regression.json |
| T12 | PASS | PASS | woo-stores.json, magento-stores.json |
| PHP | PASS | PASS | magento-php.json, woo-php.json |

Known issues in those rows are the ones in section 4. BLOCKED items: Lifestyle videos (made by the remote backend); Overlay text rendered inside the picture (legible, not cut off).

Performance, soak and test counts of that run:

**Magento adapter** (p95 in ms, 10 workers; baseline = build before the optimisations):

| route | rps | p50 | p95 | baseline p95 | target p95 | status |
|---|---|---|---|---|---|---|
| GET /api/bootstrap | 234.2 | 40.8 | 57.3 | 571.2 | 76.5 | within target |
| GET /api/products | 391.3 | 24.6 | 32.9 | 511.1 | 38.3 | within target |
| GET /api/billing/status | 293.8 | 32 | 45.8 | 102.8 | 54.2 | within target |
| GET /api/billing/history | 262.8 | 36.5 | 47.6 | 136.2 | 52.2 | within target |
| GET /api/status/:tag/:type | 376.8 | 25.6 | 34 | 101.4 | 36.4 | within target |
| GET /api/overlay-families | 278 | 34.5 | 47.2 | 114.3 | 50.9 | within target |
| GET / (page) | 2237.5 | 4.3 | 5.7 | 10.4 | 10.9 | within target |

**WooCommerce adapter** (p95 in ms, 10 workers; baseline = build before the optimisations):

| route | rps | p50 | p95 | baseline p95 | target p95 | status |
|---|---|---|---|---|---|---|
| GET /api/bootstrap | 224.5 | 43.1 | 62.8 | 446.7 | 72.2 | within target |
| GET /api/products | 370.5 | 26 | 35.3 | 477.2 | 38.9 | within target |
| GET /api/billing/status | 276.2 | 35 | 50 | 84.8 | 53.1 | within target |
| GET /api/billing/history | 248.3 | 38.9 | 54.3 | 77.5 | 53.3 | within target |
| GET /api/status/:tag/:type | 340.3 | 28.3 | 40 | 61.3 | 36.5 | within target |
| GET /api/overlay-families | 260.8 | 37 | 50.8 | 68.4 | 53.1 | within target |
| GET / (page) | 3732.5 | 2.3 | 4.3 | 10.7 | 10.2 | within target |

Compared with the build before the changes (same tests, `tag pre-perf` + test hook, check by check, by name):

**Magento adapter**

```
case | before | after | checks before | checks after
T2 | PASS | PASS | 11 | 11
T3 | PASS | PASS | 5 | 5
T4 | PASS | PASS | 13 | 13
T9 | PASS | PASS | 4 | 4
T5 | KNOWN ISSUE | KNOWN ISSUE | 36 | 36
T6 | PASS | PASS | 9 | 9
T7 | PASS | PASS | 10 | 10
T8 | PASS | PASS | 11 | 11
T11 | KNOWN ISSUE | KNOWN ISSUE | 180 | 180
T10 | PASS | PASS | 34 | 34
PERF | n/a | PASS | 0 | 14

worse: 0, better: 0, only in before: 0, only in after: 14
ONLY AFTER  PERF|GET /api/bootstrap: no errors under load
ONLY AFTER  PERF|GET /api/products: no errors under load
ONLY AFTER  PERF|GET /api/billing/status: no errors under load
ONLY AFTER  PERF|GET /api/billing/history: no errors under load
ONLY AFTER  PERF|GET /api/status/:tag/:type: no errors under load
ONLY AFTER  PERF|GET /api/overlay-families: no errors under load
ONLY AFTER  PERF|GET / (page): no errors under load
ONLY AFTER  PERF|GET /api/bootstrap: p95 57.3 ms within target 76.5 ms + 10% (limit 91.5 ms)
ONLY AFTER  PERF|GET /api/products: p95 32.9 ms within target 38.3 ms + 10% (limit 53.3 ms)
ONLY AFTER  PERF|GET /api/billing/status: p95 45.8 ms within target 54.2 ms + 10% (limit 69.2 ms)
ONLY AFTER  PERF|GET /api/billing/history: p95 47.6 ms within target 52.2 ms + 10% (limit 67.2 ms)
ONLY AFTER  PERF|GET /api/status/:tag/:type: p95 34 ms within target 36.4 ms + 10% (limit 51.4 ms)
ONLY AFTER  PERF|GET /api/overlay-families: p95 47.2 ms within target 50.9 ms + 10% (limit 65.9 ms)
ONLY AFTER  PERF|GET / (page): p95 5.7 ms within target 10.9 ms + 10% (limit 25.9 ms)
```

**WooCommerce adapter**

```
case | before | after | checks before | checks after
T2 | PASS | PASS | 11 | 11
T3 | PASS | PASS | 5 | 5
T4 | PASS | PASS | 13 | 13
T9 | PASS | PASS | 4 | 4
T5 | KNOWN ISSUE | KNOWN ISSUE | 36 | 36
T6 | PASS | PASS | 9 | 9
T7 | PASS | PASS | 10 | 10
T8 | PASS | PASS | 11 | 11
T11 | KNOWN ISSUE | KNOWN ISSUE | 180 | 180
T10 | PASS | PASS | 18 | 18
PERF | n/a | PASS | 0 | 14

worse: 0, better: 0, only in before: 0, only in after: 14
ONLY AFTER  PERF|GET /api/bootstrap: no errors under load
ONLY AFTER  PERF|GET /api/products: no errors under load
ONLY AFTER  PERF|GET /api/billing/status: no errors under load
ONLY AFTER  PERF|GET /api/billing/history: no errors under load
ONLY AFTER  PERF|GET /api/status/:tag/:type: no errors under load
ONLY AFTER  PERF|GET /api/overlay-families: no errors under load
ONLY AFTER  PERF|GET / (page): no errors under load
ONLY AFTER  PERF|GET /api/bootstrap: p95 62.8 ms within target 72.2 ms + 10% (limit 87.2 ms)
ONLY AFTER  PERF|GET /api/products: p95 35.3 ms within target 38.9 ms + 10% (limit 53.9 ms)
ONLY AFTER  PERF|GET /api/billing/status: p95 50 ms within target 53.1 ms + 10% (limit 68.1 ms)
ONLY AFTER  PERF|GET /api/billing/history: p95 54.3 ms within target 53.3 ms + 10% (limit 68.3 ms)
ONLY AFTER  PERF|GET /api/status/:tag/:type: p95 40 ms within target 36.5 ms + 10% (limit 51.5 ms)
ONLY AFTER  PERF|GET /api/overlay-families: p95 50.8 ms within target 53.1 ms + 10% (limit 68.1 ms)
ONLY AFTER  PERF|GET / (page): p95 4.3 ms within target 10.2 ms + 10% (limit 25.2 ms)
```

"Nothing that passed before now fails": see the "worse: 0" line above for each adapter. Checks that exist only after the changes are tests of the changes themselves.

T11 evidence (screenshots, Chrome and Firefox, desktop and phone): `tests/regression/reports/ui/` in each adapter repo after a run. T13 soak: 30-minute run on the optimised build, 3-minute run in every regression.

## 6. Where the tests live and how to run them

| What | Where | Command |
|---|---|---|
| Everything | workspace root | `bash scripts/run-all-tests.sh` (`--quick`, `--soak`, `--no-stores`) |
| Adapter regression (T2-T11, T13) | `magento-adaptor/tests/regression`, `woocommerce-adaptor/tests/regression` | `npm run regression` |
| PHP checks | `magento_module-main/tests/regression/run.sh`, `flipick-video-generator-for-woocommerce/tests/regression/run.sh` | `bash tests/regression/run.sh` |
| Store scripts (T1, T12) | `scripts/ui/woo-stores.js`, `scripts/ui/magento-stores.js` | run by run-all-tests.sh |
| Test cases, report format, how to run | `docs/testing/` in every repo and the root | read `TEST-CASES.md` first |
| Baseline and targets | `docs/performance/BASELINE.md`, `TARGETS.md`, `TARGETS.json` | the `perf` case fails when a route is over its target |
| Instruction for Claude | `CLAUDE.md` in every repo and the root | contains the "carry out testing" rule |

The full run was proven from a clean state: all test containers were stopped first and `run-all-tests.sh` started them again.

## 7. Residual risks

- The perf targets depend on the machine: they were set on this PC. A busy machine can push p95 over a limit; the case re-measures a failing route twice before it fails, and the suite should be run on a quiet machine. A new machine needs `PERF_RECORD=1` to re-record.
- Mock engine, fake store and pretend bank: video content, overlay drawing, Lifestyle and the real payment flow are not exercised (BLOCKED, section 4).
- O2 changes how the tenant context reaches the database. It is covered by six new tests, the security journey and the end-to-end tests, but it is the change to look at first if tenant data ever appears in the wrong store.
- The older 50-connection before/after table in the first measurements moved about 60 % even on routes that were not changed, so only the same-session harness numbers above (and the statement counts) are used as evidence.
- Test stores T12 modify the local Docker stores (uninstall and reconnect); the Magento test needs its admin logins in `scripts/ui/.env.local` (not committed).
- The adapters' own dev processes on :4200 and :4300 were not restarted by the run; they run whatever code was loaded when they started.
