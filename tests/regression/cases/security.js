// T10 security regression: runs the repo's own live security journey (test-journeys/security-live.js) against the regression adapter and
// turns every PASS/FAIL line into a check. Its fake store listens on 127.0.0.1:45124 (Magento) / :45224 (WooCommerce): nothing else may use that port.
const { spawnSync } = require('child_process');
const path = require('path');

module.exports = async function security({ stack, run }) {
  run.section('T10', 'Security regression (live journey against the running adapter)');
  const script = path.join(stack.repo, 'test-journeys', 'security-live.js');
  const r = spawnSync(process.execPath, [script, stack.base], { cwd: stack.repo, encoding: 'utf8', timeout: 240000, env: { ...process.env, QA_DB: `${stack.platform}_regression`, QA_DB_ADMIN_URL: stack.ownerUrl, QA_DB_SCHEMA: stack.schema, MSYS_NO_PATHCONV: '1' } });
  const lines = String(r.stdout || '').split(/\r?\n/);
  let n = 0;
  for (const l of lines) {
    const m = /^(PASS|FAIL)\s+(.*)$/.exec(l);
    if (!m) continue;
    n++;
    run.check(m[2].replace(/\s+\[.*\]$/, ''), m[1] === 'PASS', (/\[(.*)\]$/.exec(m[2]) || [])[1] || '');
  }
  run.check('the journey ran to the end and reported checks', n >= 15 && r.status !== 2 && r.status !== null, `${n} checks, exit ${r.status}${r.stderr ? ' ' + String(r.stderr).slice(-120) : ''}`);
};
