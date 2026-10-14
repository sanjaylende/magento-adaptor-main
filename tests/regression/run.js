// The automated regression suite of ONE adapter repo.   npm run regression
//   node tests/regression/run.js [case,case,...]      cases: subscriptions, video, ui, security, sqli, perf, soak   (default: all but soak)
// It starts a throwaway database, a mock video engine, a fake store and the adapter itself (development mode, pretend bank), runs the cases, writes
// tests/regression/reports/<platform>-<cases>.{md,json} and exits 1 when any check failed. Nothing here reaches a real service.
// The cases run in up to three groups, each on its own freshly started adapter: the functional cases (real rate limits, so the security journey can
// prove them), perf (rate limits scaled up so that handlers, not the limiter, are measured) and soak (scaled, with the metrics address).
// Environment: REPO (adapter folder, default this repo), PLATFORM (magento|woo, default from package.json), REGRESSION_PORT, REPORT_DIR,
//              PERF_RECORD, PERF_SECONDS, SOAK_MINUTES, PLAYWRIGHT_DIR (names only; see docs/testing/HOW-TO-RUN.md).
const path = require('path');
const { start } = require('./lib/stack');
const { Run } = require('./lib/runner');
const { connectStore, waitStatus, sleep } = require('./lib/client');

const repo = path.resolve(process.env.REPO || path.join(__dirname, '..', '..'));
const platform = process.env.PLATFORM || (/woo/i.test(require(path.join(repo, 'package.json')).name) ? 'woo' : 'magento');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const only = (arg || 'subscriptions,video,ui,security,sqli,perf').split(',');
const reportDir = path.resolve(process.env.REPORT_DIR || path.join(__dirname, 'reports'));
const port = Number(process.env.REGRESSION_PORT || (platform === 'magento' ? 4290 : 4390));
const groups = [
  { cases: only.filter((c) => !['perf', 'soak', 'sqli'].includes(c)), options: {} },
  { cases: only.filter((c) => c === 'sqli'), options: { rateLimitScale: 1000 } }, // payloads must reach the handlers, not the rate limiter
  { cases: only.filter((c) => c === 'perf'), options: { rateLimitScale: 1000 } },
  { cases: only.filter((c) => c === 'soak'), options: { rateLimitScale: 1000, metrics: true } },
].filter((g) => g.cases.length);

(async () => {
  const run = new Run(`Regression: ${platform} adapter (${only.join(', ')})`);
  for (const group of groups) {
    const stack = await start({ repo, platform, port, ...group.options });
    try {
      for (const name of group.cases) {
        let c; try { c = require(path.join(__dirname, 'cases', name)); } catch (e) { run.section(name, 'missing'); run.check('case file exists', false, e.message); continue; }
        try { await c({ stack, run, connectStore, waitStatus, sleep, reportDir }); } catch (e) { run.section(name, 'crashed'); run.check('case ran to the end', false, e.stack.split('\n').slice(0, 3).join(' | ')); }
      }
    } finally { await stack.stop(); }
  }
  const s = run.save(reportDir, `${platform}-${only.join('+')}`);
  console.log(`\n${platform}: ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.known} known issues (${s.seconds}s)  report: ${path.join(reportDir, `${platform}-${only.join('+')}.md`)}`);
  process.exit(s.failed ? 1 : 0);
})().catch((e) => { console.error('RUNNER FAILED', e.stack); process.exit(2); });
