# Project Standing Rules

## Projects in scope
1. Magento extension
2. Magento adaptor (Node.js)
3. WooCommerce plugin (PHP)
4. WooCommerce adaptor (Node.js)

These rules apply to EVERY task in ALL four projects, without being re-asked.

## 1. Preserve existing work
- Do not modify, rename, reformat, or delete existing working code unless the
  task requires it. Add new code alongside it.
- Before editing, read the surrounding code and follow its existing patterns,
  naming, and folder structure.
- Make minimal, additive diffs. No drive-by refactors. If you see an existing
  problem outside the task, report it at the end instead of fixing it silently.
- Never break backward compatibility (DB schema, API contracts, hooks/events,
  config keys) without calling it out and providing a migration.

## 2. Priority order for every change
1. Security  2. Correctness  3. Performance/optimization  4. UX  5. Maintainability
Security and performance work is done WHILE writing the feature, not afterwards.

## 3. Security hardening (always)
General:
- Validate all input on the server (type, length, format, allow-list). Never
  trust client data, iframe messages, query params, or webhook payloads.
- Escape all output for its context. Use parameterized queries only.
- No secrets in code, logs, or the repo. Use environment variables.
- Least privilege; deny by default. Log security events without logging PII or
  secrets.
- Rate limit and abuse-protect every public or costly endpoint (especially
  video generation).
- Pin dependencies, run `npm audit` / `composer audit`, and avoid new
  dependencies unless justified.

WordPress/WooCommerce plugin:
- Prefix all functions, classes, hooks, options. Block direct file access.
- Nonces + capability checks on every action and AJAX/REST handler.
- Sanitize on input (`sanitize_*`), escape on output (`esc_*`), use
  `$wpdb->prepare`. REST routes need a real `permission_callback`.
- Follow WordPress Coding Standards; run PHPCS and the Plugin Check tool.
- No remotely loaded executable code, no obfuscation, GPL-compatible only.

Magento extension:
- Use Magento 2 standards: dependency injection, service contracts, plugins/
  observers (no `ObjectManager` direct use, no core overrides), ACL resources,
  CSRF form keys, `escapeHtml`/`escapeUrl`, declarative schema.
- Run PHPCS (Magento2 standard) and static content/DI compile checks.

Node.js adaptors:
- Use helmet, strict CORS allow-list, CSP with correct `frame-ancestors`
  (only verified store origins), HTTPS only, secure cookies
  (`HttpOnly; Secure; SameSite`), and token-based session handoff for iframes.
- Verify signed tokens/JWTs and webhook signatures (HMAC, timestamp, replay
  protection). Validate request bodies with a schema (zod/joi).
- Server-side entitlement and credit checks for every paid action. Never rely
  on the client for plan enforcement.
- Payment flows (ICICI): idempotency keys, verify gateway signatures server
  side, handle failure/renewal/cancel states, never store card data.

## 4. Optimization (always)
- Avoid N+1 queries; add indexes where queries need them; cache with proper
  invalidation; paginate large lists.
- Frontend: minimal JS/CSS, lazy-load below-the-fold assets, optimized images,
  no layout shift, no blocking scripts. Load assets only on the pages that
  need them (admin page only for the plugin screen).
- Async or queued processing for long jobs (video generation); set timeouts,
  retries with backoff, and clear status/progress for the user.
- Target Core Web Vitals and Lighthouse >= 90 on the pages we control.

## 5. UI/UX standards
- Match the existing design system: reuse existing colors, fonts, spacing
  scale, border radius, shadows, and components. Do not invent new styles when
  one exists. Extract spacing/typography/color values from the existing page
  and reuse them via CSS variables/tokens.
- Responsive (360px, 768px, 1280px, 1920px), accessible (WCAG 2.1 AA: contrast,
  focus states, labels, keyboard navigation, ARIA where needed).
- Every interactive view needs loading, empty, error, and success states with
  clear human-readable messages.
- Respect WP admin / Magento admin look inside the plugin shell, and the
  adaptor's own design inside the iframe.

## 6. Verification with Playwright (required before declaring done)
- Install if missing: `npm i -D @playwright/test` then
  `npx playwright install --with-deps chromium` (add firefox/webkit for
  cross-browser when relevant).
- For every UI-affecting task: write/extend Playwright tests that cover the
  main flow, error states, and the iframe handoff; run at the viewports above;
  capture screenshots and compare against the reference page for spacing,
  alignment, typography, and colors.
- Check console errors, failed network requests, broken links, keyboard
  navigation, and basic accessibility (e.g. `@axe-core/playwright`).
- Fix every issue found, re-run, and iterate until the suite is green.
- Also run existing unit/integration tests, linters, and type checks. Do not
  mark anything done with failing tests.

## 7. Definition of done / final report
End every task with:
1. Files changed/added (and confirmation existing code was preserved).
2. Security hardening applied and any residual risks.
3. Optimizations applied, with before/after numbers where measured.
4. Playwright results and screenshots; tests added.
5. Existing issues noticed but intentionally not touched.
6. Anything I need to decide or configure (env vars, keys, migrations).

## 8. Working agreements
- If requirements are ambiguous, state your assumption and proceed, unless the
  ambiguity risks data loss or security, in which case ask first.
- Never invent API behavior, gateway fields, or Magento/WP functions. Check the
  docs or the code; say "unverified" when you cannot confirm.
- Commit in small, logical commits with clear messages (if git is in use).

---

## Agents that do the repetitive parts (user-level, in `C:\Users\<you>\.claude\agents\`)

| Agent | Use it for | Edits code? |
|---|---|---|
| `security-reviewer` | rules 3 (all projects): review of a diff or repo, audits, security test cases | no |
| `wp-plugin-compliance` | WordPress.org readiness: build zip, Plugin Check, smoke test, guideline checklist | no |
| `magento-standards-checker` | Magento 2 standards for the extension (DI, ACL, CSRF, escaping, compat) | no |
| `playwright-verifier` | rule 6: UI flows, viewports, console, a11y, screenshots | tests only |
| `regression-runner` | "carry out testing / run the tests / run regression": the full cycle and report | no |
| `perf-auditor` | rule 4: measure against baseline and targets, propose one optimisation at a time | only when asked |

Suggested order for a task: write the change (main session) -> `security-reviewer` (and `magento-standards-checker` or `wp-plugin-compliance` for the PHP repos) -> `playwright-verifier` if the UI changed -> `perf-auditor` if a hot path changed -> `regression-runner` before committing. Then give the final report of section 7.
