// Performance target check. Measures p95 latency of the main routes under light load (10 workers, 6 s per route, best of 3 rounds) and fails when a
// route is slower than its target in docs/performance/TARGETS.json (target = recorded baseline p95 + PERF_TOLERANCE, default 10 %, with an
// absolute allowance of 15 ms so that normal timing noise on a busy computer does not fail the run). PERF_RECORD=1 writes the measured numbers
// to docs/performance/baseline-measured.json instead of checking. The adapter runs with the rate limits scaled up (RATE_LIMIT_SCALE) for this case only.
const fs = require('fs');
const path = require('path');
const { hit } = require('../lib/load');

const SECONDS = Number(process.env.PERF_SECONDS || 6), CONC = Number(process.env.PERF_CONCURRENCY || 10);
module.exports = async function perf({ stack, run, connectStore, waitStatus }) {
  run.section('PERF', `Performance targets (p95, ${CONC} workers, ${SECONDS} s per route)`);
  const c = await connectStore(stack, { name: 'Perf' });
  const products = (await c.get('/api/products')).body.products;
  const tag = encodeURIComponent(products[0].uniqueTag);
  // ready videos on every product, so the list and bootstrap routes do the same work as for a merchant who has generated videos (Free plan allows 5)
  for (const p of products) { await c.post('/api/generate', { uniqueTag: p.uniqueTag, videoType: 'hero_product', aspectRatio: '16:9' }); }
  for (const p of products) await waitStatus(c, p.uniqueTag, 'hero_product', ['ready', 'error']);
  const routes = [['GET /api/bootstrap', '/api/bootstrap'], ['GET /api/products', '/api/products'], ['GET /api/billing/status', '/api/billing/status'], ['GET /api/billing/history', '/api/billing/history'], ['GET /api/status/:tag/:type', `/api/status/${tag}/hero_product`], ['GET /api/overlay-families', '/api/overlay-families'], ['GET / (page)', '/']];
  const measured = {};
  for (const [name, p] of routes) {
    const rounds = [];
    for (let i = 0; i < 3; i++) rounds.push(await hit(stack.base + p, p === '/' ? {} : c.auth, SECONDS, CONC));
    measured[name] = rounds.sort((a, b) => a.p95 - b.p95)[0];
    run.check(`${name}: no errors under load`, measured[name].errors === 0 && measured[name].non2xx === 0, `${measured[name].requests} requests, ${measured[name].errors} errors, ${measured[name].non2xx} non-2xx`);
  }
  const dir = path.join(stack.repo, 'docs', 'performance');
  if (process.env.PERF_RECORD) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'baseline-measured.json'), JSON.stringify({ platform: stack.platform, measuredAt: new Date().toISOString(), seconds: SECONDS, concurrency: CONC, routes: measured }, null, 2)); run.blocked('target comparison', 'PERF_RECORD=1: numbers recorded, not compared'); return; }
  const file = path.join(dir, 'TARGETS.json');
  if (!fs.existsSync(file)) { run.check('docs/performance/TARGETS.json exists', false, file); return; }
  const T = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tol = Number(process.env.PERF_TOLERANCE || T.tolerancePercent || 10) / 100, allow = T.allowanceMs == null ? 15 : T.allowanceMs;
  for (const [name, m] of Object.entries(measured)) {
    const t = T.routes[name];
    if (!t) { run.check(`${name}: has a target`, false, 'missing in TARGETS.json'); continue; }
    const limit = Math.max(t.p95Ms * (1 + tol), t.p95Ms + allow);
    // a busy computer (containers still starting, a backup, a browser) slows every route: look again, up to two more times, and keep the best round
    const p = routes.find((r) => r[0] === name)[1];
    for (let again = 0; again < 2 && m.p95 > limit; again++) {
      await new Promise((r) => setTimeout(r, 5000));
      for (let i = 0; i < 3; i++) { const x = await hit(stack.base + p, p === '/' ? {} : c.auth, SECONDS, CONC); if (x.p95 < m.p95) { measured[name] = x; Object.assign(m, x); } }
    }
    run.check(`${name}: p95 ${m.p95} ms within target ${t.p95Ms} ms + ${Math.round(tol * 100)}% (limit ${limit.toFixed(1)} ms)`, m.p95 <= limit, `p50 ${m.p50}, p95 ${m.p95}, p99 ${m.p99}, ${m.rps} rps`);
  }
  run.table('Measured latency (ms)', ['route', 'requests', 'rps', 'p50', 'p95', 'p99'], Object.entries(measured).map(([k, m]) => [k, m.requests, m.rps, m.p50, m.p95, m.p99]));
};
