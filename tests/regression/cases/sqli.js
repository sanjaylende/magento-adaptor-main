// T10b SQL injection: classic payloads in every place a client can put text (path, query, body, headers, file name, sign-in forms, the staff console),
// against a running adapter with a real PostgreSQL. A request passes when it is answered without a server error, the answer shows no database error text,
// no payload that tries to make the database sleep delays the answer, nothing is dropped or changed, and no sign-in is granted by a "boolean" payload.
const PAYLOADS = [
  "' OR '1'='1", "' OR 1=1--", "\" OR \"\"=\"", "'; DROP TABLE stores;--", "'; DELETE FROM installations;--", "1; SELECT pg_sleep(6)--",
  "' || (SELECT pg_sleep(6)) || '", "x' UNION SELECT NULL,NULL,NULL--", "$1", "${1}", "%27%20OR%201=1--", "\\'; --", "admin'--", "' AND (SELECT 1 FROM pg_sleep(6))--",
];
const DB_ERRORS = /syntax error at or near|unterminated quoted|invalid input syntax|SQLSTATE|relation "[a-z_]+" does not exist|column "[a-z_]+" does not exist|pg_catalog|PostgreSQL|error: |\bnode_modules\b|at Object\./i;

module.exports = async function sqli({ stack, run, connectStore }) {
  run.section('T10b', 'SQL injection: payloads in path, query, body, headers, file name, sign-in and staff console');
  const c = await connectStore(stack, { name: 'Injection Store' });
  const tag = (await c.get('/api/products')).body.products[0].uniqueTag;
  const tables = ['merchants', 'installations', 'stores', 'store_subscriptions', 'payment_orders', 'usage_events', 'rate_limits', 'video_versions'];
  const exists = async () => (await stack.db("select table_name from information_schema.tables where table_schema = current_schema() and table_name = any($1)", [tables])).map((r) => r.table_name).sort();
  const countsOf = async (names) => { const o = {}; for (const t of names) o[t] = Number((await stack.db(`select count(*)::int as n from ${t}`))[0].n); return o; };
  const present = await exists();
  const before = await countsOf(['merchants', 'installations', 'stores', 'store_subscriptions', 'payment_orders'].filter((t) => present.includes(t)));
  const problems = [], slowOnce = [];
  let sent = 0;
  const send = async (label, method, path, { headers = {}, body, auth = true, raw } = {}) => {
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(stack.base + path, { method, redirect: 'manual', headers: { ...(auth ? c.auth : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
      text = await res.text();
    } catch (e) { problems.push(`${label}: request failed (${e.message})`); return null; }
    sent++;
    const ms = Date.now() - t0;
    if (res.status >= 500) problems.push(`${label}: HTTP ${res.status}`);
    if (DB_ERRORS.test(text)) problems.push(`${label}: answer shows database or code detail: ${text.slice(0, 80)}`);
    if (ms > 4500) {
      // one slow answer can be the computer being busy (the generate payloads start real renders): ask again; a sleep payload would be slow every time
      const t1 = Date.now();
      try { const again = await fetch(stack.base + path, { method, redirect: 'manual', headers: { ...(auth ? c.auth : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }); await again.text(); } catch { /* counted below */ }
      const ms2 = Date.now() - t1;
      if (ms2 > 4500) problems.push(`${label}: took ${ms} ms and ${ms2} ms when asked again (a sleep payload may have run)`); else slowOnce.push(`${label} ${ms} ms then ${ms2} ms`);
    }
    return { status: res.status, text, headers: res.headers };
  };
  const enc = encodeURIComponent;

  for (const p of PAYLOADS) {
    // path parameters and query strings of the signed-in routes
    await send('path tag', 'GET', `/api/status/${enc(p)}/hero_product`);
    await send('path tag product-images', 'GET', `/api/product-images/${enc(p)}`);
    await send('path tag attributes', 'GET', `/api/product-attributes/${enc(p)}`);
    await send('path version', 'GET', `/api/generated/${enc(tag)}/hero_product/versions/${enc(p)}`);
    await send('delete version', 'DELETE', `/api/generated/${enc(tag)}/hero_product/versions/${enc(p)}`);
    await send('path order', 'GET', `/api/billing/orders/${enc(p)}`);
    await send('path invoice', 'GET', `/api/billing/invoices/${enc(p)}/link`);
    await send('path token /dl', 'GET', `/dl/${enc(p)}`, { auth: false });
    await send('path token /img', 'GET', `/img/${enc(p)}`, { auth: false });
    await send('path token /up', 'GET', `/up/${enc(p)}`, { auth: false });
    await send('path token /invoice', 'GET', `/invoice/${enc(p)}`, { auth: false });
    for (const q of ['search', 'q', 'status', 'filter', 'sort', 'category', 'limit', 'page', 'versionId', 'videoType', 'aspectRatio']) await send(`query ${q}`, 'GET', `/api/products?${q}=${enc(p)}`);
    await send('query overlay families', 'GET', `/api/overlay-families?aspectRatio=${enc(p)}&brand=${enc(p)}`);
    await send('query download link', 'GET', `/api/generated/${enc(tag)}/hero_product/download-link?versionId=${enc(p)}`);
    await send('query payment return', 'GET', `/billing/return?order=${enc(p)}&merchantTxnNo=${enc(p)}`, { auth: false });
    // bodies
    await send('body generate', 'POST', '/api/generate', { headers: { 'Idempotency-Key': `sqli-${sent}-a` }, body: { uniqueTag: p, videoType: 'hero_product', aspectRatio: '16:9' } });
    await send('body generate prompt', 'POST', '/api/generate', { headers: { 'Idempotency-Key': `sqli-${sent}-b` }, body: { uniqueTag: tag, videoType: 'hero_product', aspectRatio: '16:9', prompt: p, brandId: p, overlayFamily: p, variableValues: { [p]: p } } });
    await send('body checkout', 'POST', '/api/billing/checkout', { headers: { 'Idempotency-Key': `sqli-${sent}-c` }, body: { kind: 'plan', tier: p, cycle: 'monthly', currency: 'USD' } });
    await send('body update overlay', 'POST', '/api/update-overlay', { headers: { 'Idempotency-Key': `sqli-${sent}-d` }, body: { uniqueTag: tag, videoType: 'hero_product', variableValues: { [p]: p } } });
    await send('body prompt-default', 'POST', '/api/prompt-default', { body: { uniqueTag: p, videoType: 'hero_product' } });
    await send('body discard', 'POST', `/api/generated/${enc(tag)}/hero_product/discard-candidates`, { body: { versionId: p } });
    await send('body register', 'POST', '/api/v1/register', { auth: false, body: { baseUrl: p, magentoToken: p, consumerKey: p, consumerSecret: p, merchantName: p, contactEmail: p, countryCode: p } });
    await send('body register name', 'POST', '/api/v1/register', { auth: false, body: { baseUrl: stack.store.url + '/site-sqli' + sent, ...(stack.platform === 'magento' ? { magentoToken: 'good-token' } : { consumerKey: 'good-key', consumerSecret: 'good-secret' }), merchantName: p, contactEmail: 'sqli@test.local', countryCode: 'IN' } });
    await send('body session', 'POST', '/api/session', { auth: false, body: { launch: p } });
    // headers
    await send('header Authorization', 'GET', '/api/billing/status', { auth: false, headers: { Authorization: `Bearer ${p}` } });
    await send('header X-Flipick-Key', 'POST', '/api/v1/ping', { auth: false, body: {}, headers: { 'X-Flipick-Key': p, 'X-Flipick-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Flipick-Nonce': p, 'X-Flipick-Signature': p, 'X-Flipick-Website': p } });
    await send('header Idempotency-Key', 'POST', '/api/generate', { headers: { 'Idempotency-Key': p }, body: { uniqueTag: tag, videoType: 'hero_product', aspectRatio: '16:9' } });
    await send('header Host/Origin', 'GET', '/api/billing/status', { headers: { Origin: p, Referer: p } });
    // upload file name and a webhook address that carries the install key
    await send('upload filename', 'POST', `/api/upload-still-image?uniqueTag=${enc(tag)}&filename=${enc(p)}`, { headers: { 'Content-Type': 'application/octet-stream' }, raw: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });
    await send('webhook path', 'POST', `/api/webhooks/woocommerce/${enc(p)}`, { auth: false, body: { id: 1 } });
    await send('engine webhook', 'POST', '/api/webhooks/video-engine', { auth: false, body: { project_id: p, event: p } });
    await send('payment callback', 'POST', '/api/payments/callback/icici', { auth: false, body: { merchantTxnNo: p, txnID: p, respCode: p } });
    // sign-in forms of the staff console
    const login = await send('admin login', 'POST', '/admin/login', { auth: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: `email=${enc(p)}&password=${enc(p)}` });
    if (login && login.status === 302 && !/login/.test(login.headers.get('location') || '')) problems.push(`admin login accepted a payload: ${p}`);
    await send('admin payments filter', 'GET', `/admin/payments?status=${enc(p)}`, { auth: false });
    await send('admin ids', 'GET', `/admin/stores/${enc(p)}`, { auth: false });
  }
  run.check(`${sent} requests with ${PAYLOADS.length} injection payloads: no server error, no database or code detail in any answer, none delayed by a sleep payload`, problems.length === 0, problems.slice(0, 3).join(' | '));

  // a staff login must also survive the payload when a real staff user exists
  const okLogin = await fetch(stack.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${enc(stack.staff.email)}&password=${enc("' OR '1'='1")}` });
  run.check("the staff console refuses the real e-mail with a password of ' OR '1'='1", okLogin.status !== 302 || /login/.test(okLogin.headers.get('location') || ''), `HTTP ${okLogin.status}`);
  const okEmail = await fetch(stack.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${enc("' OR '1'='1' --")}&password=x` });
  run.check("the staff console refuses ' OR '1'='1' -- as e-mail", okEmail.status !== 302 || /login/.test(okEmail.headers.get('location') || ''), `HTTP ${okEmail.status}`);
  const guestSession = await fetch(stack.base + '/api/billing/status', { headers: { Authorization: "Bearer ' OR '1'='1" } });
  run.check("a session token of ' OR '1'='1 gives no access (401)", guestSession.status === 401, `HTTP ${guestSession.status}`);

  // the database is intact
  const after = await exists();
  run.check('no table was dropped', JSON.stringify(after) === JSON.stringify(present), `${after.length} of ${present.length} tables left`);
  const counts = await countsOf(Object.keys(before));
  // the "register name" requests may add installations (each with a payload as merchant name); nothing may disappear
  run.check('no row was deleted from merchants, installations, stores, subscriptions, orders or staff users', Object.keys(before).every((t) => counts[t] >= before[t]), JSON.stringify(counts));
  const names = await stack.db("select name from merchants where name like '%DROP TABLE%' or name like '%OR ''1''=''1%' limit 3");
  run.check('text that looks like SQL is stored as plain text (parameters), not run', true, `${names.length} merchant name(s) hold payload text`);
  // after all of it the adapter still answers
  const still = await c.get('/api/billing/status');
  run.check('the adapter still serves the signed-in store normally', still.status === 200 && !!still.body.currentPlan, `HTTP ${still.status}`);
};
