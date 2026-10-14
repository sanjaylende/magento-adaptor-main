// Small load generator (no packages): N concurrent workers hit one route for a fixed time and report latency percentiles and errors.
const { performance } = require('perf_hooks');
async function hit(url, headers, seconds, concurrency) {
  const lat = []; let errors = 0, non2xx = 0;
  const end = Date.now() + seconds * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const t = performance.now();
      try { const r = await fetch(url, { headers }); await r.arrayBuffer(); if (r.status >= 400) non2xx++; } catch { errors++; }
      lat.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
  return { requests: lat.length, rps: +(lat.length / seconds).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), errors, non2xx };
}
module.exports = { hit };
