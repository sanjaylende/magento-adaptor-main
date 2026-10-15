# Magento adapter (Node.js, Express 5, PostgreSQL)

The service behind the Magento extension: multi-tenant (row-level security), billing and ICICI gateway, video generation through the Flipick engine, the merchant app and the staff console.
Commands: `npm test` (unit and end-to-end), `npm run lint`, `npm run regression` (automated regression suite: cases subscriptions, video, security, perf, ui), `npm run regression:soak`.

## Testing
When the user says 'carry out testing', 'run the tests' or 'run regression', do NOT ask what to test. Read docs/testing/TEST-CASES.md, start the test instances, run scripts/run-all-tests.sh, run the manual checklist items, compare with docs/performance/BASELINE.md, and give the report in the format in docs/testing/REPORT-FORMAT.md. When code changes add or change a feature, add or update its test case first.

- `docs/testing/TEST-CASES.md` what is tested and how; `docs/testing/REPORT-FORMAT.md` how to report; `docs/testing/HOW-TO-RUN.md` prerequisites and commands.
- `docs/performance/BASELINE.md`, `TARGETS.md` (+ `TARGETS.json`), `AUDIT.md`, `PERF-REPORT.md` performance numbers, targets and findings.
- Regression suite: `tests/regression/` (one command: `npm run regression`; reports in `tests/regression/reports/`).

`scripts/run-all-tests.sh` exists in this repo as a wrapper that runs the workspace-root script `D:\Flipick-Video-Genertor\scripts\run-all-tests.sh` (all four components). `docs/testing` and `docs/performance` are in this repo (and combined in the workspace root).

`scripts/run-all-tests.sh` exists in this repo as a wrapper that runs the workspace-root script `D:\Flipick-Video-Genertor\scripts\run-all-tests.sh` (all four components). `docs/testing` and `docs/performance` are in this repo (and combined in the workspace root).

`scripts/run-all-tests.sh` exists in this repo as a wrapper that runs the workspace-root script `D:\Flipick-Video-Genertor\scripts\run-all-tests.sh` (all four components). `docs/testing` and `docs/performance` are in this repo (and combined in the workspace root).

`scripts/run-all-tests.sh` exists in this repo as a wrapper that runs the workspace-root script `D:\Flipick-Video-Genertor\scripts\run-all-tests.sh` (all four components). `docs/testing` and `docs/performance` are in this repo (and combined in the workspace root).

`scripts/run-all-tests.sh` exists in this repo as a wrapper that runs the workspace-root script `D:\Flipick-Video-Genertor\scripts\run-all-tests.sh` (all four components). `docs/testing` and `docs/performance` are in this repo (and combined in the workspace root).

## Rules that always apply
- Test only on the local Docker instances and the throwaway test databases. Never touch production, never push to GitHub, no paid services, never print or store real secrets (use environment variable names only).
- Do not change public routes, response shapes, webhooks, plan or pricing logic, and never weaken validation, rate limits, headers or signature checks to make something faster or to make a test pass.
- Say "tested" or "faster" only for something that was run and measured; when something cannot be run here, report it as BLOCKED with the reason.
- If a change could alter behaviour merchants rely on, stop and ask before making it.

## Standing rules and agents
The standing rules for all four projects are in `docs/STANDING-RULES.md` (copy in the workspace root: `STANDING-RULES.md`). Read them before any change and end every task with the report of its section 7. Use the agents for the repetitive parts: `security-reviewer`, `wp-plugin-compliance`, `magento-standards-checker`, `playwright-verifier`, `regression-runner`, `perf-auditor` (user-level, `~/.claude/agents/`; the table at the end of the rules says when to use which).
