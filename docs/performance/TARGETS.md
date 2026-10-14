# Performance targets: Magento adapter

The regression suite (`npm run regression`, case `perf`) **fails** when a route is slower than its limit. Machine-readable version: `TARGETS.json`.

Rule: limit = max(target p95 x (1 + 10 %), target p95 + 15 ms). The 15 ms floor stops ordinary timing noise from failing a route that answers in 40 ms. Targets are the p95 measured on the optimised build (see `post-perf-measured.json`, 10 workers, same harness as `BASELINE.md`); the build before the optimisations fails 6 of the 7 (verified).

| route | target p95 ms | limit ms |
|---|---|---|
| GET /api/bootstrap | 76.5 | 91.5 |
| GET /api/products | 38.3 | 53.3 |
| GET /api/billing/status | 54.2 | 69.2 |
| GET /api/billing/history | 52.2 | 67.2 |
| GET /api/status/:tag/:type | 36.4 | 51.4 |
| GET /api/overlay-families | 50.9 | 65.9 |
| GET / (page) | 10.9 | 25.9 |

Other limits checked by the suite: no errors and no non-2xx answers under load; soak: heap and resident memory growth below 15 % and zero errors.

Changing a target: run `PERF_RECORD=1 npm run regression -- perf` on a quiet machine, look at the new numbers, edit `TARGETS.json` and write the reason in the commit message. Never raise a target just to make a failing run pass: first find out why it got slower.
