# How to run the tests

## Prerequisites
| Need | Used for | Check |
|---|---|---|
| Docker Desktop, running | adapter PostgreSQL (the Magento and WooCommerce adapters and their tests use the shared PostgreSQL service on 127.0.0.1:5432, where the tests create and drop a scratch database; set `TEST_DATABASE_SUPERUSER_URL` in the git-ignored `.env.test` if the administrator is not postgres/postgres), the WordPress and Magento test stores, PHP checks | `docker ps` |
| Node.js 22 or newer (24 is fine) | the adapters and the regression suite | `node -v` |
| PHP | not needed on the host: PHP checks run inside the store containers | `docker exec woocommerce-local-wordpress-1 php -v` |
| ffmpeg and ffprobe on the PATH | the mock video engine renders real clips; the tests read colours and sizes from them | `ffmpeg -version` |
| Playwright (`playwright-core`), Chrome, Playwright's Firefox | case `ui` and the store scripts | `npx playwright install firefox`; set `PLAYWRIGHT_DIR` if it is not in `node_modules` |
| `npm install` in each adapter repo | dependencies | `npm ls` |

## Environment variable names (values are never written in files or reports)
| Name | Meaning | Default |
|---|---|---|
| `REPO` | adapter folder to test (use a `git worktree` of another commit to test an older build) | the repo the command runs in |
| `REGRESSION_PORT` | port of the adapter started by the suite | 4290 Magento, 4390 WooCommerce |
| `REPORT_DIR` | where reports are written | `tests/regression/reports` |
| `PERF_RECORD` | `1` records the measured latencies instead of comparing with the targets | off |
| `PERF_SECONDS`, `PERF_CONCURRENCY`, `PERF_TOLERANCE` | length of each route measurement, workers, allowed percent over target | 6, 10, 10 |
| `SOAK_MINUTES`, `SOAK_WINDOW` | soak length and sample window in seconds | 2, 30 (the acceptance run uses 30) |
| `PLAYWRIGHT_DIR` | folder that contains `node_modules/playwright-core` | looked up automatically |
| `CHROME_CHANNEL` | Playwright browser channel for Chrome | `chrome` |
| `WP_CONTAINER`, `MAGENTO_CONTAINER` | PHP container names for the PHP checks | `woocommerce-local-wordpress-1`, `magento-php-1` |
| `M1_ADMIN_USER`, `M1_ADMIN_PASS`, `M2_ADMIN_USER`, `M2_ADMIN_PASS` | Magento admin logins of the two test instances (store script) | none: the script is skipped as BLOCKED when unset |

WordPress admin logins are read from `woocommerce-adaptor/infra/woocommerce/.env` and `.env2` (not printed).

## One command per repo
| Repo | Command |
|---|---|
| Magento adapter | `cd magento-adaptor && npm run regression` (all but soak), `npm run regression -- video`, `npm run regression:soak` |
| WooCommerce adapter | `cd woocommerce-adaptor && npm run regression` |
| Magento extension | `cd magento_module-main && bash tests/regression/run.sh` |
| WooCommerce plugin | `cd flipick-video-generator-for-woocommerce && bash tests/regression/run.sh` |
| Everything | `bash scripts/run-all-tests.sh` (from the workspace root `Flipick-Video-Genertor`) |

`scripts/run-all-tests.sh` starts the Docker instances that are not running, runs `npm test`, `npm run lint`, both adapters' regression suites, both PHP suites, the store scripts
(unless `--no-stores`), and writes one report to `docs/testing/reports/`. Options: `--soak` (30 minutes), `--quick` (skip ui and perf), `--no-stores`.

## Where things are written
- `tests/regression/reports/<platform>-<cases>.md|json` and `tests/regression/reports/ui/*.png` in each adapter repo (not committed).
- `docs/testing/reports/` in the workspace root: the combined report of a full run.

## Safe by construction
The suite starts its own adapter on a throwaway database (`magento_regression`, `woo_regression`, dropped and recreated every run), a mock video engine and a fake store; the "bank" is the in-repo
`test/fakeIcici.js`. Nothing contacts a real payment gateway, a real video engine, production or GitHub.
