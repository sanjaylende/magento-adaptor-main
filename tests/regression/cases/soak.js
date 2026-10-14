// T13 load and soak: steady mixed traffic for SOAK_MINUTES (default 2; the full acceptance run uses 30), sampled every SOAK_WINDOW seconds
// (default 30): throughput, latency, memory and event-loop delay of the adapter process. Passes when there is not one error or non-2xx answer and
// memory does not keep growing (heap and resident memory, last third against the first third after warm-up, below 15 %).
// The adapter runs with the rate limits scaled up and with the test-only metrics address (port + 90), both for this case only.
const { performance } = require('perf_hooks');
const MIN = Number(process.env.SOAK_MINUTES || 2), WINDOW = Number(process.env.SOAK_WINDOW || 30), CONC = Number(process.env.SOAK_CONCURRENCY || 10);

module.exports = async function soak({ stack, run, connectStore }) {
  run.section('T13', `Load and soak: ${MIN} minute(s), ${CONC} workers, mixed routes`);
  const c = await connectStore(stack, { name: 'Soak' });
  const tag = encodeURIComponent((await c.get('/api/products')).body.products[0].uniqueTag);
  const mix = [['/api/bootstrap', 1], ['/api/products', 1], ['/api/billing/status', 1], ['/api/billing/history', 1], [`/api/status/${tag}/hero_product`, 1], ['/api/overlay-families', 1], ['/', 0], ['/static/js/app.js', 0]];
  const metrics = async (reset) => (await fetch(`http://127.0.0.1:${stack.port + 90}/metrics${reset ? '?reset=1' : ''}`)).json();
  await metrics(true);
  const samples = []; let errors = 0, non2xx = 0, total = 0, n = 0;
  const t0 = Date.now(), end = t0 + MIN * 60000;
  while (Date.now() < end) {
    const windowEnd = Math.min(end, Date.now() + WINDOW * 1000), lat = [];
    let werr = 0, w2xx = 0;
    const worker = async () => {
      while (Date.now() < windowEnd) {
        const [p, auth] = mix[n++ % mix.length]; const t = performance.now();
        try { const r = await fetch(stack.base + p, { headers: auth ? c.auth : {} }); await r.arrayBuffer(); if (r.status >= 400) w2xx++; } catch { werr++; }
        lat.push(performance.now() - t);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    lat.sort((a, b) => a - b);
    const m = await metrics(true);
    errors += werr; non2xx += w2xx; total += lat.length;
    samples.push({ minute: +((Date.now() - t0) / 60000).toFixed(1), rps: Math.round(lat.length / WINDOW), p50: +lat[Math.floor(lat.length / 2)].toFixed(1), p99: +lat[Math.floor(lat.length * 0.99)].toFixed(1), rssMB: m.memoryMB.rss, heapMB: m.memoryMB.heapUsed, loopP99: m.eventLoopMs.p99 });
    const s = samples[samples.length - 1];
    console.log(`  soak min ${s.minute}: ${s.rps} rps, p50 ${s.p50} ms, p99 ${s.p99} ms, rss ${s.rssMB} MB, heap ${s.heapMB} MB, loop p99 ${s.loopP99} ms`);
  }
  run.check(`no errors and no failed answers in ${total} requests`, errors === 0 && non2xx === 0, `${errors} errors, ${non2xx} non-2xx`);
  const avg = (a, k) => a.reduce((x, r) => x + r[k], 0) / a.length;
  if (samples.length >= 6) {
    const third = Math.floor(samples.length / 3), early = samples.slice(1, 1 + third), late = samples.slice(-third);
    const heap = 100 * (avg(late, 'heapMB') - avg(early, 'heapMB')) / avg(early, 'heapMB'), rss = 100 * (avg(late, 'rssMB') - avg(early, 'rssMB')) / avg(early, 'rssMB');
    run.check('heap does not keep growing (< 15 % between the first and last third)', heap < 15, `${heap.toFixed(1)} %`);
    run.check('resident memory does not keep growing (< 15 %)', rss < 15, `${rss.toFixed(1)} %`);
  } else run.blocked('memory growth over time', `needs at least 6 samples (${samples.length} taken); run with SOAK_MINUTES=3 or more`);
  run.table('Soak samples', ['minute', 'rps', 'p50 ms', 'p99 ms', 'rss MB', 'heap MB', 'loop p99 ms'], samples.map((s) => [s.minute, s.rps, s.p50, s.p99, s.rssMB, s.heapMB, s.loopP99]));
};
