// Test-only instrumentation loaded by qa-start.js (--metrics): counts SQL statements and their time, samples event-loop delay, and exposes
// everything on a control address (port + 90):  GET /metrics   (add ?reset=1 to zero the counters afterwards).
// It changes nothing in the adapter: it wraps the pg client from outside, in the test process only.
const path = require('path');
const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');

module.exports = function install(repoDir, port) {
  const pg = require(path.join(repoDir, 'node_modules', 'pg'));
  const state = { queries: 0, queryMs: 0, slowest: [] };
  const orig = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
    const t0 = process.hrtime.bigint();
    state.queries++;
    const done = () => { const ms = Number(process.hrtime.bigint() - t0) / 1e6; state.queryMs += ms; if (ms > 20) { state.slowest.push({ ms: Math.round(ms), sql: text.replace(/\s+/g, ' ').slice(0, 100) }); if (state.slowest.length > 50) state.slowest.shift(); } };
    const r = orig.apply(this, args);
    if (r && typeof r.then === 'function') r.then(done, done);
    return r;
  };
  const eld = monitorEventLoopDelay({ resolution: 10 }); eld.enable();
  let cpu0 = process.cpuUsage(); let t0 = Date.now();
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/shutdown') { res.writeHead(200); res.end('bye'); return setTimeout(() => process.exit(0), 50); } // lets --cpu-prof write its file
    if (u.pathname !== '/metrics') { res.writeHead(404); return res.end(); }
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(cpu0); const wall = (Date.now() - t0) * 1000;
    const out = {
      queries: state.queries, queryMs: Math.round(state.queryMs), slowest: state.slowest.slice(-10),
      eventLoopMs: { mean: +(eld.mean / 1e6).toFixed(2), p50: +(eld.percentile(50) / 1e6).toFixed(2), p99: +(eld.percentile(99) / 1e6).toFixed(2), max: +(eld.max / 1e6).toFixed(2) },
      memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576), external: Math.round(mem.external / 1048576) },
      cpuPercentSinceReset: +(100 * (cpu.user + cpu.system) / Math.max(wall, 1)).toFixed(1),
      uptimeSec: Math.round(process.uptime()),
    };
    if (u.searchParams.get('reset')) { state.queries = 0; state.queryMs = 0; state.slowest = []; eld.reset(); cpu0 = process.cpuUsage(); t0 = Date.now(); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  }).listen(Number(port) + 90, '127.0.0.1');
};
