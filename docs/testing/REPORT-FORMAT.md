# Test report format

Give the report in this order, in the chat and saved as `docs/testing/reports/<date>-<short-commit>.md`. Plain language, short sentences, numbers from the run (never typed from memory).

## 1. Verdict (3 lines)
- One sentence: **PASS**, **PASS with known issues** or **FAIL**, and why.
- Build under test: repo, branch, short commit of each of the four components, date, machine.
- Totals: checks passed / failed / known issues / blocked, per component.

## 2. Suites run
A table, one row per suite: `suite | component | command | passed | failed | known | blocked | seconds`.
Suites: adapter unit/e2e (`npm test`), lint, regression cases (`subscriptions`, `video`, `security`, `perf`, `ui`, `soak`), PHP checks, store scripts, manual checklist.

## 3. Cases T1 to T13, per platform
A table `case | Magento | WooCommerce | evidence` using only PASS / FAIL / KNOWN ISSUE / BLOCKED; the evidence column is a file path (report, screenshot, log) or the case number in a report.
For every BLOCKED say why in one line.

## 4. Performance against the baseline
`route | baseline p95 (docs/performance/BASELINE.md) | now | target | status` for both adapters, plus soak result (requests, errors, heap growth, rss growth).
A route over its target is a FAIL even when every functional check passed.

## 5. Failures (only if any)
For each: case id, what was expected, what happened, evidence path, most likely cause, whether it passed in the previous run.

## 6. Known issues and blocked items
The known issues that are still present (id and one line) and everything Blocked with the reason and what would unblock it.

## 7. Compared with the previous run
Name the previous report. State "nothing that passed before fails now" only after comparing the two result files; otherwise list every check that changed.

## 8. Manual checklist
Each item M1..M6 of `docs/testing/TEST-CASES.md`: done / blocked, and what was seen.

## 9. How to repeat
The exact commands and the folder with the full reports.
